// 历史版本快照：策略是纯函数（可被 scripts/check-snapshot-policy.mjs 在 Node 里断言），
// I/O 只在文件末尾的薄胶层里。
import { formatDate } from '../utils/time.js';
import { STORE, get, getAll, getByIndex, put, remove } from './idb.js';

// —— 节奏 ——
export const SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000;       // 连续编辑期间最多每 15 分钟一份
export const STARTUP_SNAPSHOT_MS = 24 * 60 * 60 * 1000;   // 启动时若最近一份超过 24h 则补一份
export const RETENTION_SWEEP_MS = 6 * 60 * 60 * 1000;     // 常驻标签页每 6h 复查一次淘汰
export const LATEST_FILE_THROTTLE_MS = 60 * 1000;         // 镜像文件夹 latest.json 的写盘节流

// —— 保留窗口 ——
export const DAY_MS = 24 * 60 * 60 * 1000;
export const TIER_ALL_MS = 7 * DAY_MS;                    // ≤7 天：全留
export const TIER_DAILY_MS = 30 * DAY_MS;                 // 8~30 天：每自然日留最早一份
export const TIER_MONTHLY_MS = 365 * DAY_MS;              // 31~365 天：每月留最早一份
export const MAX_SNAPSHOTS = 500;                         // 总量兜底上限

export const REASONS = ['interval', 'startup', 'manual', 'import', 'pre-restore', 'restored-from'];
export const PROTECTED_REASONS = ['manual', 'import', 'pre-restore'];

// —— 内容指纹 ——
// 事件数组顺序无语义（渲染按槽位排），所以先排序；模板数组顺序 = 插入顺序（不变量 I3），保持原序。
function stableStringify(value) {
  if (Array.isArray(value)) {
    let out = '[';
    for (let i = 0; i < value.length; i++) out += (i ? ',' : '') + stableStringify(value[i]);
    return out + ']';
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (let i = 0; i < keys.length; i++) parts.push(JSON.stringify(keys[i]) + ':' + stableStringify(value[keys[i]]));
    return '{' + parts.join(',') + '}';
  }
  if (value === undefined || value === null) return 'null';
  return JSON.stringify(value);
}

function eventSortKey(event) {
  return [String(event.date || ''), String(event.startSlot), String(event.endSlot),
    String(event.id || ''), String(event.name || '')].join('|');
}

export function canonicalPayload(payload) {
  const events = (payload && Array.isArray(payload.events) ? payload.events.slice() : [])
    .sort((a, b) => (eventSortKey(a) < eventSortKey(b) ? -1 : eventSortKey(a) > eventSortKey(b) ? 1 : 0));
  const templates = payload && Array.isArray(payload.templates) ? payload.templates : [];
  return stableStringify({ events: events, templates: templates });
}

function fnv1a32(text, seedOffset) {
  let hash = seedOffset >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function djb2(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return hash >>> 0;
}

// 三段拼接（两个独立 32 位散列 + 长度）——只为去重，不做安全用途
export function hashPayload(payload) {
  const canonical = canonicalPayload(payload);
  const hex = (n) => n.toString(16).padStart(8, '0');
  return hex(fnv1a32(canonical, 2166136261)) + hex(djb2(canonical)) + '.' + canonical.length;
}

// —— 触发时机 ——
export function shouldSnapshot(options) {
  const nowMs = options.nowMs;
  const lastCreatedAt = options.lastCreatedAt;
  const intervalMs = options.intervalMs || SNAPSHOT_INTERVAL_MS;
  if (!Number.isFinite(nowMs)) return false;
  if (!Number.isFinite(lastCreatedAt)) return true;   // 从未备份过
  return nowMs - lastCreatedAt >= intervalMs;
}

export function needsStartupSnapshot(options) {
  const nowMs = options.nowMs;
  const lastCreatedAt = options.lastCreatedAt;
  const intervalMs = options.intervalMs || STARTUP_SNAPSHOT_MS;
  if (!Number.isFinite(lastCreatedAt)) return true;
  return nowMs - lastCreatedAt >= intervalMs;
}

export function isProtected(snapshot) {
  if (!snapshot) return false;
  if (snapshot.protected === true) return true;
  return PROTECTED_REASONS.indexOf(snapshot.reason) !== -1;
}
// —— 时间分层淘汰 ——
// 返回 bucket 标识：同一 bucket 内只保留最早的一份（列表按 createdAt 升序遍历）
export function retentionBucket(snapshot, nowMs) {
  const id = snapshot.id;
  if (!snapshot || !Number.isFinite(snapshot.createdAt)) return 'invalid|' + id;
  const age = (Number.isFinite(nowMs) ? nowMs : Date.now()) - snapshot.createdAt;
  const day = formatDate(new Date(snapshot.createdAt));
  if (age <= TIER_ALL_MS) return 'all|' + id;                       // 近 7 天全留
  if (age <= TIER_DAILY_MS) return 'day|' + day;                    // 每自然日一份
  if (age <= TIER_MONTHLY_MS) return 'month|' + day.slice(0, 7);    // 每月一份
  return 'year|' + day.slice(0, 4);                                 // 每年一份
}

export function selectSnapshotsToDelete(snapshots, nowMs, options) {
  const limit = options && Number.isFinite(options.maxSnapshots) ? options.maxSnapshots : MAX_SNAPSHOTS;
  const asc = (snapshots || [])
    .filter((s) => s && typeof s.id === 'string' && Number.isFinite(s.createdAt))
    .sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!asc.length) return [];
  const newestId = asc[asc.length - 1].id;
  const kept = [];
  const removed = [];
  const seen = new Set();
  asc.forEach((s) => {
    if (s.id === newestId || isProtected(s)) { kept.push(s); return; }
    const bucket = retentionBucket(s, nowMs);
    if (seen.has(bucket)) { removed.push(s.id); return; }
    seen.add(bucket);
    kept.push(s);
  });
  if (limit > 0 && kept.length > limit) {
    let excess = kept.length - limit;
    for (let i = 0; i < kept.length && excess > 0; i++) {
      const s = kept[i];
      if (s.id === newestId || isProtected(s)) continue;
      removed.push(s.id);
      excess -= 1;
    }
  }
  return removed.sort();
}

export function snapshotStats(snapshots) {
  const list = snapshots || [];
  let bytes = 0;
  list.forEach((s) => { bytes += Number.isFinite(s.bytes) ? s.bytes : 0; });
  return { count: list.length, bytes: bytes, oldest: list.length ? list[0].createdAt : null };
}

// —— I/O 薄胶层 ——
export async function listSnapshots(bookId) {
  const rows = await getByIndex(STORE.snapshots, 'by-book', bookId);
  return (rows || []).sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function getSnapshot(id) {
  return get(STORE.snapshots, id);
}

function bytesOf(text) {
  try {
    return new TextEncoder().encode(text).length;
  } catch (err) {
    return text.length;
  }
}

function defaultId(bookId, nowMs) {
  return bookId + ':' + nowMs + ':' + Math.random().toString(36).slice(2, 8);
}

// 建快照 + 立刻跑淘汰；返回最终保留列表与被删掉的快照对象（镜像文件夹要按它们删文件）
export async function createSnapshot(bookId, payload, reason, options) {
  const opts = options || {};
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const existing = opts.existing || await listSnapshots(bookId);
  const hash = hashPayload(payload);
  const last = existing.length ? existing[existing.length - 1] : null;
  if (!opts.force && last && last.hash === hash) {
    return { created: false, unchanged: true, snapshot: null, removed: [], snapshots: existing };
  }
  const events = Array.isArray(payload.events) ? payload.events : [];
  const templates = Array.isArray(payload.templates) ? payload.templates : [];
  const clean = { events: JSON.parse(JSON.stringify(events)), templates: JSON.parse(JSON.stringify(templates)) };
  const json = canonicalPayload(clean);
  const snapshot = {
    id: (opts.idFactory || defaultId)(bookId, nowMs),
    bookId: bookId,
    createdAt: nowMs,
    iso: new Date(nowMs).toISOString(),
    reason: reason,
    hash: hash,
    eventCount: events.length,
    templateCount: templates.length,
    bytes: bytesOf(json),
    protected: PROTECTED_REASONS.indexOf(reason) !== -1,
    note: typeof opts.note === 'string' ? opts.note : '',
    payload: clean,
  };
  await put(STORE.snapshots, snapshot);
  const merged = existing.concat([snapshot]).sort((a, b) => a.createdAt - b.createdAt);
  const deleteIds = selectSnapshotsToDelete(merged, nowMs, { maxSnapshots: opts.maxSnapshots });
  const idSet = new Set(deleteIds);
  const removed = merged.filter((s) => idSet.has(s.id));
  await deleteSnapshots(deleteIds);
  return {
    created: true,
    unchanged: false,
    snapshot: snapshot,
    removed: removed,
    snapshots: merged.filter((s) => !idSet.has(s.id)),
  };
}

export async function deleteSnapshots(ids) {
  const list = Array.isArray(ids) ? ids : [ids];
  for (let i = 0; i < list.length; i++) await remove(STORE.snapshots, list[i]);
  return list.length;
}

export async function pruneSnapshots(bookId, nowMs, options) {
  const existing = await listSnapshots(bookId);
  const deleteIds = selectSnapshotsToDelete(existing, nowMs || Date.now(), options);
  const idSet = new Set(deleteIds);
  await deleteSnapshots(deleteIds);
  return { removed: existing.filter((s) => idSet.has(s.id)), snapshots: existing.filter((s) => !idSet.has(s.id)) };
}