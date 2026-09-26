import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isFolderSupported,
  pickBackupRoot,
  getBackupRoot,
  forgetBackupRoot,
  checkPermission,
  writeManifest,
  writeLatest,
  mirrorSnapshot,
  unmirrorSnapshot,
  removeBookFolder,
  resyncTree,
} from '../storage/folderBackup.js';

// 「备份到本地文件夹」的开关与守护：未选择文件夹或权限被收回时，所有写盘动作安静地跳过。
export function useBackupFolder() {
  const supported = useRef(isFolderSupported()).current;
  const [handle, setHandle] = useState(null);
  const [permission, setPermission] = useState('none');
  const [lastError, setLastError] = useState(null);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  // 句柄与权限的「当前值」镜像。写路径一律读它，不读闭包里的 state：
  // 「选完新文件夹 → 立刻整链重推」发生在同一次事件里，那时 setState 还没生效，
  // 闭包里的 handle 仍是旧的（或 null），重推就会写进老地方、或者干脆安静跳过。
  const stateRef = useRef({ handle: null, permission: 'none' });

  const applyState = useCallback((nextHandle, nextPermission) => {
    stateRef.current = { handle: nextHandle, permission: nextPermission };
    setHandle(nextHandle);
    setPermission(nextPermission);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!supported) return;
      let stored = null;
      try { stored = await getBackupRoot(); } catch (err) { return; }
      if (!stored || cancelled) return;
      const state = await checkPermission(stored, false);
      if (cancelled) return;
      applyState(stored, state || 'prompt');
    })();
    return () => { cancelled = true; };
  }, [supported, applyState]);

  const active = !!handle && permission === 'granted';
  const needsPermission = !!handle && permission !== 'granted';

  // 返回 { ok, cancelled, state }：用户在系统弹窗里按「取消」是常态，
  // 必须安静地当成「什么都没发生」，不能冒成未处理的 rejection。
  const select = useCallback(async () => {
    let picked = null;
    try {
      picked = await pickBackupRoot();
    } catch (err) {
      const name = err && err.name ? err.name : '';
      if (name === 'AbortError' || name === 'NotAllowedError') return { ok: false, cancelled: true, state: 'cancelled' };
      setLastError('pick: ' + (err && err.message ? err.message : String(err)));
      return { ok: false, cancelled: false, state: 'denied' };
    }
    const state = await checkPermission(picked, true);
    applyState(picked, state || 'granted');
    setLastError(null);
    return { ok: (state || 'granted') === 'granted', cancelled: false, state: state || 'granted' };
  }, [applyState]);

  const grant = useCallback(async () => {
    const current = stateRef.current.handle;
    if (!current) return { ok: false, state: 'denied' };
    const state = await checkPermission(current, true);
    applyState(current, state || 'denied');
    if ((state || 'denied') === 'granted') setLastError(null);
    return { ok: (state || 'denied') === 'granted', state: state || 'denied' };
  }, [applyState]);

  // 断开只是不再写：目标文件夹里的既有文件一个都不动（那是用户自己的副本）
  const forget = useCallback(async () => {
    await forgetBackupRoot();
    applyState(null, 'none');
    setLastError(null);
  }, [applyState]);

  // 统一包装：失败只记录，绝不打断编辑
  const guard = useCallback(async (label, fn) => {
    const cur = stateRef.current;
    if (!cur.handle || cur.permission !== 'granted') return { ok: false, skipped: true };
    try {
      const value = await fn(cur.handle);
      setLastSyncAt(Date.now());
      setLastError(null);
      return { ok: true, value: value };
    } catch (err) {
      setLastError(label + ': ' + (err && err.message ? err.message : String(err)));
      return { ok: false, error: err };
    }
  }, []);

  // 供编排层判断「现在动手有没有意义」（例如整链重推前先问一句），读 ref 而非 state
  const canMirror = useCallback(() => {
    const cur = stateRef.current;
    return !!cur.handle && cur.permission === 'granted';
  }, []);

  const syncManifest = useCallback((entries) => guard('manifest', (h) => writeManifest(h, entries)), [guard]);
  const syncLatest = useCallback((book, payload, options) => guard('latest', (h) => writeLatest(h, book, payload, options)), [guard]);
  const syncSnapshot = useCallback((book, snapshot) => guard('snapshot', (h) => mirrorSnapshot(h, book, snapshot)), [guard]);
  const dropSnapshot = useCallback((book, snapshot) => guard('prune', (h) => unmirrorSnapshot(h, book, snapshot)), [guard]);
  const dropBook = useCallback((book) => guard('remove-book', (h) => removeBookFolder(h, book)), [guard]);
  const resyncAll = useCallback((entries) => guard('resync', (h) => resyncTree(h, entries)), [guard]);

  return {
    supported,
    active,
    rootName: handle ? (handle.name || '') : '',
    needsPermission,
    permission,
    lastError,
    lastSyncAt,
    select,
    grant,
    forget,
    canMirror,
    syncManifest,
    syncLatest,
    syncSnapshot,
    dropSnapshot,
    dropBook,
    resyncAll,
  };
}
