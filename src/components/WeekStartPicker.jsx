import React, { useMemo } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { formatDate, getWeekRange, weekNumber, WEEK_START_DAYS } from '../utils/time.js';

const rowStyle = { display: 'flex', gap: '6px', flexWrap: 'wrap' };
const chipStyle = (active) => ({
  padding: '7px 12px', borderRadius: '16px', fontSize: '13px',
  border: '1px solid ' + (active ? 'var(--color-accent)' : 'var(--color-border)'),
  background: active ? 'var(--color-accent)' : 'var(--color-bg)',
  color: active ? '#fff' : 'var(--color-text)',
  fontWeight: active ? 600 : 400,
});
const previewStyle = {
  marginTop: '8px', fontSize: '12px', color: 'var(--color-text-secondary)',
};

// 周开始日：0=周日 … 6=周六，值直接写进 EventBook.settings
export default function WeekStartPicker({ value, onChange }) {
  const { lang, tr } = useI18n();
  const names = tr('book.weekStartDays');
  const today = useMemo(() => new Date(), []);
  const [start, end] = useMemo(() => getWeekRange(today, value), [today, value]);
  return (
    <div>
      <div style={rowStyle}>
        {WEEK_START_DAYS.map((day) => (
          <button key={day} type="button" style={chipStyle(value === day)} onClick={() => onChange(day)}>
            {Array.isArray(names) && names[day] ? names[day] : day}
          </button>
        ))}
      </div>
      <div style={previewStyle}>
        {tr('book.weekPreview', { start: formatDate(start), end: formatDate(end), n: weekNumber(today, value) })}
      </div>
    </div>
  );
}
