// 时间轴跨日期拖动的落点规则层：纯函数、无 React 依赖（design.md I10）
// 约定与 eventClipboard.js 完全一致：区间一律半开 [startSlot, endSlot)，端点是"槽位分界线"（0 … TOTAL_SLOTS）
import { TOTAL_SLOTS } from './time.js';

function asIntOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(value, lower, upper) {
  const v = asIntOr(value, lower);
  return Math.min(Math.max(Math.round(v), lower), upper);
}

// 目标日还剩哪些可放置窗口：半开、互不相交、覆盖 [0, TOTAL_SLOTS]；返回 [] 表示这一天已经排满
// excludeId 排除"正在被拖的那条自己"（与粘贴侧 hasOverlap 的 ignoreId 同口径），否则原地微调永远撞自己
// 脏数据（端点缺失 / 倒序 / 零长）整条丢弃；越界端点裁进当天；互相重叠的脏区间只把游标往前推，不产生负宽度窗口
export function freeWindowsForDay(dayEvents, excludeId) {
  const blocks = [];
  if (Array.isArray(dayEvents)) {
    dayEvents.forEach(function (e) {
      if (!e || e.id === excludeId) return;
      const s = asIntOr(e.startSlot, NaN);
      const t = asIntOr(e.endSlot, NaN);
      if (!Number.isFinite(s) || !Number.isFinite(t) || t <= s) return;
      const start = Math.max(0, Math.round(s));
      const end = Math.min(TOTAL_SLOTS, Math.round(t));
      if (end > start) blocks.push({ start: start, end: end });
    });
  }
  blocks.sort(function (a, b) { return a.start - b.start; });
  const windows = [];
  let cursor = 0;
  blocks.forEach(function (b) {
    if (b.start > cursor) windows.push({ start: cursor, end: b.start });
    if (b.end > cursor) cursor = b.end;
  });
  if (cursor < TOTAL_SLOTS) windows.push({ start: cursor, end: TOTAL_SLOTS });
  return windows;
}

// candidate 到可行起点区间 [lower, upper] 的距离：落在区间内为 0
function distanceToRange(value, lower, upper) {
  if (value < lower) return lower - value;
  if (value > upper) return value - upper;
  return 0;
}

// 一次拖动的落点夹紧：时长锁死不变，起点挪到"位移最小的空闲窗口"，并列取更早的那个
// 装不下的定义是"没有任何窗口长度 >= duration"，此时 valid:false，由调用方决定"作废 + 提示"，绝不硬塞成长度变化
export function clampMoveToFreeWindow(windows, duration, candidateStart) {
  const invalid = { startSlot: null, endSlot: null, valid: false };
  const len = asIntOr(duration, NaN);
  if (!Array.isArray(windows) || !Number.isFinite(len) || Math.round(len) < 1) return invalid;
  const candidate = asIntOr(candidateStart, NaN);
  if (!Number.isFinite(candidate)) return invalid;
  const wanted = Math.round(candidate);
  let best = null;
  let bestDistance = Infinity;
  windows.forEach(function (w) {
    if (!w) return;
    const ws = asIntOr(w.start, NaN);
    const we = asIntOr(w.end, NaN);
    if (!Number.isFinite(ws) || !Number.isFinite(we)) return;
    const lower = Math.max(0, Math.round(ws));
    const upper = Math.round(we) - len;
    if (upper < lower) return; // 这个窗口装不下，跳过
    const distance = distanceToRange(wanted, lower, upper);
    if (distance < bestDistance) { // 严格小于 = 并列保留更早的窗口
      bestDistance = distance;
      best = { lower: lower, upper: upper };
    }
  });
  if (!best) return invalid;
  const startSlot = clampInt(wanted, best.lower, best.upper);
  return { startSlot: startSlot, endSlot: startSlot + len, valid: true };
}

// 横向落点：clientX 命中哪一列（rects 来自各列 getBoundingClientRect 的 { left, right }）
// 命中优先；拖到网格外（面板外、两列缝隙的浮点误差）取中心点最近的列，于是"永远有落点，但恒夹在可见列内"
export function columnIndexOfX(clientX, rects) {
  if (!Array.isArray(rects) || rects.length === 0) return -1;
  const x = asIntOr(clientX, NaN);
  if (!Number.isFinite(x)) return -1;
  let bestIndex = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (!r) continue;
    const left = asIntOr(r.left, NaN);
    const right = asIntOr(r.right, NaN);
    if (!Number.isFinite(left) || !Number.isFinite(right) || right < left) continue;
    if (x >= left && x < right) return i;
    const distance = Math.abs(x - (left + right) / 2);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}
