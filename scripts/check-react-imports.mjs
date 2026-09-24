// 静态守卫：用了 React 的 API 却没 import。
// 为什么需要它：Vite/esbuild 打包时不解析模块作用域，漏 import 的标识符会被原样留在产物里，
// 于是 dev 服务器可能照常跑（HMR 缓存、旧闭包），线上一挂载就 ReferenceError → 白屏，
// 而且 CSP 和构建都不会报警。真实事故：useBookTransfer.js 用 useCallback 忘了 import。
// 用法： node scripts/check-react-imports.mjs   （非 0 退出码即失败）
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

// 只查这些「从 react 包具名导入」的标识符：漏一个就是运行时 ReferenceError。
const REACT_NAMES = [
  'useState', 'useEffect', 'useLayoutEffect', 'useMemo', 'useCallback', 'useRef',
  'useContext', 'useReducer', 'useId', 'useTransition', 'useDeferredValue', 'useSyncExternalStore',
  'createContext', 'createRef', 'forwardRef', 'memo', 'lazy', 'Suspense', 'Component',
  'PureComponent', 'Fragment', 'StrictMode', 'startTransition', 'act',
];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(js|jsx)$/.test(name) ? [full] : [];
  });
}

// 把 import 语句（含多行）从正文里剥出来，两边分开判定
function split(src) {
  const lines = src.split(/\r?\n/);
  const importLines = [];
  const bodyLines = [];
  let buf = null;
  const done = (line) => /['"]\s*;?\s*$/.test(line) || /;\s*$/.test(line);
  for (const line of lines) {
    if (buf) {
      buf.push(line);
      if (done(line)) { importLines.push(buf.join('\n')); buf = null; }
      continue;
    }
    if (/^\s*import[\s{*'"(]/.test(line)) {
      if (done(line)) importLines.push(line);
      else buf = [line];
      continue;
    }
    bodyLines.push(line);
  }
  if (buf) importLines.push(buf.join('\n'));
  return { imports: importLines.join('\n'), body: bodyLines.join('\n') };
}

let problems = 0;
let checked = 0;
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file).split(/[\\/]/).join('/');
  const src = readFileSync(file, 'utf8');
  const { imports, body } = split(src);
  checked++;
  for (const name of REACT_NAMES) {
    // 正文里以「调用 / JSX / 成员」形式出现，且前面不是点号（排除 obj.useState）
    const used = new RegExp('(?<![\\w$.])' + name + '\\s*(?:[(<.]|\\b=)', 'm').test(body);
    if (!used) continue;
    // 本文件自己声明过（罕见，但别误报）
    if (new RegExp('(?:const|let|var|function|class)\\s+' + name + '\\b', 'm').test(body)) continue;
    const imported = new RegExp('[\\{,\\s(]' + name + '\\s*(?:[,}]|\\bin\\b|\\bas\\b|\\))', 'm').test(imports)
      || new RegExp('^\\s*import\\s+' + name + '\\b', 'm').test(imports)
      || new RegExp('\\b' + name + '\\s+as\\s+\\w+', 'm').test(imports);
    if (imported) continue;
    console.log('  ✗ ' + rel + '：用了 ' + name + ' 但没有 import ' + name);
    problems++;
  }
}

if (problems) {
  console.log('React import 检查失败：' + problems + ' 处漏导入（' + checked + ' 个文件）');
  process.exit(1);
}
console.log('✓ React import 检查通过：' + checked + ' 个文件，' + REACT_NAMES.length + ' 个具名 API 无漏导入');