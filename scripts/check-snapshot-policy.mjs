// 历史版本策略检查：快照触发节奏、内容指纹、时间分层淘汰（纯函数，Node 里直接断言）
// 用法：npm run snapshot:check
import {
  REASONS,
  PROTECTED_REASONS,
  SNAPSHOT_INTERVAL_MS,
  STARTUP_SNAPSHOT_MS,
  RETENTION_SWEEP_MS,
  DAY_MS,
  TIER_ALL_MS,
  TIER_DAILY_MS,
  TIER_MONTHLY_MS,
  MAX_SNAPSHOTS,
  canonicalPayload,
  hashPayload,
  shouldSnapshot,
  needsStartupSnapshot,
  isProtected,
  retentionBucket,
  selectSnapshotsToDelete,
  snapshotStats,
} from '../src/storage/snapshots.js';

const problems = [];
function check(name, condition, detail) {
  if (!condition) problems.push(name + (detail ? ' -> ' + detail : ''));
}
function eq(name, actual, expected) {
  check(name, actual === expected, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
}
const NOW = new Date(2026, 8, 24, 12, 0, 0).getTime();
const ago = (days) => NOW - days * DAY_MS;
const ev = (id, date, startSlot) => ({ id: id, name: 'n-' + id, category: 'work', date: date, startSlot: startSlot, endSlot: startSlot + 6 });
const tp = (id) => ({ id: id, name: 't-' + id, category: 'work', timestamps: [1, 2] });
const snap = (id, createdAt, reason, extra) => Object.assign(
  { id: id, bookId: 'b1', createdAt: createdAt, reason: reason },
  extra || {},
);

// —— 1. 触发节奏 ——
eq('编辑期存档间隔 15 分钟', SNAPSHOT_INTERVAL_MS, 15 * 60 * 1000);
eq('启动补档阈值 24 小时', STARTUP_SNAPSHOT_MS, 24 * 60 * 60 * 1000);
eq('常驻清扫周期 6 小时', RETENTION_SWEEP_MS, 6 * 60 * 60 * 1000);
eq('从没备份过要存', shouldSnapshot({ nowMs: NOW, lastCreatedAt: undefined }), true);
eq('lastCreatedAt 为 null 要存', shouldSnapshot({ nowMs: NOW, lastCreatedAt: null }), true);
eq('14 分钟前不存', shouldSnapshot({ nowMs: NOW, lastCreatedAt: NOW - 14 * 60 * 1000 }), false);
eq('15 分钟前要存', shouldSnapshot({ nowMs: NOW, lastCreatedAt: NOW - SNAPSHOT_INTERVAL_MS }), true);
eq('时间倒流不存（时钟被改）', shouldSnapshot({ nowMs: NOW, lastCreatedAt: NOW + 60 * 1000 }), false);
eq('nowMs 非法不存', shouldSnapshot({ nowMs: NaN, lastCreatedAt: undefined }), false);
eq('自定义间隔生效', shouldSnapshot({ nowMs: NOW, lastCreatedAt: NOW - 60 * 1000, intervalMs: 30 * 1000 }), true);
eq('首次启动要补档', needsStartupSnapshot({ nowMs: NOW, lastCreatedAt: undefined }), true);
eq('23 小时内不补', needsStartupSnapshot({ nowMs: NOW, lastCreatedAt: NOW - 23 * 60 * 60 * 1000 }), false);
eq('超过 24 小时要补', needsStartupSnapshot({ nowMs: NOW, lastCreatedAt: ago(1.5) }), true);

// —— 2. 内容指纹：事件顺序无语义，模板顺序 = 插入顺序（不变量 I3）——
const A = { events: [ev('1', '2026-09-01', 60), ev('2', '2026-09-02', 80)], templates: [tp('a'), tp('b')] };
const shuffledEvents = { events: [ev('2', '2026-09-02', 80), ev('1', '2026-09-01', 60)], templates: [tp('a'), tp('b')] };
const swappedTemplates = { events: [ev('1', '2026-09-01', 60), ev('2', '2026-09-02', 80)], templates: [tp('b'), tp('a')] };
const reorderedKeys = {
  events: [{ endSlot: 66, date: '2026-09-01', startSlot: 60, category: 'work', name: 'n-1', id: '1' }, ev('2', '2026-09-02', 80)],
  templates: [tp('a'), tp('b')],
};
eq('事件顺序无关', hashPayload(A), hashPayload(shuffledEvents));
eq('对象键顺序无关', hashPayload(A), hashPayload(reorderedKeys));
eq('模板顺序有关', hashPayload(A) === hashPayload(swappedTemplates), false);
eq('指纹稳定（可重复计算）', hashPayload(A), hashPayload(A));
eq('改一个槽位就变指纹', hashPayload(A) === hashPayload({ events: [ev('1', '2026-09-01', 61), ev('2', '2026-09-02', 80)], templates: A.templates }), false);
eq('空 payload 也能算', typeof hashPayload({}), 'string');
eq('null payload 也能算', hashPayload(null), hashPayload({ events: [], templates: [] }));
check('canonical 是确定性字符串', canonicalPayload(A) === canonicalPayload(shuffledEvents), '');
check('指纹不是明文（不含事件名）', hashPayload(A).indexOf('n-1') === -1, hashPayload(A));

// —— 3. 受保护原因 ——
eq('受保护原因集合', PROTECTED_REASONS.join(','), 'manual,import,pre-restore');
eq('原因枚举完整', REASONS.length, 6);
PROTECTED_REASONS.forEach((r) => eq('受保护: ' + r, isProtected(snap('x', NOW, r)), true));
['interval', 'startup', 'restored-from'].forEach((r) => eq('不受保护: ' + r, isProtected(snap('x', NOW, r)), false));
eq('显式 protected 标记生效', isProtected(snap('x', NOW, 'interval', { protected: true })), true);
eq('null 安全', isProtected(null), false);

// —— 4. 分层窗口 ——
eq('全留窗口 7 天', TIER_ALL_MS, 7 * DAY_MS);
eq('按日窗口 30 天', TIER_DAILY_MS, 30 * DAY_MS);
eq('按月窗口 365 天', TIER_MONTHLY_MS, 365 * DAY_MS);
eq('总量上限 500', MAX_SNAPSHOTS, 500);
eq('6 天前仍按 id 独占（全留）', retentionBucket(snap('s1', ago(6), 'interval'), NOW).startsWith('all|'), true);
eq('恰好 7 天仍全留', retentionBucket(snap('s1', ago(7), 'interval'), NOW).startsWith('all|'), true);
eq('8 天进按日桶', /^day\|\d{4}-\d{2}-\d{2}$/.test(retentionBucket(snap('s1', ago(8), 'interval'), NOW)), true);
eq('31 天进按月桶', /^month\|\d{4}-\d{2}$/.test(retentionBucket(snap('s1', ago(31), 'interval'), NOW)), true);
eq('366 天进按年桶', /^year\|\d{4}$/.test(retentionBucket(snap('s1', ago(366), 'interval'), NOW)), true);
eq('非法 createdAt 单独成桶（不会被顺手删掉）', retentionBucket(snap('s1', NaN, 'interval'), NOW).startsWith('invalid|'), true);

// —— 5. 淘汰：同桶只留最早一份，最新一份与受保护的永不删 ——
const day10a = snap('d10a', ago(10), 'interval');
const day10b = snap('d10b', ago(10) + 1000, 'interval');
const day10c = snap('d10c', ago(10) + 2000, 'interval');
const day12 = snap('d12', ago(12), 'interval');
const manual = snap('m', ago(20), 'manual');
const newest = snap('newest', NOW, 'interval');
const set = [day12, day10a, day10b, day10c, manual, newest];
const del = selectSnapshotsToDelete(set, NOW, {});
eq('同一天只留最早一份', del.indexOf('d10b') !== -1 && del.indexOf('d10c') !== -1, true);
eq('保留同一天最早那份', del.indexOf('d10a'), -1);
eq('不同天各留一份', del.indexOf('d12'), -1);
eq('受保护的不删', del.indexOf('m'), -1);
eq('最新的不删', del.indexOf('newest'), -1);
eq('返回升序 id', del.join(','), [...del].sort().join(','));
eq('不改动入参数组', set.length, 6);
eq('空输入安全', selectSnapshotsToDelete([], NOW, {}).length, 0);
eq('null 输入安全', selectSnapshotsToDelete(null, NOW, null).length, 0);
eq('脏数据（无 id / 无时间）不进删除名单', selectSnapshotsToDelete([{ id: 'x' }, { createdAt: 1 }, null, newest], NOW, {}).length, 0);
// 只有最新一份时，无论多老都必须留着
eq('孤本永不删除', selectSnapshotsToDelete([snap('only', ago(900), 'interval')], NOW, {}).length, 0);

// —— 6. 500 上限：只削最老的非受保护项，受保护项超上限也不动 ——
const many = [];
for (let i = 0; i < 620; i++) many.push(snap('s' + String(i).padStart(4, '0'), ago(0.5) + i * 1000, 'interval'));
const trimmed = selectSnapshotsToDelete(many, NOW, {});
eq('超出 500 会被削', trimmed.length, 620 - MAX_SNAPSHOTS);
eq('削的是最老的（保留尾部）', trimmed[0], 's0000');
const mostlyProtected = [];
for (let i = 0; i < 5; i++) mostlyProtected.push(snap('p' + i, ago(400) + i * 1000, 'manual'));
mostlyProtected.push(snap('u', ago(400) + 9999, 'interval'));
mostlyProtected.push(snap('z', NOW, 'interval'));
const overLimit = selectSnapshotsToDelete(mostlyProtected, NOW, { maxSnapshots: 3 });
eq('受保护项宁超上限也不删', overLimit.filter((id) => id[0] === 'p').length, 0);
eq('先删非受保护的普通项', overLimit.join(','), 'u');
eq('最新一份永远留着', overLimit.indexOf('z'), -1);

// —— 7. 两年真实节奏模拟：留存量必须有界，且永远能回到任意历史时刻 ——
const sim = [];
let seq = 0;
const push = (createdAt, reason) => sim.push(snap('x' + (seq++), createdAt, reason));
for (let t = ago(7); t <= NOW; t += SNAPSHOT_INTERVAL_MS) push(t, 'interval');        // 近 7 天：每 15 分钟
for (let day = 8; day <= 30; day++) { push(ago(day), 'interval'); push(ago(day) + 6 * 60 * 60 * 1000, 'interval'); } // 每天 2 份
for (let day = 31; day <= 365; day += 3) push(ago(day), 'interval');                   // 每 3 天 1 份
for (let day = 366; day <= 730; day += 30) push(ago(day), 'interval');                 // 更早每月 1 份
const manualId = 'x' + seq;
push(ago(100), 'manual');
const simDel = selectSnapshotsToDelete(sim, NOW, {});
const simKeep = sim.length - simDel.length;
check('模拟留存量不超上限', simKeep <= MAX_SNAPSHOTS, 'keep=' + simKeep);
check('模拟总量确实超过上限（否则这条测试没意义）', sim.length > MAX_SNAPSHOTS, 'total=' + sim.length);
eq('模拟保留最新', simDel.indexOf(sim[sim.length - 1].id), -1);
eq('模拟保留受保护', simDel.indexOf(manualId), -1);
eq('淘汰是幂等的（再跑一次不再删）', selectSnapshotsToDelete(sim.filter((s) => simDel.indexOf(s.id) === -1), NOW, {}).length, 0);
// 每个历史分层桶都至少还有一份可回放
const buckets = new Set(sim.filter((s) => simDel.indexOf(s.id) === -1).map((s) => retentionBucket(s, NOW)));
check('每个桶都留了东西', buckets.size === simKeep, buckets.size + ' vs ' + simKeep);

// —— 8. 统计展示 ——
const stats = snapshotStats([snap('a', ago(3), 'interval', { bytes: 100 }), snap('b', ago(1), 'interval', { bytes: 250 })]);
eq('份数', stats.count, 2);
eq('总字节', stats.bytes, 350);
eq('最老一份', stats.oldest, ago(3));
eq('空列表', snapshotStats([]).bytes, 0);
eq('null 安全', snapshotStats(null).count, 0);
eq('缺 bytes 按 0 计', snapshotStats([{ createdAt: 5 }]).bytes, 0);

if (problems.length) {
  console.error('snapshot policy check FAILED (' + problems.length + ' issues):');
  problems.slice(0, 40).forEach((p) => console.error('  - ' + p));
  process.exit(1);
}
console.log('snapshot policy check OK: 指纹/节奏/分层淘汰/上限 + 模拟 ' + sim.length + ' 份留 ' + simKeep + ' 份');