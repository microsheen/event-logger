import { useCallback, useEffect, useRef, useState } from 'react';
import { readLiveData, writeLiveData } from '../storage/books.js';
import {
  listSnapshots,
  createSnapshot,
  pruneSnapshots,
  shouldSnapshot,
  needsStartupSnapshot,
  SNAPSHOT_INTERVAL_MS,
  RETENTION_SWEEP_MS,
} from '../storage/snapshots.js';
import { createBus, MSG } from '../storage/bus.js';
import { requestPersistence, estimateUsage } from '../storage/idb.js';

const SAVE_DEBOUNCE_MS = 500;
const QUOTA_BYTES = 1024 * 1024;

// 当前 book 的 live 数据 + 快照链 + 单写者锁 + 文件夹镜像。
// 这里是全站唯一允许触碰持久化的 hook（沿用旧 usePersistentData 的所有权边界）。
export function useBookData(book, backup) {
  const bookId = book ? book.id : null;
  const [live, setLive] = useState({ events: [], templates: [], rev: 0 });
  const [loading, setLoading] = useState(true);
  // 数据「属于哪一本书」必须能在渲染期直接判断：只看 loading 状态的话，bookId 刚变化的
  // 那一次提交里 loading 还是上一本书留下的 false，于是 Workspace 会被挂载一次又立刻被
  // ⏳ 卸载（整棵子树白 mount/unmount，外部还能观察到一帧空 DOM）。
  const [loadedId, setLoadedId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [snapshots, setSnapshots] = useState([]);
  const [canWrite, setCanWrite] = useState(true);
  const [preview, setPreview] = useState(null);
  const [storageError, setStorageError] = useState(null);
  const [quota, setQuota] = useState(null);
  const [remoteSeed, setRemoteSeed] = useState(null);

  const bookRef = useRef(book);
  const backupRef = useRef(backup);
  const eventsRef = useRef([]);
  const templatesRef = useRef([]);
  const snapshotsRef = useRef([]);
  const pendingRef = useRef(false);
  const timerRef = useRef(null);
  const skipSaveRef = useRef(0);
  const busRef = useRef(null);
  // LOAD 还没 apply 完成之前一律禁止落盘（见下面的 scheduleSave / flushSave）。
  // 否则「组件挂载时的第一次空写」会把内存里的空数组盖到 IndexedDB 上，
  // 真数据被一个 rev+1 的空版本顶掉 —— 这是数据安全红线，design.md 里有对应不变量。
  const loadedRef = useRef(false);

  useEffect(() => { bookRef.current = book; }, [book]);
  useEffect(() => { backupRef.current = backup; }, [backup]);

  const refreshQuota = useCallback(async () => {
    const est = await estimateUsage();
    if (!est || !Number.isFinite(est.quota)) return;
    setQuota({
      usage: est.usage || 0,
      quota: est.quota,
      ratio: est.quota > 0 ? (est.usage || 0) / est.quota : 0,
    });
  }, []);

  const applySnapshotResult = useCallback((result) => {
    if (!result) return;
    snapshotsRef.current = result.snapshots;
    setSnapshots(result.snapshots);
    const bk = bookRef.current;
    const folder = backupRef.current;
    if (!bk || !folder) return;
    if (result.created && result.snapshot) folder.syncSnapshot(bk, result.snapshot);
    (result.removed || []).forEach((s) => folder.dropSnapshot(bk, s));
  }, []);

  const currentPayload = useCallback(() => ({
    events: eventsRef.current,
    templates: templatesRef.current,
  }), []);

  const maybeSnapshot = useCallback(async (payload, options) => {
    if (!bookId) return;
    const opts = options || {};
    const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    const list = snapshotsRef.current;
    const last = list.length ? list[list.length - 1] : null;
    if (!opts.force && !shouldSnapshot({ nowMs: nowMs, lastCreatedAt: last ? last.createdAt : null, intervalMs: SNAPSHOT_INTERVAL_MS })) return;
    const result = await createSnapshot(bookId, payload, opts.reason || 'interval', {
      nowMs: nowMs,
      existing: list,
      force: !!opts.force,
      note: opts.note,
    });
    applySnapshotResult(result);
    if (result.created) refreshQuota();
  }, [bookId, applySnapshotResult, refreshQuota]);

  const flushSave = useCallback(async () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (!bookId || !pendingRef.current) return null;
    if (!loadedRef.current) { pendingRef.current = false; return null; }
    pendingRef.current = false;
    const payload = currentPayload();
    const bus = busRef.current;
    if (bus && !bus.isWriter(bookId)) {
      // 本标签页已不是写者：丢弃待发内容，改用另一个标签页的最新数据
      setCanWrite(false);
      return null;
    }
    setSaving(true);
    try {
      const row = await writeLiveData(bookId, payload);
      setLive({ events: row.events, templates: row.templates, rev: row.rev });
      if (bus) bus.broadcast(MSG.data, { bookId: bookId, rev: row.rev });
      if (backupRef.current) await backupRef.current.syncLatest(bookRef.current, payload);
      await maybeSnapshot(payload);
      return row;
    } catch (err) {
      setStorageError(err && err.message ? err.message : String(err));
      return null;
    } finally {
      setSaving(false);
    }
  }, [bookId, currentPayload, maybeSnapshot]);

  const scheduleSave = useCallback(() => {
    if (!bookId || !loadedRef.current) return;
    pendingRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { flushSave(); }, SAVE_DEBOUNCE_MS);
  }, [bookId, flushSave]);

  const onEventsChange = useCallback((events) => {
    eventsRef.current = events;
    if (skipSaveRef.current > 0) { skipSaveRef.current -= 1; return; }
    scheduleSave();
  }, [scheduleSave]);

  const onTemplatesChange = useCallback((templates) => {
    templatesRef.current = templates;
    if (skipSaveRef.current > 0) { skipSaveRef.current -= 1; return; }
    scheduleSave();
  }, [scheduleSave]);

  // 开始编辑即接管写者身份（后开始编辑的标签页胜出，另一个转为只读）
  const claimWrite = useCallback(() => {
    if (!bookId) return false;
    const bus = busRef.current;
    if (!bus) return true;
    bus.claim(bookId);
    if (!bus.isWriter(bookId)) return false;
    setCanWrite(true);
    return true;
  }, [bookId]);

  // —— 载入当前 book ——
  useEffect(() => {
    let cancelled = false;
    skipSaveRef.current = 0;
    loadedRef.current = false;
    setPreview(null);
    if (!bookId) {
      loadedRef.current = true;
      eventsRef.current = [];
      templatesRef.current = [];
      snapshotsRef.current = [];
      setLive({ events: [], templates: [], rev: 0 });
      setSnapshots([]);
      setLoadedId(null);
      setLoading(false);
      return () => { cancelled = true; };
    }
    setLoading(true);
    (async () => {
      try {
        const row = await readLiveData(bookId);
        const snaps = await listSnapshots(bookId);
        if (cancelled) return;
        loadedRef.current = true;
        eventsRef.current = row.events;
        templatesRef.current = row.templates;
        snapshotsRef.current = snaps;
        setLive(row);
        setSnapshots(snaps);
        setStorageError(null);
        const last = snaps.length ? snaps[snaps.length - 1] : null;
        const hasContent = row.events.length > 0 || row.templates.length > 0;
        if (hasContent && needsStartupSnapshot({ nowMs: Date.now(), lastCreatedAt: last ? last.createdAt : null })) {
          // 标签页关掉期间也可能编辑过（别的设备/别的浏览器），补一份，避免历史出现空洞
          const result = await createSnapshot(bookId, { events: row.events, templates: row.templates }, 'startup', { existing: snaps });
          if (!cancelled) applySnapshotResult(result);
        }
      } catch (err) {
        if (!cancelled) setStorageError(err && err.message ? err.message : String(err));
      } finally {
        if (!cancelled) {
          setLoadedId(bookId);
          setLoading(false);
          requestPersistence();
          refreshQuota();
        }
      }
    })();
    return () => {
      cancelled = true;
      // 切书 / 关页前把防抖窗口里的编辑落盘，避免最后 500ms 丢失
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      if (pendingRef.current) flushSave();
    };
  }, [bookId, applySnapshotResult, refreshQuota, flushSave]);
  // —— 跨标签页总线 ——
  useEffect(() => {
    const bus = createBus();
    busRef.current = bus;
    const off = bus.on((msg) => {
      if (msg.type === MSG.claim || msg.type === MSG.release || msg.type === MSG.books) {
        setCanWrite(bookId ? bus.isWriter(bookId) : true);
        return;
      }
      if (msg.fromSelf) return;
      const payload = msg.payload || {};
      if (msg.type === MSG.data && bookId && payload.bookId === bookId && !bus.isWriter(bookId)) {
        (async () => {
          try {
            const row = await readLiveData(bookId);
            loadedRef.current = true;
            eventsRef.current = row.events;
            templatesRef.current = row.templates;
            skipSaveRef.current = 2;      // 远端数据回填不回写，否则会乒乓
            setLive(row);
            setRemoteSeed({ events: row.events, templates: row.templates, token: Date.now() });
          } catch (err) {
            setStorageError(err && err.message ? err.message : String(err));
          }
        })();
        return;
      }
      if (msg.type === MSG.snapshots && bookId && (!payload.bookId || payload.bookId === bookId)) {
        listSnapshots(bookId).then((snaps) => {
          snapshotsRef.current = snaps;
          setSnapshots(snaps);
        }).catch(() => { /* 忽略 */ });
      }
    });
    return () => { off(); bus.destroy(); busRef.current = null; };
  }, [bookId]);

  // —— 常驻任务：定期淘汰 + 切到后台时抢救 ——
  useEffect(() => {
    if (!bookId) return undefined;
    const sweep = setInterval(() => {
      pruneSnapshots(bookId, Date.now()).then((res) => {
        snapshotsRef.current = res.snapshots;
        setSnapshots(res.snapshots);
        const bk = bookRef.current;
        if (bk && backupRef.current) res.removed.forEach((s) => backupRef.current.dropSnapshot(bk, s));
      }).catch(() => { /* 忽略 */ });
    }, RETENTION_SWEEP_MS);
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') return;
      Promise.resolve(flushSave()).then(() => maybeSnapshot(currentPayload())).catch(() => { /* 忽略 */ });
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(sweep);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [bookId, flushSave, maybeSnapshot, currentPayload]);

  const refreshSnapshots = useCallback(async () => {
    if (!bookId) return [];
    const snaps = await listSnapshots(bookId);
    snapshotsRef.current = snaps;
    setSnapshots(snaps);
    return snaps;
  }, [bookId]);

  // 立即存档：内容未变时不产生重复快照（沿用旧 writeData 的逐字比对语义）
  const snapshotNow = useCallback(async () => {
    if (!bookId) return null;
    await flushSave();
    const result = await createSnapshot(bookId, currentPayload(), 'manual', { existing: snapshotsRef.current });
    applySnapshotResult(result);
    await refreshQuota();
    return result;
  }, [bookId, flushSave, currentPayload, applySnapshotResult, refreshQuota]);

  // 追加式恢复：① 先把当前内容存成 pre-restore（绝不丢）② 交出目标版本内容交给 UI 应用
  const restoreToSnapshot = useCallback(async (snapshot) => {
    if (!bookId || !snapshot || !snapshot.payload) return null;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    await flushSave();
    const guard = await createSnapshot(bookId, currentPayload(), 'pre-restore', {
      existing: snapshotsRef.current,
      force: true,
      note: snapshot.id,
    });
    applySnapshotResult(guard);
    return {
      events: Array.isArray(snapshot.payload.events) ? snapshot.payload.events : [],
      templates: Array.isArray(snapshot.payload.templates) ? snapshot.payload.templates : [],
    };
  }, [bookId, flushSave, currentPayload, applySnapshotResult]);

  // ③ 恢复完成后把新状态也记进历史链（reason=restored-from，可再次追溯）
  const finishRestore = useCallback(async (sourceSnapshotId) => {
    if (!bookId) return null;
    await flushSave();
    const result = await createSnapshot(bookId, currentPayload(), 'restored-from', {
      existing: snapshotsRef.current,
      force: true,
      note: sourceSnapshotId,
    });
    applySnapshotResult(result);
    setPreview(null);
    await refreshQuota();
    return result;
  }, [bookId, flushSave, currentPayload, applySnapshotResult, refreshQuota]);

  const openPreview = useCallback((snapshot) => setPreview(snapshot || null), []);
  const closePreview = useCallback(() => setPreview(null), []);

  return {
    events: live.events,
    templates: live.templates,
    rev: live.rev,
    // 就绪 = 不在载入中 且 已载入的就是当前这本（见上面 loadedId 的注释）
    loading: loading || loadedId !== bookId,
    saving: saving,
    storageError: storageError,
    snapshots: snapshots,
    preview: preview,
    canWrite: canWrite,
    quota: quota,
    remoteSeed: remoteSeed,
    onEventsChange: onEventsChange,
    onTemplatesChange: onTemplatesChange,
    claimWrite: claimWrite,
    flushSave: flushSave,
    snapshotNow: snapshotNow,
    refreshSnapshots: refreshSnapshots,
    restoreToSnapshot: restoreToSnapshot,
    finishRestore: finishRestore,
    openPreview: openPreview,
    closePreview: closePreview,
  };
}