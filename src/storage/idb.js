// 全站唯一允许触碰 indexedDB 的模块：策略与校验都在别处，
// 这样 scripts/check-*.mjs 能在 Node 里直接 import 纯逻辑层。
export const DB_NAME = 'event-logger';
export const DB_VERSION = 1;
export const STORE = {
  books: 'books',
  data: 'data',
  snapshots: 'snapshots',
  meta: 'meta',
};

let dbPromise = null;

export function isSupported() {
  return typeof indexedDB !== 'undefined' && !!indexedDB;
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!isSupported()) {
      reject(new Error('IndexedDB 不可用（隐私模式或浏览器不支持）'));
      return;
    }
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE.books)) {
        db.createObjectStore(STORE.books, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE.data)) {
        db.createObjectStore(STORE.data, { keyPath: 'bookId' });
      }
      if (!db.objectStoreNames.contains(STORE.snapshots)) {
        const s = db.createObjectStore(STORE.snapshots, { keyPath: 'id' });
        s.createIndex('by-book', 'bookId', { unique: false });
        s.createIndex('by-time', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE.meta)) {
        db.createObjectStore(STORE.meta, { keyPath: 'key' });
      }
      void ev;
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    req.onblocked = () => reject(new Error('IndexedDB 被其它标签页阻塞'));
  });
  return dbPromise;
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    let result;
    let failure = null;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error || new Error('IndexedDB 事务失败'));
    t.onabort = () => reject(failure || t.error || new Error('IndexedDB 事务被中止'));
    Promise.resolve(fn(t.objectStore(storeName)))
      .then((value) => { result = value; })
      .catch((err) => {
        failure = err;
        try { t.abort(); } catch (e) { reject(err); }
      });
  });
}

export function get(storeName, key) {
  return run(storeName, 'readonly', (store) => wrap(store.get(key)));
}

export function getAll(storeName) {
  return run(storeName, 'readonly', (store) => wrap(store.getAll()));
}

export function getByIndex(storeName, indexName, query) {
  return run(storeName, 'readonly', (store) => wrap(store.index(indexName).getAll(query)));
}

export function put(storeName, value) {
  return run(storeName, 'readwrite', (store) => wrap(store.put(value)));
}

export function remove(storeName, key) {
  return run(storeName, 'readwrite', (store) => wrap(store.delete(key)));
}

export async function count(storeName) {
  return run(storeName, 'readonly', (store) => wrap(store.count()));
}

export async function getMeta(key) {
  const row = await get(STORE.meta, key);
  return row ? row.value : null;
}

export async function setMeta(key, value) {
  // FileSystemDirectoryHandle 可以被结构化克隆，所以句柄能直接存进 meta
  await put(STORE.meta, { key, value });
  return value;
}

export async function removeMeta(key) {
  await remove(STORE.meta, key);
}

export async function estimateUsage() {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.estimate) return null;
  try {
    return await navigator.storage.estimate();
  } catch (err) {
    return null;
  }
}

export async function requestPersistence() {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch (err) {
    return false;
  }
}