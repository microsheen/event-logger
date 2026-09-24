// 时间轴跨日期拖动落点检查：纯函数层（空闲窗口 / 位移最小夹紧 / 横向命中列）的确定性断言
// 用法：npm run daydrop:check
import { freeWindowsForDay, clampMoveToFreeWindow, columnIndexOfX } from '../src/utils/dayDrop.js';
import { hasOverlap } from '../src/utils/eventClipboard.js';
import { TOTAL_SLOTS } from '../src/utils/time.js';

const DATE = '2026-09-22';
const problems = [];

function check(name, condition, detail) {
  if (!condition) problems.push(name + (detail ? ' -> ' + detail : ''));
}

function eq(name, actual, expected) {
  check(name, actual === expected, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
}

function ev(id, startSlot, endSlot, date) {
  return { id: id, name: id, category: 'work', date: date || DATE, startSlot: startSlot, endSlot: endSlot };
}

function wins(list) {
  return list.map(x => x.start + '-' + x.end).join(',');
}

function out(r) {
  return r.valid ? r.startSlot + '-' + r.endSlot : 'invalid';
}

// —— 1. freeWindowsForDay：空闲窗口 = 当天没被占的连续段 ——
eq('空一天 = 一整段', wins(freeWindowsForDay([], 'a')), '0-144');
eq('非数组也当作空一天', wins(freeWindowsForDay(undefined, 'a')), '0-144');
eq('一天排满 = 空数组', wins(freeWindowsForDay([ev('a', 0, 144)], 'x')), '');
eq('中段占用切成两段', wins(freeWindowsForDay([ev('a', 60, 70)], 'x')), '0-60,70-144');
eq('贴边占用只留一段', wins(freeWindowsForDay([ev('a', 0, 60)], 'x')), '60-144');
eq('end === start 算相邻：不留零宽窗口',
  wins(freeWindowsForDay([ev('a', 0, 60), ev('b', 60, 70)], 'x')), '70-144');
eq('互相重叠的占用只合并一次',
  wins(freeWindowsForDay([ev('a', 10, 40), ev('b', 30, 60)], 'x')), '0-10,60-144');
eq('数组顺序不影响结果',
  wins(freeWindowsForDay([ev('a', 80, 90), ev('b', 10, 20)], 'x')), '0-10,20-80,90-144');
eq('排除自己（原地微调永远合法的前提）',
  wins(freeWindowsForDay([ev('a', 10, 20)], 'a')), '0-144');
eq('越界端点裁进当天',
  wins(freeWindowsForDay([ev('a', -10, 20)], 'x')), '20-144');
eq('整条越界 = 占满一天', wins(freeWindowsForDay([ev('a', -50, 500)], 'x')), '');
eq('数字字符串合法', wins(freeWindowsForDay([ev('a', '30', '45')], 'x')), '0-30,45-144');
eq('倒序 / 零长 / 缺字段 / null 条目整条丢弃',
  wins(freeWindowsForDay([null, undefined, ev('a', 50, 20), ev('b', 30, 30),
    { id: 'c' }, ev('d', NaN, 40), ev('e', 10, 20)], 'x')), '0-10,20-144');
check('窗口互不相交且按序', freeWindowsForDay([ev('a', 10, 20), ev('b', 25, 30)], 'x')
  .every((v, i, arr) => v.start < v.end && (i === 0 || arr[i - 1].end <= v.start)), '');

// —— 2. clampMoveToFreeWindow：时长锁死，起点挪到位移最小的空档 ——
const W = [{ start: 0, end: 50 }, { start: 70, end: 144 }];
eq('已在空档内：纹丝不动', out(clampMoveToFreeWindow(W, 10, 20)), '20-30');
eq('刚好贴住空档上沿：不动', out(clampMoveToFreeWindow(W, 10, 40)), '40-50');
eq('压到墙上：往回夹到最近空档', out(clampMoveToFreeWindow(W, 10, 45)), '40-50');
eq('越过后墙：往前夹', out(clampMoveToFreeWindow(W, 10, 62)), '70-80');
eq('越出全天上界：夹到 144-duration', out(clampMoveToFreeWindow(W, 10, 139)), '134-144');
eq('负坐标：夹到 0', out(clampMoveToFreeWindow(W, 10, -40)), '0-10');
eq('并列取更早的空档', out(clampMoveToFreeWindow([{ start: 0, end: 6 }, { start: 10, end: 20 }], 2, 7)), '4-6');
eq('装不下的窗口直接跳过', out(clampMoveToFreeWindow([{ start: 0, end: 3 }, { start: 10, end: 120 }], 10, 1)), '10-20');
eq('所有窗口都太窄：invalid', out(clampMoveToFreeWindow([{ start: 0, end: 5 }, { start: 10, end: 15 }], 6, 0)), 'invalid');
eq('排满的一天：invalid', out(clampMoveToFreeWindow([], 1, 0)), 'invalid');
eq('时长超过一天：invalid', out(clampMoveToFreeWindow(W, TOTAL_SLOTS + 1, 0)), 'invalid');
eq('时长恰好等于全天', out(clampMoveToFreeWindow([{ start: 0, end: 144 }], 144, 99)), '0-144');
eq('零长事件：invalid', out(clampMoveToFreeWindow(W, 0, 10)), 'invalid');
eq('负时长：invalid', out(clampMoveToFreeWindow(W, -5, 10)), 'invalid');
eq('非数字时长：invalid', out(clampMoveToFreeWindow(W, NaN, 10)), 'invalid');
eq('非数字候选起点：invalid', out(clampMoveToFreeWindow(W, 10, undefined)), 'invalid');
eq('窗口列表非数组：invalid', out(clampMoveToFreeWindow(null, 10, 0)), 'invalid');
eq('非法窗口条目被忽略', out(clampMoveToFreeWindow([null, { start: NaN, end: 5 }, { start: 0, end: 20 }], 5, 30)), '15-20');
check('结果恒半开且时长不变', clampMoveToFreeWindow(W, 7, 44).endSlot - clampMoveToFreeWindow(W, 7, 44).startSlot === 7, '');

// —— 3. columnIndexOfX：横向落到哪一列 ——
const RECTS = [{ left: 0, right: 100 }, { left: 100, right: 200 }, { left: 200, right: 300 }];
eq('命中第一列', columnIndexOfX(50, RECTS), 0);
eq('列边界算右列（半开）', columnIndexOfX(100, RECTS), 1);
eq('命中最后一列', columnIndexOfX(299, RECTS), 2);
eq('拖到左边框外：吸附最近的第 0 列', columnIndexOfX(-5000, RECTS), 0);
eq('拖到右边框外：吸附最末列', columnIndexOfX(5000, RECTS), 2);
eq('空列表：-1', columnIndexOfX(50, []), -1);
eq('非数组：-1', columnIndexOfX(50, null), -1);
eq('坐标非法：-1', columnIndexOfX('x', RECTS), -1);
eq('缺列时索引仍按原数组对齐', columnIndexOfX(150, [null, RECTS[1], RECTS[2]]), 1);
eq('倒置矩形跳过', columnIndexOfX(50, [{ left: 100, right: 0 }, RECTS[1]]), 1);
eq('全是坏矩形：-1', columnIndexOfX(50, [null, { left: NaN, right: 9 }]), -1);

// —— 4. 不变量扫描：夹紧结果永远落在真空档里，且与"粘贴侧"重叠谓词同口径 ——
// 独立实现一份 oracle：逐槽占用位图 + 前缀和（与 freeWindowsForDay 的区间合并算法完全不同）
function occupiedBitmap(dayEvents, excludeId) {
  const occ = new Array(TOTAL_SLOTS).fill(0);
  (dayEvents || []).forEach((e) => {
    if (!e || e.id === excludeId) return;
    const s = Number(e.startSlot);
    const t = Number(e.endSlot);
    if (!Number.isFinite(s) || !Number.isFinite(t)) return;
    for (let i = Math.max(0, Math.round(s)); i < Math.min(TOTAL_SLOTS, Math.round(t)); i++) occ[i] = 1;
  });
  return occ;
}

function feasibleStarts(dayEvents, excludeId, duration) {
  const occ = occupiedBitmap(dayEvents, excludeId);
  const prefix = new Array(TOTAL_SLOTS + 1).fill(0);
  for (let i = 0; i < TOTAL_SLOTS; i++) prefix[i + 1] = prefix[i] + occ[i];
  const ok = [];
  for (let s = 0; s + duration <= TOTAL_SLOTS; s++) {
    if (prefix[s + duration] - prefix[s] === 0) ok.push(s);
  }
  return ok;
}

const LAYOUTS = [
  [],
  [[0, 144]],
  [[60, 70]],
  [[0, 30], [60, 90], [120, 144]],
  [[10, 20], [25, 35], [100, 110]],
  [[0, 6], [6, 12], [12, 18], [130, 144]],
  [[50, 55], [56, 60], [61, 70], [71, 80]],
  [[0, 10], [20, 30], [40, 50], [60, 70], [80, 90], [100, 110], [120, 130]],
  [[-5, 20], [130, 200]], // 脏：越界端点
  [[40, 30], [55, 55], [70, 90]], // 脏：倒序 + 零长
];
const DURATIONS = [1, 2, 3, 6, 12, 24, 72, 144, 145];
let sweep = 0;

LAYOUTS.forEach(function (layout, li) {
  const clean = layout.every(p => p[0] >= 0 && p[1] <= TOTAL_SLOTS && p[0] < p[1]);
  const dayEvents = layout.map((p, i) => ev('o' + i, p[0], p[1]));
  DURATIONS.forEach(function (duration) {
    const okStarts = feasibleStarts(dayEvents, 'self', duration);
    const windows = freeWindowsForDay(dayEvents, 'self');
    // 逐槽占用与区间合并必须描述同一片空闲
    let freeByWindow = 0;
    windows.forEach(x => { freeByWindow += x.end - x.start; });
    const occ = occupiedBitmap(dayEvents, 'self');
    let freeByBitmap = 0;
    for (let i = 0; i < TOTAL_SLOTS; i++) if (!occ[i]) freeByBitmap += 1;
    check('扫描: 窗口并集 = 空闲槽位', freeByWindow === freeByBitmap, 'layout#' + li + ' d=' + duration);

    for (let candidate = 0; candidate < TOTAL_SLOTS; candidate++) {
      sweep += 1;
      const r = clampMoveToFreeWindow(windows, duration, candidate);
      if (okStarts.length === 0) {
        check('扫描: 装不下必须作废', r.valid === false, 'layout#' + li + ' d=' + duration + ' c=' + candidate);
        continue;
      }
      check('扫描: 有解必须有效', r.valid === true, 'layout#' + li + ' d=' + duration + ' c=' + candidate);
      if (!r.valid) continue;
      check('扫描: 时长锁死', r.endSlot - r.startSlot === duration, 'layout#' + li + ' d=' + duration);
      check('扫描: 结果落在可行起点集内', okStarts.indexOf(r.startSlot) >= 0,
        'layout#' + li + ' d=' + duration + ' c=' + candidate + ' => ' + out(r));
      // 与暴力 oracle 完全一致：位移最小，并列取更早
      let best = okStarts[0];
      let bestDist = Math.abs(best - candidate);
      for (let i = 1; i < okStarts.length; i++) {
        const d = Math.abs(okStarts[i] - candidate);
        if (d < bestDist) { bestDist = d; best = okStarts[i]; }
      }
      check('扫描: 位移最小且并列取更早', r.startSlot === best,
        'layout#' + li + ' d=' + duration + ' c=' + candidate + ' => ' + out(r) + ', want ' + best);
      // 跨层不变量：干净数据下，拖动避让用的空档 == 粘贴拒绝用的重叠谓词
      if (clean) {
        check('扫描: 与 hasOverlap 同口径',
          hasOverlap(dayEvents, DATE, r.startSlot, r.endSlot, 'self') === null,
          'layout#' + li + ' d=' + duration + ' => ' + out(r));
      }
    }
  });

  // 原地微调永远合法：被拖的那条自己不构成墙（否则"点一下没挪"都会被判失败）
  // 起手位置必须取自"排除自己之前的真实空档"，否则等于拿一条本来就压在别人身上的脏数据要它原地不动
  if (clean) {
    [1, 10, 30].forEach(function (len) {
      const free = freeWindowsForDay(dayEvents, 'self');
      const slot = free.find(w => w.end - w.start >= len);
      if (!slot) return;
      const lo = slot.start;
      const hi = slot.end - len; // 合法候选位只有 [lo, hi]：越界的那几个位置本来就压在别人身上
      [lo, Math.floor((lo + hi) / 2), hi].forEach(function (at) {
        const withSelf = dayEvents.concat([ev('self', at, at + len)]);
        const selfWindows = freeWindowsForDay(withSelf, 'self');
        check('扫描: 排除自己后窗口不变',
          wins(selfWindows) === wins(free), 'layout#' + li + ' d=' + len + ' at=' + at);
        const r = clampMoveToFreeWindow(selfWindows, len, at);
        check('扫描: 原地微调不改一字', r.valid && r.startSlot === at && r.endSlot === at + len,
          'layout#' + li + ' d=' + len + ' at=' + at + ' => ' + out(r));
      });
    });
  }
});

if (problems.length) {
  console.error('day drop check FAILED (' + problems.length + ' issues):');
  problems.slice(0, 40).forEach((p) => console.error('  - ' + p));
  process.exit(1);
}
console.log('day drop check OK: 空闲窗口 / 位移最小夹紧 / 横向命中列 + ' + sweep + ' 组不变量扫描');
