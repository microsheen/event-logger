import React, { Fragment, useCallback, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { relativeTime, absoluteTimeLabel } from '../i18n/format.js';
import { snapshotStats } from '../storage/snapshots.js';
import { bookSlug } from '../storage/books.js';
import { ROOT_DIR_NAME, LATEST_FILE_NAME, SNAPSHOT_DIR_NAME } from '../storage/folderBackup.js';
import { formatBytes, formatPercent } from '../utils/size.js';

const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.28)', zIndex: 900,
  display: 'flex', justifyContent: 'flex-end',
};
const panelStyle = {
  width: '420px', maxWidth: '92vw', height: '100%', background: 'var(--color-surface)',
  boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column',
};
const headStyle = { padding: '16px 18px', borderBottom: '1px solid var(--color-border)', flexShrink: 0 };
const titleRowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' };
const titleStyle = { fontSize: '16px', fontWeight: 700 };
const subStyle = { fontSize: '12px', color: 'var(--color-text-secondary)', marginTop: '4px' };
const closeBtnStyle = { background: 'transparent', fontSize: '18px', color: 'var(--color-text-secondary)', padding: '0 6px' };
const toolbarStyle = { padding: '12px 18px', borderBottom: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', gap: '8px', flexShrink: 0 };
const toolRowStyle = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' };
const primaryBtnStyle = {
  padding: '9px 14px', borderRadius: 'var(--radius)', background: 'var(--color-accent)',
  color: '#fff', fontWeight: 600, fontSize: '13px',
};
const ghostBtnStyle = {
  padding: '6px 10px', borderRadius: 'var(--radius)', background: 'var(--color-bg)',
  border: '1px solid var(--color-border)', color: 'var(--color-text)', fontSize: '12px',
};
const noteStyle = { fontSize: '11px', color: 'var(--color-text-secondary)', lineHeight: 1.6 };
const errorStyle = {
  fontSize: '11px', color: 'var(--color-danger)', background: 'var(--color-danger-light)',
  borderRadius: '6px', padding: '6px 8px', lineHeight: 1.6, wordBreak: 'break-all',
};
const mirrorBoxStyle = { borderTop: '1px dashed var(--color-border)', paddingTop: '8px' };
const mirrorHeadStyle = { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', fontWeight: 600, marginBottom: '4px' };
const mirrorOkStyle = { fontSize: '11px', color: 'var(--color-accent)', lineHeight: 1.6, marginTop: '6px' };
const mirrorRowStyle = { display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' };
// 镜像状态的四个取值同时是 data-mirror-state 的契约（smoke 第 16 步按它断言）
const MIRROR_PILL = { on: 'history.mirrored', permission: 'folder.statePermission', off: 'folder.none', unsupported: 'folder.stateUnsupported' };
const MIRROR_TONE = { on: 'lock', permission: 'danger', off: '', unsupported: '' };
const listStyle = { flex: 1, overflowY: 'auto', padding: '6px 0' };
const rowStyle = (active) => ({
  padding: '10px 18px', borderBottom: '1px solid var(--color-border)',
  background: active ? 'var(--color-danger-light)' : 'transparent',
  cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '4px',
});
const rowTopStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' };
const timeStyle = { fontSize: '13px', fontWeight: 600 };
const tagStyle = (tone) => ({
  fontSize: '10px', padding: '1px 7px', borderRadius: '9px', fontWeight: 700,
  background: tone === 'danger' ? 'var(--color-danger)' : tone === 'lock' ? 'var(--color-accent)' : 'var(--color-accent-light)',
  color: tone === 'danger' || tone === 'lock' ? '#fff' : 'var(--color-accent)',
});
const metaRowStyle = { display: 'flex', gap: '8px', fontSize: '11px', color: 'var(--color-text-secondary)', flexWrap: 'wrap' };
const actionRowStyle = { display: 'flex', gap: '6px', marginTop: '2px' };
const emptyStyle = { padding: '32px 18px', textAlign: 'center', fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: 1.7 };

function reasonKey(reason) {
  const parts = String(reason || 'interval').split('-');
  const tail = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  return 'history.reason' + tail;
}

export default function HistoryPanel({
  open, onClose, book, snapshots, previewId, onPreview, onExitPreview, onRestore, onArchiveNow, quota, backup, onMirrorAll, onExportAll,
}) {
  const { lang, tr } = useI18n();
  const [busy, setBusy] = useState(false);
  const [restoreId, setRestoreId] = useState(null);
  const [mirrorBusy, setMirrorBusy] = useState(false);
  const [mirrorNote, setMirrorNote] = useState(null);   // { tone: 'ok' | 'err', text }
  const [exportBusy, setExportBusy] = useState(false);

  const list = snapshots || [];
  const stats = snapshotStats(list);
  const rows = list.slice().reverse();   // 最新的排最前

  const doArchive = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try { await onArchiveNow(); } finally { setBusy(false); }
  }, [busy, onArchiveNow]);

  const askRestore = useCallback((snapshot) => {
    setRestoreId(snapshot.id);
  }, []);

  const confirmRestore = useCallback(async (snapshot) => {
    setRestoreId(null);
    if (busy) return;
    setBusy(true);
    try { await onRestore(snapshot); } finally { setBusy(false); }
  }, [busy, onRestore]);

  // 镜像文件夹：查看（连到哪儿、上次镜像、落在磁盘什么位置）+ 修改（选、换、再授权、补齐、断开）
  // 导出全部：与镜像无关的兜底通路，任何浏览器都能用（Firefox / Safari 不支持文件夹镜像）
  const doExportAll = useCallback(async () => {
    if (exportBusy || !onExportAll) return;
    setExportBusy(true);
    try { await onExportAll(); } finally { setExportBusy(false); }
  }, [exportBusy, onExportAll]);

  const mirrorState = !backup.supported ? 'unsupported' : (backup.active ? 'on' : (backup.needsPermission ? 'permission' : 'off'));

  const resync = useCallback(async () => {
    const result = onMirrorAll ? await onMirrorAll() : null;
    if (!result) { setMirrorNote({ tone: 'err', text: tr('folder.resyncBlocked') }); return; }
    setMirrorNote({ tone: 'ok', text: tr('folder.resyncDone', { books: result.books, snapshots: result.snapshots }) });
  }, [onMirrorAll, tr]);

  const runMirror = useCallback(async (action) => {
    if (mirrorBusy) return;
    setMirrorBusy(true);
    setMirrorNote(null);
    try {
      if (action === 'pick') {
        const picked = await backup.select();
        if (picked.cancelled) return;                       // 用户在系统弹窗里按了取消：什么都没发生
        if (!picked.ok) { setMirrorNote({ tone: 'err', text: tr('folder.needPermission') }); return; }
      } else if (action === 'grant') {
        const granted = await backup.grant();
        if (!granted.ok) { setMirrorNote({ tone: 'err', text: tr('folder.needPermission') }); return; }
      } else if (action === 'forget') {
        await backup.forget();                              // 只断连接：磁盘上的副本一个都不动
        return;
      }
      await resync();                                       // 选完 / 授权完立刻整链补齐，别留一个近乎空的文件夹
    } finally {
      setMirrorBusy(false);
    }
  }, [mirrorBusy, backup, resync, tr]);

  if (!open) return null;

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headStyle}>
          <div style={titleRowStyle}>
            <div style={titleStyle}>{tr('history.title')}</div>
            <button style={closeBtnStyle} onClick={onClose} aria-label={tr('common.close')} data-action="panel-close">{'✕'}</button>
          </div>
          <div style={subStyle}>
            {book.name} · {tr('history.subtitle', { count: stats.count, size: formatBytes(stats.bytes) })}
          </div>
        </div>

        <div style={toolbarStyle}>
          <div style={toolRowStyle}>
            <button style={primaryBtnStyle} onClick={doArchive} disabled={busy} data-action="archive-now">{tr('history.archiveNow')}</button>
            {onExportAll && (
              <button style={ghostBtnStyle} onClick={doExportAll} disabled={busy || exportBusy} data-action="export-all" title={tr('history.exportAllHint')}>{exportBusy ? tr('history.exporting') : tr('history.exportAll')}</button>
            )}
          </div>
          {quota && (
            <div style={noteStyle}>
              {tr('history.quota', { used: formatBytes(quota.usage) + ' (' + formatPercent(quota.ratio) + ')', total: formatBytes(quota.quota) })}
              {' · '}
              {tr('history.quotaHint')}
            </div>
          )}
          <div style={mirrorBoxStyle} data-mirror-state={mirrorState}>
            <div style={mirrorHeadStyle}>
              <span>{tr('folder.title')}</span>
              <span style={tagStyle(MIRROR_TONE[mirrorState])}>{tr(MIRROR_PILL[mirrorState])}</span>
            </div>
            {mirrorState === 'unsupported' && (
              <div style={noteStyle}>{tr('folder.unsupported')}</div>
            )}
            {mirrorState !== 'unsupported' && (
              <Fragment>
                {mirrorState === 'on' && (
                  <div style={noteStyle}>
                    {tr('folder.connected', { name: backup.rootName })}
                    {' · '}
                    {backup.lastSyncAt ? tr('folder.lastSync', { time: relativeTime(backup.lastSyncAt, lang) }) : tr('folder.none')}
                  </div>
                )}
                {mirrorState === 'permission' && (
                  <div style={noteStyle}>{tr('folder.needPermission')}</div>
                )}
                {mirrorState === 'off' && (
                  <div style={noteStyle}>{tr('folder.intro')} {'·'} {tr('history.browserOnly')}</div>
                )}
                <div style={noteStyle}>
                  {tr('folder.path', { root: ROOT_DIR_NAME, book: book ? bookSlug(book) : '-', latest: LATEST_FILE_NAME, snapshots: SNAPSHOT_DIR_NAME })}
                </div>
                <div style={noteStyle}>{tr('folder.chain', { count: stats.count })}</div>
                <div style={mirrorRowStyle}>
                  {(mirrorState === 'off' || mirrorState === 'permission') && (
                    <button style={ghostBtnStyle} data-action="mirror-pick" disabled={mirrorBusy} onClick={() => runMirror('pick')}>{tr('folder.pick')}</button>
                  )}
                  {mirrorState === 'permission' && (
                    <button style={ghostBtnStyle} data-action="mirror-grant" disabled={mirrorBusy} onClick={() => runMirror('grant')}>{tr('folder.grant')}</button>
                  )}
                  {mirrorState === 'on' && (
                    <Fragment>
                      <button style={ghostBtnStyle} data-action="mirror-resync" disabled={mirrorBusy} onClick={() => runMirror('resync')}>{mirrorBusy ? tr('folder.mirroring') : tr('folder.resync')}</button>
                      <button style={ghostBtnStyle} data-action="mirror-reselect" disabled={mirrorBusy} onClick={() => runMirror('pick')}>{tr('folder.reselect')}</button>
                    </Fragment>
                  )}
                  {(mirrorState === 'on' || mirrorState === 'permission') && (
                    <button style={ghostBtnStyle} data-action="mirror-forget" disabled={mirrorBusy} onClick={() => runMirror('forget')}>{tr('folder.forget')}</button>
                  )}
                </div>
                {mirrorNote && (
                  <div style={mirrorNote.tone === 'ok' ? mirrorOkStyle : { ...errorStyle, marginTop: '6px' }}>{mirrorNote.text}</div>
                )}
              </Fragment>
            )}
            {backup.lastError && <div style={{ ...errorStyle, marginTop: '6px' }}>{tr('folder.failed', { message: backup.lastError })}</div>}
          </div>
        </div>

        <div style={listStyle}>
          {!rows.length ? (
            <div style={emptyStyle}>{tr('history.empty')}</div>
          ) : rows.map((s, index) => {
            const active = previewId === s.id;
            const latest = index === 0;
            return (
              <div key={s.id} data-snap={s.id} style={rowStyle(active)} onClick={() => (active ? onExitPreview() : onPreview(s))}>
                <div style={rowTopStyle}>
                  <span style={timeStyle} title={absoluteTimeLabel(s.createdAt, lang)}>
                    {relativeTime(s.createdAt, lang)}
                  </span>
                  <span style={tagStyle(latest ? 'accent' : 'soft')}>
                    {active ? tr('preview.exit') : latest ? tr('history.latest') : tr(reasonKey(s.reason))}
                  </span>
                </div>
                <div style={metaRowStyle}>
                  <span>{absoluteTimeLabel(s.createdAt, lang)}</span>
                  <span>{tr('history.eventsN', { n: s.eventCount })}</span>
                  <span>{tr('history.templatesN', { n: s.templateCount })}</span>
                  <span>{formatBytes(s.bytes)}</span>
                  {s.protected && <span style={tagStyle('lock')}>{tr('history.locked')}</span>}
                </div>
                {restoreId === s.id ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }} onClick={(e) => e.stopPropagation()}>
                    <div style={{ fontSize: '11px', color: 'var(--color-danger)', lineHeight: 1.6 }}>
                      {tr('history.restoreIntro', {
                        time: absoluteTimeLabel(s.createdAt, lang),
                        events: s.eventCount,
                        templates: s.templateCount,
                      })}
                      {' '}
                      {tr('history.restoreSafety')}
                    </div>
                    <div style={actionRowStyle}>
                      <button style={{ ...primaryBtnStyle, background: 'var(--color-danger)', padding: '6px 12px', fontSize: '12px' }}
                        onClick={() => confirmRestore(s)} disabled={busy} data-action="confirm-restore">{tr('history.restore')}</button>
                      <button style={ghostBtnStyle} onClick={() => setRestoreId(null)} data-action="cancel-restore">{tr('common.cancel')}</button>
                    </div>
                  </div>
                ) : (
                  <div style={actionRowStyle} onClick={(e) => e.stopPropagation()}>
                    <button style={ghostBtnStyle} onClick={() => (active ? onExitPreview() : onPreview(s))} data-action="view">{tr('history.view')}</button>
                    <button style={ghostBtnStyle} onClick={() => askRestore(s)} data-action="ask-restore">{tr('history.restore')}</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
