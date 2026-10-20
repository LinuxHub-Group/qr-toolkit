/**
 * service worker 与面板页属于两个独立的执行上下文，没有共享的运行时变量。
 * 这里集中声明菜单 id、页面路径与存储键，避免两侧各写一份字符串后悄悄漂移。
 */

export const MENU_TEXT = 'qk-text-to-qr';
export const MENU_DECODE = 'qk-decode-image';

export const PANEL_PAGE = 'src/panel/panel.html';

/**
 * 注入到宿主页面的悬浮层宿主脚本。
 *
 * executeScript 的 files 只能注入经典脚本（不支持 ESM），注入后又是独立执行、
 * 无法 import 模块，所以 overlay.js 必须自包含。它内部重复定义了一份消息常量
 * （MSG）与存储键 —— 改动下面这些字符串时必须同步 src/content/overlay.js。
 */
export const OVERLAY_FILES = ['src/content/overlay.js'];

/**
 * chrome.storage.session 的键前缀。
 * 每次唤起面板都生成一次性 token 并写进 iframe 的 URL hash，面板取完即删：
 * 这样同时开多个浮层也不会互相读到对方的数据，选中内容也不会长期驻留。
 */
export const PAYLOAD_KEY_PREFIX = 'payload:';

/** 悬浮层宿主与面板 iframe 之间的 postMessage 协议。 */
export const OVERLAY_MSG = {
  HEIGHT: 'qk:height',
  CLOSE: 'qk:close',
  DRAG_START: 'qk:drag-start',
};

/**
 * 「点击浮层外部是否关闭」的偏好。
 * 面板 iframe 负责写入，宿主脚本只负责读取与监听变更：
 * 单一写入点，避免两边同时写造成状态互相覆盖。
 */
export const SETTINGS_KEY = 'overlay:closeOnOutsideClick';

/** 设置项的默认值：默认开启点击外部关闭，符合悬浮窗的一般预期。 */
export const DEFAULT_CLOSE_ON_OUTSIDE_CLICK = true;
