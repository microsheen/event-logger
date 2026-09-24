// 时间轴边缘缩放（resize）的几何与夹紧规则：纯函数、无 React 依赖
// 约定：区间一律半开 [startSlot, endSlot)，端点都是"槽位分界线"（0 … TOTAL_SLOTS）
import { TOTAL_SLOTS } from './time.js';

// 最短时长 1 槽 = 10 分钟，钉死 design.md I1（start < end）
export const MIN_DURATION_SLOTS = 1;

// 事件条上下边缘热区高度（px），只被渲染层使用
export const EDGE_HANDLE_HEIGHT = 5;

// 端点可达范围的退化情形（脏数据导致墙互相矛盾）：原样返回，宁可不动
function same(target) {
  return { startSlot: target.startSlot, endSlot: target.endSlot };
}

function asIntOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// 把鼠标位置的像素偏移换算成槽位分界线：半格以上算一格，实现 10 分钟吸附
export function boundarySlotFromY(clientY, rectTop, baseSlot, slotHeight) {
  const y = asIntOr(clientY, NaN);
  const top = asIntOr(rectTop, NaN);
  const base = asIntOr(baseSlot, 0);
  if (!Number.isFinite(y) || !Number.isFinite(top) || !Number.isFinite(slotHeight) || slotHeight <= 0) {
    return base;
  }
  return Math.round((y - top) / slotHeight + base);
}

// 同组事件里紧贴 target 上/下方的邻居边界；没有邻居时为 null
// prevEnd = 满足 endSlot <= target.startSlot 的最大 endSlot；nextStart = 满足 startSlot >= target.endSlot 的最小 startSlot
// 与既有重叠判定 a.start < b.end && a.end > b.start 一致：end === start 算相邻，不算阻挡
export function neighbourBounds(events, target) {
  const bounds = { prevEnd: null, nextStart: null };
  if (!Array.isArray(events) || !target) return bounds;
  const start = asIntOr(target.startSlot, 0);
  const end = asIntOr(target.endSlot, 0);
  events.forEach((e) => {
    if (!e || e.id === target.id) return;
    const s = asIntOr(e.startSlot, NaN);
    const t = asIntOr(e.endSlot, NaN);
    if (!Number.isFinite(s) || !Number.isFinite(t)) return;
    if (t <= start && (bounds.prevEnd === null || t > bounds.prevEnd)) bounds.prevEnd = t;
    if (s >= end && (bounds.nextStart === null || s < bounds.nextStart)) bounds.nextStart = s;
  });
  return bounds;
}

function clampSlot(value, lower, upper) {
  const v = asIntOr(value, NaN);
  if (!Number.isFinite(v)) return lower;
  return Math.min(Math.max(Math.round(v), lower), upper);
}

// 算一次边缘拖拽的结果区间；edge = 'start'（上边缘，改开始）| 'end'（下边缘，改结束）
// bounds 是当前时间轴视口（timelineStart / timelineEnd），neighbours 是按下时快照的邻居墙
// 三条规则：不越邻居、不短于 1 槽、端点不会被强行从视口外拉回视口内（所以拖动不会因为越界而"跳变"）
export function resizeRange(target, edge, candidate, bounds, neighbours) {
  if (!target) return { startSlot: 0, endSlot: MIN_DURATION_SLOTS };
  const start = asIntOr(target.startSlot, 0);
  const end = asIntOr(target.endSlot, 0);
  const viewMin = asIntOr(bounds && bounds.min, 0);
  const viewMax = asIntOr(bounds && bounds.max, TOTAL_SLOTS);
  const hasPrev = neighbours && neighbours.prevEnd !== null && neighbours.prevEnd !== undefined;
  const hasNext = neighbours && neighbours.nextStart !== null && neighbours.nextStart !== undefined;
  const prevEnd = hasPrev ? asIntOr(neighbours.prevEnd, 0) : 0;
  const nextStart = hasNext ? asIntOr(neighbours.nextStart, TOTAL_SLOTS) : TOTAL_SLOTS;

  if (edge === 'start') {
    const lower = Math.max(prevEnd, Math.min(viewMin, start));
    const upper = Math.min(end - MIN_DURATION_SLOTS, Math.max(viewMax - MIN_DURATION_SLOTS, start));
    if (upper < lower) return same(target);
    return { startSlot: clampSlot(candidate, lower, upper), endSlot: end };
  }

  const lower = Math.max(start + MIN_DURATION_SLOTS, Math.min(viewMin + MIN_DURATION_SLOTS, end));
  const upper = Math.min(nextStart, Math.max(viewMax, end));
  if (upper < lower) return same(target);
  return { startSlot: start, endSlot: clampSlot(candidate, lower, upper) };
}
