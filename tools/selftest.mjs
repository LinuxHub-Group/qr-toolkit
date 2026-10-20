/**
 * 无浏览器自检：验证「生成矩阵 → 栅格化成位图 → 识别还原」这条闭环是否真的通。
 *
 * qrcode-generator 与 jsQR 都是纯 JS、不依赖 DOM，所以可以直接在 Node 里跑，
 * 不必等到装进浏览器才发现编码或调用签名不对。
 * 覆盖点：中文 UTF-8 往返、自动版本选择、jsQR 的入参形状与返回结构。
 *
 * 用法：node tools/selftest.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 用最小可用全局对象执行经典脚本：两个库都不碰 DOM，缺的东西按需补齐即可。 */
function loadScript(relativePath) {
  const context = vm.createContext({
    console,
    TextEncoder,
    Uint8Array,
    Uint8ClampedArray,
    Math,
    JSON,
    Date,
    RegExp,
    Number,
    String,
    Array,
    Object,
    Error,
    TypeError,
    isNaN,
    parseInt,
    parseFloat,
  });
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  vm.runInContext(source, context, { filename: relativePath });
  return context;
}

/** 把模块矩阵栅格化成 jsQR 需要的 RGBA 位图（含静默区）。 */
function rasterize(qr, { scale = 8, quiet = 4 } = {}) {
  const count = qr.getModuleCount();
  const edge = (count + quiet * 2) * scale;
  const data = new Uint8ClampedArray(edge * edge * 4).fill(255);

  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!qr.isDark(row, col)) continue;
      for (let y = 0; y < scale; y += 1) {
        for (let x = 0; x < scale; x += 1) {
          const px = (col + quiet) * scale + x;
          const py = (row + quiet) * scale + y;
          const offset = (py * edge + px) * 4;
          data[offset] = 0;
          data[offset + 1] = 0;
          data[offset + 2] = 0;
          data[offset + 3] = 255;
        }
      }
    }
  }

  return { data, width: edge, height: edge };
}

const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const generator = loadScript('src/vendor/qrcode-generator.js');
const decoder = loadScript('src/vendor/jsQR.js');

const qrcode = generator.qrcode;
check('vendor/qrcode-generator.js 暴露全局 qrcode', typeof qrcode === 'function');

check(
  'vendor/qrcode-generator.js 带 UTF-8 编码函数',
  typeof qrcode?.stringToBytesFuncs?.['UTF-8'] === 'function',
);

const jsQR = decoder.jsQR;
check('vendor/jsQR.js 暴露全局 jsQR', typeof jsQR === 'function');

if (typeof qrcode === 'function' && typeof jsQR === 'function') {
  // 与 qr.js 保持一致：中文必须走 UTF-8，否则会被 Latin-1 截断
  qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];

  const cases = [
    ['纯英文链接', 'https://example.com/order?id=8801'],
    ['中文文本', '二维码工具箱：这是一段用于验证 UTF-8 往返的中文。'],
    ['中英混排 + 符号', 'QR Toolkit / 二维码工具箱 — 测试 #15 & "quoted"'],
  ];

  for (const [label, text] of cases) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();

    const count = qr.getModuleCount();
    const version = (count - 17) / 4;
    check(`${label}：版本号换算是整数`, Number.isInteger(version), `v${version} / ${count}×${count}`);

    const image = rasterize(qr);
    const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
    check(`${label}：jsQR 还原内容一致`, code?.data === text, code ? '往返成功' : '未识别到二维码');
  }

  // 容量边界：超长内容应当抛错而不是产出坏码
  let overflowed = false;
  try {
    const qr = qrcode(0, 'L');
    qr.addData('x'.repeat(5000));
    qr.make();
  } catch {
    overflowed = true;
  }
  check('超容量内容抛错（对应 qr.js 的 OVERFLOW 分支）', overflowed);
}

const failed = results.filter((item) => !item.passed);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
