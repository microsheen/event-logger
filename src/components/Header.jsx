import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { LANGS } from '../i18n/core.js';

const headerStyle = {
  height: 'var(--header-height)', background: 'var(--color-surface)',
  borderBottom: '1px solid var(--color-border)', display: 'flex',
  alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', gap: '12px',
  boxShadow: '0 1px 3px rgba(0,0,0,0.04)', position: 'sticky', top: 0, zIndex: 100,
  flexShrink: 0,
};
const leftGroupStyle = { display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 };
const titleStyle = {
  fontSize: '18px', fontWeight: 700, color: 'var(--color-accent)',
  display: 'flex', alignItems: 'center', gap: '8px', whiteSpace: 'nowrap',
};
const btnGroupStyle = { display: 'flex', gap: '6px', alignItems: 'center' };
const btnStyle = {
  padding: '8px 12px', borderRadius: 'var(--radius)', background: 'var(--color-bg)',
  color: 'var(--color-text)', border: '1px solid var(--color-border)',
  fontSize: '13px', fontWeight: 500, whiteSpace: 'nowrap',
};
const btnHoverStyle = { background: 'var(--color-accent)', color: '#fff', borderColor: 'var(--color-accent)' };
const bookBtnStyle = {
  ...btnStyle, maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis',
  display: 'inline-flex', alignItems: 'center', gap: '6px',
  background: 'var(--color-accent-light)', borderColor: 'var(--color-accent)', color: 'var(--color-accent)', fontWeight: 600,
};
const langSelectStyle = { ...btnStyle, cursor: 'pointer', minWidth: '104px', fontFamily: 'inherit' };
const badgeStyle = {
  fontSize: '11px', color: 'var(--color-text-secondary)', border: '1px dashed var(--color-border)',
  borderRadius: '12px', padding: '3px 9px', whiteSpace: 'nowrap',
};
const menuStyle = {
  position: 'absolute', top: 'calc(100% + 6px)', left: 0, minWidth: '220px',
  background: 'var(--color-surface)', border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)', zIndex: 500,
  padding: '6px 0', fontSize: '13px',
  // 菜单加了「数据与备份」段之后项数变多，限高避免在笔记本上顶出屏幕
  maxHeight: '70vh', overflowY: 'auto',
};
const menuItemStyle = (hovered, disabled) => ({
  padding: '8px 14px', display: 'flex', alignItems: 'center', gap: '8px',
  background: hovered && !disabled ? 'var(--color-accent-light)' : 'transparent',
  color: disabled ? 'var(--color-text-secondary)' : hovered ? 'var(--color-accent)' : 'var(--color-text)',
  opacity: disabled ? 0.5 : 1, cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
});
const menuDividerStyle = { height: '1px', background: 'var(--color-border)', margin: '6px 0' };
const menuLabelStyle = { padding: '4px 14px', fontSize: '11px', color: 'var(--color-text-secondary)' };

function HoverButton({ children, onClick, title, disabled }) {
  const [hovered, setHovered] = useState(false);
  if (disabled) {
    return <button style={{ ...btnStyle, opacity: 0.45, cursor: 'not-allowed' }} title={title} onClick={undefined}>{children}</button>;
  }
  return (
    <button style={hovered ? { ...btnStyle, ...btnHoverStyle } : btnStyle} title={title}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onClick={onClick}>
      {children}
    </button>
  );
}

// 顶栏下拉：点外面或 Esc 关闭，不引入任何组件库
function Dropdown({ label, labelStyle, align, children }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <span style={{ display: 'inline-block' }} role="button" tabIndex={0} aria-haspopup="menu"
        aria-expanded={open} onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); } }}>
        {typeof label === 'function' ? label(open) : label}
      </span>
      {open && (
        <div style={{ ...menuStyle, ...(align === 'right' ? { left: 'auto', right: 0 } : {}) }} role="menu"
          onClick={() => setOpen(false)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setOpen(false); }}>
          {children}
        </div>
      )}
    </div>
  );
}

function MenuItem({ children, onClick, disabled }) {
  const [hovered, setHovered] = useState(false);
  const activate = () => {
    if (disabled) return;
    if (onClick) onClick();
  };
  return (
    <div style={menuItemStyle(hovered, disabled)} role="menuitem" tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onClick={activate} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } }}>
      {children}
    </div>
  );
}

export default function Header({
  book, books, onSelectBook, onCreateBook, onOpenBookSettings, onDeleteBook,
  onExportBook, onExportAll, onImportFile, onOpenTemplates, onOpenHistory, historyCount, locked,
}) {
  const { lang, setLanguage, tr } = useI18n();
  const fileRef = useRef(null);
  const allBooks = books || [];

  // 文件输入框常驻在 header 根节点：Dropdown 关闭会卸载 children，
  // 一旦把 input 挪进菜单，选完文件就收不到 change（表现为「导入点了没反应」）。
  const pickImportFile = () => {
    if (fileRef.current) fileRef.current.click();
  };

  const handleFileChange = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file && onImportFile) onImportFile(file);
  };

  return (
    <header style={headerStyle}>
      <div style={leftGroupStyle}>
        <Dropdown
          align="left"
          label={(open) => (
            <span style={{ ...bookBtnStyle, ...btnHoverStyle, opacity: open ? 1 : 0.92 }}>
              <span style={{ fontSize: '15px' }}>🗂</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{book ? book.name : tr('book.unnamed')}</span>
              <span style={{ fontSize: '10px' }}>{'▾'}</span>
            </span>
          )}
        >
          <div style={menuLabelStyle}>{tr('header.books', { n: allBooks.length })}</div>
          {allBooks.map((b) => (
            <MenuItem key={b.id} onClick={() => onSelectBook(b.id)}>
              <span style={{ width: '14px' }}>{b.id === (book && book.id) ? '✓' : ''}</span>
              <span>{b.name}</span>
            </MenuItem>
          ))}
          <div style={menuDividerStyle} />
          <MenuItem onClick={onCreateBook}>{tr('header.createBook')}</MenuItem>
          <div style={menuDividerStyle} />
          <MenuItem onClick={onOpenBookSettings}>{tr('book.settings')}</MenuItem>
          <MenuItem onClick={onExportBook}>{tr('book.exportOne')}</MenuItem>
          <div style={menuDividerStyle} />
          <div style={menuLabelStyle}>{tr('book.dataLabel')}</div>
          <MenuItem onClick={onExportAll}>{tr('book.exportAll', { n: allBooks.length })}</MenuItem>
          <MenuItem onClick={pickImportFile} disabled={locked}>{tr('book.importFile')}</MenuItem>
          <div style={menuDividerStyle} />
          <MenuItem onClick={onDeleteBook} disabled={allBooks.length <= 1}>{tr('book.remove')}</MenuItem>
        </Dropdown>
        <div style={titleStyle}>
          <span style={{ fontSize: '22px' }}>📅</span>
          {tr('app.title')}
        </div>
      </div>
      <div style={btnGroupStyle}>
        <span style={badgeStyle} title={tr('firstRun.intro')}>{tr('app.localBadge')}</span>
        <HoverButton onClick={onOpenHistory} title={tr('history.title')}>
          {tr('header.history')}{historyCount ? ' (' + historyCount + ')' : ''}
        </HoverButton>
        <HoverButton onClick={onOpenTemplates} disabled={locked} title={tr('templates.title')}>{tr('header.templates')}</HoverButton>
        {/* 导出/导入已并入左上 EventBook 菜单；input 必须留在 header 根节点常驻 */}
        <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={handleFileChange} />
        <select
          style={langSelectStyle}
          value={lang}
          onChange={(e) => setLanguage(e.target.value)}
          title={tr('book.language')}
          aria-label={tr('book.language')}
          disabled={locked}
        >
          {LANGS.map((l) => (<option key={l.code} value={l.code}>🌐 {l.name}</option>))}
        </select>
      </div>
    </header>
  );
}
