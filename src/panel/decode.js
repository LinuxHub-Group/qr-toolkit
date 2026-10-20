/**
 * 图片获取与二维码识别。
 *
 * 这里的难点不是「下载一张图片」，而是图片可能以三种扩展拿不到字节的形态出现：
 *   1. blob: URL —— 只对创建它的那个页面有效，扩展侧 fetch 必然失败；
 *   2. 跨域图片且响应头没有 Access-Control-Allow-Origin —— 画到 canvas 后 canvas 被污染，
 *      toDataURL / getImageData 会抛 SecurityError；
 *   3. 需要登录态或防盗链的图片 —— 扩展页直接 fetch 拿不到内容。
 *
 * 因此按下面顺序降级，每降一级都在面板上如实说明当前走到了哪一步：
 *   页面内 canvas 导出 → 页面内 fetch（页面自己的 origin）→ 扩展页直连取字节 → 申请主机权限后重试。
 *
 * 为什么中间要有「页面内 fetch」这一级：它请求时带的是**站点自己的 cookie 与 Referer**，
 * 同源图、带 CORS 头但没出现在 DOM 里的图（srcset / 懒加载 / 背景图）都能直接拿到，
 * 完全不需要任何主机权限。只有「跨域且无 CORS 头」的图才会真正落到授权那一级。
 *
 * 识别引擎同理做两级：原生 BarcodeDetector 有则用（快，无额外体积），
 * 但它只覆盖 ChromeOS/macOS 的 Chrome，Windows 桌面版没有，因此必须内置 jsQR 兜底。
 */

const MAX_DECODE_EDGE = 1600; // 超大图会让 jsQR 的定位搜索变得极慢，先降采样到这一档再试
const MAX_RASTER_EDGE = 3200; // 栅格化后的长边上限：再放大只是插值，不会多出信息
const MIN_DECODE_EDGE = 240; // 过小的图定位图案不够清晰，先放大再试

/**
 * 输入体积与像素上限。
 *
 * 这两道闸门防的是内存放大而不是识别精度：一张 15000×15000 的 PNG 解码成位图后是
 * 约 900 MB，面板会直接被标签页 OOM 杀掉；而 executeScript 把几十 MB 的 dataURL
 * 跨进程回传、再逐字节 atob，也会让面板长时间无响应。
 * 二维码图片实际只需要几十万像素，这两个上限对正常场景没有影响。
 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;

/**
 * 网络取图的超时上限。
 *
 * fetch 默认不超时：图片服务器接受连接后不再响应时，Promise 会一直悬着，
 * 面板就永久停在「正在获取图片…」，用户除了关掉浮层没有别的出路。
 * 二维码图片正常在几百毫秒内就能取回，10 秒是给慢速移动网络留的余量。
 */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * 取图。返回 { ok, blob, origin, notes }，失败时额外带 reason / originPattern。
 *
 * pageUrl 只用于一个判断：跨站取图时该不该带用户的 cookie（见第 4 级的注释）。
 *
 * @param {{ srcUrl?: string, pageUrl?: string, tabId?: number|null }} payload
 */
export async function acquireImage({ srcUrl, pageUrl, tabId }) {
  const notes = [];

  if (!srcUrl) {
    return { ok: false, reason: 'NO_SOURCE', notes };
  }

  const isInline = /^data:/i.test(srcUrl);

  if (isInline) {
    const inline = await tryFetchBlob(srcUrl);
    if (inline.ok) return { ok: true, blob: inline.blob, origin: 'inline', notes };
    if (inline.reason === 'TOO_LARGE') return { ok: false, reason: 'IMAGE_TOO_LARGE', notes };
    notes.push('内联图片读取失败');
  }

  // 页面内导出优先：用的就是页面已经加载好的那份像素，blob: 与同源图都能拿到，
  // 只有「跨域且未带 CORS 头」的图会污染 canvas 而失败。
  if (!isInline && tabId != null) {
    const captured = await captureFromPage(tabId, srcUrl);
    if (captured.ok) {
      try {
        return {
          ok: true,
          blob: dataUrlToBlob(captured.dataUrl),
          origin: 'page-canvas',
          dimension: { width: captured.width, height: captured.height },
          notes,
        };
      } catch (error) {
        // 数据异常就当作这一级失败，继续走后面的降级链，而不是让整个流程抛出
        notes.push('页面内导出的图片数据无法解析');
      }
    } else {
      notes.push(`页面内取图失败（${captured.reason}）`);
    }
  }

  if (!isInline) {
    // 页面内 fetch：带站点自己的 cookie 与 Referer，同源图与 CORS 放行的图都不需要授权
    if (tabId != null) {
      const fetched = await fetchFromPage(tabId, srcUrl);
      if (fetched.ok) {
        try {
          return { ok: true, blob: dataUrlToBlob(fetched.dataUrl), origin: 'page-fetch', notes };
        } catch (error) {
          notes.push('页面内取回的图片数据无法解析');
        }
      } else {
        notes.push(`页面内取字节失败（${fetched.reason}）`);
      }
    }

    // 第 4 级：扩展页直连取字节。
    //
    // credentials 只在「图片与其所在页面同源」时才带 include —— srcUrl 完全由被访问的
    // 页面控制，跨站带着用户 cookie 发 GET 等于把扩展变成 CSRF 跳板：
    // 页面自己发不出这种请求（同源策略拦着），扩展发得出，这就是纯扩权。
    // 同源时页面本来就能自己发同样的请求，带 cookie 不构成任何额外能力，因此这一级
    // 在真正需要它的场景（同源、需登录态）里一点也没变弱。
    const direct = await tryFetchBlob(srcUrl, {
      credentials: isSameOrigin(srcUrl, pageUrl) ? 'include' : 'omit',
    });
    if (direct.ok) return { ok: true, blob: direct.blob, origin: 'network', notes };
    // 体积超限时直接结束这一级：再让用户去授权，只会拿到同样的失败
    if (direct.reason === 'TOO_LARGE') {
      return { ok: false, reason: 'IMAGE_TOO_LARGE', originPattern: hostPatternOf(srcUrl), notes };
    }
    notes.push('扩展直接读取图片地址失败');
  }

  const originPattern = hostPatternOf(srcUrl);
  return {
    ok: false,
    reason: originPattern ? 'NEED_HOST_PERMISSION' : 'FETCH_FAILED',
    originPattern,
    notes,
  };
}

/**
 * 把图片地址换算成可申请的主机权限匹配模式。
 * 匹配模式里的主机名不包含端口，所以同一个模式天然覆盖该域名的所有端口。
 */
export function hostPatternOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    return null;
  }
}

/**
 * 识别一张图片里的二维码 / 条码。
 *
 * @param {Blob} blob
 * @returns {Promise<{ok: boolean, text?: string, engine?: string, format?: string, attempts: string[], reason?: string}>}
 */
export async function decodeImageBlob(blob) {
  if (!blob || !blob.size) {
    return { ok: false, reason: 'BAD_IMAGE', attempts: [] };
  }
  // 先按字节数挡掉明显过大的输入，避免为了「看一眼尺寸」而先解码整张图
  if (blob.size > MAX_IMAGE_BYTES) {
    return { ok: false, reason: 'IMAGE_TOO_LARGE', attempts: [], size: blob.size };
  }

  let source;
  try {
    source = await loadBitmap(blob);
  } catch (error) {
    return { ok: false, reason: 'BAD_IMAGE', attempts: [], message: String(error?.message || error) };
  }

  const width = source.width || source.naturalWidth || 0;
  const height = source.height || source.naturalHeight || 0;
  if (!width || !height) {
    return { ok: false, reason: 'BAD_IMAGE', attempts: [] };
  }
  // 字节数没超不代表像素没超：高压缩比的大尺寸 PNG 会在这里被拦下
  if (width * height > MAX_IMAGE_PIXELS) {
    return { ok: false, reason: 'IMAGE_TOO_LARGE', attempts: [], dimension: { width, height } };
  }

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const attempts = [];

  for (const scale of buildScales(width, height)) {
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    context.clearRect(0, 0, targetWidth, targetHeight);
    context.drawImage(source, 0, 0, targetWidth, targetHeight);

    const label = `${targetWidth}×${targetHeight}`;
    let imageData = null;
    try {
      imageData = context.getImageData(0, 0, targetWidth, targetHeight);
    } catch (error) {
      // 走到这里说明 canvas 被跨域图片污染，换尺度也救不回来，直接退出
      return { ok: false, reason: 'TAINTED_CANVAS', attempts, message: String(error) };
    }

    const native = await runBarcodeDetector(canvas);
    if (native) {
      attempts.push(`${label} / 原生`);
      return { ok: true, ...native, attempts, source: { width, height } };
    }

    const jsqr = runJsQr(imageData);
    if (jsqr) {
      attempts.push(`${label} / jsQR`);
      return { ok: true, ...jsqr, attempts, source: { width, height } };
    }

    attempts.push(label);
  }

  return { ok: false, reason: 'NOT_DETECTED', attempts, source: { width, height } };
}

/**
 * 判断解码结果是网址还是普通文本。
 * 二维码里常见省略协议的写法（www.example.com、example.com/a），
 * 补上 https 能解析就认作可打开，并标记 guessed 以便界面区分。
 */
export function classifyDecodedText(text) {
  const value = (text || '').trim();
  if (!value) return { kind: 'empty' };

  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return { kind: 'url', url: parsed.href };
    }
    return { kind: 'text' };
  } catch {
    // 继续走补协议的启发式
  }

  // 含空格、或没有任何点的纯文字不会命中这个形状，不会被误判成网址
  if (/^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+(?:[/?#].*)?$/u.test(value)) {
    try {
      const parsed = new URL(`https://${value}`);
      return { kind: 'url', url: parsed.href, guessed: true };
    } catch {
      return { kind: 'text' };
    }
  }

  return { kind: 'text' };
}

/* ── 内部实现 ─────────────────────────────────────────────── */

/**
 * 取一个地址的字节。
 *
 * 两种失败必须区分开，因为上层要做的事完全不同：
 *   - `TOO_LARGE`：地址能用但内容超限。这是授权也解决不了的问题，
 *     若与 `FETCH_FAILED` 混为一谈，用户会被引导去点「允许读取该站点」然后再次失败；
 *   - `FETCH_FAILED`：网络错误、HTTP 错误码、CORS 拒绝、超时中止。
 */
async function tryFetchBlob(url, { credentials = 'same-origin', timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { credentials, signal: controller.signal });
    if (!response.ok) return { ok: false, reason: 'FETCH_FAILED' };

    // 先看声明体积再读 body：被指过来的超大图不该先把内存吃满、再被后面的闸门拒绝。
    // Content-Length 可能缺省也可能撒谎，所以这只是提前退出，读回 body 后仍会再查一次
    // —— 两处都不是可选的。
    if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
      return { ok: false, reason: 'TOO_LARGE' };
    }

    const blob = await response.blob();
    if (blob.size > MAX_IMAGE_BYTES) return { ok: false, reason: 'TOO_LARGE' };
    if (!blob.size) return { ok: false, reason: 'FETCH_FAILED' };
    return { ok: true, blob };
  } catch {
    // 网络错误、CORS 拒绝、超时中止都走这里：这一级失败即降级，不是异常
    return { ok: false, reason: 'FETCH_FAILED' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 图片地址是否与其所在页面同源（仅就「要不要带 cookie」这一判断而言）。
 *
 * 有三条都必须返回 false 的保守分支：
 *   - 非 http(s) 地址：`blob:` 的 origin 会被解析成内嵌的那个源（`blob:https://a.com/uuid`
 *     的 origin 就是 `https://a.com`），看起来「同源」，但这类地址根本不会产生网络请求，
 *     带凭证没有意义，判定成同源只会让这条规则的含义变模糊；
 *   - pageUrl 缺失（兜底标签页场景）；
 *   - 任一侧无法解析。
 *
 * 这个判断的失败方向必须始终是**少给权限**，所以除「明确同源」外一律 false。
 */
function isSameOrigin(url, pageUrl) {
  try {
    const target = new URL(url);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
    return target.origin === new URL(pageUrl).origin;
  } catch {
    return false;
  }
}

async function captureFromPage(tabId, srcUrl) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: captureImageInPage,
      args: [srcUrl],
    });
    return injection?.result || { ok: false, reason: 'NO_RESULT' };
  } catch (error) {
    // chrome:// 页面、扩展商店页、已关闭的标签页都会在这里被拒绝
    return { ok: false, reason: 'INJECT_FAILED', message: String(error?.message || error) };
  }
}

/**
 * 在页面自己的 origin 下把图片字节取回来。
 *
 * 与 canvas 导出的区别：不依赖「图片元素还在 DOM 里」，因此能覆盖
 * srcset / 懒加载换过 src / CSS 背景图 / 已被 React 卸载的图；
 * 且请求由站点自己发出，自带 cookie 与 Referer，同源与防盗链场景都不需要任何主机权限。
 * 代价是跨域且无 CORS 头的图在这里仍会被浏览器拦下 —— 那种情况只能靠授权。
 */
async function fetchFromPage(tabId, srcUrl) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: fetchImageInPage,
      args: [srcUrl],
    });
    return injection?.result || { ok: false, reason: 'NO_RESULT' };
  } catch (error) {
    return { ok: false, reason: 'INJECT_FAILED', message: String(error?.message || error) };
  }
}

/**
 * 在页面里 fetch 图片并转成 data URL 回传。
 *
 * 会被序列化后注入，不能引用模块作用域：所有常量都就地写。
 * 返回结构必须可结构化克隆，所以不能直接回传 Blob。
 */
function fetchImageInPage(srcUrl) {
  return fetch(srcUrl, { credentials: 'include' })
    .then(async (response) => {
      if (!response.ok) return { ok: false, reason: `HTTP_${response.status}` };
      const blob = await response.blob();
      if (!blob.size) return { ok: false, reason: 'EMPTY_BODY' };
      // 超过 8 MB 的图不在面板里处理：回传 base64 的体积与解码代价都不划算
      if (blob.size > 8 * 1024 * 1024) return { ok: false, reason: 'TOO_LARGE' };

      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
        reader.readAsDataURL(blob);
      });
      return { ok: true, dataUrl, size: blob.size };
    })
    .catch((error) => ({
      ok: false,
      reason: 'FETCH_FAILED',
      message: String((error && error.message) || error),
    }));
}

/**
 * 在图片所在页面里把图片画进 canvas 再导出 PNG。
 *
 * 这个函数会被序列化后注入页面，因此不能引用模块作用域里的任何变量：
 * 外部传进来的只有 args 里的 srcUrl，闭包与绑定都会丢失。
 * 返回 Promise 时 executeScript 会等待它 settle 并把结果作为 result 带回来。
 */
function captureImageInPage(srcUrl) {
  return new Promise((resolve) => {
    const absolute = (value) => {
      try {
        return new URL(value, location.href).href;
      } catch {
        return value;
      }
    };

    const target = absolute(srcUrl);
    const image = Array.from(document.images).find((candidate) => {
      const current = candidate.currentSrc || candidate.src;
      return current && absolute(current) === target;
    });

    if (!image) {
      resolve({ ok: false, reason: 'IMAGE_NOT_FOUND' });
      return;
    }

    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) {
      resolve({ ok: false, reason: 'IMAGE_NOT_LOADED' });
      return;
    }

    // 这个函数会被序列化，取不到模块作用域的 MAX_RASTER_EDGE，所以这里写死同样的上限。
    // 导出前就按长边缩放：等 canvas 画完再缩，内存峰值已经白付了。
    const scale = Math.min(1, 3200 / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));

    try {
      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      canvas.getContext('2d').drawImage(image, 0, 0, targetWidth, targetHeight);
      resolve({
        ok: true,
        dataUrl: canvas.toDataURL('image/png'),
        width: targetWidth,
        height: targetHeight,
      });
    } catch (error) {
      // 跨域图未带 CORS 头时 canvas 被污染，只能如实上报
      resolve({ ok: false, reason: 'TAINTED', message: String(error?.message || error) });
    }
  });
}

/**
 * 把 canvas 导出的 data URL 还原成 Blob。
 *
 * 调用方只有 captureImageInPage，而 canvas.toDataURL() 恒为 base64，
 * 因此这里只处理 base64 形态；解析不出来就抛错，由上层降级到下一级取图手段。
 */
function dataUrlToBlob(dataUrl) {
  const value = String(dataUrl);
  const comma = value.indexOf(',');
  if (comma < 0) throw new Error('不是合法的 data URL');

  const head = value.slice(0, comma);
  const body = value.slice(comma + 1);
  if (!/;base64$/i.test(head)) throw new Error('不是 base64 编码的 data URL');

  const mime = /^data:([^;,]+)/i.exec(head)?.[1] || 'image/png';
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function loadBitmap(blob) {
  if (globalThis.createImageBitmap) {
    try {
      return await createImageBitmap(blob);
    } catch {
      // 少数格式 createImageBitmap 解不了，退回 Image 元素
    }
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('图片解码失败'));
      element.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * 生成一组待尝试的缩放比例：原尺寸 → 降采样 → 放大去重后按序返回。
 * 单一尺度容易漏检（小图定位图案太糊、大图噪点太多），多试几档比调参更稳。
 */
function buildScales(width, height) {
  const longest = Math.max(width, height);
  const candidates = [];
  if (longest > MAX_DECODE_EDGE) candidates.push(MAX_DECODE_EDGE / longest);
  candidates.push(1);
  if (longest < MIN_DECODE_EDGE) candidates.push(MIN_DECODE_EDGE / longest);
  candidates.push(0.5, 2);

  const seen = new Set();
  const scales = [];
  for (const candidate of candidates) {
    const scale = Math.min(4, Math.max(0.05, candidate));
    // 放大到超过栅格化上限只是白烧时间：源图的信息量不会因为插值而变多
    if (longest * scale > MAX_RASTER_EDGE) continue;
    const key = scale.toFixed(3);
    if (seen.has(key)) continue;
    seen.add(key);
    scales.push(scale);
  }
  return scales;
}

let detectorPromise = null;

function getBarcodeDetector() {
  if (!('BarcodeDetector' in globalThis)) return null;
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const formats = await BarcodeDetector.getSupportedFormats();
      const wanted = ['qr_code', 'micro_qr_code', 'data_matrix', 'aztec', 'pdf417', 'ean_13', 'code_128'].filter(
        (format) => formats.includes(format),
      );
      return wanted.length ? new BarcodeDetector({ formats: wanted }) : null;
    })().catch(() => null);
  }
  return detectorPromise;
}

async function runBarcodeDetector(canvas) {
  const detector = await getBarcodeDetector();
  if (!detector) return null;
  try {
    const codes = await detector.detect(canvas);
    const hit = codes.find((code) => code.rawValue);
    if (!hit) return null;
    return { text: hit.rawValue, format: hit.format, engine: 'BarcodeDetector（系统原生）' };
  } catch {
    // 该接口在部分平台「存在但不可用」（例如 macOS Ventura 早期版本会静默失败），失败即降级
    return null;
  }
}

function runJsQr(imageData) {
  const decode = globalThis.jsQR;
  if (typeof decode !== 'function') return null;
  // 逐像素一次性识别，attemptBoth 会多花约 50% 时间但能识别浅色底/深色码的反色二维码，
  // 对「只跑一次」的场景这笔开销值得花。
  const code = decode(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });
  if (!code?.data) return null;
  return { text: code.data, format: 'qr_code', engine: 'jsQR' };
}
