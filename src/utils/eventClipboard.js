// 时间轴右键剪贴板（copy / cut / paste）的规则层：纯函数、无 React 依赖
// 约定与 slotRange.js 一致：区间一律半开 [startSlot, endSlot)，端点是"槽位分界线"（0 … TOTAL_SLOTS）
import { TOTAL_SLOTS } from './time.js';

function asIntOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(value, lower, upper) {
  const v = asIntOr(value, lower);
  return Math.min(Math.max(Math.round(v), lower), upper);
}

// 把事件压成一份「与位置无关」的剪贴板快照：mode = 'copy' | 'cut'
// 名称为空、区间退化（零长或倒序）一律返回 null，宁可不给复制也不产生脏快照
export function clipboardFromEvent(event, mode) {
  if (!event || (mode !== 'copy' && mode !== 'cut')) return null;
  const name = typeof event.name === 'string' ? event.name.trim() : '';
  if (!name) return null;
  const start = asIntOr(event.startSlot, NaN);
  const end = asIntOr(event.endSlot, NaN);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const duration = Math.round(end - start);
  if (duration < 1) return null; // 守 I1：start < end
  return {
    mode: mode,
    sourceId: event.id === undefined ? null : event.id,
    name: name,
    category: (typeof event.category === 'string' && event.category) ? event.category : 'work',
    templateId: event.templateId === undefined ? null : event.templateId,
    duration: Math.min(duration, TOTAL_SLOTS),
  };
}

// 算一次粘贴的落点：slot 是右键命中的空白槽位，bounds 是目标列当前视口 { min, max }
// 四条规则：快照非法（时长 < 1 槽）直接返回 null；时长尽量保持；起点放不下时向前回夹（先守视口，视口装不下才退化为守一整天）；恒 start < end
export function pasteRange(payload, slot, bounds) {
  if (!payload) return null;
  const duration = asIntOr(payload.duration, NaN);
  if (!Number.isFinite(duration) || duration < 1) return null;
  const len = Math.min(Math.round(duration), TOTAL_SLOTS);

  const viewMin = clampInt(asIntOr(bounds && bounds.min, 0), 0, TOTAL_SLOTS);
  const viewMax = clampInt(asIntOr(bounds && bounds.max, TOTAL_SLOTS), 0, TOTAL_SLOTS);
  const fitsViewport = viewMax - viewMin >= len;
  const lower = fitsViewport ? viewMin : 0;
  const upper = fitsViewport ? viewMax - len : TOTAL_SLOTS - len;

  const startSlot = clampInt(slot, lower, upper);
  return { startSlot: startSlot, endSlot: startSlot + len };
}

// 重叠谓词与 EventDialog 的冲突校验、slotRange.neighbourBounds 完全同一套：
// 同日、排除 ignoreId、a.start < b.end && a.end > b.start（end === start 算相邻，不算冲突）
export function hasOverlap(events, dateStr, startSlot, endSlot, ignoreId) {
  if (!Array.isArray(events)) return null;
  const start = asIntOr(startSlot, NaN);
  const end = asIntOr(endSlot, NaN);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e || e.id === ignoreId) continue;
    if (e.date !== dateStr) continue;
    const s = asIntOr(e.startSlot, NaN);
    const t = asIntOr(e.endSlot, NaN);
    if (!Number.isFinite(s) || !Number.isFinite(t)) continue;
    if (s < end && t > start) return e;
  }
  return null;
}
