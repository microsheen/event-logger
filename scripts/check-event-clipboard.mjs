// 时间轴剪贴板规则检查：快照合法性 / 粘贴落点夹紧 / 重叠谓词（纯函数层，确定性断言）
// 用法：npm run clipboard:check
import {
  clipboardFromEvent,
  pasteRange,
  hasOverlap,
} from '../src/utils/eventClipboard.js';
import { TOTAL_SLOTS } from '../src/utils/time.js';

const problems = [];

function check(name, condition, detail) {
  if (!condition) problems.push(name + (detail ? ' -> ' + detail : ''));
}

function eq(name, actual, expected) {
  check(name, actual === expected, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
}

function jsonEq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
}

function ev(id, date, startSlot, endSlot) {
  return { id: id, name: id, category: 'work', date: date, startSlot: startSlot, endSlot: endSlot };
}

function payload(duration, extra) {
  return { mode: 'copy', sourceId: null, name: 'n', category: 'work', templateId: null, duration: duration, ...extra };
}

const DAY = '2026-09-22';
const VIEW = { min: 36, max: 144 };   // 06:00 起视图

// —— 1. 快照：只留与位置无关的内容，脏事件直接拒绝 ——
jsonEq('copy 快照字段', clipboardFromEvent({ id: 'a', name: '  会议  ', category: 'life', startSlot: 40, endSlot: 46, templateId: 't' }, 'copy'),
  { mode: 'copy', sourceId: 'a', name: '会议', category: 'life', templateId: 't', duration: 6 });
eq('cut 快照 mode', clipboardFromEvent(ev('a', DAY, 40, 46), 'cut').mode, 'cut');
eq('cut 快照 sourceId', clipboardFromEvent(ev('a', DAY, 40, 46), 'cut').sourceId, 'a');
eq('零长事件不快照', clipboardFromEvent(ev('a', DAY, 40, 40), 'copy'), null);
eq('倒序区间不快照', clipboardFromEvent(ev('a', DAY, 41, 40), 'cut'), null);
eq('空名不快照', clipboardFromEvent({ id: 'a', name: '   ', startSlot: 1, endSlot: 2 }, 'copy'), null);
eq('脏 startSlot 不快照', clipboardFromEvent({ id: 'a', name: 'x', startSlot: 'abc', endSlot: 9 }, 'copy'), null);
eq('未知 mode 不快照', clipboardFromEvent(ev('a', DAY, 1, 2), 'paste'), null);
eq('缺 category 回落 work', clipboardFromEvent({ id: 'a', name: 'x', startSlot: 1, endSlot: 2 }, 'copy').category, 'work');
eq('缺 templateId 归 null', clipboardFromEvent({ id: 'a', name: 'x', startSlot: 1, endSlot: 2 }, 'cut').templateId, null);
eq('无 id 事件 sourceId 为 null', clipboardFromEvent({ name: 'x', startSlot: 1, endSlot: 2 }, 'copy').sourceId, null);
eq('超长区间时长封顶一整天', clipboardFromEvent({ id: 'a', name: 'x', startSlot: 0, endSlot: 999 }, 'copy').duration, TOTAL_SLOTS);

// —— 2. 落点：时长尽量保持，放不下就向前回夹 ——
jsonEq('中段原样落点', pasteRange(payload(6), 50, VIEW), { startSlot: 50, endSlot: 56 });
jsonEq('贴近视口末尾向前夹', pasteRange(payload(6), 142, VIEW), { startSlot: 138, endSlot: 144 });
jsonEq('右键槽位在视口下沿之前也夹回视口', pasteRange(payload(6), 10, VIEW), { startSlot: 36, endSlot: 42 });
jsonEq('单槽时长贴末尾', pasteRange(payload(1), 143, VIEW), { startSlot: 143, endSlot: 144 });
jsonEq('时长大于视口 → 退化为守一整天', pasteRange(payload(120), 40, { min: 36, max: 100 }), { startSlot: 24, endSlot: 144 });
jsonEq('时长等于一整天', pasteRange(payload(TOTAL_SLOTS), 90, { min: 0, max: TOTAL_SLOTS }), { startSlot: 0, endSlot: TOTAL_SLOTS });
jsonEq('非法 slot 取视口下沿', pasteRange(payload(6), 'x', VIEW), { startSlot: 36, endSlot: 42 });
eq('脏时长（<1 槽）不落点', pasteRange(payload(0), 50, VIEW), null);
eq('负时长不落点', pasteRange(payload(-6), 50, VIEW), null);
eq('无快照返回 null', pasteRange(null, 50, VIEW), null);
eq('无 bounds 时按全天', pasteRange(payload(6), 200, undefined).endSlot, TOTAL_SLOTS);

let sweep = 0;
for (let d = 1; d <= TOTAL_SLOTS; d++) {
  for (let s = 0; s <= TOTAL_SLOTS; s++) {
    [VIEW, { min: 0, max: TOTAL_SLOTS }, { min: 60, max: 72 }].forEach((bounds) => {
      sweep++;
      const r = pasteRange(payload(d), s, bounds);
      check('恒 start < end', r.startSlot < r.endSlot, 'd=' + d + ' slot=' + s);
      check('恒落在一天内', r.startSlot >= 0 && r.endSlot <= TOTAL_SLOTS, 'd=' + d + ' slot=' + s);
      check('视口装得下时不越视口', d > bounds.max - bounds.min
        || (r.startSlot >= bounds.min && r.endSlot <= bounds.max), 'd=' + d + ' slot=' + s);
      check('时长保持不缩水', r.endSlot - r.startSlot === Math.min(d, TOTAL_SLOTS), 'd=' + d + ' slot=' + s);
      check('起点不回穿（右键靠后则不会更靠前）', r.startSlot >= Math.min(s, bounds.max - d), 'd=' + d + ' slot=' + s);
    });
  }
}

// —— 3. 重叠谓词：与 EventDialog / neighbourBounds 同一口径 ——
const same = [ev('a', DAY, 40, 46), ev('b', DAY, 50, 55), ev('c', '2026-09-21', 40, 46)];
eq('正中覆盖判冲突', hasOverlap(same, DAY, 43, 44, null), same[0]);
eq('左端压一格判冲突', hasOverlap(same, DAY, 39, 41, null), same[0]);
eq('右端压一格判冲突', hasOverlap(same, DAY, 45, 47, null), same[0]);
eq('end === start 算相邻不冲突', hasOverlap(same, DAY, 34, 40, null), null);
eq('start === end 算相邻不冲突', hasOverlap(same, DAY, 46, 50, null), null);
eq('完全包含判冲突', hasOverlap(same, DAY, 30, 60, null), same[0]);
eq('只报同日阻塞者', hasOverlap(same, '2026-09-21', 41, 45, null), same[2]);
eq('ignoreId 让 cut 原位粘贴不自我冲突', hasOverlap(same, DAY, 40, 46, 'a'), null);
eq('ignoreId 只忽略自己', hasOverlap(same, DAY, 40, 55, 'a'), same[1]);
eq('空事件数组无冲突', hasOverlap([], DAY, 40, 46, null), null);
eq('非数组容忍为无冲突', hasOverlap(undefined, DAY, 40, 46, null), null);
eq('脏事件（缺槽位）跳过', hasOverlap([null, { id: 'z' }, ev('d', DAY, NaN, NaN)], DAY, 40, 46, null), null);
eq('非法落点区间返回 null', hasOverlap(same, DAY, 46, 40, null), null);

// —— 4. 与既有关键规则的一致性：相邻粘贴链不被剪贴板打破 ——
const chain = [ev('x', DAY, 40, 44), ev('y', DAY, 44, 48)];
jsonEq('紧贴已有事件末尾粘贴合法', pasteRange(payload(4), 48, { min: 0, max: TOTAL_SLOTS }), { startSlot: 48, endSlot: 52 });
eq('紧贴链尾粘贴无冲突', hasOverlap(chain, DAY, 48, 52, null), null);
eq('压住链中判冲突', hasOverlap(chain, DAY, 42, 46, null), chain[0]);

if (problems.length) {
  console.error('event clipboard check FAILED (' + problems.length + ' issues):');
  problems.slice(0, 40).forEach((p) => console.error('  - ' + p));
  process.exit(1);
}
console.log('event clipboard check OK: 快照 / 落点夹紧 / 重叠谓词 + ' + sweep + ' 组不变量扫描');
