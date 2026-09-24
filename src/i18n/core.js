// 纯函数 i18n 内核（不依赖 React），供组件、hooks 与 utils 共用
import zh from './locales/zh.js';
import en from './locales/en.js';
import ja from './locales/ja.js';

export const LANGS = [
  { code: 'zh', name: '中文' },
  { code: 'en', name: 'English' },
  { code: 'ja', name: '日本語' },
];

export const DEFAULT_LANG = 'en';
const FALLBACK_LANG = 'zh';
export const STORAGE_KEY = 'event-logger:lang';

const DICTS = { zh: zh, en: en, ja: ja };
const LOCALE_TAGS = { zh: 'zh-CN', en: 'en-US', ja: 'ja-JP' };
const HTML_LANGS = { zh: 'zh-CN', en: 'en', ja: 'ja' };

export function isValidLang(code) {
  return code === 'zh' || code === 'en' || code === 'ja';
}

export function localeTag(lang) {
  return LOCALE_TAGS[isValidLang(lang) ? lang : DEFAULT_LANG];
}

export function htmlLang(lang) {
  return HTML_LANGS[isValidLang(lang) ? lang : DEFAULT_LANG];
}

function lookup(dict, key) {
  const parts = key.split('.');
  let current = dict;
  for (let i = 0; i < parts.length; i++) {
    if (current === null || typeof current !== 'object') return undefined;
    current = current[parts[i]];
  }
  return current;
}

// tr('stats.weekN', { n: 36 }) -> '第36周'；未知 key 回退中文，再回退 key 本身
export function translate(lang, key, params) {
  const preferred = isValidLang(lang) ? lang : DEFAULT_LANG;
  let value = lookup(DICTS[preferred], key);
  if (value === undefined) value = lookup(DICTS[FALLBACK_LANG], key);
  if (value === undefined) return key;
  if (typeof value !== 'string') return value;
  if (!params) return value;
  let out = value;
  Object.keys(params).forEach(function (name) {
    const token = '{' + name + '}';
    out = out.split(token).join(String(params[name]));
  });
  return out;
}

export function readStoredLang() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isValidLang(raw) ? raw : null;
  } catch (err) {
    return null;
  }
}

export function writeStoredLang(lang) {
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch (err) {
    // 隐私模式或存储被禁用时忽略，内存中的语言仍生效
  }
}

export function detectLang() {
  const candidates = [];
  if (typeof navigator !== 'undefined') {
    if (Array.isArray(navigator.languages)) {
      for (let i = 0; i < navigator.languages.length; i++) candidates.push(navigator.languages[i]);
    }
    if (navigator.language) candidates.push(navigator.language);
  }
  for (let i = 0; i < candidates.length; i++) {
    const tag = String(candidates[i] || '').toLowerCase();
    if (tag.indexOf('zh') === 0) return 'zh';
    if (tag.indexOf('ja') === 0) return 'ja';
    if (tag.indexOf('en') === 0) return 'en';
  }
  return DEFAULT_LANG;
}

// 优先级：EventBook 的语言 > localStorage 缓存（上一次活跃 book 的语言，供 index.html 内联脚本防闪烁）> 浏览器语言
export function resolveInitialLang(bookLang) {
  if (isValidLang(bookLang)) return { lang: bookLang, fromBook: true };
  const stored = readStoredLang();
  if (stored) return { lang: stored, fromStorage: true, fromBook: false };
  return { lang: detectLang(), fromStorage: false, fromBook: false };
}
