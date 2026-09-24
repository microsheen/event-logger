// 时间轴边缘缩放规则检查：纯函数层（slot / 视口 / 邻居墙 / 最短时长）的确定性断言
// 用法：npm run slotrange:check
import {
  MIN_DURATION_SLOTS,
  boundarySlotFromY,
  neighbourBounds,
  resizeRange,
} from '../src/utils/slotRange.js';
import { TOTAL_SLOTS } from '../src/utils/time.js';

const problems = [];

function check(name, condition, detail) {
  if (!condition) problems.push(name + (detail ? ' -> ' + detail : ''));
}

function eq(name, actual, expected) {
  check(name, actual === expected, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
}

function range(r) {
  return r.startSlot + '-' + r.endSlot;
}

function ev(id, startSlot, endSlot) {
  return { id: id, name: id, category: 'work', date: '2026-09-21', startSlot: startSlot, endSlot: endSlot };
}

const FULL = { min: 0, max: TOTAL_SLOTS };
const MORNING = { min: 36, max: 144 };   // 06:00 起视图
const NO_WALL = { prevEnd: null, nextStart: null };

// —— 1. 邻居墙：只认「不重叠」的最近邻，紧贴算相邻 ——
const target = ev('t', 60, 70);
const three = [target, ev('prev', 50, 60), ev('next', 70, 80)];
const walls = neighbourBounds(three, target);
eq('上方邻居 endSlot', walls.prevEnd, 60);
eq('下方邻居 startSlot', walls.nextStart, 70);
const far = neighbourBounds([target, ev('p2', 10, 20), ev('p3', 30, 40), ev('n2', 100, 110), ev('n3', 90, 95)], target);
eq('取最近的上方邻居', far.prevEnd, 40);
eq('取最近的下方邻居', far.nextStart, 90);
eq('无邻居时 prevEnd 为 null', neighbourBounds([target], target).prevEnd, null);
eq('无邻居时 nextStart 为 null', neighbourBounds([target], target).nextStart, null);
const dirty = neighbourBounds([target, ev('ov', 65, 75)], target);
eq('与自身重叠的事件不算墙（不冻结拖动）', dirty.prevEnd === null && dirty.nextStart === null, true);
eq('脏数据（缺槽位）被忽略', neighbourBounds([target, { id: 'x' }], target).prevEnd, null);
eq('非数组入参安全', neighbourBounds(null, target).nextStart, null);

// —— 2. 像素 -> 槽位分界线：四舍五入实现 10 分钟吸附 ——
eq('半格以下不进位', boundarySlotFromY(104, 0, 0, 20), 5);
eq('半格及以上进位', boundarySlotFromY(110, 0, 0, 20), 6);
eq('整格命中', boundarySlotFromY(100, 0, 0, 20), 5);
eq('视口基线参与换算', boundarySlotFromY(0, 0, 36, 20), 36);
eq('负偏移换算为更小边界', boundarySlotFromY(-30, 0, 36, 20), 35);
eq('非法坐标回退基线', boundarySlotFromY(NaN, 0, 36, 20), 36);
eq('零高度格子回退基线', boundarySlotFromY(500, 0, 36, 0), 36);

// —— 3. 常规缩放：只动被拖的那个端点 ——
eq('上边缘上移拉长', range(resizeRange(target, 'start', 55, FULL, NO_WALL)), '55-70');
eq('上边缘下移缩短', range(resizeRange(target, 'start', 64, FULL, NO_WALL)), '64-70');
eq('下边缘下移拉长', range(resizeRange(target, 'end', 75, FULL, NO_WALL)), '60-75');
eq('下边缘上移缩短', range(resizeRange(target, 'end', 63, FULL, NO_WALL)), '60-63');
eq('edge=start 时 endSlot 恒定', resizeRange(target, 'start', 55, FULL, NO_WALL).endSlot, 70);
eq('edge=end 时 startSlot 恒定', resizeRange(target, 'end', 75, FULL, NO_WALL).startSlot, 60);
eq('未知 edge 按下边缘处理', range(resizeRange(target, 'END', 75, FULL, NO_WALL)), '60-75');

// —— 4. 越不过邻居，紧贴时是 no-op ——
const both = { prevEnd: 60, nextStart: 70 };
eq('上边缘越不过 prevEnd', range(resizeRange(target, 'start', 10, FULL, both)), '60-70');
eq('下边缘越不过 nextStart', range(resizeRange(target, 'end', 100, FULL, both)), '60-70');
const loose = { prevEnd: 40, nextStart: 100 };
eq('prevEnd 之内可自由拉长', range(resizeRange(target, 'start', 45, FULL, loose)), '45-70');
eq('nextStart 之内可自由拉长', range(resizeRange(target, 'end', 95, FULL, loose)), '60-95');
eq('null 邻居不构成墙', range(resizeRange(target, 'start', 0, FULL, NO_WALL)), '0-70');

// —— 5. 最短 1 槽：拖过对面只留 10 分钟 ——
eq('上边缘拖过下边缘', range(resizeRange(target, 'start', 100, FULL, NO_WALL)), '69-70');
eq('下边缘拖过上边缘', range(resizeRange(target, 'end', 0, FULL, NO_WALL)), '60-61');
const single = ev('s', 60, 61);
eq('1 槽事件无法再缩短（上边缘）', range(resizeRange(single, 'start', 70, FULL, NO_WALL)), '60-61');
eq('1 槽事件无法再缩短（下边缘）', range(resizeRange(single, 'end', 50, FULL, NO_WALL)), '60-61');
eq('1 槽事件可以拉长', range(resizeRange(single, 'end', 65, FULL, NO_WALL)), '60-65');
eq('最短时长常量锁定 1 槽', MIN_DURATION_SLOTS, 1);

// —— 6. 视口夹紧：端点只在可见范围内移动 ——
eq('视口内不得早于 viewMin', range(resizeRange(target, 'start', 10, MORNING, NO_WALL)), '36-70');
eq('视口内不得晚于 viewMax', range(resizeRange(ev('e', 60, 100), 'end', 144, MORNING, NO_WALL)), '60-144');
eq('全日视口不越 0', range(resizeRange(target, 'start', -50, FULL, NO_WALL)), '0-70');
eq('全日视口不越 144', range(resizeRange(target, 'end', 200, FULL, NO_WALL)), '60-144');
// 已经越出视口的端点：只准往视口方向走，绝不因为夹紧而"跳变"回视口内
const aboveView = ev('a', 20, 50);
eq('越出视口上方的 start 不被弹回', range(resizeRange(aboveView, 'start', 0, MORNING, NO_WALL)), '20-50');
eq('越出视口上方仍可缩短', range(resizeRange(aboveView, 'start', 30, MORNING, NO_WALL)), '30-50');
const NOON = { min: 36, max: 100 };        // 视口比事件窄：下方端点在视口之外
eq('越出视口下方的 end 不被弹回', range(resizeRange(ev('b', 60, 120), 'end', 200, NOON, NO_WALL)), '60-120');
eq('越出视口下方仍可缩短回视口内', range(resizeRange(ev('b', 60, 120), 'end', 80, NOON, NO_WALL)), '60-80');

// —— 7. 幂等 / 健壮性 ——
eq('candidate 等于当前端点则原样返回', range(resizeRange(target, 'start', 60, FULL, NO_WALL)), '60-70');
eq('缺 bounds 与 neighbours 时用数据全范围', range(resizeRange(target, 'start', 55, null, null)), '55-70');
eq('非法 candidate 回退到下限', range(resizeRange(target, 'start', NaN, MORNING, NO_WALL)), '36-70');
eq('退化区间（墙互相矛盾）不改动', range(resizeRange(ev('d', 5, 5), 'start', 3, FULL, { prevEnd: 5, nextStart: null })), '5-5');
eq('空 target 返回最小合法区间', range(resizeRange(null, 'start', 3, FULL, NO_WALL)), '0-1');

// —— 8. 不变量扫描：任意组合下 start < end、不越邻居、不越界 ——
let sweep = 0;
[0, 20, 36, 60, 100, 143].forEach(function (s) {
  [s + 1, s + 5, 144].forEach(function (e) {
    if (e <= s || e > TOTAL_SLOTS) return;
    [{ min: 0, max: 144 }, { min: 36, max: 144 }, { min: 0, max: 72 }].forEach(function (b) {
      [{ prevEnd: null, nextStart: null }, { prevEnd: Math.max(0, s - 3), nextStart: Math.min(144, e + 3) }].forEach(function (n) {
        ['start', 'end'].forEach(function (edge) {
          [-10, 0, 12, 36, 55, 60, 72, 100, 144, 200].forEach(function (c) {
            const r = resizeRange(ev('sw', s, e), edge, c, b, n);
            sweep += 1;
            check('扫描: 区间半开且至少 1 槽', r.startSlot < r.endSlot && r.endSlot - r.startSlot >= MIN_DURATION_SLOTS, s + '-' + e + ' ' + edge + ' c=' + c + ' => ' + range(r));
            check('扫描: 不越数据边界', r.startSlot >= 0 && r.endSlot <= TOTAL_SLOTS, range(r));
            if (n.prevEnd !== null) check('扫描: 不越 prevEnd', r.startSlot >= n.prevEnd, range(r));
            if (n.nextStart !== null) check('扫描: 不越 nextStart', r.endSlot <= n.nextStart, range(r));
            check('扫描: 只动被拖端点', edge === 'start' ? r.endSlot === e : r.startSlot === s, range(r));
          });
        });
      });
    });
  });
});

if (problems.length) {
  console.error('slot range check FAILED (' + problems.length + ' issues):');
  problems.slice(0, 40).forEach((p) => console.error('  - ' + p));
  process.exit(1);
}
console.log('slot range check OK: 邻居墙 / 视口夹紧 / 最短时长 + ' + sweep + ' 组不变量扫描');
