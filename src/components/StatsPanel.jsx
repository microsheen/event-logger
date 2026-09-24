import React, { useCallback, useMemo } from 'react';
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { filterEventsByRange, calcCategoryStats, calcEventStats, calcDailyStats } from '../utils/stats.js';
import { formatMinutesCompact } from '../utils/time.js';
import { useI18n } from '../i18n/index.jsx';
import { CATEGORIES, getCategory } from '../utils/categories.js';

const containerStyle = {
  background: 'var(--color-surface)',
  padding: '16px',
};
const tabsStyle = {
  display: 'flex', gap: '4px', marginBottom: '16px',
  background: 'var(--color-bg)', borderRadius: 'var(--radius)', padding: '4px', width: 'fit-content',
};
const tabStyle = (active) => ({
  padding: '6px 14px', borderRadius: '6px',
  background: active ? 'var(--color-accent)' : 'transparent',
  color: active ? '#fff' : 'var(--color-text-secondary)',
  fontWeight: active ? 600 : 400, fontSize: '12px',
});
const chartCardStyle = {
  background: 'var(--color-bg)',
  borderRadius: 'var(--radius)', padding: '12px', marginBottom: '12px',
};
const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: '12px' };
const thStyle = {
  textAlign: 'left', padding: '6px 8px',
  borderBottom: '2px solid var(--color-border)', color: 'var(--color-text-secondary)', fontWeight: 600,
};
const tdStyle = { padding: '6px 8px', borderBottom: '1px solid var(--color-border)' };

const COLORS = Object.fromEntries(CATEGORIES.map(c => [c.key, c.hex]));
const RADIAN = Math.PI / 180;
const SCOPES = ['day', 'week', 'month', 'year'];

export default function StatsPanel({ events, selectedDate, scope, onScopeChange, weekStartsOn }) {
  const { lang, tr } = useI18n();
  const filteredEvents = useMemo(() => filterEventsByRange(events, selectedDate, scope, weekStartsOn), [events, selectedDate, scope, weekStartsOn]);
  const categoryStats = useMemo(() => calcCategoryStats(filteredEvents), [filteredEvents]);
  const eventStats = useMemo(() => calcEventStats(filteredEvents), [filteredEvents]);
  const dailyStats = useMemo(() => calcDailyStats(events, selectedDate, scope, lang, weekStartsOn), [events, selectedDate, scope, lang, weekStartsOn]);

  const pieData = useMemo(() => CATEGORIES
    .map(c => ({ name: tr('category.' + c.key), value: categoryStats[c.key] || 0, key: c.key }))
    .filter(d => d.value > 0), [categoryStats, lang]);

  // 实际占比：以当前时间范围内各类别总时长为分母计算百分比
  const pieTotal = useMemo(() => pieData.reduce((sum, d) => sum + d.value, 0), [pieData]);
  const percentOf = useCallback((value) => (pieTotal > 0 ? (value / pieTotal) * 100 : 0), [pieTotal]);
  const formatPercent = useCallback((value) => {
    const p = percentOf(value);
    if (p <= 0) return '0%';
    return (p >= 10 ? String(Math.round(p)) : String(Math.round(p * 10) / 10)) + '%';
  }, [percentOf]);

  // 扇区内显示百分比，扇区外显示类别名（占比过小时合并到外部标签）
  const renderPieLabel = (props) => {
    const { cx, cy, midAngle, innerRadius, outerRadius, payload, index } = props;
    const d = payload && payload.value != null ? payload : pieData[index];
    if (!d || !Number.isFinite(cx) || !Number.isFinite(midAngle)) return null;
    const pct = percentOf(d.value);
    const pctText = formatPercent(d.value);
    const cos = Math.cos(-midAngle * RADIAN);
    const sin = Math.sin(-midAngle * RADIAN);
    const showInside = pct >= 7;
    const midRadius = (innerRadius + outerRadius) / 2;
    const labelRadius = outerRadius + 12;
    const anchor = cos > 0.3 ? 'start' : cos < -0.3 ? 'end' : 'middle';
    return (
      <g style={{ pointerEvents: 'none' }}>
        {showInside && (
          <text x={cx + midRadius * cos} y={cy + midRadius * sin} textAnchor="middle" dominantBaseline="central"
            fill="#fff" fontSize={12} fontWeight={700}>
            {pctText}
          </text>
        )}
        <text x={cx + labelRadius * cos} y={cy + labelRadius * sin} textAnchor={anchor} dominantBaseline="central"
          fill={COLORS[d.key] || 'var(--color-text-secondary)'} fontSize={11.5} fontWeight={600}>
          {d.name + (showInside ? '' : ' ' + pctText)}
        </text>
      </g>
    );
  };

  const barData = useMemo(() => {
    if (scope === 'day') {
      return eventStats.map(e => ({ name: e.name, minutes: e.totalMinutes, category: e.category }));
    }
    return dailyStats.map(d => ({
      name: d.name || (d.date ? d.date.slice(5) : ''),
      weekStart: d.weekStart,
      weekEnd: d.weekEnd,
      ...Object.fromEntries(CATEGORIES.map(c => [c.key, d[c.key] || 0])),
    }));
  }, [scope, eventStats, dailyStats]);


  const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius)',
          padding: '8px 12px',
          fontSize: '12px',
        }}>
          {scope === 'month' && data.weekStart && data.weekEnd && (
            <div style={{ marginBottom: '4px', color: 'var(--color-text-secondary)' }}>
              {data.weekStart.slice(5)}~{data.weekEnd.slice(5)}
            </div>
          )}
          <div style={{ fontWeight: 600, marginBottom: '4px' }}>{label}</div>
          {payload.map((p, i) => (
            <div key={i} style={{ color: p.color }}>
              {p.name}: {formatMinutesCompact(p.value)}
            </div>
          ))}
          <div style={{ borderTop: '1px solid var(--color-border)', marginTop: '4px', paddingTop: '4px', fontWeight: 600 }}>
            {tr('stats.total')}: {formatMinutesCompact(payload.reduce((sum, p) => sum + (p.value || 0), 0))}
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <div style={containerStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <h3 style={{ fontSize: '15px', fontWeight: 600 }}>{tr('stats.title')}</h3>
        <div style={tabsStyle}>
          {SCOPES.map(s => (
            <button key={s} style={tabStyle(scope === s)} onClick={() => onScopeChange(s)}>{tr('common.' + s)}</button>
          ))}
        </div>
      </div>
      {filteredEvents.length === 0 ? (
        <div style={{ textAlign: 'center', color: 'var(--color-text-secondary)', padding: '24px', fontSize: '13px' }}>
          {tr('stats.empty')}
        </div>
      ) : (
        <>
          <div style={chartCardStyle}>
            <h4 style={{ fontSize: '13px', marginBottom: '8px', color: 'var(--color-text-secondary)' }}>{tr('stats.categoryShare')}</h4>
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={pieData} cx="50%" cy="50%" innerRadius={45} outerRadius={70} paddingAngle={3} dataKey="value"
                  label={renderPieLabel} labelLine={false}>
                  {pieData.map(d => <Cell key={d.key} fill={COLORS[d.key]} />)}
                </Pie>
                <Tooltip formatter={(v) => formatMinutesCompact(v)} />
              </PieChart>
            </ResponsiveContainer>
            <div style={{ display: 'flex', justifyContent: 'center', gap: '16px', marginTop: '4px' }}>
              {CATEGORIES.map(c => (
                <span key={c.key} style={{ fontSize: '12px' }}>{c.icon} {tr('category.' + c.key)}: {formatMinutesCompact(categoryStats[c.key] || 0)}</span>
              ))}
            </div>
          </div>
          <div style={chartCardStyle}>
            <h4 style={{ fontSize: '13px', marginBottom: '8px', color: 'var(--color-text-secondary)' }}>
              {tr(scope === 'day' ? 'stats.byEvent' : scope === 'month' ? 'stats.byWeek' : scope === 'year' ? 'stats.byMonth' : 'stats.byDay')}
            </h4>
            <ResponsiveContainer width="100%" height={160}>
              {scope === 'day' ? (
                <BarChart data={barData}>
                  <XAxis dataKey="name" fontSize={11} />
                  <YAxis fontSize={11} tickFormatter={v => Math.round(v/60) + 'h'} />
                  <Tooltip formatter={v => formatMinutesCompact(v)} />
                  <Bar dataKey="minutes" name={tr('stats.duration')} radius={[4,4,0,0]}>
                  {barData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[entry.category]} />
                  ))}
                </Bar>
                </BarChart>
              ) : (
                <BarChart data={barData}>
                  <XAxis dataKey="name" fontSize={11} />
                  <YAxis fontSize={11} tickFormatter={v => Math.round(v/60) + 'h'} />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend />
                  {CATEGORIES.map((c, i) => (
                    <Bar key={c.key} dataKey={c.key} name={tr('category.' + c.key)} stackId="a" fill={COLORS[c.key]}
                      radius={i === CATEGORIES.length - 1 ? [4, 4, 0, 0] : 0} />
                  ))}
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>
          <div style={chartCardStyle}>
            <h4 style={{ fontSize: '13px', marginBottom: '8px', color: 'var(--color-text-secondary)' }}>{tr('stats.ranking')}</h4>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>#</th>
                  <th style={thStyle}>{tr('stats.thName')}</th>
                  <th style={thStyle}>{tr('stats.thCategory')}</th>
                  <th style={thStyle}>{tr('stats.thTotal')}</th>
                  <th style={thStyle}>{tr('stats.thCount')}</th>
                </tr>
              </thead>
              <tbody>
                {eventStats.map((e, i) => (
                  <tr key={e.name}>
                    <td style={tdStyle}>{i + 1}</td>
                    <td style={tdStyle}>{e.name}</td>
                    <td style={tdStyle}>
                      <span style={{
                        padding: '2px 6px', borderRadius: '4px', fontSize: '11px',
                        background: getCategory(e.category).light,
                        color: getCategory(e.category).color,
                      }}>
                        {tr('category.' + e.category)}
                      </span>
                    </td>
                    <td style={tdStyle}>{formatMinutesCompact(e.totalMinutes)}</td>
                    <td style={tdStyle}>{e.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
