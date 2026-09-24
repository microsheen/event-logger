import { useCallback, useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import {
  listBooks,
  saveBook,
  makeBook,
  normalizeSettings,
  deleteBook as deleteBookRow,
  writeLiveData,
} from '../storage/books.js';
import { listSnapshots, deleteSnapshots } from '../storage/snapshots.js';
import { detectLang } from '../i18n/core.js';

const ACTIVE_KEY = 'event-logger:active-book';
const SETTINGS_WRITE_MS = 400;

function readActiveId() {
  try { return window.localStorage.getItem(ACTIVE_KEY); } catch (err) { return null; }
}

function writeActiveId(id) {
  try { if (id) window.localStorage.setItem(ACTIVE_KEY, id); else window.localStorage.removeItem(ACTIVE_KEY); } catch (err) { /* 隐私模式：仅内存生效 */ }
}

export function useBooks() {
  const [books, setBooks] = useState([]);
  const [activeBookId, setActiveId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [storageError, setStorageError] = useState(null);
  // 「该给哪本书打开设置弹窗」是一个跨挂载的意图：Workspace 的 key = book.id，
  // 换书时它会被整棵卸载再重装（中间还夹着 bookData.loading 的 ⏳），
  // 所以这个状态必须住在 App 层的这里，只交给 Workspace 派生，绝不能存成局部 setState。
  const [settingsOpenFor, setSettingsOpenFor] = useState(null);
  const pendingSettings = useRef({});
  const settingsTimer = useRef(null);

  const refresh = useCallback(async () => {
    const rows = await listBooks();
    setBooks(rows);
    return rows;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await listBooks();
        if (cancelled) return;
        setBooks(rows);
        const stored = readActiveId();
        const initial = rows.find((b) => b.id === stored) || rows[0] || null;
        setActiveId(initial ? initial.id : null);
        if (initial) writeActiveId(initial.id);
        setStorageError(null);
      } catch (err) {
        if (!cancelled) setStorageError(err && err.message ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [refresh]);

  // 其它标签页新建/改名/删除 book 时同步列表
  useEffect(() => {
    const onStorage = (e) => {
      if (!e.key || e.key === ACTIVE_KEY) return;
      refresh().catch(() => { /* 忽略 */ });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [refresh]);

  const flushSettings = useCallback(async () => {
    if (settingsTimer.current) { clearTimeout(settingsTimer.current); settingsTimer.current = null; }
    const queue = pendingSettings.current;
    pendingSettings.current = {};
    const ids = Object.keys(queue);
    for (let i = 0; i < ids.length; i++) {
      try { await saveBook(queue[ids[i]]); } catch (err) { setStorageError(err.message || String(err)); }
    }
    if (ids.length) setBooks((prev) => prev.map((b) => (queue[b.id] ? Object.assign({}, b, { settings: queue[b.id].settings, name: queue[b.id].name }) : b)));
  }, []);

  const patchBook = useCallback((book, patch) => {
    if (!book) return null;
    const next = Object.assign({}, book, { updatedAt: Date.now() });
    if (patch.name !== undefined) next.name = makeBook({ name: patch.name }, { idFactory: () => book.id, nowMs: Date.now() }).name;
    if (patch.settings) next.settings = normalizeSettings(Object.assign({}, book.settings, patch.settings));
    pendingSettings.current[next.id] = next;
    setBooks((prev) => prev.map((b) => (b.id === next.id ? next : b)));
    if (settingsTimer.current) clearTimeout(settingsTimer.current);
    settingsTimer.current = setTimeout(() => { flushSettings(); }, SETTINGS_WRITE_MS);
    return next;
  }, [flushSettings]);

  const createBook = useCallback(async (raw, options) => {
    const opts = options || {};
    const source = raw || {};
    const book = makeBook(
      { name: source.name, language: source.language, weekStartsOn: source.weekStartsOn, settings: source.settings },
      { idFactory: uuidv4, deviceLang: source.language || detectLang(), defaultName: 'EventBook' },
    );
    await saveBook(book);
    await writeLiveData(book.id, { events: [], templates: [] });
    await refresh();
    setActiveId(book.id);
    writeActiveId(book.id);
    if (opts.openSettings) setSettingsOpenFor(book.id);
    return book;
  }, [refresh]);

  // 设置弹窗的唯一开关入口（状态住在本 hook，任何挂载周期都不会把它弄丢）
  const openSettings = useCallback((id) => setSettingsOpenFor(id), []);
  const closeSettings = useCallback(() => setSettingsOpenFor(null), []);

  const selectBook = useCallback((id) => {
    setActiveId(id);
    writeActiveId(id);
    // 切书时丢掉没被消费的「打开设置」意图，否则切回去会莫名其妙再弹一次
    setSettingsOpenFor(null);
  }, []);

  // 删除整本书：连带它的全部历史快照；返回被删快照供镜像文件夹清理
  const removeBook = useCallback(async (book) => {
    if (!book) return { removedSnapshots: [] };
    const snaps = await listSnapshots(book.id);
    await deleteSnapshots(snaps.map((s) => s.id));
    await deleteBookRow(book.id);
    const rows = await refresh();
    if (activeBookId === book.id) {
      const next = rows[0] || null;
      setActiveId(next ? next.id : null);
      writeActiveId(next ? next.id : null);
    }
    return { removedSnapshots: snaps };
  }, [activeBookId, refresh]);

  const activeBook = books.find((b) => b.id === activeBookId) || null;

  return {
    books,
    activeBook,
    activeBookId,
    settingsOpenFor,
    openSettings,
    closeSettings,
    loading,
    storageError,
    refresh,
    createBook,
    patchBook,
    selectBook,
    removeBook,
    flushSettings,
  };
}