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

// —— 自动镜像的节奏（设备级设置，存在 meta 里，不随 EventBook 变）——
// 只给固定档位：任意分钟数允许写死 latest.json（0 / 负数 / 几天），脏值一律归到最近的档位。
export const MIRROR_INTERVAL_OPTIONS_MIN = [1, 5, 10, 15, 30, 60];
export const DEFAULT_MIRROR_INTERVAL_MIN = 10;
const INTERVAL_META_KEY = 'mirrorIntervalMinutes';

export function isFolderSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

// 必须由用户手势触发
export async function pickBackupRoot() {
  const handle = await window.showDirectoryPicker({ id: 'event-logger-backups', mode: 'readwrite' });
  await setMeta(META_KEY, handle);
  resetLatestStamps();
  return handle;
}

export function getBackupRoot() {
  return getMeta(META_KEY);
}

export async function forgetBackupRoot() {
  await removeMeta(META_KEY);
  resetLatestStamps();
}

// 换节奏也要清窗口：不然从 60 分钟改到 1 分钟，下一次改动还得等旧窗口耗尽
export function resetLatestStamps() {
  Object.keys(latestStamps).forEach((k) => delete latestStamps[k]);
}

// 纯函数：任何脏值（含字符串、NaN、超出范围）都归到最近的合法档位，永远不会把节流写死
export function normalizeMirrorInterval(value) {
  if (value === null || value === undefined || value === '') return DEFAULT_MIRROR_INTERVAL_MIN;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_MIRROR_INTERVAL_MIN;
  let best = DEFAULT_MIRROR_INTERVAL_MIN;
  let bestDiff = Infinity;
  for (let i = 0; i < MIRROR_INTERVAL_OPTIONS_MIN.length; i++) {
    const opt = MIRROR_INTERVAL_OPTIONS_MIN[i];
    const diff = Math.abs(n - opt);
    if (diff < bestDiff) { bestDiff = diff; best = opt; }
  }
  return best;
}

export async function getMirrorInterval() {
  let stored = null;
  try { stored = await getMeta(INTERVAL_META_KEY); } catch (err) { return DEFAULT_MIRROR_INTERVAL_MIN; }
  return normalizeMirrorInterval(stored);
}

// 返回实际写进去的分钟数（归一化后），UI 直接用它回填下拉
export async function setMirrorInterval(minutes) {
  const minutes2 = normalizeMirrorInterval(minutes);
  await setMeta(INTERVAL_META_KEY, minutes2);
  resetLatestStamps();
  return minutes2;
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

// —— 只读列举：给「查看镜像文件夹」面板用 ——
// 边界必须写死：这里只做 getDirectoryHandle({ create: false }) + entries()，
// 既不建目录也不写文件，而且绝不打开任何文件的内容 —— 只列文件名。
// 读到的清单仅用于展示，永不回填进应用状态：应用的数据始终只来自 IndexedDB（I30「只写不读」）。

// 单层最多列这么多个文件，脏值 / 缺省一律回落到它，防止一本巨型文件夹把面板卡住
export const LIST_LIMIT = 300;

// 「不存在」和「读不了」要分开：目录缺失就当成没有这一层，权限被收回得让上层报错，别假装是空的
function isMissingError(err) {
  const text = String((err && err.name) || '') + ' ' + String((err && err.message) || '');
  return text.indexOf('NotFoundError') >= 0 || text.indexOf('AbortError') >= 0;
}

async function readDir(dir, name) {
  if (!dir || typeof dir.getDirectoryHandle !== 'function') return null;
  let found = null;
  try {
    found = await dir.getDirectoryHandle(name, { create: false });
  } catch (err) {
    if (isMissingError(err)) return null;
    throw err;
  }
  return found || null;
}

// 文件名倒序：快照文件名是 data-<ISO>.json（Windows 不许冒号，所以全换成连字符），
// 字典序就是时间序，倒过来排即「最新的排最前」；目录名正序，稳定好读。
async function scanDir(dir, limit) {
  const files = [];
  const dirs = [];
  if (dir && typeof dir.entries === 'function') {
    for await (const entry of dir.entries()) {
      const name = Array.isArray(entry) ? entry[0] : '';
      const child = Array.isArray(entry) ? entry[1] : null;
      if (!name) continue;
      if (child && child.kind === 'directory') dirs.push(name);
      else files.push(name);
    }
  }
  dirs.sort();
  files.sort((a, b) => (a < b ? 1 : (a > b ? -1 : 0)));
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : LIST_LIMIT;
  return { files: files.slice(0, cap), dirs, total: files.length, truncated: files.length > cap };
}

export async function listMirrorTree(handle, options) {
  const opts = options || {};
  const cap = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : LIST_LIMIT;
  const rootName = (handle && handle.name) || '';
  const empty = { ok: false, error: 'no-handle', root: rootName, rootFiles: [], rootTotal: 0, books: [] };
  if (!handle) return empty;
  try {
    const root = await readDir(handle, ROOT_DIR_NAME);
    // 还没有任何副本：这不是错误，界面该老实说「这个文件夹里还没有镜像目录」
    if (!root) return { ok: true, missingRoot: true, root: rootName, rootFiles: [], rootTotal: 0, books: [] };
    const scan = await scanDir(root, cap);
    const books = [];
    for (let i = 0; i < scan.dirs.length; i++) {
      const folder = scan.dirs[i];
      const dir = await readDir(root, folder);
      const inner = await scanDir(dir, cap);
      const snaps = await scanDir(await readDir(dir, SNAPSHOT_DIR_NAME), cap);
      books.push({
        folder,
        files: inner.files,
        fileTotal: inner.total,
        snapshots: snaps.files,
        snapshotTotal: snaps.total,
      });
    }
    return {
      ok: true,
      missingRoot: false,
      root: rootName,
      rootFiles: scan.files,
      rootTotal: scan.total,
      books,
    };
  } catch (err) {
    const message = (err && err.message) ? err.message : String(err);
    return { ok: false, error: (err && err.name) || 'read', message, root: rootName, rootFiles: [], rootTotal: 0, books: [] };
  }
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