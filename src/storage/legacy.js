// 备份文件信封：
//   v1 = 旧的单书整包 { events, templates, settings }（server.js 时代的 data.json 与老导出文件）
//   v2 = 多书备份 { version: "2.0", exportedAt, books: [{ id, name, createdAt, updatedAt, settings, events, templates }] }
// 本模块是纯函数：Node 里可直接断言（scripts/check-book-store.mjs）。
import { makeBook, normalizeSettings, sanitizeBookName, MAX_BOOK_NAME } from './books.js';

export const ENVELOPE_V2 = '2.0';

export function detectEnvelope(raw) {
  if (!raw || typeof raw !== 'object') return 'invalid';
  if (Array.isArray(raw.books)) return 'v2';
  if (Array.isArray(raw.events)) return 'v1';
  return 'invalid';
}

// book（含 settings） + live payload 合成一条 v2 记录
function toBookEntry(book, live) {
  return {
    id: book.id,
    name: book.name,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
    settings: book.settings,
    events: Array.isArray(live && live.events) ? live.events : [],
    templates: Array.isArray(live && live.templates) ? live.templates : [],
  };
}

export function toV2Envelope(entries, nowMs) {
  const stamp = Number.isFinite(nowMs) ? nowMs : Date.now();
  return {
    version: ENVELOPE_V2,
    app: 'event-logger',
    exportedAt: new Date(stamp).toISOString(),
    books: (entries || []).map((e) => toBookEntry(e.book, e.live)),
  };
}

// 解析任意可导入的信封 → { books:[{book, events, templates}], warnings:[] }
export function booksFromEnvelope(raw, options) {
  const opts = options || {};
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const warnings = [];
  const kind = detectEnvelope(raw);
  if (kind === 'invalid') return { books: [], warnings: ['bad-format'] };
  const entries = kind === 'v1'
    ? [{
      id: undefined,
      name: opts.bookName || 'Imported',
      createdAt: nowMs,
      settings: raw.settings,
      events: raw.events,
      templates: raw.templates,
    }]
    : raw.books;

  const parsed = [];
  (entries || []).forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') { warnings.push('entry-' + index + '-invalid'); return; }
    const book = makeBook(
      {
        id: entry.id,
        name: entry.name || (opts.bookName ? opts.bookName + ' ' + (index + 1) : 'Book ' + (index + 1)),
        createdAt: entry.createdAt,
        language: entry.settings && entry.settings.language,
        settings: entry.settings,
      },
      { nowMs: nowMs, deviceLang: opts.deviceLang, idFactory: opts.idFactory },
    );
    parsed.push({
      book: book,
      events: Array.isArray(entry.events) ? entry.events : [],
      templates: Array.isArray(entry.templates) ? entry.templates : [],
    });
  });
  if (!parsed.length) warnings.push('empty');
  return { books: parsed, warnings: warnings };
}

// 导入合并策略：id 撞车就换新 id；名字撞车加 " (2)" 后缀
export function planImport(existingBooks, incoming, options) {
  const opts = options || {};
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const usedIds = new Set((existingBooks || []).map((b) => b.id));
  const usedNames = new Set((existingBooks || []).map((b) => b.name));
  return (incoming || []).map((item) => {
    let id = item.book.id;
    if (!id || usedIds.has(id)) id = opts.idFactory ? opts.idFactory() : String(nowMs) + '-' + Math.random().toString(36).slice(2, 8);
    usedIds.add(id);
    const base = sanitizeBookName(item.book.name) || 'EventBook';
    let name = base;
    let n = 2;
    while (usedNames.has(name)) {
      const suffix = ' (' + n + ')';
      name = base.slice(0, Math.max(1, MAX_BOOK_NAME - suffix.length)) + suffix;
      n += 1;
    }
    usedNames.add(name);
    const book = Object.assign({}, item.book, { id: id, name: name });
    return { book: book, events: item.events, templates: item.templates };
  });
}

export function normalizeLivePayload(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    events: Array.isArray(src.events) ? src.events : [],
    templates: Array.isArray(src.templates) ? src.templates : [],
  };
}