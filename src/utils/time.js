const TOTAL_SLOTS = 144;
const SLOT_MINUTES = 10;

export function slotToTime(slot) {
  const totalMinutes = slot * SLOT_MINUTES;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
}

export function timeToSlot(time) {
  const parts = time.split(':').map(Number);
  return parts[0] * (60 / SLOT_MINUTES) + Math.floor(parts[1] / SLOT_MINUTES);
}

export function slotRangeLabel(startSlot, endSlot) {
  return slotToTime(startSlot) + ' - ' + slotToTime(Math.min(endSlot, TOTAL_SLOTS));
}

export function slotDuration(startSlot, endSlot) {
  return (endSlot - startSlot) * SLOT_MINUTES;
}

export function formatMinutesCompact(totalMinutes) {
  const hours = Math.round(totalMinutes / 60 * 10) / 10;
  if (hours === 0) return '0h';
  return hours + 'h';
}

export function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

export function parseDate(dateStr) {
  const parts = dateStr.split('-').map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

// 周开始日：0=周日 … 6=周六（每个 EventBook 自带一个值）
export const WEEK_START_DAYS = [0, 1, 2, 3, 4, 5, 6];

export function normalizeWeekStart(value) {
  // Number(null) === 0，会被静默当成「周日」；缺值一律回退周一
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return 1;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : 1;
}

export function getWeekStart(date, weekStartsOn) {
  const start = normalizeWeekStart(weekStartsOn);
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offset = (d.getDay() - start + 7) % 7;
  d.setDate(d.getDate() - offset);
  return d;
}

export function getWeekRange(date, weekStartsOn) {
  const first = getWeekStart(date, weekStartsOn);
  const last = new Date(first);
  last.setDate(first.getDate() + 6);
  return [first, last];
}

// 周编号：以「该周的第 4 天」为锚点，锚点所在年份决定所属年，
// 该年第 4 天所在的周为第 1 周。weekStartsOn === 1 时与 ISO-8601 完全一致。
export function weekNumber(date, weekStartsOn) {
  const start = normalizeWeekStart(weekStartsOn);
  const anchor = getWeekStart(date, start);
  anchor.setDate(anchor.getDate() + 3);
  const jan4 = new Date(anchor.getFullYear(), 0, 4);
  const firstAnchor = getWeekStart(jan4, start);
  firstAnchor.setDate(firstAnchor.getDate() + 3);
  const days = Math.round((anchor.getTime() - firstAnchor.getTime()) / 86400000);
  return 1 + days / 7;
}

// 月历网格第一行前面要垫几个格子：让 1 号落在本簿周序的第 lead 位上
export function leadDaysBeforeMonth(date, weekStartsOn) {
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  return (first.getDay() - normalizeWeekStart(weekStartsOn) + 7) % 7;
}

export function getMonthRange(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  return [start, end];
}

export function getYearRange(date) {
  const start = new Date(date.getFullYear(), 0, 1);
  const end = new Date(date.getFullYear(), 11, 31);
  return [start, end];
}

export function getDatesInRange(start, end) {
  const dates = [];
  const current = new Date(start);
  while (current <= end) {
    dates.push(formatDate(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

export { TOTAL_SLOTS, SLOT_MINUTES };
