import React from 'react';
import { SORT_KEYS } from '../utils/templateSort.js';
import { useTemplateSort } from '../hooks/useTemplateSort.js';
import { useI18n } from '../i18n/index.jsx';

// 与统计面板 scope tabs 同一套视觉，模板管理弹窗和事件弹窗共用
const groupStyle = {
  display: 'flex', gap: '4px', background: 'var(--color-bg)',
  borderRadius: 'var(--radius)', padding: '4px', width: 'fit-content', flexShrink: 0,
};
const segmentStyle = (active) => ({
  padding: '6px 12px', borderRadius: '6px', whiteSpace: 'nowrap', lineHeight: '16px',
  background: active ? 'var(--color-accent)' : 'transparent',
  color: active ? '#fff' : 'var(--color-text-secondary)',
  fontWeight: active ? 600 : 400, fontSize: '12px',
});
const directionStyle = { ...segmentStyle(false), fontWeight: 600, padding: '6px 10px' };

function sortLabelKey(sortKey) {
  return 'templates.sort' + sortKey.charAt(0).toUpperCase() + sortKey.slice(1);
}

export default function TemplateSortControl({ style }) {
  const { tr } = useI18n();
  const { sort, direction, setSort, toggleDirection } = useTemplateSort();
  const ascending = direction !== 'desc';

  return (
    <div style={{ ...groupStyle, ...(style || {}) }} role="group" aria-label={tr('templates.sortLabel')}>
      {SORT_KEYS.map((key) => (
        <button key={key} type="button" style={segmentStyle(sort === key)}
          aria-pressed={sort === key} onClick={() => setSort(key)}>
          {tr(sortLabelKey(key))}
        </button>
      ))}
      {sort !== 'default' && (
        <button type="button" style={directionStyle} onClick={toggleDirection}
          aria-pressed={!ascending} title={tr(ascending ? 'templates.sortAsc' : 'templates.sortDesc')}
          aria-label={tr(ascending ? 'templates.sortAsc' : 'templates.sortDesc')}>
          {ascending ? '↑' : '↓'}
        </button>
      )}
    </div>
  );
}
