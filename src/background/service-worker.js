import {
  MENU_TEXT,
  MENU_DECODE,
  PANEL_PAGE,
  PAYLOAD_KEY_PREFIX,
  OVERLAY_FILES,
} from '../common/protocol.js';

/**
 * 选中文字进载荷前的字符上限。
 *
 * 二维码本身最多装 2953 字节，这里留的余量足够覆盖「整段文章」这类误操作，
 * 同时避免把几 MB 的字符串写进 storage.session、再灌进面板的 textarea。
 */
const MAX_SELECTION_CHARS = 100_000;

function clipText(value) {
  if (typeof value !== 'string') return '';
  return value.length > MAX_SELECTION_CHARS ? value.slice(0, MAX_SELECTION_CHARS) : value;
}

chrome.runtime.onInstalled.addListener(() => {
  // 先 removeAll 再 create：重新加载扩展时旧菜单项仍挂在浏览器上，
  // 直接 create 同一个 id 会抛 "Cannot create item with duplicate id"。
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_TEXT,
      title: '为选中文字生成二维码',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: MENU_DECODE,
      title: '解码二维码 / 条码',
      contexts: ['image'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const tabId = tab?.id;
  if (tabId == null) return;

  if (info.menuItemId === MENU_TEXT) {
    showOverlay(tabId, {
      mode: 'text',
      text: clipText(info.selectionText),
      pageUrl: info.pageUrl || '',
      tabId,
    });
    return;
  }

  if (info.menuItemId === MENU_DECODE) {
    showOverlay(tabId, {
      mode: 'image',
      srcUrl: info.srcUrl || '',
      pageUrl: info.pageUrl || '',
      tabId,
    });
  }
});

// 不声明 action.default_popup 才能收到这个事件；工具栏图标与右键菜单走同一条唤起逻辑。
chrome.action.onClicked.addListener((tab) => {
  if (tab?.id == null) return;
  showOverlay(tab.id, { mode: 'text', text: '', pageUrl: tab.url || '', tabId: tab.id });
});

/**
 * 在当前标签页里唤起悬浮层。
 *
 * 载荷不放在内存里：MV3 的 service worker 随时可能被回收，内存变量保不住。
 * 也不用 chrome.storage.local：那是落盘存储，选中的文字没必要写进磁盘。
 * chrome.storage.session 只活在本次浏览器会话中，正好匹配这个生命周期。
 *
 * 两条失败路径分开处理，因为它们能做的事不一样：
 *   - 载荷写不进去 → 后续步骤都没有意义（面板打开了也是空的），只记日志并返回；
 *   - 注入被页面拒绝 → 载荷仍在，可以退回「新标签页打开面板」。
 * 这两步都必须留在这里的 try/catch 内：调用方（菜单/图标监听器）既没有 await
 * 也没有 catch，任何漏出去的 rejection 都表现为「点了完全没反应」。
 */
async function showOverlay(tabId, payload) {
  const token = crypto.randomUUID();

  try {
    await chrome.storage.session.set({ [PAYLOAD_KEY_PREFIX + token]: payload });
  } catch (error) {
    console.error('[二维码工具箱] 载荷写入失败，本次唤起已放弃', error);
    return;
  }

  try {
    // 分两次注入：executeScript 不允许同时指定 files 与 func，
    // 而 token 只能通过 func 的 args 传进去。
    // 第一次注入宿主脚本（脚本自带幂等守卫，重复注入只初始化一次），
    // 第二次把 token 交给它挂载。
    await chrome.scripting.executeScript({ target: { tabId }, files: OVERLAY_FILES });

    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (value) => Boolean(globalThis.__QR_TOOLKIT__?.mount(value)),
      args: [token],
    });

    if (!result?.result) throw new Error('悬浮层宿主未就绪');
  } catch (error) {
    // chrome:// 页面、扩展商店页、PDF 阅读器等场景不允许脚本注入。
    // 这是异常兜底而非常规形态：改用标签页打开面板，至少让功能不至于完全不可用。
    console.warn('[二维码工具箱] 悬浮层注入失败，回退为标签页', error);
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL(`${PANEL_PAGE}#token=${token}`) });
    } catch (fallbackError) {
      console.error('[二维码工具箱] 兜底标签页也未能打开', fallbackError);
    }
  }
}

/*
 * 这里没有 tabs 权限：chrome.tabs.create 不需要它，
 * 而「图片所在页面」的 URL 取自上下文菜单回调里的 info.pageUrl（该字段始终可用），
 * 不必去读 tab.url —— 读它才需要 tabs 权限。
 *
 * 这里也没有安装期 host_permissions：注入悬浮层走 activeTab
 * （上下文菜单点击与点击工具栏图标都会授予），只有跨域图片确实读不到像素时，
 * 才由用户在面板里显式授权单个站点。
 */
