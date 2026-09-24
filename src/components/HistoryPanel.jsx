import React, { useCallback, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { relativeTime, absoluteTimeLabel } from '../i18n/format.js';
import { snapshotStats } from '../storage/snapshots.js';
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
  open, onClose, book, snapshots, previewId, onPreview, onExitPreview, onRestore, onArchiveNow, quota, backup,
}) {
  const { lang, tr } = useI18n();
  const [busy, setBusy] = useState(false);
  const [restoreId, setRestoreId] = useState(null);

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
          <button style={primaryBtnStyle} onClick={doArchive} disabled={busy} data-action="archive-now">{tr('history.archiveNow')}</button>
          {quota && (
            <div style={noteStyle}>
              {tr('history.quota', { used: formatBytes(quota.usage) + ' (' + formatPercent(quota.ratio) + ')', total: formatBytes(quota.quota) })}
              {' · '}
              {tr('history.quotaHint')}
            </div>
          )}
          <div style={{ borderTop: '1px dashed var(--color-border)', paddingTop: '8px' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>{tr('folder.title')}</div>
            {!backup.supported ? (
              <div style={noteStyle}>{tr('folder.unsupported')}</div>
            ) : backup.active ? (
              <div style={noteStyle}>
                {tr('folder.connected', { name: backup.rootName })}
                {' · '}
                {backup.lastSyncAt ? tr('folder.lastSync', { time: relativeTime(backup.lastSyncAt, lang) }) : tr('folder.none')}
                {' · '}
                {tr('history.mirrored')}
                <div style={{ marginTop: '6px' }}>
                  <button style={ghostBtnStyle} onClick={backup.forget}>{tr('folder.forget')}</button>
                </div>
              </div>
            ) : (
              <div style={noteStyle}>
                {tr('folder.intro')}
                <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                  <button style={ghostBtnStyle} onClick={backup.select}>{tr('folder.pick')}</button>
                  {backup.needsPermission && (
                    <button style={ghostBtnStyle} onClick={backup.grant}>{tr('folder.grant')}</button>
                  )}
                </div>
              </div>
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
