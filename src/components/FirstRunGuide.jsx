import React, { useRef, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { LANGS } from '../i18n/core.js';
import { defaultWeekStartsOn } from '../storage/books.js';
import WeekStartPicker from './WeekStartPicker.jsx';

const screenStyle = {
  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: '24px', overflowY: 'auto', background: 'var(--color-bg)',
};
const cardStyle = {
  width: '560px', maxWidth: '100%', background: 'var(--color-surface)',
  border: '1px solid var(--color-border)', borderRadius: '14px', boxShadow: 'var(--shadow-lg)',
  padding: '30px',
};
const logoStyle = { fontSize: '30px', marginBottom: '6px' };
const titleStyle = { fontSize: '21px', fontWeight: 700, marginBottom: '8px' };
const introStyle = { fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: 1.7, marginBottom: '22px' };
const fieldStyle = { marginBottom: '18px' };
const labelStyle = { display: 'block', fontSize: '13px', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: '6px' };
const inputStyle = {
  width: '100%', padding: '10px 12px', border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius)', fontSize: '14px',
};
const selectStyle = { ...inputStyle, cursor: 'pointer', fontFamily: 'inherit' };
const primaryStyle = {
  width: '100%', padding: '12px', borderRadius: 'var(--radius)', background: 'var(--color-accent)',
  color: '#fff', fontWeight: 700, fontSize: '14px',
};
const dividerStyle = { display: 'flex', alignItems: 'center', gap: '10px', margin: '20px 0', fontSize: '11px', color: 'var(--color-text-secondary)' };
const lineStyle = { flex: 1, height: '1px', background: 'var(--color-border)' };
const altRowStyle = { display: 'flex', gap: '8px', flexWrap: 'wrap' };
const altBtnStyle = {
  flex: 1, minWidth: '200px', padding: '11px 12px', borderRadius: 'var(--radius)',
  background: 'var(--color-bg)', border: '1px solid var(--color-border)',
  color: 'var(--color-text)', fontSize: '13px', fontWeight: 500,
};
const hintStyle = { fontSize: '11px', color: 'var(--color-text-secondary)', marginTop: '8px', lineHeight: 1.7 };
const footnoteStyle = {
  marginTop: '22px', paddingTop: '14px', borderTop: '1px solid var(--color-border)',
  fontSize: '11px', color: 'var(--color-text-secondary)', textAlign: 'center', lineHeight: 1.7,
};

export default function FirstRunGuide({ legacy, legacyBusy, onCreate, onRestoreFile, onImportLocal }) {
  const { lang, setLanguage, tr } = useI18n();
  const [name, setName] = useState('');
  const [weekStartsOn, setWeekStartsOn] = useState(() => defaultWeekStartsOn(lang));
  const [weekTouched, setWeekTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const legacyCount = legacy && Array.isArray(legacy.events) ? legacy.events.length : 0;

  const pickWeekStart = (day) => {
    setWeekTouched(true);
    setWeekStartsOn(day);
  };

  const changeLang = (next) => {
    setLanguage(next);
    if (!weekTouched) setWeekStartsOn(defaultWeekStartsOn(next));
  };

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onCreate({ name: name.trim(), language: lang, weekStartsOn });
    } finally {
      setBusy(false);
    }
  };

  const handleFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file || busy) return;
    setBusy(true);
    try { await onRestoreFile(file); } finally { setBusy(false); }
  };

  const importLocal = async () => {
    if (busy) return;
    setBusy(true);
    try { await onImportLocal(); } finally { setBusy(false); }
  };

  return (
    <div style={screenStyle}>
      <div style={cardStyle}>
        <div style={logoStyle}>{'📅'}</div>
        <div style={titleStyle}>{tr('firstRun.title')}</div>
        <div style={introStyle}>
          {tr('firstRun.intro')}
          {' '}
          {tr('app.localBadge')}
        </div>

        <div style={fieldStyle}>
          <label style={labelStyle}>{tr('firstRun.name')}</label>
          <input style={inputStyle} value={name} maxLength={40} onChange={(e) => setName(e.target.value)}
            placeholder={tr('firstRun.namePlaceholder')} autoFocus />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>{tr('firstRun.weekStart')}</label>
          <WeekStartPicker value={weekStartsOn} onChange={pickWeekStart} />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>{tr('firstRun.language')}</label>
          <select style={selectStyle} value={lang} onChange={(e) => changeLang(e.target.value)}>
            {LANGS.map((l) => (<option key={l.code} value={l.code}>🌐 {l.name}</option>))}
          </select>
        </div>

        <button style={primaryStyle} onClick={create} disabled={busy}>{tr('firstRun.create')}</button>

        <div style={dividerStyle}>
          <span style={lineStyle} />
          <span>{'📥'}</span>
          <span style={lineStyle} />
        </div>

        <div style={altRowStyle}>
          <button style={altBtnStyle} onClick={() => fileRef.current && fileRef.current.click()} disabled={busy}>
            {tr('firstRun.fromBackup')}
          </button>
          <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={handleFile} />
          {legacyCount > 0 && (
            <button style={altBtnStyle} onClick={importLocal} disabled={busy || legacyBusy}>
              {tr('firstRun.localImport')}
            </button>
          )}
        </div>
        <div style={hintStyle}>
          {legacyCount > 0
            ? tr('firstRun.localFound', { n: legacyCount })
            : (legacy === undefined ? tr('app.loading') : tr('firstRun.localNone'))}
        </div>

        <div style={footnoteStyle}>{tr('firstRun.footnote')}</div>
      </div>
    </div>
  );
}
