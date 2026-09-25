import React, { useState, useMemo } from 'react';
import { formatDate, leadDaysBeforeMonth } from '../utils/time.js';
import { useI18n } from '../i18n/index.jsx';
import { monthLabel, weekdays } from '../i18n/format.js';

const containerStyle = {
  background: 'var(--color-surface)',
  padding: '14px',
  overflowY: 'auto',
  flexShrink: 0,
};

const navStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: '10px',
  gap: '4px',
};

const monthLabelStyle = {
  fontSize: '14px',
  fontWeight: 600,
};

const navBtnStyle = {
  width: '28px',
  height: '28px',
  borderRadius: '50%',
  background: 'var(--color-bg)',
  border: '1px solid var(--color-border)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '12px',
  color: 'var(--color-text)',
};

const todayBtnStyle = {
  ...navBtnStyle,
  width: 'auto',
  padding: '4px 10px',
  borderRadius: 'var(--radius)',
  fontSize: '11px',
  background: 'var(--color-accent-light)',
  color: 'var(--color-accent)',
  fontWeight: 500,
  flexShrink: 0,
};

const gridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(7, 1fr)',
  gap: '2px',
  maxWidth: '320px',
  margin: '0 auto',
};

const weekdayStyle = {
  textAlign: 'center',
  fontSize: '11px',
  fontWeight: 600,
  color: 'var(--color-text-secondary)',
  padding: '3px 0',
};

// 前导格数交给 utils/time.js 的纯函数，scripts/check-week-start.mjs 能直接在 Node 里断言
function getCalendarDays(year, month, weekStartsOn) {
  const firstDay = new Date(year, month, 1);
  const lead = leadDaysBeforeMonth(firstDay, weekStartsOn);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();
  const days = [];
  for (let i = lead - 1; i >= 0; i--) {
    days.push({ day: daysInPrevMonth - i, month: month - 1, year: month === 0 ? year - 1 : year, isCurrentMonth: false });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    days.push({ day: d, month, year, isCurrentMonth: true });
  }
  const remaining = 42 - days.length;
  for (let d = 1; d <= remaining; d++) {
    days.push({ day: d, month: month + 1, year: month === 11 ? year + 1 : year, isCurrentMonth: false });
  }
  return days;
}

export default function Calendar({ selectedDate, onSelectDate, dateSet, weekStartsOn }) {
  const { lang, tr } = useI18n();
  const weekdayLabels = weekdays(lang, weekStartsOn);
  const [viewYear, setViewYear] = useState(selectedDate.getFullYear());
  const [viewMonth, setViewMonth] = useState(selectedDate.getMonth());
  const days = useMemo(() => getCalendarDays(viewYear, viewMonth, weekStartsOn), [viewYear, viewMonth, weekStartsOn]);

  const prevMonth = () => {
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); }
    else setViewMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); }
    else setViewMonth(m => m + 1);
  };

  const today = formatDate(new Date());
  const selectedStr = formatDate(selectedDate);

  return (
    <div style={containerStyle}>
      <div style={navStyle}>
        <button style={navBtnStyle} onClick={prevMonth}>{'◀'}</button>
        <span style={monthLabelStyle}>{monthLabel(new Date(viewYear, viewMonth, 1), lang)}</span>
        <button style={navBtnStyle} onClick={nextMonth}>{'▶'}</button>
        <button style={todayBtnStyle} onClick={() => { const now = new Date(); onSelectDate(now); setViewYear(now.getFullYear()); setViewMonth(now.getMonth()); }}>{tr('calendar.today')}</button>
      </div>
      <div style={gridStyle}>
        {/* data-cal-weekday / data-cal-date 是给 e2e-smoke 对齐检查用的锚点：
            第 c 列的表头必须真是该列日期的星期（口径见 i18n/format.js 的 weekdays） */}
        {weekdayLabels.map((w, i) => (<div key={w} data-cal-weekday={i} style={weekdayStyle}>{w}</div>))}
        {days.map((d, i) => {
          const realMonth = d.month < 0 ? 11 : d.month > 11 ? 0 : d.month;
          const realYear = d.month < 0 ? d.year : d.month > 11 ? d.year : d.year;
          const dateStr = formatDate(new Date(realYear, realMonth, d.day));
          const isSelected = dateStr === selectedStr;
          const isToday = dateStr === today;
          const hasEvents = dateSet.has(dateStr);
          const dayBtnStyle = {
            width: '100%', aspectRatio: '1',
            border: isSelected ? '2px solid var(--color-accent)' : isToday ? '2px solid var(--color-accent-light)' : '2px solid transparent',
            borderRadius: '50%',
            background: isSelected ? 'var(--color-accent)' : 'transparent',
            color: isSelected ? '#fff' : d.isCurrentMonth ? 'var(--color-text)' : 'var(--color-text-secondary)',
            fontSize: '12px', fontWeight: isToday || isSelected ? 700 : 400,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            position: 'relative', opacity: d.isCurrentMonth ? 1 : 0.4,
          };
          return (
            <button key={i} data-cal-date={dateStr} style={dayBtnStyle} onClick={() => {
              onSelectDate(new Date(realYear, realMonth, d.day));
              if (!d.isCurrentMonth) { setViewYear(realYear); setViewMonth(realMonth); }
            }}>
              {d.day}
              {hasEvents && (<span style={{ position: 'absolute', bottom: '3px', width: '4px', height: '4px', borderRadius: '50%', background: isSelected ? '#fff' : 'var(--color-accent)' }} />)}
            </button>
          );
        })}
      </div>
    </div>
  );
}