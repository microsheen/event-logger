// EventBook：一本书 = 一份事件 + 一套模板 + 自己的「周开始日」与「语言」。
// 纯校验在文件上半部（Node 可直接断言），IndexedDB 读写在末尾薄胶层。
import { STORE, get, getAll, put, remove } from './idb.js';
import { normalizeWeekStart, TOTAL_SLOTS } from '../utils/time.js';
import { isValidLang, DEFAULT_LANG } from '../i18n/core.js';

export const STATS_SCOPES = ['day', 'week', 'month', 'year'];
export const LANG_WEEK_START = { zh: 1, en: 0, ja: 1 };
export const MAX_BOOK_NAME = 40;

export function defaultWeekStartsOn(lang) {
  return Object.prototype.hasOwnProperty.call(LANG_WEEK_START, lang) ? LANG_WEEK_START[lang] : 1;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

// 守门不变量 I2：0 ≤ timelineStart < timelineEnd ≤ 144
export function normalizeSettings(raw, options) {
  const opts = options || {};
  const src = raw && typeof raw === 'object' ? raw : {};
  const fallbackLang = isValidLang(opts.fallbackLang) ? opts.fallbackLang : DEFAULT_LANG;
  const language = isValidLang(src.language) ? src.language : fallbackLang;
  const weekStartsOn = src.weekStartsOn === undefined || src.weekStartsOn === null
    ? defaultWeekStartsOn(language)
    : normalizeWeekStart(src.weekStartsOn);
  const max = TOTAL_SLOTS;
  let start = clampInt(src.timelineStart, 0, max - 1, 0);
  let end = clampInt(src.timelineEnd, 1, max, max);
  if (start >= end) { start = 0; end = max; }
  const statsScope = STATS_SCOPES.indexOf(src.statsScope) !== -1 ? src.statsScope : 'week';
  return {
    language: language,
    weekStartsOn: weekStartsOn,
    timelineStart: start,
    timelineEnd: end,
    statsScope: statsScope,
  };
}

export function sanitizeBookName(name) {
  const text = String(name === undefined || name === null ? '' : name)
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= MAX_BOOK_NAME) return text;
  return text.slice(0, MAX_BOOK_NAME).trim();
}

// 文件夹/导出文件名用的安全短名：去掉 Windows/Linux 非法字符，保留中文
export function bookSlug(book) {
  const raw = sanitizeBookName(book && book.name ? book.name : '') || 'eventbook';
  const cleaned = raw.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '-').replace(/^-+|-+$/g, '');
  const base = cleaned || 'eventbook';
  const id = String((book && book.id) || '').slice(0, 8);
  return id ? base + '-' + id : base;
}

export function makeBook(raw, options) {
  const opts = options || {};
  const src = raw && typeof raw === 'object' ? raw : {};
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const deviceLang = isValidLang(opts.deviceLang) ? opts.deviceLang : DEFAULT_LANG;
  const language = isValidLang(src.language) ? src.language : deviceLang;
  const settings = normalizeSettings(
    Object.assign({}, src.settings, {
      language: isValidLang(src.language) ? src.language : (src.settings && src.settings.language),
      weekStartsOn: src.weekStartsOn !== undefined ? src.weekStartsOn : (src.settings && src.settings.weekStartsOn),
    }),
    { fallbackLang: deviceLang },
  );
  const name = sanitizeBookName(src.name) || opts.defaultName || 'EventBook';
  return {
    id: typeof src.id === 'string' && src.id ? src.id : (opts.idFactory ? opts.idFactory() : String(nowMs)),
    name: name,
    createdAt: Number.isFinite(src.createdAt) ? src.createdAt : nowMs,
    updatedAt: nowMs,
    settings: settings,
  };
}

export function isBook(value) {
  return !!value && typeof value === 'object' && typeof value.id === 'string' && !!value.settings;
}

// —— I/O 薄胶层 ——
export async function listBooks() {
  const rows = await getAll(STORE.books);
  return (rows || []).filter(isBook).sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : 1));
}

export function getBook(id) {
  return get(STORE.books, id);
}

export async function saveBook(book) {
  const next = Object.assign({}, book, { updatedAt: Date.now() });
  await put(STORE.books, next);
  return next;
}

export async function readLiveData(bookId) {
  const row = await get(STORE.data, bookId);
  return {
    events: row && Array.isArray(row.events) ? row.events : [],
    templates: row && Array.isArray(row.templates) ? row.templates : [],
    rev: row && Number.isFinite(row.rev) ? row.rev : 0,
    updatedAt: row && Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
  };
}

export async function writeLiveData(bookId, payload) {
  const current = await readLiveData(bookId);
  const row = {
    bookId: bookId,
    events: Array.isArray(payload.events) ? payload.events : [],
    templates: Array.isArray(payload.templates) ? payload.templates : [],
    rev: current.rev + 1,
    updatedAt: Date.now(),
  };
  await put(STORE.data, row);
  return row;
}

export async function deleteBook(bookId) {
  await remove(STORE.data, bookId);
  await remove(STORE.books, bookId);
}