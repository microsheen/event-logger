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
} from '../storage/folderBackup.js';

// 「备份到本地文件夹」的开关与守护：未选择文件夹或权限被收回时，所有写盘动作安静地跳过。
export function useBackupFolder() {
  const supported = useRef(isFolderSupported()).current;
  const [handle, setHandle] = useState(null);
  const [permission, setPermission] = useState('none');
  const [lastError, setLastError] = useState(null);
  const [lastSyncAt, setLastSyncAt] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!supported) return;
      let stored = null;
      try { stored = await getBackupRoot(); } catch (err) { return; }
      if (!stored || cancelled) return;
      setHandle(stored);
      const state = await checkPermission(stored, false);
      if (!cancelled) setPermission(state || 'prompt');
    })();
    return () => { cancelled = true; };
  }, [supported]);

  const active = !!handle && permission === 'granted';
  const needsPermission = !!handle && permission !== 'granted';

  const select = useCallback(async () => {
    const picked = await pickBackupRoot();
    const state = await checkPermission(picked, true);
    setHandle(picked);
    setPermission(state || 'granted');
    setLastError(null);
    return picked;
  }, []);

  const grant = useCallback(async () => {
    if (!handle) return 'denied';
    const state = await checkPermission(handle, true);
    setPermission(state || 'denied');
    return state;
  }, [handle]);

  const forget = useCallback(async () => {
    await forgetBackupRoot();
    setHandle(null);
    setPermission('none');
    setLastError(null);
  }, []);

  // 统一包装：失败只记录，绝不打断编辑
  const guard = useCallback(async (label, fn) => {
    if (!handle || permission !== 'granted') return { ok: false, skipped: true };
    try {
      const value = await fn(handle);
      setLastSyncAt(Date.now());
      setLastError(null);
      return { ok: true, value: value };
    } catch (err) {
      setLastError(label + ': ' + (err && err.message ? err.message : String(err)));
      return { ok: false, error: err };
    }
  }, [handle, permission]);

  const syncManifest = useCallback((entries) => guard('manifest', (h) => writeManifest(h, entries)), [guard]);
  const syncLatest = useCallback((book, payload, options) => guard('latest', (h) => writeLatest(h, book, payload, options)), [guard]);
  const syncSnapshot = useCallback((book, snapshot) => guard('snapshot', (h) => mirrorSnapshot(h, book, snapshot)), [guard]);
  const dropSnapshot = useCallback((book, snapshot) => guard('prune', (h) => unmirrorSnapshot(h, book, snapshot)), [guard]);
  const dropBook = useCallback((book) => guard('remove-book', (h) => removeBookFolder(h, book)), [guard]);

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
    syncManifest,
    syncLatest,
    syncSnapshot,
    dropSnapshot,
    dropBook,
  };
}