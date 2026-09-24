// i18n 字典一致性检查：以 zh 为基准，校验 en / ja 键集合相同且无空值
// 用法：npm run i18n:check
import zh from '../src/i18n/locales/zh.js';
import en from '../src/i18n/locales/en.js';
import ja from '../src/i18n/locales/ja.js';

function flatten(obj, prefix, out) {
  Object.keys(obj).forEach((key) => {
    const path = prefix ? prefix + '.' + key : key;
    const value = obj[key];
    if (Array.isArray(value)) {
      if (value.length === 0) out.push([path, '<empty array>']);
      value.forEach((item, i) => out.push([path + '[' + i + ']', item]));
    } else if (value && typeof value === 'object') {
      flatten(value, path, out);
    } else {
      out.push([path, value]);
    }
  });
  return out;
}

function placeholderTokens(text) {
  const found = [];
  let rest = String(text);
  let guard = 0;
  while (rest.indexOf('{') !== -1 && guard < 50) {
    guard += 1;
    const start = rest.indexOf('{');
    const end = rest.indexOf('}', start);
    if (end === -1) break;
    found.push(rest.slice(start + 1, end));
    rest = rest.slice(end + 1);
  }
  return found.sort();
}

const problems = [];
const base = flatten(zh, '', []);
const baseKeys = base.map((entry) => entry[0]);
const baseMap = Object.fromEntries(base);

const dicts = { en, ja };
Object.keys(dicts).forEach((name) => {
  const flat = flatten(dicts[name], '', []);
  const keys = flat.map((entry) => entry[0]);
  const map = Object.fromEntries(flat);

  baseKeys.forEach((key) => {
    if (!keys.includes(key)) problems.push(name + ' 缺少键: ' + key);
  });
  keys.forEach((key) => {
    if (!baseKeys.includes(key)) problems.push(name + ' 多出的键: ' + key);
  });
  keys.forEach((key) => {
    const value = map[key];
    if (typeof value !== 'string' || value.trim() === '') {
      problems.push(name + ' 键值为空: ' + key);
      return;
    }
    if (baseMap[key] !== undefined && placeholderTokens(baseMap[key]).join(',') !== placeholderTokens(value).join(',')) {
      problems.push(name + ' 占位符不匹配: ' + key + ' -> zh{' + placeholderTokens(baseMap[key]) + '} / ' + name + '{' + placeholderTokens(value) + '}');
    }
  });
});

if (problems.length) {
  console.error('i18n check FAILED (' + problems.length + ' issues):');
  problems.forEach((p) => console.error('  - ' + p));
  process.exit(1);
}
console.log('i18n check OK: ' + baseKeys.length + ' keys x 3 locales (zh/en/ja)');
