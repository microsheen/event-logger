import React, { useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { LANGS } from '../i18n/core.js';
import WeekStartPicker from './WeekStartPicker.jsx';
import { BUILD_ID } from '../buildInfo.js';

const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 1000, backdropFilter: 'blur(2px)',
};
const dialogStyle = {
  background: 'var(--color-surface)', borderRadius: '12px', padding: '28px',
  width: '520px', maxWidth: '90vw', boxShadow: 'var(--shadow-lg)',
  maxHeight: '90vh', overflowY: 'auto',
};
const titleStyle = { fontSize: '18px', fontWeight: 700, marginBottom: '18px' };
const fieldStyle = { marginBottom: '16px' };
const labelStyle = { display: 'block', fontSize: '13px', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: '6px' };
const hintStyle = { fontSize: '12px', color: 'var(--color-text-secondary)', marginTop: '6px', lineHeight: 1.6 };
const inputStyle = {
  width: '100%', padding: '10px 12px', border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius)', fontSize: '14px',
};
const selectStyle = { ...inputStyle, cursor: 'pointer', fontFamily: 'inherit' };
const actionRowStyle = { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '22px' };
const primaryBtnStyle = { padding: '10px 24px', borderRadius: 'var(--radius)', background: 'var(--color-accent)', color: '#fff', fontWeight: 600 };
const primaryDisabledStyle = { ...primaryBtnStyle, background: 'var(--color-border)', cursor: 'not-allowed' };
const cancelBtnStyle = {
  padding: '10px 24px', borderRadius: 'var(--radius)',
  background: 'var(--color-bg)', color: 'var(--color-text)', border: '1px solid var(--color-border)',
};
const metaStyle = { fontSize: '11px', color: 'var(--color-text-secondary)', borderTop: '1px solid var(--color-border)', paddingTop: '12px', marginTop: '4px' };

export default function BookSettingsDialog({ book, onClose, onSave }) {
  const { tr } = useI18n();
  const [name, setName] = useState(book.name);
  const [language, setLanguage] = useState(book.settings.language);
  const [weekStartsOn, setWeekStartsOn] = useState(book.settings.weekStartsOn);
  const [busy, setBusy] = useState(false);

  const dirty = name !== book.name || language !== book.settings.language || weekStartsOn !== book.settings.weekStartsOn;

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await onSave({ name, settings: { language, weekStartsOn } });
    setBusy(false);
    if (!ok) return;
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={dialogStyle} onClick={(e) => e.stopPropagation()}>
        <div style={titleStyle}>{tr('book.settingsTitle')}</div>
        <div style={fieldStyle}>
          <label style={labelStyle}>{tr('book.name')}</label>
          <input style={inputStyle} value={name} maxLength={40}
            placeholder={tr('book.namePlaceholder')}
            onChange={(e) => setName(e.target.value)} />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>{tr('book.weekStart')}</label>
          <WeekStartPicker value={weekStartsOn} onChange={setWeekStartsOn} />
          <div style={hintStyle}>{tr('book.weekStartHint')}</div>
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>{tr('book.language')}</label>
          <select style={selectStyle} value={language} onChange={(e) => setLanguage(e.target.value)}>
            {LANGS.map((l) => (<option key={l.code} value={l.code}>🌐 {l.name}</option>))}
          </select>
          <div style={hintStyle}>{tr('book.languageHint')}</div>
        </div>
        <div style={metaStyle} data-build={BUILD_ID}>
          {'🆔'} {book.id.slice(0, 8)} · {'🕒'} {new Date(book.createdAt).toLocaleDateString()} · {'📦'} {BUILD_ID}
        </div>
        <div style={actionRowStyle}>
          <button style={cancelBtnStyle} onClick={onClose}>{tr('common.cancel')}</button>
          <button style={dirty && !busy ? primaryBtnStyle : primaryDisabledStyle} disabled={!dirty || busy} onClick={submit}>
            {tr('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
