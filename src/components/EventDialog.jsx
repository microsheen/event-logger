import React, { useState, useEffect } from 'react';
import { slotRangeLabel, slotToTime, TOTAL_SLOTS } from '../utils/time.js';
import { CATEGORIES } from '../utils/categories.js';
import { useI18n } from '../i18n/index.jsx';
import { sortTemplates } from '../utils/templateSort.js';
import { useTemplateSort } from '../hooks/useTemplateSort.js';
import TemplateSortControl from './TemplateSortControl.jsx';

const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 1000, backdropFilter: 'blur(2px)',
};
const dialogStyle = {
  background: 'var(--color-surface)', borderRadius: '12px',
  padding: '28px', width: '520px', maxWidth: '90vw', boxShadow: 'var(--shadow-lg)',
  maxHeight: '90vh', overflowY: 'auto',
};
const fieldStyle = { marginBottom: '16px' };
const labelStyle = {
  display: 'block', fontSize: '13px', fontWeight: 600,
  color: 'var(--color-text-secondary)', marginBottom: '6px',
};
const inputStyle = {
  width: '100%', padding: '10px 12px', border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius)', fontSize: '14px', transition: 'border-color 0.2s',
};
const selectStyle = { ...inputStyle, cursor: 'pointer' };
const categoryBtnGroupStyle = { display: 'flex', gap: '8px' };
const categoryBtnStyle = (active, cat) => ({
  flex: 1, padding: '10px', borderRadius: 'var(--radius)',
  border: '2px solid ' + (active ? cat.color : 'var(--color-border)'),
  background: active ? cat.light : 'transparent',
  color: active ? cat.color : 'var(--color-text-secondary)',
  fontWeight: active ? 600 : 400, fontSize: '14px',
});
const actionRowStyle = { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '20px' };
const primaryBtnStyle = {
  padding: '10px 24px', borderRadius: 'var(--radius)',
  background: 'var(--color-accent)', color: '#fff', fontWeight: 600,
};
const primaryBtnDisabledStyle = {
  ...primaryBtnStyle, opacity: 0.5, cursor: 'not-allowed',
};
const cancelBtnStyle = {
  padding: '10px 24px', borderRadius: 'var(--radius)',
  background: 'var(--color-bg)', color: 'var(--color-text)', border: '1px solid var(--color-border)',
};
const deleteBtnStyle = {
  padding: '10px 16px', borderRadius: 'var(--radius)',
  background: 'var(--color-danger-light)', color: 'var(--color-danger)', fontWeight: 500,
};
const templateBtnStyle = {
  padding: '10px 16px', borderRadius: 'var(--radius)',
  background: '#fef3cd', color: '#856404', fontWeight: 500,
};
const templateInfoStyle = {
  display: 'flex', alignItems: 'center', gap: '6px',
  padding: '8px 12px', borderRadius: 'var(--radius)',
  background: 'var(--color-accent-light)', fontSize: '13px',
  color: 'var(--color-accent)', marginBottom: '16px',
};
const sortRowStyle = { display: 'flex', justifyContent: 'flex-end', marginTop: '6px' };
const conflictWarningStyle = {
  padding: '10px 14px', borderRadius: 'var(--radius)',
  background: 'var(--color-danger-light)', fontSize: '13px',
  color: 'var(--color-danger)', marginBottom: '16px',
  fontWeight: 500,
};

function getSortedTemplates(templates, events) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const twentyOneDaysAgo = new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const recentEvents = events.filter(e => {
    const d = new Date(e.date);
    return d >= thirtyDaysAgo && d <= now;
  });
  const scores = {};
  templates.forEach(t => { scores[t.id] = 0; });
  recentEvents.forEach(e => {
    if (!e.templateId || scores[e.templateId] === undefined) return;
    const d = new Date(e.date);
    if (d >= sevenDaysAgo) {
      scores[e.templateId] += 3;
    } else if (d >= twentyOneDaysAgo) {
      scores[e.templateId] += 2;
    } else {
      scores[e.templateId] += 1;
    }
  });
  return [...templates].sort((a, b) => (scores[b.id] || 0) - (scores[a.id] || 0));
}

export default function EventDialog({ mode, initialData, templates, events, dateStr, onSave, onDelete, onCancel, onAddTemplate }) {
  const { lang, tr } = useI18n();
  const { sort, direction } = useTemplateSort();
  const [name, setName] = useState(initialData?.name || '');
  const [category, setCategory] = useState(initialData?.category || 'work');
  const [startSlot, setStartSlot] = useState(initialData?.startSlot ?? 0);
  const [endSlot, setEndSlot] = useState(initialData?.endSlot ?? 1);
  const [templateId, setTemplateId] = useState(initialData?.templateId || null);

  useEffect(() => {
    if (initialData) {
      setName(initialData.name || '');
      setCategory(initialData.category || 'work');
      setStartSlot(initialData.startSlot ?? 0);
      setEndSlot(initialData.endSlot ?? 1);
      setTemplateId(initialData.templateId || null);
    }
  }, [initialData]);

  const conflictEvent = (() => {
    if (!events || startSlot >= endSlot) return null;
    return events.find(e =>
      e.date === dateStr &&
      e.id !== initialData?.id &&
      e.startSlot < endSlot &&
      e.endSlot > startSlot
    );
  })();

  // 偏好为"默认"时保留原有的按最近使用打分；选了名称 / 类别 / 修改时间时与模板管理弹窗一致
  const sortedTemplates = sort === 'default'
    ? getSortedTemplates(templates, events || [])
    : sortTemplates(templates, {
        sort, direction, lang, categoryLabel: (key) => tr('category.' + key),
      });

  const handleTemplateSelect = (selectedId) => {
    if (selectedId) {
      const t = templates.find(t => t.id === selectedId);
      if (t) {
        setName(t.name);
        setCategory(t.category);
        setTemplateId(selectedId);
      }
    } else {
      setTemplateId(null);
    }
  };

  const handleSubmit = () => {
    if (!name.trim()) { alert(tr('dialog.errName')); return; }
    if (startSlot >= endSlot) { alert(tr('dialog.errEndAfterStart')); return; }
    if (conflictEvent) return;
    onSave({ id: initialData?.id, name: name.trim(), category, date: dateStr, startSlot, endSlot, templateId });
  };

  const handleSaveAsTemplate = () => {
    if (!name.trim()) { alert(tr('dialog.errName')); return; }
    const template = onAddTemplate(name.trim(), category);
    onSave({ id: initialData?.id, name: name.trim(), category, date: dateStr, startSlot, endSlot, templateId: template.id });
  };

  const timeOptions = [];
  for (let i = 0; i <= TOTAL_SLOTS; i++) {
    timeOptions.push(<option key={i} value={i}>{slotToTime(i)}</option>);
  }

  const currentTemplate = templateId ? templates.find(t => t.id === templateId) : null;

  return (
    <div style={overlayStyle} onClick={onCancel}>
      <div style={dialogStyle} onClick={e => e.stopPropagation()}>
        <h3 style={{ marginBottom: '20px', fontSize: '18px' }}>
          {mode === 'edit' ? tr('dialog.editTitle') : tr('dialog.createTitle')}
        </h3>

        {mode === 'create' && templates.length > 0 && (
          <div style={fieldStyle}>
            <label style={labelStyle}>{tr('dialog.fromHistory')}</label>
            <select style={selectStyle} onChange={e => handleTemplateSelect(e.target.value)} defaultValue="">
              <option value="">-- {tr('dialog.selectTemplate')} --</option>
              {sortedTemplates.map(t => (
                <option key={t.id} value={t.id}>{t.name} ({tr('category.' + t.category)})</option>
              ))}
            </select>
            {templates.length > 1 && (
              <div style={sortRowStyle}>
                <TemplateSortControl />
              </div>
            )}
          </div>
        )}

        {mode === 'edit' && (
          <div style={fieldStyle}>
            <label style={labelStyle}>{tr('dialog.linkedTemplate')}</label>
            <select
              style={selectStyle}
              value={templateId || ''}
              onChange={e => handleTemplateSelect(e.target.value)}
            >
              <option value="">-- {tr('dialog.noTemplate')} --</option>
              {sortedTemplates.map(t => (
                <option key={t.id} value={t.id}>{t.name} ({tr('category.' + t.category)})</option>
              ))}
            </select>
            {templates.length > 1 && (
              <div style={sortRowStyle}>
                <TemplateSortControl />
              </div>
            )}
          </div>
        )}

        {mode === 'edit' && currentTemplate && (
          <div style={templateInfoStyle}>
            🔗 {tr('dialog.linkedNow')}{currentTemplate.name}
          </div>
        )}

        <div style={fieldStyle}>
          <label style={labelStyle}>{tr('dialog.nameLabel')}</label>
          <input style={inputStyle} value={name} onChange={e => setName(e.target.value)}
            placeholder={tr('dialog.namePlaceholder')} autoFocus />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>{tr('dialog.categoryLabel')}</label>
          <div style={categoryBtnGroupStyle}>
            {CATEGORIES.map(c => (
              <button key={c.key} style={categoryBtnStyle(category === c.key, c)} onClick={() => setCategory(c.key)}>
                {c.icon} {tr('category.' + c.key)}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '12px', marginBottom: '16px' }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>{tr('dialog.startLabel')}</label>
            <select style={selectStyle} value={startSlot} onChange={e => setStartSlot(Number(e.target.value))}>
              {timeOptions}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>{tr('dialog.endLabel')}</label>
            <select style={selectStyle} value={endSlot} onChange={e => setEndSlot(Number(e.target.value))}>
              {timeOptions.filter((_, i) => i > startSlot)}
            </select>
          </div>
        </div>
        <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '16px' }}>
          {slotRangeLabel(startSlot, endSlot)}
        </div>
        {conflictEvent && (
          <div style={conflictWarningStyle}>
            {tr('dialog.conflictWith', {
              name: conflictEvent.name,
              range: slotRangeLabel(conflictEvent.startSlot, conflictEvent.endSlot),
            })}
          </div>
        )}
        <div style={actionRowStyle}>
          {mode === 'edit' && (<button style={deleteBtnStyle} onClick={() => onDelete(initialData.id)}>🗑️ {tr('common.delete')}</button>)}
          <button style={cancelBtnStyle} onClick={onCancel}>{tr('common.cancel')}</button>
          {mode === 'edit' && !templateId && (
            <button style={templateBtnStyle} onClick={handleSaveAsTemplate}>{tr('dialog.saveAsTemplate')}</button>
          )}
          <button
            style={conflictEvent ? primaryBtnDisabledStyle : primaryBtnStyle}
            onClick={handleSubmit}
            disabled={!!conflictEvent}
          >{mode === 'edit' ? tr('common.save') : tr('common.create')}</button>
        </div>
      </div>
    </div>
  );
}
