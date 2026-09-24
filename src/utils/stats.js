import { getWeekRange, getWeekStart, weekNumber, getMonthRange, getYearRange, getDatesInRange, slotDuration, parseDate, formatDate, normalizeWeekStart } from './time.js';
import { CATEGORIES } from './categories.js';
import { monthAxisLabel, weekAxisLabel } from '../i18n/format.js';

// weekStartsOn 来自当前 EventBook；不传就按周一，保持旧调用点可用（口径唯一：utils/time.js）
const normalizeScopeWeek = normalizeWeekStart;

export function filterEventsByRange(events, selectedDate, scope, weekStartsOn) {
  const weekStart = normalizeScopeWeek(weekStartsOn);
  if (scope === 'day') {
    // 与日历/时间轴同一口径：本地日期，不用 toISOString（UTC+8 早上 8 点前会掉到前一天）
    const dateStr = formatDate(selectedDate);
    return events.filter(e => e.date === dateStr);
  }

  let [start, end] = [null, null];
  if (scope === 'week') [start, end] = getWeekRange(selectedDate, weekStart);
  else if (scope === 'month') [start, end] = getMonthRange(selectedDate);
  else if (scope === 'year') [start, end] = getYearRange(selectedDate);

  const dates = new Set(getDatesInRange(start, end));
  return events.filter(e => dates.has(e.date));
}

export function calcCategoryStats(events) {
  const stats = {};
  CATEGORIES.forEach(c => { stats[c.key] = 0; });
  events.forEach(e => {
    const mins = slotDuration(e.startSlot, e.endSlot);
    if (stats[e.category] != null) stats[e.category] += mins;
  });
  return stats;
}

export function calcEventStats(events) {
  const map = {};
  events.forEach(e => {
    if (!map[e.name]) {
      map[e.name] = { name: e.name, category: e.category, totalMinutes: 0, count: 0 };
    }
    map[e.name].totalMinutes += slotDuration(e.startSlot, e.endSlot);
    map[e.name].count += 1;
  });
  return Object.values(map).sort((a, b) => b.totalMinutes - a.totalMinutes);
}

export function calcDailyStats(events, selectedDate, scope, lang, weekStartsOn) {
  const weekStart = normalizeScopeWeek(weekStartsOn);
  let [start, end] = [null, null];
  if (scope === 'week') [start, end] = getWeekRange(selectedDate, weekStart);
  else if (scope === 'month') [start, end] = getMonthRange(selectedDate);
  else if (scope === 'year') [start, end] = getYearRange(selectedDate);
  else {
    const dateStr = formatDate(selectedDate);
    return events
      .filter(e => e.date === dateStr)
      .map(e => ({
        name: e.name,
        minutes: slotDuration(e.startSlot, e.endSlot),
        category: e.category
      }));
  }

  const dates = getDatesInRange(start, end);
  const dailyMap = {};
  dates.forEach(d => {
    dailyMap[d] = { date: d };
    CATEGORIES.forEach(c => { dailyMap[d][c.key] = 0; });
  });
  events.forEach(e => {
    if (dailyMap[e.date]) {
      const mins = slotDuration(e.startSlot, e.endSlot);
      if (dailyMap[e.date][e.category] != null) dailyMap[e.date][e.category] += mins;
    }
  });

  if (scope === 'month') {
    // 按周聚合：分桶起点用本簿的周开始日，编号用 weekNumber（weekStartsOn=1 时等于 ISO 周号）
    const weeks = [];
    let currentWeek = null;
    dates.forEach(d => {
      const dateObj = parseDate(d);
      const ws = getWeekStart(dateObj, weekStart);
      const weekKey = formatDate(ws);
      if (!currentWeek || currentWeek.key !== weekKey) {
        const weekNum = weekNumber(ws, weekStart);
        const weekEnd = new Date(ws);
        weekEnd.setDate(ws.getDate() + 6);
        currentWeek = { key: weekKey, name: weekAxisLabel(weekNum, lang), date: d, weekStart: weekKey, weekEnd: formatDate(weekEnd) };
        CATEGORIES.forEach(c => { currentWeek[c.key] = 0; });
        weeks.push(currentWeek);
      }
      CATEGORIES.forEach(c => {
        currentWeek[c.key] += (dailyMap[d][c.key] || 0);
      });
    });
    return weeks;
  }

  if (scope === 'year') {
    // Aggregate by month
    const months = [];
    for (let m = 0; m < 12; m++) {
      const entry = { name: monthAxisLabel(m + 1, lang), date: '' };
      CATEGORIES.forEach(c => { entry[c.key] = 0; });
      months.push(entry);
    }
    dates.forEach(d => {
      const dateObj = parseDate(d);
      const m = dateObj.getMonth();
      CATEGORIES.forEach(c => {
        months[m][c.key] += (dailyMap[d][c.key] || 0);
      });
    });
    return months;
  }

  return Object.values(dailyMap);
}