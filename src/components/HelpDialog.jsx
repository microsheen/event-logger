import React, { useEffect, useRef } from 'react';
import { useI18n } from '../i18n/index.jsx';

// 小节顺序住在组件里而不是字典里：sections 是无序对象，i18n:check 只比键集合与数组长度、比不了顺序，
// 把渲染顺序固定成这里的常量，三语字典就只管「说什么」，不管「先说哪一节」。
const SECTION_ORDER = ['start', 'record', 'adjust', 'view', 'book', 'backup', 'privacy', 'faq'];

const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 1000, backdropFilter: 'blur(2px)',
};
const panelStyle = {
  background: 'var(--color-surface)', borderRadius: '12px',
  width: '720px', maxWidth: '92vw', maxHeight: '86vh',
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
  boxShadow: 'var(--shadow-lg)',
};
const headStyle = {
  display: 'flex', alignItems: 'center', gap: '12px',
  padding: '20px 24px 6px', flexShrink: 0,
};
const titleStyle = { fontSize: '18px', fontWeight: 700, flex: 1 };
const closeBtnStyle = {
  padding: '4px 10px', borderRadius: 'var(--radius)', fontSize: '16px', lineHeight: 1,
  background: 'var(--color-bg)', color: 'var(--color-text)', border: '1px solid var(--color-border)',
};
const introStyle = {
  padding: '0 24px 12px', fontSize: '12.5px', color: 'var(--color-text-secondary)',
  lineHeight: 1.7, flexShrink: 0,
};
const navStyle = {
  display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center',
  padding: '10px 24px', borderTop: '1px solid var(--color-border)',
  borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface)',
  position: 'sticky', top: 0, zIndex: 2, flexShrink: 0,
};
const navLabelStyle = { fontSize: '11px', color: 'var(--color-text-secondary)', marginRight: '4px' };
const chipStyle = {
  padding: '4px 10px', borderRadius: '14px', fontSize: '12px', fontWeight: 500,
  background: 'var(--color-bg)', color: 'var(--color-text)', border: '1px solid var(--color-border)',
};
const chipHoverStyle = { ...chipStyle, background: 'var(--color-accent-light)', borderColor: 'var(--color-accent)', color: 'var(--color-accent)' };
const scrollStyle = { overflowY: 'auto', padding: '6px 24px 8px', flex: 1 };
const sectionStyle = { padding: '14px 0', borderBottom: '1px dashed var(--color-border)', scrollMarginTop: '8px' };
const sectionTitleStyle = { fontSize: '14px', fontWeight: 700, color: 'var(--color-accent)', marginBottom: '8px' };
const listStyle = { listStyle: 'none', padding: 0, margin: 0 };
const liStyle = { fontSize: '12.5px', lineHeight: 1.8, color: 'var(--color-text)', marginBottom: '6px', paddingLeft: '14px', position: 'relative' };
const bulletStyle = { position: 'absolute', left: 0, color: 'var(--color-text-secondary)' };
const footStyle = {
  padding: '12px 24px 18px', fontSize: '11px', color: 'var(--color-text-secondary)',
  textAlign: 'center', flexShrink: 0,
};

// 纯只读的使用指南：不写任何数据，所以顶栏那个入口在只读态（回放历史 / 他页编辑）里也必须能点。
export default function HelpDialog({ open, onClose }) {
  const { tr } = useI18n();
  const sectionRefs = useRef({});
  const [hoverKey, setHoverKey] = React.useState(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const jump = (key) => {
    const el = sectionRefs.current[key];
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()} data-help-dialog
        role="dialog" aria-modal="true" aria-label={tr('help.title')}>
        <div style={headStyle}>
          <div style={titleStyle}>{tr('help.title')}</div>
          <button style={closeBtnStyle} onClick={onClose} data-action="help-close"
            aria-label={tr('common.close')} title={tr('common.close')}>{'✕'}</button>
        </div>
        <div style={introStyle} data-help-intro>{tr('help.intro')}</div>
        <div style={navStyle}>
          <span style={navLabelStyle}>{tr('help.navLabel')}</span>
          {SECTION_ORDER.map((key) => (
            <button key={key} style={hoverKey === key ? chipHoverStyle : chipStyle} data-help-nav={key}
              onMouseEnter={() => setHoverKey(key)} onMouseLeave={() => setHoverKey(null)}
              onClick={() => jump(key)}>
              {tr('help.sections.' + key + '.title')}
            </button>
          ))}
        </div>
        <div style={scrollStyle} data-help-scroll>
          {SECTION_ORDER.map((key) => {
            const lines = tr('help.sections.' + key + '.lines') || [];
            return (
              <div key={key} style={sectionStyle} data-help-section={key}
                ref={(el) => { sectionRefs.current[key] = el; }}>
                <div style={sectionTitleStyle}>{tr('help.sections.' + key + '.title')}</div>
                <ul style={listStyle}>
                  {lines.map((line, i) => (
                    <li key={i} style={liStyle}>
                      <span style={bulletStyle}>{'·'}</span>
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
        <div style={footStyle}>{tr('app.localBadge')}</div>
      </div>
    </div>
  );
}
