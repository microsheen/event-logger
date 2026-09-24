import React, { useState, useMemo } from 'react';
import { CATEGORIES, getCategory } from '../utils/categories.js';
import { sortTemplates } from '../utils/templateSort.js';
import { getUpdatedTime } from '../utils/templates.js';
import { absoluteTimeLabel, relativeTime } from '../i18n/format.js';
import { useTemplateSort } from '../hooks/useTemplateSort.js';
import { useI18n } from '../i18n/index.jsx';
import TemplateSortControl from './TemplateSortControl.jsx';

const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
};
const dialogStyle = {
  background: 'var(--color-surface)', borderRadius: 'var(--radius)', padding: '24px',
  width: '480px', maxWidth: '90vw', maxHeight: '80vh', overflowY: 'auto', boxShadow: 'var(--shadow-lg)',
};
const headerRowStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  flexWrap: 'wrap', gap: '8px', marginBottom: '16px',
};
const addRowStyle = { display: 'flex', gap: '8px', marginBottom: '16px' };
const inputStyle = {
  flex: 1, minWidth: 0, padding: '8px 12px', border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius)', fontSize: '13px',
};
const selectStyle = { ...inputStyle, flex: '0 0 auto', cursor: 'pointer' };
const addBtnStyle = {
  padding: '8px 16px', borderRadius: 'var(--radius)', background: 'var(--color-accent)',
  color: '#fff', fontWeight: 600, fontSize: '13px',
};
const rowStyle = {
  display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px',
  border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', marginBottom: '8px',
};
const nameStyle = { flex: 1, minWidth: 0, fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const badgeStyle = (cat) => ({
  padding: '2px 8px', borderRadius: '4px', fontSize: '11px',
  background: cat.light, color: cat.color, flexShrink: 0,
});
const timeStyle = {
  fontSize: '11px', color: 'var(--color-text-secondary)', flexShrink: 0, whiteSpace: 'nowrap',
};
const iconBtnStyle = {
  padding: '4px 8px', borderRadius: '4px', background: 'var(--color-bg)',
  border: '1px solid var(--color-border)', fontSize: '12px', flexShrink: 0,
};
const closeBtnStyle = {
  padding: '8px 20px', borderRadius: 'var(--radius)', background: 'var(--color-bg)',
  border: '1px solid var(--color-border)', fontSize: '13px',
};

export default function TemplateManager({ templates, onAdd, onUpdate, onDelete, onClose }) {
  const { lang, tr } = useI18n();
  const { sort, direction } = useTemplateSort();
  const [newName, setNewName] = useState('');
  const [newCategory, setNewCategory] = useState('work');
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editCategory, setEditCategory] = useState('work');

  // 排序只影响这里的显示顺序，data.json 里的模板数组顺序保持不变
  const visibleTemplates = useMemo(
    () => sortTemplates(templates, {
      sort, direction, lang, categoryLabel: (key) => tr('category.' + key),
    }),
    [templates, sort, direction, lang, tr]
  );

  const handleAdd = () => {
    if (!newName.trim()) { alert(tr('templates.errName')); return; }
    onAdd(newName.trim(), newCategory);
    setNewName('');
  };

  const startEdit = (t) => {
    setEditingId(t.id);
    setEditName(t.name);
    setEditCategory(t.category);
  };

  const saveEdit = () => {
    if (!editName.trim()) { alert(tr('templates.errName')); return; }
    onUpdate(editingId, { name: editName.trim(), category: editCategory });
    setEditingId(null);
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={dialogStyle} onClick={e => e.stopPropagation()}>
        <div style={headerRowStyle}>
          <h3 style={{ fontSize: '18px' }}>{tr('templates.title')}</h3>
          {templates.length > 0 && <TemplateSortControl />}
        </div>

        <div style={addRowStyle}>
          <input style={inputStyle} value={newName} onChange={e => setNewName(e.target.value)}
            placeholder={tr('templates.namePlaceholder')} onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }} />
          <select style={selectStyle} value={newCategory} onChange={e => setNewCategory(e.target.value)}>
            {CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.icon} {tr('category.' + c.key)}</option>)}
          </select>
          <button style={addBtnStyle} onClick={handleAdd}>{tr('templates.add')}</button>
        </div>

        {templates.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--color-text-secondary)', padding: '16px', fontSize: '13px' }}>
            {tr('templates.empty')}
          </div>
        ) : (
          visibleTemplates.map(t => {
            const cat = getCategory(t.category);
            const updatedMs = getUpdatedTime(t);
            return editingId === t.id ? (
              <div key={t.id} style={rowStyle}>
                <input style={inputStyle} value={editName} onChange={e => setEditName(e.target.value)} autoFocus />
                <select style={selectStyle} value={editCategory} onChange={e => setEditCategory(e.target.value)}>
                  {CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.icon} {tr('category.' + c.key)}</option>)}
                </select>
                <button style={iconBtnStyle} onClick={saveEdit}>{tr('common.save')}</button>
                <button style={iconBtnStyle} onClick={() => setEditingId(null)}>{tr('common.cancel')}</button>
              </div>
            ) : (
              <div key={t.id} style={rowStyle}>
                <span style={nameStyle}>{cat.icon} {t.name}</span>
                <span style={badgeStyle(cat)}>{tr('category.' + cat.key)}</span>
                {updatedMs !== null && (
                  <span style={timeStyle} title={absoluteTimeLabel(updatedMs, lang)}>
                    {relativeTime(updatedMs, lang)}
                  </span>
                )}
                <button style={iconBtnStyle} onClick={() => startEdit(t)}>{tr('templates.edit')}</button>
                <button style={iconBtnStyle} onClick={() => { if (confirm(tr('templates.confirmDelete', { name: t.name }))) onDelete(t.id); }}>{tr('templates.remove')}</button>
              </div>
            );
          })
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px' }}>
          <button style={closeBtnStyle} onClick={onClose}>{tr('common.close')}</button>
        </div>
      </div>
    </div>
  );
}
