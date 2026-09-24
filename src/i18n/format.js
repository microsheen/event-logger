// 与语言相关的日期 / 时长格式化（基于 Intl，无新依赖）
import { localeTag, translate } from './core.js';

const formatterCache = {};

function formatter(lang, options) {
  const key = lang + '|' + JSON.stringify(options);
  if (!formatterCache[key]) formatterCache[key] = new Intl.DateTimeFormat(localeTag(lang), options);
  return formatterCache[key];
}

// 2026年9月 / September 2026 / 2026年9月
export function monthLabel(date, lang) {
  return formatter(lang, { year: 'numeric', month: 'long' }).format(date);
}

// 周一 9/21 / Mon 9/21 / 月 9/21
export function dayHeaderLabel(date, lang) {
  const weekday = formatter(lang, { weekday: 'short' }).format(date);
  return weekday + ' ' + (date.getMonth() + 1) + '/' + date.getDate();
}

// 字典里的 calendar.weekdays 恒为「周一开头」；这里按 book 的周开始日轮转，
// 避免三份字典各自维护七种起始顺序。
const MONDAY_FIRST = ['一', '二', '三', '四', '五', '六', '日'];

export function weekdays(lang, weekStartsOn) {
  const list = translate(lang, 'calendar.weekdays');
  const base = Array.isArray(list) && list.length === 7 ? list : MONDAY_FIRST;
  const n = Number(weekStartsOn);
  const start = Number.isInteger(n) && n >= 0 && n <= 6 ? n : 1;
  return base.slice(start).concat(base.slice(0, start));
}

// 统计图 Y 轴/ X 轴的月份标签：9月 / Sep / 9月
export function monthAxisLabel(monthOneBased, lang) {
  if (lang === 'en') {
    return formatter('en', { month: 'short' }).format(new Date(2000, monthOneBased - 1, 1));
  }
  return monthOneBased + translate(lang, 'common.month');
}

export function weekAxisLabel(weekNumber, lang) {
  return translate(lang, 'stats.weekN', { n: weekNumber });
}

// 3小时5分钟 / 3h 5m / 3時間5分
export function formatMinutes(totalMinutes, lang) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return translate(lang, 'time.mOnly', { m: m });
  if (m === 0) return translate(lang, 'time.hOnly', { h: h });
  return translate(lang, 'time.hm', { h: h, m: m });
}

// —— 相对时间 / 绝对时间（修改时间展示用，基于 Intl，无新依赖）——
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

const absoluteCache = {};
const relativeCache = {};

function absoluteFormatter(lang) {
  const tag = localeTag(lang);
  if (!absoluteCache[tag]) absoluteCache[tag] = new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeStyle: 'short' });
  return absoluteCache[tag];
}

function relativeFormatter(lang) {
  const tag = localeTag(lang);
  if (!relativeCache[tag]) relativeCache[tag] = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' });
  return relativeCache[tag];
}

// tooltip 用的完整时间：2026年9月21日 15:04 / Sep 21, 2026, 3:04 PM
export function absoluteTimeLabel(timeMs, lang) {
  if (typeof timeMs !== 'number' || !Number.isFinite(timeMs)) return '';
  return absoluteFormatter(lang).format(new Date(timeMs));
}

// 多久以前：45 秒内→"现在"，其后按 分钟 / 小时 / 天 / 周 分档，超过 31 天回退绝对日期
// 时间在未来（时钟偏差）时同一套公式给出"X 后"，不做特殊夹紧
export function relativeTime(timeMs, lang) {
  if (typeof timeMs !== 'number' || !Number.isFinite(timeMs)) return '';
  const delta = Date.now() - timeMs;
  const abs = Math.abs(delta);
  let unit;
  let units;
  if (abs < 45 * SECOND_MS) { unit = 'second'; units = 0; }
  else if (abs < 45 * MINUTE_MS) { unit = 'minute'; units = delta / MINUTE_MS; }
  else if (abs < 22 * HOUR_MS) { unit = 'hour'; units = delta / HOUR_MS; }
  else if (abs < 7 * DAY_MS) { unit = 'day'; units = delta / DAY_MS; }
  else if (abs < 31 * DAY_MS) { unit = 'week'; units = delta / WEEK_MS; }
  if (unit) return relativeFormatter(lang).format(-Math.round(units), unit);
  return absoluteTimeLabel(timeMs, lang);
}
