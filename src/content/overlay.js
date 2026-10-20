/**
 * 悬浮层宿主脚本。
 *
 * 由 chrome.scripting.executeScript({ files }) 注入到目标页面的 ISOLATED world，
 * 注入后挂一个 __QR_TOOLKIT__ 到该 world 的全局对象上，再由第二次注入的 func 调 mount()。
 *
 * 为什么必须自包含：files 注入只支持经典脚本（不支持 ESM），且注入后是独立执行上下文，
 * 无法 import 模块。因此下面这份常量是从 src/common/protocol.js 抄过来的，
 * 改动任何一个是字符串时，两处都要同步。
 *
 * 为什么 UI 放在 iframe 里，而不是直接在页面 DOM 里搭：
 *   1. 扩展页面拥有完整权限 —— chrome.downloads、安全上下文里的 navigator.clipboard、
 *      chrome.permissions 按需授权；这些在内容脚本里都拿不到或被降级；
 *   2. iframe 自带样式隔离，页面 CSS 进不来，面板不必对抗页面样式；
 *   3. 扩展页面有自己独立的 CSP，不受页面 style-src 约束 ——
 *      而在页面里创建 <style> 元素、写 style 属性都会被页面的 style-src 拦掉。
 *
 * 宿主自身的定位样式全部走 CSSOM（element.style.setProperty）：
 * CSSOM 赋值不属于 inline style 解析，因此不受页面 CSP 的 style-src 约束。
 */

(function () {
  'use strict';

  // 已经是第二次注入了：只做初始化一次，否则会重复注册全局监听器
  if (globalThis.__QR_TOOLKIT__) return;

  const HOST_ID = 'qr-toolkit-overlay-host';
  const EXTENSION_ORIGIN = `chrome-extension://${chrome.runtime.id}`;

  // 与 src/common/protocol.js 保持一致
  const MSG = {
    HEIGHT: 'qk:height',
    CLOSE: 'qk:close',
    DRAG_START: 'qk:drag-start',
  };
  const SETTINGS_KEY = 'overlay:closeOnOutsideClick';

  const PANEL_WIDTH = 380;
  const PANEL_MIN_HEIGHT = 160;
  const VIEWPORT_MARGIN = 16;
  const Z_INDEX = '2147483647';

  let state = null;

  function mount(token) {
    unmount();

    const host = document.createElement('div');
    host.id = HOST_ID;
    applyHostStyle(host);

    // Shadow DOM 只为隔离：页面 CSS 选择器穿透不了 shadow 边界。
    // 这里不往 shadow 里放任何样式表 —— shadow 内部样式无法被文档级规则命中，
    // 而 <style> 元素又会被页面 CSP 拦掉，所以内部元素样式一律用 CSSOM 逐个设。
    const shadow = host.attachShadow({ mode: 'open' });
    const iframe = document.createElement('iframe');
    iframe.setAttribute('title', '二维码工具箱');
    // 声明式请求剪贴板写权限的委派；页面若在 Permissions-Policy 里收紧，仍有扩展权限兜底
    iframe.setAttribute('allow', 'clipboard-write');
    applyFrameStyle(iframe);
    iframe.src = `${chrome.runtime.getURL('src/panel/panel.html')}#token=${encodeURIComponent(token)}`;

    shadow.appendChild(iframe);
    document.documentElement.appendChild(host);

    state = {
      host,
      iframe,
      loaded: false,
      closeOnOutsideClick: true,
      drag: null,
      contentHeight: PANEL_MIN_HEIGHT,
      loadTimer: 0,
    };

    // 把本次实例钉住：下面所有异步回调都要先确认 state 还是自己，
    // 否则「上一个实例的定时器/加载事件」会作用到新实例上（见下面 loadTimer 的说明）。
    const instance = state;

    // 安全网：极少数页面会用 frame-src 'none' 之类的策略挡住扩展 iframe。
    // 超时未等到 load 就把内容换成可读提示，而不是留一个空白方框让人无从判断；
    // 此时 Esc 与「点击外部关闭」仍然可用，用户不会被卡住。
    //
    // 定时器必须挂在实例上并在 unmount 时清掉：它是 mount 的局部变量时，
    // 快速连开两次（unmount → 再次 mount）会让旧定时器在 3 秒后打到新实例上，
    // 把正在正常加载的新面板替换成「CSP 禁止嵌入」的错误提示。
    instance.loadTimer = setTimeout(() => {
      if (state !== instance || instance.loaded) return;
      showFrameLoadFailure();
    }, 3000);
    iframe.addEventListener('load', () => {
      if (state !== instance) return;
      instance.loaded = true;
      clearTimeout(instance.loadTimer);
      instance.loadTimer = 0;
    });

    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    document.addEventListener('keydown', onDocumentKeyDown, true);
    window.addEventListener('message', onWindowMessage);
    window.addEventListener('resize', onViewportResize);

    loadSettings(instance);
    return true;
  }

  function unmount() {
    if (!state) return;

    clearTimeout(state.loadTimer);
    document.removeEventListener('pointerdown', onDocumentPointerDown, true);
    document.removeEventListener('keydown', onDocumentKeyDown, true);
    window.removeEventListener('message', onWindowMessage);
    window.removeEventListener('resize', onViewportResize);
    endDrag();

    state.host.remove();
    state = null;
  }

  /* ── iframe 加载失败时的降级提示 ────────────────────────── */

  function showFrameLoadFailure() {
    if (!state?.iframe) return;

    const notice = document.createElement('div');
    notice.setAttribute('role', 'alert');
    // 面板内容本身在 iframe 里，这里的提示位于宿主 shadow 内，
    // 文档级样式穿不进来，所以逐条用 CSSOM 设置
    const style = notice.style;
    style.setProperty('all', 'initial', 'important');
    style.setProperty('display', 'block', 'important');
    style.setProperty('box-sizing', 'border-box', 'important');
    style.setProperty('height', '100%', 'important');
    style.setProperty('padding', '14px', 'important');
    style.setProperty('border-radius', '14px', 'important');
    style.setProperty('background', '#ffffff', 'important');
    style.setProperty('color', '#12161c', 'important');
    style.setProperty('font', '13px/1.6 system-ui, "Microsoft YaHei", sans-serif', 'important');
    notice.textContent =
      '面板未能加载：该页面的内容安全策略可能禁止嵌入扩展页面。按 Esc 或点击本提示框以外的区域可关闭。';

    state.iframe.replaceWith(notice);
    state.iframe = null;
  }

  /* ── 与面板 iframe 的通信 ───────────────────────────────── */

  function onWindowMessage(event) {
    if (!state) return;

    // 必须同时校验 origin 与 source。
    // 面板用 postMessage 的 targetOrigin 只能是 '*'（父窗口是任意站点，无法预知其 origin），
    // 这就意味着页面自己也拿得到并伪造这些消息 —— 不校验来源等于把开关和关闭的控制权交给被访问的页面。
    if (event.origin !== EXTENSION_ORIGIN) return;
    if (!state.iframe || event.source !== state.iframe.contentWindow) return;

    const data = event.data;
    if (!data || typeof data.type !== 'string') return;

    if (data.type === MSG.CLOSE) {
      unmount();
      return;
    }
    if (data.type === MSG.DRAG_START) {
      beginDrag(data.clientX, data.clientY);
      return;
    }
    if (data.type === MSG.HEIGHT) {
      setFrameHeight(Number(data.value) || PANEL_MIN_HEIGHT);
    }
  }

  /* ── 关闭行为 ───────────────────────────────────────────── */

  function onDocumentPointerDown(event) {
    if (!state || state.drag) return;
    if (!state.closeOnOutsideClick) return;

    // 用 composedPath 而不是 host.contains：
    // 命中 shadow 内部元素时 contains 不穿透边界会返回 false，会被误判成「点在浮层外」。
    if (event.composedPath().includes(state.host)) return;
    unmount();
  }

  function onDocumentKeyDown(event) {
    if (!state) return;
    if (event.key === 'Escape') unmount();
  }

  /* ── 尺寸与位置 ─────────────────────────────────────────── */

  function setFrameHeight(contentHeight) {
    if (!state) return;
    state.contentHeight = contentHeight;

    // 高度上限跟着视口走：面板再高也不该盖满整屏导致无法操作页面
    const maxHeight = Math.max(PANEL_MIN_HEIGHT, window.innerHeight - VIEWPORT_MARGIN * 2);
    const height = Math.min(Math.max(PANEL_MIN_HEIGHT, contentHeight), maxHeight);
    state.host.style.setProperty('height', `${Math.round(height)}px`, 'important');
  }

  function setHostPosition(left, top) {
    if (!state) return;
    const rect = state.host.getBoundingClientRect();

    // 夹在视口内：拖出屏幕外就再也拖不回来了
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.width - VIEWPORT_MARGIN);
    const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.height - VIEWPORT_MARGIN);
    const x = Math.min(Math.max(VIEWPORT_MARGIN, left), maxLeft);
    const y = Math.min(Math.max(VIEWPORT_MARGIN, top), maxTop);

    state.host.style.setProperty('left', `${Math.round(x)}px`, 'important');
    state.host.style.setProperty('top', `${Math.round(y)}px`, 'important');
    state.host.style.setProperty('right', 'auto', 'important');
  }

  function onViewportResize() {
    if (!state) return;
    const rect = state.host.getBoundingClientRect();
    setFrameHeight(state.contentHeight);
    setHostPosition(rect.left, rect.top);
  }

  /* ── 拖动 ───────────────────────────────────────────────── */

  function beginDrag(clientX, clientY) {
    if (!state || state.drag) return;

    const rect = state.host.getBoundingClientRect();
    state.drag = {
      // iframe 内的 clientX/Y 是相对 iframe 视口的，换算到顶层视口要加上 iframe 的位置
      pointerX: rect.left + clientX,
      pointerY: rect.top + clientY,
      originLeft: rect.left,
      originTop: rect.top,
    };

    // 拖动期间让 iframe 不再接收指针事件：
    // 否则鼠标一旦移到 iframe 上，pointermove 全被 iframe 文档吃掉，父文档收不到，拖动会卡住。
    if (state.iframe) state.iframe.style.setProperty('pointer-events', 'none', 'important');
    window.addEventListener('pointermove', onDragMove, true);
    window.addEventListener('pointerup', endDrag, true);
    window.addEventListener('pointercancel', endDrag, true);
  }

  function onDragMove(event) {
    if (!state?.drag) return;
    setHostPosition(
      state.drag.originLeft + (event.clientX - state.drag.pointerX),
      state.drag.originTop + (event.clientY - state.drag.pointerY),
    );
  }

  function endDrag() {
    if (!state) return;
    state.drag = null;
    if (state.iframe) state.iframe.style.removeProperty('pointer-events');
    window.removeEventListener('pointermove', onDragMove, true);
    window.removeEventListener('pointerup', endDrag, true);
    window.removeEventListener('pointercancel', endDrag, true);
  }

  /* ── 偏好设置 ───────────────────────────────────────────── */

  async function loadSettings(instance) {
    try {
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      const value = stored?.[SETTINGS_KEY];
      // 读取期间浮层可能已被关闭或重建，只写回发起读取的那个实例
      if (state === instance && typeof value === 'boolean') instance.closeOnOutsideClick = value;
    } catch (error) {
      // 读取失败就沿用默认值「点击外部关闭」，不影响浮层可用性
    }
  }

  // 只注册一次：这段脚本虽然会被重复注入，但上面的守卫保证整个初始化只走一次
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !state) return;
    const value = changes[SETTINGS_KEY]?.newValue;
    if (typeof value === 'boolean') state.closeOnOutsideClick = value;
  });

  /* ── 样式（全部走 CSSOM，规避页面 CSP 的 style-src） ────── */

  function applyHostStyle(host) {
    const style = host.style;
    // all: initial 先清掉页面可能继承下来的属性，再逐条设上需要的值。
    // 统一带 !important：inline !important 的优先级高于页面任何选择器，
    // 而宿主 id 是固定的唯一值，页面几乎不可能有意命中它。
    style.setProperty('all', 'initial', 'important');
    style.setProperty('position', 'fixed', 'important');
    style.setProperty('top', `${VIEWPORT_MARGIN}px`, 'important');
    style.setProperty('right', `${VIEWPORT_MARGIN}px`, 'important');
    style.setProperty('width', `${PANEL_WIDTH}px`, 'important');
    style.setProperty('height', `${PANEL_MIN_HEIGHT}px`, 'important');
    style.setProperty('z-index', Z_INDEX, 'important');
    style.setProperty('display', 'block', 'important');
    style.setProperty('margin', '0', 'important');
    style.setProperty('padding', '0', 'important');
    style.setProperty('border', '0', 'important');
    style.setProperty('background', 'transparent', 'important');
    style.setProperty('transform', 'none', 'important');
    style.setProperty('filter', 'none', 'important');
    style.setProperty('opacity', '1', 'important');
    style.setProperty('visibility', 'visible', 'important');
    style.setProperty('pointer-events', 'auto', 'important');
  }

  function applyFrameStyle(iframe) {
    const style = iframe.style;
    style.setProperty('all', 'initial', 'important');
    style.setProperty('display', 'block', 'important');
    style.setProperty('width', '100%', 'important');
    style.setProperty('height', '100%', 'important');
    style.setProperty('margin', '0', 'important');
    style.setProperty('padding', '0', 'important');
    style.setProperty('border', '0', 'important');
    style.setProperty('overflow', 'hidden', 'important');
    style.setProperty('background', 'transparent', 'important');
    // 圆角与投影必须落在 iframe 元素上：
    // iframe 是独立文档，在它内部画投影会被文档边界裁掉；
    // 而给 iframe 加圆角会顺带把内部内容裁成同样形状。
    style.setProperty('border-radius', '14px', 'important');
    style.setProperty('box-shadow', '0 12px 40px rgb(0 0 0 / 28%)', 'important');
    style.setProperty('color-scheme', 'normal', 'important');
  }

  globalThis.__QR_TOOLKIT__ = { mount, unmount, isMounted: () => Boolean(state) };
})();
