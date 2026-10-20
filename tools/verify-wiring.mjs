/**
 * 一致性校验：跨文件引用的 id、常量、资源路径是否对得上。
 *
 * 这些错误在浏览器里表现为「点了没反应」或「某个按钮静默失效」，
 * 排查成本远高于跑一次脚本，所以放进自检。
 *
 * 用法：node tools/verify-wiring.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(root, relative));

const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/* manifest 里声明的资源是否都存在 */
const manifest = JSON.parse(read('manifest.json'));
const declared = [
  manifest.background.service_worker,
  ...Object.values(manifest.icons),
  ...manifest.web_accessible_resources.flatMap((entry) => entry.resources),
];
const missing = declared.filter((item) => !exists(item));
check('manifest 声明的资源全部存在', missing.length === 0, missing.join(', ') || `${declared.length} 项`);

/* panel.html 的本地引用是否都存在 */
const html = read('src/panel/panel.html');
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
const brokenRefs = refs.filter((ref) => !exists(path.join('src/panel', ref)));
check('panel.html 的本地引用全部存在', brokenRefs.length === 0, brokenRefs.join(', ') || `${refs.length} 项`);

/* panel.js 里取用的元素 id 必须在 panel.html 中存在 */
const panelJs = read('src/panel/panel.js');
const usedIds = [...panelJs.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]);
const declaredIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
const danglingIds = [...new Set(usedIds)].filter((id) => !declaredIds.has(id));
check('panel.js 引用的元素 id 都存在', danglingIds.length === 0, danglingIds.join(', ') || `${usedIds.length} 处`);

/* panel.html 里绑定的 id 没有被引用（提示冗余，不阻断） */
const panelCss = read('src/panel/panel.css');
const unusedIds = [...declaredIds].filter(
  (id) => !panelJs.includes(id) && !panelCss.includes(id),
);
check('panel.html 未出现无人引用的 id', unusedIds.length === 0, unusedIds.join(', '));

/* overlay.js 是经典脚本、必须自包含：它抄了一份消息常量，这里校验两份没有漂移 */
const overlay = read('src/content/overlay.js');
const protocol = read('src/common/protocol.js');
const msgValues = [...protocol.matchAll(/(?:HEIGHT|CLOSE|DRAG_START):\s*'([^']+)'/g)].map((m) => m[1]);
const overlayMissing = msgValues.filter((value) => !overlay.includes(`'${value}'`));
check(
  'overlay.js 与 protocol.js 的消息常量一致',
  msgValues.length === 3 && overlayMissing.length === 0,
  overlayMissing.join(', ') || msgValues.join(' / '),
);

const settingsKey = /SETTINGS_KEY\s*=\s*'([^']+)'/.exec(protocol)?.[1];
check(
  'overlay.js 与 protocol.js 的设置键一致',
  Boolean(settingsKey) && overlay.includes(`'${settingsKey}'`),
  settingsKey || '未取到',
);

/* 宿主的 postMessage 校验不能少：缺了它，被访问的页面就能伪造关闭/拖动指令 */
check('overlay.js 校验了消息来源 origin', overlay.includes('event.origin !== EXTENSION_ORIGIN'));
check('overlay.js 校验了消息来源 window', overlay.includes('event.source !== state.iframe.contentWindow'));

/* 加载超时定时器必须挂在实例上并在 unmount 时清掉，否则快速连开两次会误杀新面板 */
check(
  'overlay.js 的加载超时定时器随实例清理',
  overlay.includes('clearTimeout(state.loadTimer)') && overlay.includes('state !== instance'),
);

/* 悬浮层的每一次异步回调都要确认自己面对的还是当初那个实例 */
check('overlay.js 的异步回调做了实例比对', (overlay.match(/state !== instance/g) || []).length >= 2);

/* 打开外部链接的入口必须自带协议白名单，不能只靠上游分类 */
check(
  'panel.js 的 openTab 自带协议白名单',
  /function openTab\(url\) \{\s*\n\s*if \(!isHttpUrl\(url\)\) return;/.test(panelJs),
);

/* 授权前必须查一次「是不是早就授权过」：已授权还弹同一个按钮，用户会以为授权没生效 */
check('panel.js 主动查询已有主机权限', /chrome\.permissions\.contains/.test(panelJs));

/* 「只授权一次」= 一次性请求全部可选来源；这些来源必须都在 manifest 里声明过，
   否则 chrome.permissions.request 会直接抛「未在 optional_host_permissions 中声明」 */
const optionalOrigins = new Set(manifest.optional_host_permissions || []);
const declaredAll = [...(/ALL_ORIGINS = \[([^\]]+)\]/.exec(panelJs)?.[1] || '').matchAll(/'([^']+)'/g)].map(
  (match) => match[1],
);
check(
  '「允许所有网站」请求的来源已在 optional_host_permissions 中声明',
  declaredAll.length === 2 && declaredAll.every((origin) => optionalOrigins.has(origin)),
  declaredAll.join(', ') || '未取到',
);

/* 全站授权入口必须在面板里真的存在，否则那条路永远走不到 */
check('panel.html 提供「允许所有网站」入口', /id="grantAll"/.test(html) && /\$\('grantAll'\)/.test(panelJs));

/* 页面内取字节这一级：不需要任何主机权限就能覆盖同源图与 CORS 放行的图 */
const decodeJs = read('src/panel/decode.js');
check(
  'decode.js 提供页面内取字节的降级级',
  /function fetchImageInPage\(srcUrl\)/.test(decodeJs) && decodeJs.includes("'page-fetch'"),
);

/* 解码链路必须有输入体积上限，避免超大图把面板 OOM */
check(
  'decode.js 限制了解码输入体积',
  /MAX_IMAGE_BYTES/.test(read('src/panel/decode.js')) &&
    /blob\.size > MAX_IMAGE_BYTES/.test(read('src/panel/decode.js')),
);

/* 生成侧必须在调用库之前预检容量上界 */
check(
  'qr.js 在编码前预检容量上界',
  /MAX_BYTE_LENGTH/.test(read('src/panel/qr.js')) && /bytes > MAX_BYTE_LENGTH/.test(read('src/panel/qr.js')),
);

/* WAR 只该暴露面板入口：iframe 内部加载的 css/js 属于扩展页面同源请求，不需要声明。
   暴露面越大，任意站点能拿到的扩展指纹与其可拉取的体积就越大。 */
const warResources = (manifest.web_accessible_resources || []).flatMap((entry) => entry.resources);
check(
  'web_accessible_resources 只暴露面板入口',
  warResources.length === 1 && warResources[0] === 'src/panel/panel.html',
  warResources.join(', '),
);

/* 开源合规：自有许可、三方声明与正文许可文本都必须在仓库里 */
const licenseFiles = ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'LICENSES/Apache-2.0.txt', 'LICENSES/MIT-qrcode-generator.txt'];
const missingLicenses = licenseFiles.filter((file) => !exists(file));
check('许可文件齐备', missingLicenses.length === 0, missingLicenses.join(', ') || `${licenseFiles.length} 个`);

/* jsQR 是 Apache-2.0 的构建产物，原先被剥离了版权头，这条守住它不被再次冲掉 */
const jsQr = read('src/vendor/jsQR.js');
check(
  'jsQR 保留了归属与许可声明',
  jsQr.includes('Apache License, Version 2.0') && jsQr.includes('Cosmo Wolfe'),
);

/* 开源发布的仓库里不该留调试残留与本地路径 */
const strayFiles = ['.dsh-write-test.txt', 'tools/icon-preview.py'].filter((file) => exists(file));
check('无调试残留文件', strayFiles.length === 0, strayFiles.join(', '));

/* 悬浮层样式必须全部走 CSSOM：<style> 元素与 style 属性都会被页面 CSP 拦掉 */
const overlayStyleViolation = /setAttribute\(\s*'style'|createElement\(\s*'style'\s*\)/.test(overlay);
check('overlay.js 未使用会被 CSP 拦截的样式注入方式', !overlayStyleViolation);

/* 面板不得出现视口高度，否则与宿主调整 iframe 尺寸形成反馈。
   先剥掉注释再判断，避免把说明这条约束的注释本身当成违规。 */
const cssWithoutComments = panelCss.replace(/\/\*[\s\S]*?\*\//g, '');
check('panel.css 未使用视口高度', !/\d+vh\b/.test(cssWithoutComments));

/* firefox 的 browser.* 命名空间尚未适配，先确认没有混入 */
check('源码未混入 browser.* 调用', !['src/background/service-worker.js', 'src/panel/panel.js', 'src/content/overlay.js'].some((f) => /\bbrowser\./.test(read(f))));

/* ── 以下五条守住「开源前安全审计」里修复过的问题，防止被改回去 ── */

/* 扩展页 CSP 要有 default-src 兜底，但必须同时放行取图需要的 connect-src。
   写成裸的 default-src 'self' 会把第 4 级跨域取图和 blob: 缩略图一起打死 ——
   这条检查同时守住「别删」和「别删过头」两个方向。 */
const csp = manifest.content_security_policy?.extension_pages || '';
const connectSrc = /connect-src ([^;]+)/.exec(csp)?.[1] || '';
const imgSrc = /img-src ([^;]+)/.exec(csp)?.[1] || '';
check(
  '扩展页 CSP 有 default-src 兜底且未误伤取图链',
  /default-src 'self'/.test(csp) &&
    /object-src 'none'/.test(csp) &&
    connectSrc.includes('https:') &&
    connectSrc.includes('http:') &&
    imgSrc.includes('blob:'),
  connectSrc ? `connect-src ${connectSrc.trim()}` : '缺少 connect-src',
);

/* fetch 默认不超时。缺了 signal，图片服务器不响应时面板会永久停在「正在获取图片…」。
   Content-Length 预检是第二道：避免超大图先占满内存再被 size 闸门拒绝。 */
check(
  'decode.js 的网络取图带超时中止',
  /new AbortController\(\)/.test(decodeJs) &&
    /signal: controller\.signal/.test(decodeJs) &&
    /clearTimeout\(timer\)/.test(decodeJs),
);

check(
  'decode.js 在读取 body 前预检声明体积',
  /headers\.get\('content-length'\)/.test(decodeJs) && /MAX_IMAGE_BYTES/.test(decodeJs),
);

/* srcUrl 由被访问页面控制。跨站带 cookie 发 GET 等于把扩展变成 CSRF 跳板：
   页面自己发不出（同源策略拦着），扩展发得出。凭证必须按同源判定收敛。 */
check(
  'decode.js 不对页面可控的跨站地址携带 cookie',
  /isSameOrigin\(srcUrl, pageUrl\)/.test(decodeJs) &&
    !/tryFetchBlob\(srcUrl, \{ credentials: 'include' \}/.test(decodeJs),
);

/* 模块必须整数像素，真实边长未必等于下拉框目标值；不回显就是让「512 px」这个标签撒谎 */
check(
  '导出真实边长回显给用户',
  /export function exportEdgeOf/.test(read('src/panel/qr.js')) &&
    /exportEdgeOf/.test(panelJs) &&
    /result\.edge/.test(panelJs),
);

const failed = results.filter((item) => !item.passed);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
