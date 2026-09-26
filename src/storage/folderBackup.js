// 可选的「备份到本地文件夹」：把快照链镜像到用户自己选定的目录，
// 这样即便浏览器数据被清理，历史版本仍在磁盘上。全程只在用户本机读写，不经过任何服务器。
// 依赖 File System Access API（Chrome / Edge）；不支持的浏览器由调用方降级为手动导出。
import { getMeta, setMeta, removeMeta } from './idb.js';
import { bookSlug } from './books.js';
import { LATEST_FILE_THROTTLE_MS } from './snapshots.js';

export const ROOT_DIR_NAME = 'EventLogger Backups';
export const SNAPSHOT_DIR_NAME = 'snapshots';
export const LATEST_FILE_NAME = 'latest.json';
export const MANIFEST_FILE_NAME = 'manifest.json';
const META_KEY = 'backupDirectory';
const latestStamps = {};

export function isFolderSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

// 必须由用户手势触发
export async function pickBackupRoot() {
  const handle = await window.showDirectoryPicker({ id: 'event-logger-backups', mode: 'readwrite' });
  await setMeta(META_KEY, handle);
  Object.keys(latestStamps).forEach((k) => delete latestStamps[k]);
  return handle;
}

export function getBackupRoot() {
  return getMeta(META_KEY);
}

export async function forgetBackupRoot() {
  await removeMeta(META_KEY);
  Object.keys(latestStamps).forEach((k) => delete latestStamps[k]);
}

export async function checkPermission(handle, request) {
  if (!handle) return 'denied';
  try {
    if (typeof handle.queryPermission !== 'function') return 'granted';
    const state = await handle.queryPermission({ mode: 'readwrite' });
    if (state === 'granted' || !request) return state;
    if (typeof handle.requestPermission !== 'function') return state;
    return await handle.requestPermission({ mode: 'readwrite' });
  } catch (err) {
    return 'denied';
  }
}

// Windows 文件名不允许 ':'，ISO 串里满是冒号 —— 这条不变量沿用 server.js 时代的做法
export function snapshotFileName(iso) {
  return 'data-' + String(iso || new Date().toISOString()).replace(/[:.]/g, '-') + '.json';
}

async function rootDir(handle) {
  return handle.getDirectoryHandle(ROOT_DIR_NAME, { create: true });
}

async function bookDir(handle, book, snapshotBucket) {
  const root = await rootDir(handle);
  const dir = await root.getDirectoryHandle(bookSlug(book), { create: true });
  return snapshotBucket ? dir.getDirectoryHandle(SNAPSHOT_DIR_NAME, { create: true }) : dir;
}

async function writeText(dirHandle, name, text) {
  const fileHandle = await dirHandle.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable({ keepExistingData: false });
  await writable.write(text);
  await writable.close();
  return text.length;
}

async function removeQuiet(dirHandle, name) {
  try {
    await dirHandle.removeEntry(name);
    return true;
  } catch (err) {
    return false;
  }
}

export async function writeManifest(handle, entries) {
  const root = await rootDir(handle);
  const manifest = {
    app: 'event-logger',
    version: '2.0',
    exportedAt: new Date().toISOString(),
    books: (entries || []).map((e) => ({
      id: e.book.id,
      name: e.book.name,
      folder: bookSlug(e.book),
      language: e.book.settings.language,
      weekStartsOn: e.book.settings.weekStartsOn,
      events: e.live && Array.isArray(e.live.events) ? e.live.events.length : 0,
      templates: e.live && Array.isArray(e.live.templates) ? e.live.templates.length : 0,
    })),
  };
  await writeText(root, MANIFEST_FILE_NAME, JSON.stringify(manifest, null, 2));
  return manifest;
}

export async function writeLatest(handle, book, payload, options) {
  const opts = options || {};
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const throttle = Number.isFinite(opts.throttleMs) ? opts.throttleMs : LATEST_FILE_THROTTLE_MS;
  if (!opts.force && latestStamps[book.id] && nowMs - latestStamps[book.id] < throttle) return false;
  const dir = await bookDir(handle, book, false);
  await writeText(dir, LATEST_FILE_NAME, JSON.stringify({
    bookId: book.id,
    name: book.name,
    settings: book.settings,
    savedAt: new Date(nowMs).toISOString(),
    events: payload.events,
    templates: payload.templates,
  }, null, 2));
  latestStamps[book.id] = nowMs;
  return true;
}

export async function mirrorSnapshot(handle, book, snapshot) {
  const dir = await bookDir(handle, book, true);
  const name = snapshotFileName(snapshot.iso);
  await writeText(dir, name, JSON.stringify({
    bookId: snapshot.bookId,
    name: book.name,
    createdAt: snapshot.createdAt,
    iso: snapshot.iso,
    reason: snapshot.reason,
    note: snapshot.note || '',
    eventCount: snapshot.eventCount,
    payload: snapshot.payload,
  }, null, 2));
  return name;
}

export async function unmirrorSnapshot(handle, book, snapshot) {
  const dir = await bookDir(handle, book, true);
  return removeQuiet(dir, snapshotFileName(snapshot.iso));
}

// 整链重推：把「当前所有簿 + 每本的全部历史版本」整体再写一遍到目标文件夹。
// 触发点是「刚选好文件夹 / 换了文件夹 / 重新拿到授权 / 用户手动补齐」——少了这一步，
// 新文件夹里只会拥有此后新增的那几份，看上去镜像成功，实际接近空的（旧 bug 就在这）。
// 严格单向：只写不读；也绝不删目标里已有的东西，断开连接后旧文件夹原样留全。
export async function resyncTree(handle, entries, options) {
  const opts = options || {};
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const list = entries || [];
  const manifest = await writeManifest(handle, list);
  let latest = 0;
  let snapshots = 0;
  for (let i = 0; i < list.length; i++) {
    const entry = list[i] || {};
    const bk = entry.book;
    if (!bk) continue;
    const payload = entry.payload || entry.live || { events: [], templates: [] };
    // force：镜像补齐不该被 latest.json 的节流吃掉；nowMs 透传给测试用
    if (await writeLatest(handle, bk, payload, { force: true, nowMs })) latest += 1;
    const rows = entry.snapshots || [];
    for (let j = 0; j < rows.length; j++) {
      await mirrorSnapshot(handle, bk, rows[j]);
      snapshots += 1;
    }
  }
  return { books: list.length, latest, snapshots, manifest: !!manifest };
}

// 删除 book 时清理它的整个子目录
export async function removeBookFolder(handle, book) {
  const root = await rootDir(handle);
  try {
    await root.removeEntry(bookSlug(book), { recursive: true });
    return true;
  } catch (err) {
    return false;
  }
}