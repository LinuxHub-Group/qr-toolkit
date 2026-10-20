/**
 * 二维码生成、绘制与导出。
 *
 * 依赖 src/vendor/qrcode-generator.js 注入的全局 `qrcode`（经典脚本，非 ESM）。
 * 选它而不是 npm 上的 qrcode：它的浏览器构建就是单个可直接 <script> 引入的文件，
 * 并且暴露 isDark() / getModuleCount()，让我们能自己按整数像素铺模块，
 * 显示预览与导出 PNG 共用同一套绘制逻辑，也不必依赖库内置的渲染尺寸。
 */

const vendor = globalThis.qrcode;

/**
 * 该库默认的 stringToBytes 是按字符码 &0xff 的 Latin-1 实现，中文会被静默截断成乱码。
 * 它同时内置了 UTF-8 实现，全局切过去即可，之后 addData 的 Byte 模式就是 UTF-8 编码。
 */
if (vendor?.stringToBytesFuncs?.['UTF-8']) {
  vendor.stringToBytes = vendor.stringToBytesFuncs['UTF-8'];
}

/** 规范要求的静默区宽度（单位：模块）。不足会导致扫码设备无法定位。 */
export const QUIET_ZONE = 4;

/**
 * 单个二维码的硬容量上限（字节）。
 * 版本 40 / 纠错 L / Byte 模式的容量是 2953 字节，这是 QR 规范的上界；
 * 其余纠错级别更小，交给库自行判断。
 */
export const MAX_BYTE_LENGTH = 2953;

/**
 * 构造二维码矩阵。
 *
 * @param {string} text
 * @param {'L'|'M'|'Q'|'H'} ecc 纠错级别
 * @returns {{ok: true, count: number, version: number, bytes: number, ecc: string, isDark: (r: number, c: number) => boolean}
 *          | {ok: false, reason: string, message?: string}}
 */
export function buildQr(text, ecc = 'M') {
  if (!vendor) {
    return { ok: false, reason: 'VENDOR_MISSING' };
  }

  const value = typeof text === 'string' ? text : '';
  if (!value) {
    return { ok: false, reason: 'EMPTY' };
  }

  // 先按规范上界挡掉不可能装下的内容：库在超容量时会从版本 1 一路试到 40 才抛错，
  // 对「粘贴了整篇文章」这种输入会白白跑一遍完整编码，把主线程占住几百毫秒。
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > MAX_BYTE_LENGTH) {
    return { ok: false, reason: 'OVERFLOW', bytes };
  }

  try {
    // 版本号传 0 表示由库自动选择可容纳内容的最小版本（1..40）
    const qr = vendor(0, ecc);
    qr.addData(value); // 缺省模式为 Byte，配合上面切换后的 UTF-8 编码函数
    qr.make();

    const count = qr.getModuleCount();
    return {
      ok: true,
      count,
      version: (count - 17) / 4, // 模块数 = 4 × 版本 + 17
      bytes,
      ecc,
      isDark: (row, col) => qr.isDark(row, col),
    };
  } catch (error) {
    // 内容超过当前纠错级别在版本 40 的容量时库会抛 'code length overflow.'
    const message = String(error?.message || error);
    return { ok: false, reason: /overflow/i.test(message) ? 'OVERFLOW' : 'ENCODE_FAILED', message };
  }
}

/**
 * 把矩阵画进预览用的 canvas。
 * 按设备像素比放大后备存储，并用 round 取整模块边界：
 * 模块边缘落在整数像素上，缩放后不会出现灰色接缝。
 */
export function drawQrToCanvas(canvas, qr, { size = 220 } = {}) {
  const ratio = Math.min(3, Math.max(1, globalThis.devicePixelRatio || 1));
  const backing = Math.round(size * ratio);
  const total = qr.count + QUIET_ZONE * 2;

  canvas.width = backing;
  canvas.height = backing;

  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, backing, backing);
  context.fillStyle = '#000000';

  const unit = backing / total;
  for (let row = 0; row < qr.count; row += 1) {
    for (let col = 0; col < qr.count; col += 1) {
      if (!qr.isDark(row, col)) continue;
      const x0 = Math.round((col + QUIET_ZONE) * unit);
      const y0 = Math.round((row + QUIET_ZONE) * unit);
      const x1 = Math.round((col + QUIET_ZONE + 1) * unit);
      const y1 = Math.round((row + QUIET_ZONE + 1) * unit);
      context.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  }

  return canvas;
}

/**
 * 推导导出图的几何参数。
 *
 * 模块必须是整数像素，否则缩放后模块边缘落在半像素上会出现灰边、影响识别，
 * 所以真实边长只能是「模块尺寸 × 总模块数」的整数倍，**并不等于用户选的目标尺寸**。
 * 版本 40（总模块数 185）选 512 px 时，一行只能放下 2 px/模块，实际导出 370×370 ——
 * 差了 28%。把这个换算抽出来，是为了让调用方能如实把真实边长回显给用户，
 * 而不是让「512 px」这个标签撒谎。
 */
function exportMetrics(qr, targetSize) {
  const total = qr.count + QUIET_ZONE * 2;
  const unit = Math.max(1, Math.floor(targetSize / total));
  return { total, unit, edge: unit * total };
}

/** 目标尺寸下真实的导出边长（像素），供界面回显。 */
export function exportEdgeOf(qr, targetSize = 1024) {
  return exportMetrics(qr, targetSize).edge;
}

function renderExportCanvas(qr, targetSize) {
  const { total, unit, edge } = exportMetrics(qr, targetSize);

  const canvas = document.createElement('canvas');
  canvas.width = edge;
  canvas.height = edge;

  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, edge, edge);
  context.fillStyle = '#000000';

  for (let row = 0; row < qr.count; row += 1) {
    for (let col = 0; col < qr.count; col += 1) {
      if (!qr.isDark(row, col)) continue;
      context.fillRect((col + QUIET_ZONE) * unit, (row + QUIET_ZONE) * unit, unit, unit);
    }
  }

  return canvas;
}

export function toPngBlob(qr, targetSize = 1024) {
  const canvas = renderExportCanvas(qr, targetSize);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas 导出 PNG 失败'))), 'image/png');
  });
}

export function toPngDataUrl(qr, targetSize = 1024) {
  return renderExportCanvas(qr, targetSize).toDataURL('image/png');
}

/**
 * 复制二维码图片到剪贴板。
 *
 * 直接把「生成 blob 的 Promise」交给 ClipboardItem，而不是先 await 再写：
 * clipboard.write() 仍留在点击事件的同步调用栈里，浏览器才不会判定用户手势已过期。
 */
export function copyQrImage(qr, targetSize = 1024) {
  return navigator.clipboard.write([new ClipboardItem({ 'image/png': toPngBlob(qr, targetSize) })]);
}

export function buildQrFilename(prefix = 'qrcode') {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}-${stamp}.png`;
}

/**
 * 存到浏览器默认下载目录。
 *
 * 用 data URL 而不是 blob URL：blob URL 的生命周期绑定在创建它的文档上，
 * 面板窗口一关链接就失效，下载管理器可能取不到数据；data URL 自包含，可以独立完成取数。
 * filename 不写子目录，直接落到下载文件夹根目录；conflictAction 用 uniquify 避免覆盖同名文件。
 */
export async function downloadQrImage(qr, targetSize = 1024) {
  const filename = buildQrFilename();
  const dataUrl = toPngDataUrl(qr, targetSize);
  const edge = exportEdgeOf(qr, targetSize);

  if (globalThis.chrome?.downloads?.download) {
    try {
      const id = await chrome.downloads.download({
        url: dataUrl,
        filename,
        conflictAction: 'uniquify',
        saveAs: false,
      });
      return { ok: true, filename, edge, id };
    } catch (error) {
      // 未授予 downloads 权限时落到锚点下载
    }
  }

  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  link.click();
  return { ok: true, filename, edge, fallback: true };
}
