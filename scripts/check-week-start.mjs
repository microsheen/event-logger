// 周开始日检查：每本 EventBook 自带 weekStartsOn，周/统计/月历三处必须同源
// 用法：npm run week:check
import {
  WEEK_START_DAYS,
  normalizeWeekStart,
  getWeekStart,
  getWeekRange,
  weekNumber,
  leadDaysBeforeMonth,
  formatDate,
} from '../src/utils/time.js';
import { filterEventsByRange, calcDailyStats } from '../src/utils/stats.js';
import { defaultWeekStartsOn } from '../src/storage/books.js';

const problems = [];
function check(name, condition, detail) {
  if (!condition) problems.push(name + (detail ? ' -> ' + detail : ''));
}
function eq(name, actual, expected) {
  check(name, actual === expected, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
}
const d = (y, m, day) => new Date(y, m - 1, day);
const midnight = (x) => x.getHours() === 0 && x.getMinutes() === 0 && x.getSeconds() === 0 && x.getMilliseconds() === 0;

// —— 1. normalizeWeekStart：只认 0..6 整数，其余回退周一 ——
WEEK_START_DAYS.forEach((n) => eq('合法值 ' + n, normalizeWeekStart(n), n));
eq('字符串数字可用', normalizeWeekStart('3'), 3);
eq('null 回退周一', normalizeWeekStart(null), 1);
eq('undefined 回退周一', normalizeWeekStart(undefined), 1);
eq('越上界回退周一', normalizeWeekStart(7), 1);
eq('越下界回退周一', normalizeWeekStart(-1), 1);
eq('小数回退周一', normalizeWeekStart(1.5), 1);
eq('NaN 回退周一', normalizeWeekStart('monday'), 1);

// —— 2. 语言 → 默认周开始日（zh/ja 周一，en 周日）——
eq('zh 默认周一', defaultWeekStartsOn('zh'), 1);
eq('ja 默认周一', defaultWeekStartsOn('ja'), 1);
eq('en 默认周日', defaultWeekStartsOn('en'), 0);
eq('未知语言回退周一', defaultWeekStartsOn('fr'), 1);

// —— 3. getWeekStart / getWeekRange：7 种起点 × 全量日期扫描 ——
// 基准：2020-01-01 起 6 年逐日（含闰年、跨年、跨年+跨月）
const DAYS = 366 * 6;
const base = d(2020, 1, 1);
let sweep = 0;
for (let i = 0; i < DAYS; i++) {
  const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
  WEEK_START_DAYS.forEach((ws) => {
    const first = getWeekStart(day, ws);
    const [rs, re] = getWeekRange(day, ws);
    sweep += 1;
    eq('周首日的星期必须等于 weekStartsOn', first.getDay(), ws);
    check('周首日必须是本地零点', midnight(first), formatDate(first));
    check('周首日不晚于当天', first <= day, formatDate(first) + ' > ' + formatDate(day));
    check('当天落在 7 天窗口内', (day - first) / 86400000 < 7, formatDate(day) + ' ws=' + ws);
    eq('getWeekRange 首日与 getWeekStart 一致', formatDate(rs), formatDate(first));
    eq('getWeekRange 末日 = 首日 + 6', formatDate(re), formatDate(new Date(first.getFullYear(), first.getMonth(), first.getDate() + 6)));
    eq('getWeekStart 幂等', formatDate(getWeekStart(first, ws)), formatDate(first));
  });
}

// —— 4. 周编号：weekStartsOn=1 必须逐日等于 ISO-8601 周号（旧行为不能变）——
function isoWeek(date) {
  const t = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
}
let isoSweep = 0;
for (let i = 0; i < DAYS; i++) {
  const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
  eq('ISO 周号一致', weekNumber(day, 1), isoWeek(day));
  isoSweep += 1;
}
// 该周「第 4 天」所在的年份，就是这一周的编号所属年
function weekAnchorYear(date, ws) {
  const anchor = getWeekStart(date, ws);
  anchor.setDate(anchor.getDate() + 3);
  return anchor.getFullYear();
}

// 任意起点：同一周内编号恒定，且同一编号年内下一周恰好 +1
WEEK_START_DAYS.forEach((ws) => {
  for (let i = 0; i < 400; i++) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
    const first = getWeekStart(day, ws);
    eq('同周同日编号', weekNumber(new Date(first.getFullYear(), first.getMonth(), first.getDate() + 3), ws), weekNumber(day, ws));
    const next = new Date(first.getFullYear(), first.getMonth(), first.getDate() + 7);
    // 跨年那一周编号会回到 1，这是定义而不是 bug：只在「锚点同年」时要求 +1
    if (weekAnchorYear(day, ws) === weekAnchorYear(next, ws)) {
      eq('相邻周编号差 1', weekNumber(next, ws) - weekNumber(day, ws), 1);
    } else {
      eq('跨年那一周编号归 1', weekNumber(next, ws), 1);
    }
    check('编号为正整数', Number.isInteger(weekNumber(day, ws)) && weekNumber(day, ws) >= 1, formatDate(day) + ' ws=' + ws + ' n=' + weekNumber(day, ws));
  }
});

// —— 5. 月历前导格：1 号必须落在周序第 lead 位，且 42 格能覆盖任何月份 ——
for (let y = 2020; y <= 2030; y++) {
  for (let m = 1; m <= 12; m++) {
    const first = d(y, m, 1);
    WEEK_START_DAYS.forEach((ws) => {
      const lead = leadDaysBeforeMonth(first, ws);
      check('前导格在 0..6', lead >= 0 && lead <= 6, y + '-' + m + ' ws=' + ws + ' lead=' + lead);
      const prev = new Date(y, m - 1, 1 - lead);
      eq('前导格首日就是周起点', prev.getDay(), normalizeWeekStart(ws));
      const daysInMonth = new Date(y, m, 0).getDate();
      check('42 格够用', lead + daysInMonth <= 42, y + '-' + m);
    });
    eq('周一开头时 1 月 1 号前导 = 旧逻辑', leadDaysBeforeMonth(first, 1), (first.getDay() === 0 ? 6 : first.getDay() - 1));
  }
}

// —— 6. 统计口径跟着 book 走 ——
function ev(dateStr) {
  return { id: dateStr, name: 'e', category: 'work', date: dateStr, startSlot: 60, endSlot: 70 };
}
// 2026-09-20 是周日：周一开头的周是 09-21~09-27，周日开头的周是 09-20~09-26
const sun = '2026-09-20';
const mon = '2026-09-21';
const saturday = '2026-09-26';
const events = [ev(sun), ev(mon), ev(saturday), ev('2026-09-27')];
const pick = (set) => set.map((e) => e.date).sort().join(',');
// 2026-09-21 周一 … 2026-09-27 周日：整周都算这周，上周日 09-20 不算
eq('周一开头的周 = 09-21~09-27', pick(filterEventsByRange(events, d(2026, 9, 23), 'week', 1)), '2026-09-21,2026-09-26,2026-09-27');
eq('周日开头含上周日', pick(filterEventsByRange(events, d(2026, 9, 23), 'week', 0)), '2026-09-20,2026-09-21,2026-09-26');
eq('不传 weekStartsOn 时按周一（向后兼容）', pick(filterEventsByRange(events, d(2026, 9, 23), 'week')), pick(filterEventsByRange(events, d(2026, 9, 23), 'week', 1)));
eq('周六开头的周不同', pick(filterEventsByRange(events, d(2026, 9, 23), 'week', 6)), '2026-09-19,2026-09-20,2026-09-21,2026-09-22,2026-09-23,2026-09-24,2026-09-25'.split(',').filter((x) => events.some((e) => e.date === x)).sort().join(','));
// 月视图按周聚合：桶的总时长必须等于当月明细总时长（换起点不能吞掉/重复计数）
[0, 1, 2, 3, 4, 5, 6].forEach((ws) => {
  const weeks = calcDailyStats(events, d(2026, 9, 15), 'month', 'zh', ws);
  const sum = weeks.reduce((acc, w) => acc + w.work, 0);
  eq('周聚合总时长守恒 ws=' + ws, sum, filterEventsByRange(events, d(2026, 9, 15), 'month', ws).length * 100);
  check('周桶编号唯一 ws=' + ws, new Set(weeks.map((w) => w.key)).size === weeks.length, weeks.map((w) => w.key).join(','));
});
// 分桶数可以相同（2026-09 都是 5 桶），但桶的起点必须不同：证明 book 的周开始日真的进了聚合
const keys0 = calcDailyStats(events, d(2026, 9, 15), 'month', 'zh', 0).map((w) => w.key).join(',');
const keys1 = calcDailyStats(events, d(2026, 9, 15), 'month', 'zh', 1).map((w) => w.key).join(',');
check('周日/周一开头的分桶起点不同', keys0 !== keys1, keys0 + ' | ' + keys1);

if (problems.length) {
  console.error('week start check FAILED (' + problems.length + ' issues):');
  [...new Set(problems)].slice(0, 40).forEach((p) => console.error('  - ' + p));
  process.exit(1);
}
console.log('week start check OK: ' + sweep + ' 组周窗口 / ' + isoSweep + ' 组 ISO 周号 / 月历前导格 / 统计口径');