// 校验 CSP 的 script-src sha256 与 index.html 内联引导脚本一致（npm run csp:check）。
// 内联脚本 <script> 与 </script> 之间的每一个字节都算进哈希，所以这个脚本同时保证：
//   1) public/_headers 里的 sha256 与源码一致；
//   2) 构建产物 dist/index.html 里的内联脚本没有被 Vite 改写过（改写了哈希就失效，页面直接不跑）。
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8').replace(/\r\n/g, '\n');

function inlineScripts(html, label) {
  const list = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .filter(m => m[1].trim().length > 0)
    .map(m => m[1]);
  if (list.length !== 1) {
    throw new Error(`${label}: 期望恰好 1 段内联脚本，实际 ${list.length} 段`);
  }
  return list;
}

const b64 = (text) => createHash('sha256').update(text, 'utf8').digest('base64');

const src = inlineScripts(read('index.html'), 'index.html')[0];
const hash = b64(src);
console.log('inline bootstrap sha256 =', hash);

const headersPath = 'public/_headers';
const headers = read(headersPath);
const declared = [...headers.matchAll(/sha256-([A-Za-z0-9+/=]+)/g)].map(m => m[1]);
if (declared.length === 0) throw new Error(`${headersPath}: script-src 里没有 sha256-… —— 内联脚本会被 CSP 拦掉`);
if (!declared.includes(hash)) {
  throw new Error(`${headersPath}: 声明的 sha256 (${declared.join(', ')}) 与 index.html 实际内容 (${hash}) 不一致`);
}
if (!/script-src[^;\n]*'self'/.test(headers)) {
  throw new Error(`${headersPath}: script-src 缺少 'self'`);
}
if (/script-src[^;\n]*'unsafe-inline'/.test(headers)) {
  throw new Error(`${headersPath}: script-src 不允许 'unsafe-inline'（那样哈希白算了）`);
}
console.log('_headers OK');

if (existsSync(resolve(root, 'dist/index.html'))) {
  const built = inlineScripts(read('dist/index.html'), 'dist/index.html')[0];
  if (built !== src) throw new Error('dist/index.html 的内联脚本与源码不一致，CSP 哈希会失效');
  console.log('dist/index.html OK（内联脚本逐字节一致）');
} else {
  console.log('dist/ 不存在，跳过构建产物比对（build 之后可再跑一次）');
}