import {
  PAYLOAD_KEY_PREFIX,
  OVERLAY_MSG,
  SETTINGS_KEY,
  DEFAULT_CLOSE_ON_OUTSIDE_CLICK,
} from '../common/protocol.js';
import { buildQr, drawQrToCanvas, copyQrImage, downloadQrImage, exportEdgeOf } from './qr.js';
import { acquireImage, decodeImageBlob, classifyDecodedText } from './decode.js';

const $ = (id) => document.getElementById(id);

const PREVIEW_SIZE = 200;

/**
 * 「允许所有网站」对应的一组来源。
 *
 * 扩展的主机权限是按 origin 粒度授予并存储的：只授权 `https://a.com/*` 时，
 * 换到 `b.com` 或同域的 `http://` 版本都会重新要求一次。
 * 想「只授权一次」，唯一可行的是把 manifest 里 optional_host_permissions 声明过的
 * 这一组通配一次性全部请求掉 —— 之后任何站点的图片都不再触发询问。
 */
const ALL_ORIGINS = ['http://*/*', 'https://*/*'];

/**
 * 常规形态下本页面嵌在宿主页面的 iframe 里；也可以作为独立标签页打开
 * （注入失败时的兜底路径，或开发时直接打开调试）。
 */
const EMBEDDED = window.parent !== window;

/**
 * 面板也可能被直接当普通页面打开（开发调试），那时 chrome.* 并不存在。
 * 扩展能力统一经这个判断，保证脱离扩展环境时只是功能降级，而不是整页脚本中断。
 */
const HAS_EXTENSION_API = typeof chrome !== 'undefined' && Boolean(chrome?.storage);

const state = {
  payload: {},
  qr: null,
  decodedText: null,
  decodedLink: null,
  hostPattern: null,
  thumbUrl: null,
};

boot();

async function boot() {
  bindOverlayChrome();
  bindTextPane();
  bindImagePane();

  const payload = await readPayload();
  state.payload = payload;

  if (payload.mode === 'image') {
    applyMode('image');
    await runImageFlow(payload);
  } else {
    applyMode('text');
    $('text').value = payload.text || '';
    renderQr();
    // 从右键菜单唤起时内容已填好，直接全选方便整体替换
    if (payload.text) $('text').select();
    else $('text').focus();
  }

  startHeightReporting();
}

/**
 * 读取本次面板的载荷。
 * token 在 URL hash 里（不参与网络请求、不进入浏览记录），读到后立即删除对应的存储键：
 * 选中内容只在这个面板实例的生命周期内存在，不在浏览器里长期驻留。
 */
async function readPayload() {
  const token = new URLSearchParams(location.hash.replace(/^#/, '')).get('token');
  if (!token) return { mode: 'text', text: '' };

  const key = PAYLOAD_KEY_PREFIX + token;
  try {
    const stored = await chrome.storage.session.get(key);
    await chrome.storage.session.remove(key);
    return stored[key] || { mode: 'text', text: '' };
  } catch (error) {
    return { mode: 'text', text: '' };
  }
}

function applyMode(mode) {
  document.body.dataset.mode = mode;
  $('title').textContent = mode === 'image' ? '图片 → 解码结果' : '选中文字 → 二维码';
}

/* ── 悬浮窗外壳：关闭、开关、拖动、高度 ───────────────────── */

function bindOverlayChrome() {
  $('closeOverlay').addEventListener('click', () => {
    if (EMBEDDED) postToHost({ type: OVERLAY_MSG.CLOSE });
    else window.close();
  });

  // 焦点在 iframe 内部时宿主的 keydown 收不到，所以 Esc 需要这一侧也监听一次
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && EMBEDDED) postToHost({ type: OVERLAY_MSG.CLOSE });
  });

  initCloseOnOutsideToggle();
  bindDragHandle();
}

async function initCloseOnOutsideToggle() {
  const toggle = $('closeOnOutside');
  toggle.checked = DEFAULT_CLOSE_ON_OUTSIDE_CLICK;

  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const value = stored?.[SETTINGS_KEY];
    if (typeof value === 'boolean') toggle.checked = value;
  } catch (error) {
    // 读不到就用默认值，不影响悬浮窗可用
  }

  // 偏好只有这一个写入点；宿主脚本只监听 storage.onChanged，不参与写，避免两边互相覆盖
  toggle.addEventListener('change', () => {
    if (!HAS_EXTENSION_API) return;
    chrome.storage.local.set({ [SETTINGS_KEY]: toggle.checked }).catch(() => {
      toast('偏好保存失败，本次仍然生效', 'warn');
    });
  });
}

/**
 * 打开新标签页；脱离扩展环境时退回 window.open，便于直接打开面板调试。
 *
 * 这里再校验一次协议，而不是只依赖上游的 classifyDecodedText 与按钮 disabled 状态：
 * 「危险协议永不进 chrome.tabs.create」应当是这个函数自己的不变式，
 * 否则以后新增一个调用点就可能绕过上游的过滤。
 */
function openTab(url) {
  if (!isHttpUrl(url)) return;
  if (HAS_EXTENSION_API) {
    chrome.tabs.create({ url });
    return;
  }
  window.open(url, '_blank', 'noopener');
}

function bindDragHandle() {
  $('bar').addEventListener('pointerdown', (event) => {
    if (!EMBEDDED || event.button !== 0) return;
    // 工具条里的按钮与开关不能当拖动把手，否则点关闭会先触发一次拖动
    if (event.target.closest('button, label, input, select, textarea, a')) return;
    postToHost({ type: OVERLAY_MSG.DRAG_START, clientX: event.clientX, clientY: event.clientY });
    event.preventDefault();
  });
}

/**
 * 把内容高度上报给宿主，由宿主调整 iframe 尺寸。
 *
 * 用 body 的布局高度，而不是 documentElement.scrollHeight：
 * 后者会被 iframe 视口高度托底（至少等于视口高），宿主一旦给过较大的高度，
 * 上报值就再也降不下来，内容变矮时悬浮窗会一直保持过高的尺寸。
 * body 的高度纯粹由内容决定，宿主改 iframe 尺寸不会反过来改变它，因此也不存在反馈循环。
 */
function startHeightReporting() {
  if (!EMBEDDED) return;

  const report = () => {
    const height = Math.ceil(document.body.getBoundingClientRect().height);
    postToHost({ type: OVERLAY_MSG.HEIGHT, value: height });
  };

  new ResizeObserver(report).observe(document.body);
  report();
}

function postToHost(message) {
  if (!EMBEDDED) return;
  // targetOrigin 只能是 '*'：父窗口是任意站点，没法预知它的 origin。
  // 安全性由宿主侧校验 event.origin 与 event.source 保证，见 src/content/overlay.js。
  window.parent.postMessage(message, '*');
}

/* ── 文本模式 ─────────────────────────────────────────────── */

function bindTextPane() {
  let timer = null;
  // 每敲一个字都重排矩阵会有明显卡顿感，做一个短防抖
  const scheduleRender = () => {
    clearTimeout(timer);
    timer = setTimeout(renderQr, 120);
  };

  $('text').addEventListener('input', scheduleRender);
  $('ecc').addEventListener('change', renderQr);

  // 导出尺寸只能是整数模块的倍数，未必等于下拉框里的目标值；
  // 回显真实边长，避免「选了 512 却拿到 370」这种用户无法察觉的落差
  $('copyImage').addEventListener('click', async () => {
    if (!state.qr) return toast('还没有可复制的二维码', 'warn');
    const edge = exportEdgeOf(state.qr, exportSize());
    try {
      await copyQrImage(state.qr, exportSize());
      toast(`二维码图片已复制到剪贴板（${edge}×${edge}）`);
    } catch (error) {
      toast(`复制失败：${describe(error)}`, 'error');
    }
  });

  $('downloadPng').addEventListener('click', async () => {
    if (!state.qr) return toast('还没有可下载的二维码', 'warn');
    try {
      const result = await downloadQrImage(state.qr, exportSize());
      toast(`已保存 ${result.filename}（${result.edge}×${result.edge}）`);
    } catch (error) {
      toast(`下载失败：${describe(error)}`, 'error');
    }
  });

  $('copyText').addEventListener('click', async () => {
    const value = $('text').value;
    if (!value) return toast('内容为空', 'warn');
    try {
      await navigator.clipboard.writeText(value);
      toast('文字已复制');
    } catch (error) {
      toast(`复制失败：${describe(error)}`, 'error');
    }
  });
}

function renderQr() {
  const value = $('text').value;
  const built = buildQr(value, $('ecc').value);
  const canvas = $('qrCanvas');

  if (!built.ok) {
    state.qr = null;
    canvas.hidden = true;
    $('qrEmpty').hidden = false;
    $('qrEmpty').textContent = emptyHint(built.reason);
    $('qrMeta').textContent = built.reason === 'EMPTY' ? '—' : `${byteLength(value)} 字节 · 无法生成`;
    return;
  }

  state.qr = built;
  canvas.hidden = false;
  $('qrEmpty').hidden = true;
  drawQrToCanvas(canvas, built, { size: PREVIEW_SIZE });
  $('qrMeta').textContent =
    `版本 v${built.version} · ${built.count}×${built.count} 模块 · ${built.bytes} 字节 · 纠错 ${built.ecc}`;
}

function emptyHint(reason) {
  if (reason === 'EMPTY') return '等待输入内容';
  if (reason === 'OVERFLOW') return '内容超出二维码容量上限（约 2.9 KB），请精简后再试';
  if (reason === 'VENDOR_MISSING') return '二维码库未加载';
  return '无法生成二维码';
}

/** 识别失败时按原因给出可执行的下一步，而不是一律「换张清楚的图」。 */
function failureHint(reason) {
  if (reason === 'TAINTED_CANVAS') {
    return '图片受跨域限制无法读取像素，建议改用本地文件或粘贴截图。';
  }
  if (reason === 'IMAGE_TOO_LARGE') {
    return '图片分辨率或体积超出识别上限，建议先裁剪到二维码区域再试。';
  }
  if (reason === 'BAD_IMAGE') {
    return '这个文件无法被解码成图片，请换一张 PNG / JPEG / WebP。';
  }
  return '可以试试：换一张更清晰、更完整的图片；二维码留白被裁掉时也识别不出来。';
}

function exportSize() {
  return Number($('exportSize').value) || 1024;
}

/* ── 图片模式 ─────────────────────────────────────────────── */

function bindImagePane() {
  $('grantHost').addEventListener('click', () => grantAndRetry([state.hostPattern], $('grantHost')));
  $('grantAll').addEventListener('click', () => grantAndRetry(ALL_ORIGINS, $('grantAll')));

  $('openDecoded').addEventListener('click', () => {
    if (state.decodedLink?.kind !== 'url') return;
    openTab(state.decodedLink.url);
  });

  $('copyResult').addEventListener('click', async () => {
    if (!state.decodedText) return;
    try {
      await navigator.clipboard.writeText(state.decodedText);
      toast('结果已复制');
    } catch (error) {
      toast(`复制失败：${describe(error)}`, 'error');
    }
  });

  $('openSourcePage').addEventListener('click', () => {
    openTab(state.payload.pageUrl);
  });

  $('fileInput').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    applyMode('image');
    showAndDecode(file, '本地文件');
    // 清空 value 才能连续选择同一个文件
    event.target.value = '';
  });

  bindDropAndPaste();
}

function bindDropAndPaste() {
  const toggleDropStyle = (active) => (event) => {
    if (!event.dataTransfer) return;
    event.preventDefault();
    document.body.classList.toggle('dropping', active);
  };
  document.addEventListener('dragenter', toggleDropStyle(true));
  document.addEventListener('dragover', toggleDropStyle(true));
  document.addEventListener('dragleave', toggleDropStyle(false));

  document.addEventListener('drop', (event) => {
    event.preventDefault();
    document.body.classList.remove('dropping');
    const file = pickImageFile(event.dataTransfer?.files);
    if (!file) return;
    applyMode('image');
    showAndDecode(file, '拖入的文件');
  });

  // 直接读粘贴事件里的 File，不需要剪贴板读权限，也不会误伤在文本框里粘贴文字
  document.addEventListener('paste', (event) => {
    const file = pickImageFile(event.clipboardData?.files);
    if (!file) return;
    event.preventDefault();
    applyMode('image');
    showAndDecode(file, '剪贴板截图');
  });
}

function pickImageFile(fileList) {
  return Array.from(fileList || []).find((file) => file.type.startsWith('image/')) || null;
}

/** 查询主机权限是否已在手；脱离扩展环境时恒为 false。 */
async function hasHostPermission(origins) {
  if (!HAS_EXTENSION_API || !chrome?.permissions?.contains) return false;
  try {
    return await chrome.permissions.contains({ origins });
  } catch {
    return false;
  }
}

/**
 * 请求主机权限，成功后原地重试取图。
 *
 * chrome.permissions.request 必须在用户手势内调用，所以授权做成显式按钮而不是自动弹窗；
 * 对已经授予过的 origin，它会直接 resolve(true) 而不弹窗，因此重复点击不会骚扰用户。
 */
async function grantAndRetry(origins, button) {
  const list = (origins || []).filter(Boolean);
  if (!list.length) return;

  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: list });
  } catch (error) {
    toast('当前环境无法发起站点授权，请改用本地图片', 'warn');
    return;
  }

  if (!granted) {
    toast('未授权，仍可使用本地图片或粘贴截图', 'warn');
    return;
  }
  if (button) button.hidden = true;
  await runImageFlow(state.payload);
}

async function runImageFlow(payload) {
  $('grantHost').hidden = true;
  $('grantAll').hidden = true;
  $('fallbackHint').textContent = '';
  setDecodeMeta('正在获取图片…');

  const acquired = await acquireImage(payload);
  const detail = acquired.notes?.length ? `（${acquired.notes.join('；')}）` : '';

  if (!acquired.ok) {
    state.hostPattern = acquired.originPattern || null;
    const head =
      acquired.reason === 'IMAGE_TOO_LARGE' ? '图片体积超出上限，已跳过读取' : `获取图片失败：${acquired.reason}`;
    setDecodeMeta(`${head}${detail}`);

    if (acquired.reason === 'NEED_HOST_PERMISSION') {
      const pattern = acquired.originPattern;
      const siteGranted = await hasHostPermission([pattern]);
      const allGranted = await hasHostPermission(ALL_ORIGINS);

      if (siteGranted) {
        // 已经有权限还失败，再让用户点同一个按钮就是误导：问题不在授权。
        // 这两种原因都绕不过去，直接把可行路径说清楚，别让人反复点。
        $('fallbackHint').textContent =
          `已获得 ${hostLabel(payload.srcUrl)} 的读取权限，但站点仍拒绝提供图片` +
          '（常见于防盗链，或图片需要登录态——跨站请求不携带 cookie，同源时也受 SameSite 限制）。' +
          '请改用本地文件、拖拽，或截图后粘贴。';
      } else {
        $('fallbackHint').textContent =
          `浏览器不允许扩展直接跨域读取这张图片的像素（${hostLabel(payload.srcUrl)}）。` +
          '授权后识别仍在本机完成，图片不会被上传。只想授权一次就选「允许读取所有网站图片」。';
        $('grantHost').hidden = false;
      }

      // 站点级权限已覆盖这张图时，再放宽到全站也不会改变结果
      $('grantAll').hidden = allGranted || siteGranted;
    } else if (acquired.reason === 'IMAGE_TOO_LARGE') {
      // 体积超限是授权也救不回来的，别把人引到授权按钮上
      $('fallbackHint').textContent = failureHint('IMAGE_TOO_LARGE');
    } else if (acquired.reason === 'NO_SOURCE') {
      $('fallbackHint').textContent = '没有拿到图片地址，可以直接选择本地图片或粘贴截图。';
    } else {
      $('fallbackHint').textContent = '未能读取这张图片，可以改用本地文件或粘贴截图。';
    }
    return;
  }
  await showAndDecode(acquired.blob, originLabel(acquired.origin));
}

async function showAndDecode(blob, sourceLabel) {
  showThumb(blob);
  setDecodeMeta(`已获取图片（来源：${sourceLabel}），正在识别…`);

  let decoded;
  try {
    decoded = await decodeImageBlob(blob);
  } catch (error) {
    setDecodeMeta(`识别过程出错：${describe(error)}`);
    $('fallbackHint').textContent = '可以试试换一张更清晰的图片，或放大后再截图识别。';
    return;
  }

  if (!decoded.ok) {
    state.decodedText = null;
    state.decodedLink = null;
    $('result').value = '';
    syncResultButtons();
    const tooLarge = decoded.reason === 'IMAGE_TOO_LARGE';
    const tried = decoded.attempts?.length ? `｜尝试尺寸：${decoded.attempts.join(' → ')}` : '';
    setDecodeMeta(
      tooLarge
        ? `图片过大，已跳过识别（来源：${sourceLabel}）`
        : `未识别到二维码（来源：${sourceLabel}${tried}）`,
    );
    $('fallbackHint').textContent = failureHint(decoded.reason);
    return;
  }

  state.decodedText = decoded.text;
  state.decodedLink = classifyDecodedText(decoded.text);
  $('result').value = decoded.text;
  $('fallbackHint').textContent = '';
  setDecodeMeta(`识别成功｜引擎：${decoded.engine}｜格式：${decoded.format}｜来源：${sourceLabel}`);
  syncResultButtons();
  toast('识别成功');
}

function showThumb(blob) {
  if (state.thumbUrl) URL.revokeObjectURL(state.thumbUrl);
  state.thumbUrl = URL.createObjectURL(blob);
  $('srcImage').src = state.thumbUrl;
  $('srcImage').hidden = false;
  $('thumbPlaceholder').hidden = true;
}

function syncResultButtons() {
  const link = state.decodedLink;
  const openable = link?.kind === 'url';
  const openButton = $('openDecoded');
  openButton.disabled = !openable;
  openButton.textContent = openable && link.guessed ? '打开该页面（已补全 https）' : '打开该页面';
  $('copyResult').disabled = !state.decodedText;
  $('openSourcePage').disabled = !isHttpUrl(state.payload.pageUrl);
}

/* ── 工具 ─────────────────────────────────────────────────── */

function setDecodeMeta(text) {
  $('decodeMeta').textContent = text;
}

function originLabel(origin) {
  return (
    {
      'page-canvas': '页面内取图',
      'page-fetch': '页面内取回',
      network: '网络读取',
      inline: '内联图片',
    }[origin] || origin
  );
}

function hostLabel(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '该站点';
  }
}

function isHttpUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

function describe(error) {
  return String(error?.message || error);
}

let toastTimer = null;

function toast(message, kind = 'ok') {
  const element = $('toast');
  element.textContent = message;
  element.dataset.kind = kind;
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 2400);
}
