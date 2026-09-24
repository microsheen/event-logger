// EventBook 与备份信封检查：设置守门、名称清洗、v1/v2 信封、导入防撞（纯函数层）
// 用法：npm run book:check
import {
  LANG_WEEK_START,
  MAX_BOOK_NAME,
  STATS_SCOPES,
  normalizeSettings,
  sanitizeBookName,
  bookSlug,
  makeBook,
  isBook,
} from '../src/storage/books.js';
import { TOTAL_SLOTS } from '../src/utils/time.js';
import {
  ENVELOPE_V2,
  detectEnvelope,
  toV2Envelope,
  booksFromEnvelope,
  planImport,
  normalizeLivePayload,
} from '../src/storage/legacy.js';

const problems = [];
function check(name, condition, detail) {
  if (!condition) problems.push(name + (detail ? ' -> ' + detail : ''));
}
function eq(name, actual, expected) {
  check(name, actual === expected, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
}
const NOW = new Date(2026, 8, 24, 12, 0, 0).getTime();
let seq = 0;
const idFactory = () => 'gen' + (seq++);

// —— 1. normalizeSettings：不变量 I2（0 ≤ timelineStart < timelineEnd ≤ 144）——
const ok = normalizeSettings({ timelineStart: 36, timelineEnd: 132 }, {});
eq('合法区间原样保留', ok.timelineStart + '-' + ok.timelineEnd, '36-132');
eq('缺省 statsScope = week', ok.statsScope, 'week');
[
  [{ timelineStart: 100, timelineEnd: 20 }, 'start >= end 必须整体重置'],
  [{ timelineStart: -5, timelineEnd: 9999 }, '越界重置为全日'],
  [{ timelineStart: 'a', timelineEnd: null }, '非数字回退全日'],
  [{ timelineStart: 144, timelineEnd: 0 }, '两端都越界'],
].forEach(([raw, label]) => {
  const s = normalizeSettings(raw, {});
  check(label, s.timelineStart >= 0 && s.timelineStart < s.timelineEnd && s.timelineEnd <= TOTAL_SLOTS, JSON.stringify(s));
});
eq('语言非法时用 fallbackLang', normalizeSettings({ language: 'de' }, { fallbackLang: 'ja' }).language, 'ja');
eq('zh 默认周开始 = 周一', normalizeSettings({ language: 'zh' }, {}).weekStartsOn, LANG_WEEK_START.zh);
eq('en 默认周开始 = 周日', normalizeSettings({ language: 'en' }, {}).weekStartsOn, LANG_WEEK_START.en);
eq('显式 weekStartsOn 优先于语言默认', normalizeSettings({ language: 'en', weekStartsOn: 5 }, {}).weekStartsOn, 5);
eq('非法 weekStartsOn 回退周一', normalizeSettings({ language: 'en', weekStartsOn: 9 }, {}).weekStartsOn, 1);
eq('null 入参不炸', normalizeSettings(null, {}).timelineEnd, TOTAL_SLOTS);
eq('非对象入参不炸', normalizeSettings('nope', {}).language, normalizeSettings({}, {}).language);
STATS_SCOPES.forEach((s) => eq('statsScope 可用: ' + s, normalizeSettings({ statsScope: s }, {}).statsScope, s));
eq('statsScope 白名单外回退', normalizeSettings({ statsScope: 'decade' }, {}).statsScope, 'week');
// 读盘 → 写盘 → 再读盘不能漂移
const raw = { language: 'ja', timelineStart: 5, timelineEnd: 9 };
eq('归一化幂等', JSON.stringify(normalizeSettings(normalizeSettings(raw, {}), {})), JSON.stringify(normalizeSettings(raw, {})));
// —— 2. 书名清洗 ——
eq('去首尾空白', sanitizeBookName('  我的簿  '), '我的簿');
eq('压缩内部空白', sanitizeBookName('a\u000b  b\tc'), 'a b c');
eq('控制字符换成空格', sanitizeBookName('x\u0000y'), 'x y');
eq('null 变空串', sanitizeBookName(null), '');
eq('数字入参转字符串', sanitizeBookName(2026), '2026');
eq('超长截断到 ' + MAX_BOOK_NAME, sanitizeBookName('a'.repeat(200)).length, MAX_BOOK_NAME);
eq('截断在 40 处再收尾空白', sanitizeBookName('a'.repeat(39) + ' bbbb'), 'a'.repeat(39));
eq('全空白输入变空', sanitizeBookName('   '), '');

// —— 3. bookSlug：文件名安全，中文保留 ——
eq('Windows 非法字符被剥掉', bookSlug({ id: 'abcdef12345', name: 'a/b\\\\c:d*e?f"g<h>i|j' }), 'abcdefghij-abcdef12');
eq('空格转连字符', bookSlug({ id: 'x1', name: '工作 日志' }), '工作-日志-x1');
eq('中文保留', bookSlug({ id: 'zz', name: '我的 EventBook' }).indexOf('我的'), 0);
eq('空名回退 eventbook', bookSlug({ id: '', name: '' }), 'eventbook');
eq('带 id 后缀（取前 8 位）便于区分重名簿', bookSlug({ id: 'id1234567', name: 'A' }), 'A-id123456');
eq('无 id 时不加尾杠', bookSlug({ name: 'A' }), 'A');
check('slug 不含路径分隔符', !/[\\/:*?"<>|]/.test(bookSlug({ id: 'a1', name: 'C:\\x:y' })), bookSlug({ id: 'a1', name: 'C:\\x:y' }));
check('slug 不以连字符收尾', !/-+$/.test(bookSlug({ id: 'a1', name: '---' })), bookSlug({ id: 'a1', name: '---' }));

// —— 4. makeBook ——
const b1 = makeBook({ name: '第一本', language: 'zh', weekStartsOn: 3 }, { nowMs: NOW, deviceLang: 'en', idFactory });
eq('未给 id 时用 idFactory', typeof b1.id, 'string');
eq('名称保留', b1.name, '第一本');
eq('语言取入参', b1.settings.language, 'zh');
eq('周开始日取入参（覆盖语言默认）', b1.settings.weekStartsOn, 3);
eq('createdAt 用 nowMs', b1.createdAt, NOW);
eq('updatedAt 用 nowMs', b1.updatedAt, NOW);
eq('isBook 认它', isBook(b1), true);
const b2 = makeBook({}, { nowMs: NOW, deviceLang: 'en', idFactory });
eq('无设备语言时用默认周开始日', b2.settings.weekStartsOn, LANG_WEEK_START.en);
eq('无名称时有默认名', b2.name.length > 0, true);
eq('无 id 也能造', isBook(b2), true);
const b3 = makeBook({ id: 'keep-me', name: 'x' }, { nowMs: NOW, idFactory });
eq('显式 id 必须保留', b3.id, 'keep-me');
eq('isBook 拒绝缺 settings', isBook({ id: 'a' }), false);
eq('isBook 拒绝 null', isBook(null), false);
// 每本簿自带周开始日：两本不同设置的簿互不影响
const bA = makeBook({ name: 'A', language: 'zh' }, { nowMs: NOW, idFactory });
const bB = makeBook({ name: 'B', language: 'en' }, { nowMs: NOW, idFactory });
eq('两本簿的周开始日可以不同', bA.settings.weekStartsOn + '/' + bB.settings.weekStartsOn, LANG_WEEK_START.zh + '/' + LANG_WEEK_START.en);
// —— 5. 备份信封：v1（旧单书整包）与 v2（多书）——
const v1 = { events: [{ id: 'e1', date: '2026-09-01', startSlot: 60, endSlot: 66, category: 'work', name: 'x' }], templates: [{ id: 't1', name: 'T', category: 'work', timestamps: [1] }] };
const v2 = {
  version: ENVELOPE_V2, app: 'event-logger', exportedAt: new Date(NOW).toISOString(),
  books: [
    { id: 'bk1', name: '工作', createdAt: NOW - 10, updatedAt: NOW - 5, settings: { language: 'zh', weekStartsOn: 1, timelineStart: 30, timelineEnd: 130, statsScope: 'week' }, events: v1.events, templates: [] },
    { id: 'bk2', name: '生活', createdAt: NOW - 9, updatedAt: NOW - 4, settings: { language: 'en', weekStartsOn: 0, timelineStart: 0, timelineEnd: 144, statsScope: 'month' }, events: [], templates: v1.templates },
  ],
};
eq('识别 v1', detectEnvelope(v1), 'v1');
eq('识别 v2', detectEnvelope(v2), 'v2');
eq('空对象无效', detectEnvelope({}), 'invalid');
eq('null 无效', detectEnvelope(null), 'invalid');
eq('数组无效', detectEnvelope([1, 2]), 'invalid');
eq('只有 books 但非数组无效', detectEnvelope({ books: 'x' }), 'invalid');

const parsedV1 = booksFromEnvelope(v1, { nowMs: NOW, deviceLang: 'zh', bookName: '导入的旧数据', idFactory });
eq('v1 解析出 1 本', parsedV1.books.length, 1);
eq('v1 用指定书名', parsedV1.books[0].book.name, '导入的旧数据');
eq('v1 事件数保留', parsedV1.books[0].events.length, 1);
eq('v1 模板数保留', parsedV1.books[0].templates.length, 1);
eq('v1 无警告', parsedV1.warnings.length, 0);

const parsedV2 = booksFromEnvelope(v2, { nowMs: NOW, deviceLang: 'en', idFactory });
eq('v2 解析出 2 本', parsedV2.books.length, 2);
eq('v2 保留各自 id', parsedV2.books.map((x) => x.book.id).join(','), 'bk1,bk2');
eq('v2 保留各自语言', parsedV2.books.map((x) => x.book.settings.language).join(','), 'zh,en');
// 关键需求：每本簿的周开始日必须跟着簿走，导入后不能统一成设备语言
eq('v2 保留各自周开始日', parsedV2.books.map((x) => x.book.settings.weekStartsOn).join(','), '1,0');
eq('v2 保留时间轴区间', parsedV2.books[0].book.settings.timelineStart + '-' + parsedV2.books[0].book.settings.timelineEnd, '30-130');
eq('v2 保留 statsScope', parsedV2.books[1].book.settings.statsScope, 'month');
eq('v2 事件按簿归位', parsedV2.books.map((x) => x.events.length).join(','), '1,0');
eq('v2 无警告', parsedV2.warnings.length, 0);

const broken = booksFromEnvelope({ books: [null, 42, { name: 'ok', events: 'nope' }] }, { nowMs: NOW, idFactory });
eq('坏条目被跳过但仍出有效簿', broken.books.length, 1);
eq('坏条目留下警告', broken.warnings.length, 2);
eq('非数组 events 归零', broken.books[0].events.length, 0);
eq('缺名字的条目自动补名', broken.books[0].book.name.length > 0, true);
eq('空信封警告', booksFromEnvelope({ books: [] }, {}).warnings.join(','), 'empty');
eq('坏格式警告', booksFromEnvelope({ hello: 'world' }, {}).warnings.join(','), 'bad-format');

// —— 6. 导出 → 导入 往返：设置与数据必须一模一样 ——
const envelope = toV2Envelope([
  { book: makeBook({ id: 'r1', name: '往返', language: 'ja', weekStartsOn: 4, settings: { timelineStart: 12, timelineEnd: 132 } }, { nowMs: NOW }), live: v1 },
  { book: makeBook({ id: 'r2', name: '空簿', language: 'en' }, { nowMs: NOW }), live: null },
], NOW);
eq('信封版本', envelope.version, ENVELOPE_V2);
eq('信封 app', envelope.app, 'event-logger');
eq('信封时间戳是 ISO', typeof envelope.exportedAt, 'string');
eq('信封簿数量', envelope.books.length, 2);
eq('信封里带事件', envelope.books[0].events.length, 1);
eq('live 缺失时补空数组', envelope.books[1].events.length, 0);
const roundTrip = booksFromEnvelope(envelope, { nowMs: NOW + 1000, deviceLang: 'zh', idFactory });
eq('往返保留 id', roundTrip.books.map((x) => x.book.id).join(','), 'r1,r2');
eq('往返保留名称', roundTrip.books.map((x) => x.book.name).join(','), '往返,空簿');
eq('往返保留语言', roundTrip.books.map((x) => x.book.settings.language).join(','), 'ja,en');
eq('往返保留周开始日', roundTrip.books.map((x) => x.book.settings.weekStartsOn).join(','), '4,0');
eq('往返保留时间轴', roundTrip.books[0].book.settings.timelineStart + '-' + roundTrip.books[0].book.settings.timelineEnd, '12-132');
eq('往返保留事件数', roundTrip.books[0].events.length, 1);
eq('往返保留 createdAt', roundTrip.books[0].book.createdAt, NOW);
// —— 7. planImport：导入永远新建簿，id/名字撞车各自避让 ——
const existing = [makeBook({ id: 'bk1', name: '工作' }, { nowMs: NOW }), makeBook({ id: 'bk2', name: '生活' }, { nowMs: NOW })];
const snapshotOfExisting = JSON.stringify(existing);
const incoming = booksFromEnvelope(v2, { nowMs: NOW, deviceLang: 'zh', idFactory }).books;
const planned = planImport(existing, incoming, { nowMs: NOW, idFactory });
eq('导入簿数不变（不合并不丢）', planned.length, 2);
eq('撞 id 的换新 id', planned.map((x) => x.book.id).indexOf('bk1'), -1);
eq('新 id 来自 idFactory', planned[0].book.id.slice(0, 3), 'gen');
eq('撞名的加 (2)', planned[0].book.name, '工作 (2)');
eq('不改动已有簿', JSON.stringify(existing), snapshotOfExisting);
eq('事件跟着簿走', planned[0].events.length, 1);
// 同一份备份连导两次：三本同名簿必须各自拿到不同后缀
const twice = planImport(existing.concat(planned.map((x) => x.book)), incoming, { nowMs: NOW, idFactory });
eq('第二次导入拿到 (3)', twice[0].book.name, '工作 (3)');
const allIds = existing.concat(planned.map((x) => x.book), twice.map((x) => x.book)).map((b) => b.id);
eq('所有 id 唯一', new Set(allIds).size, allIds.length);
const allNames = existing.concat(planned.map((x) => x.book), twice.map((x) => x.book)).map((b) => b.name);
eq('所有书名唯一', new Set(allNames).size, allNames.length);
// 长名字加后缀也不能超上限
const longBase = 'L'.repeat(MAX_BOOK_NAME);
const longPlan = planImport([makeBook({ id: 'L1', name: longBase }, { nowMs: NOW })],
  [{ book: makeBook({ id: 'L2', name: longBase }, { nowMs: NOW }), events: [], templates: [] }], { idFactory });
eq('撞名后缀不撑破长度上限', longPlan[0].book.name.length <= MAX_BOOK_NAME, true);
eq('撞名后缀仍然可辨', longPlan[0].book.name !== longBase, true);
eq('空 existing 也能规划', planImport([], incoming, { idFactory }).length, 2);
eq('null 入参安全', planImport(null, null, {}).length, 0);

// —— 8. live payload 归一 ——
eq('正常负载', normalizeLivePayload({ events: [1], templates: [2, 3] }).events.length, 1);
eq('缺字段补空数组', normalizeLivePayload({}).templates.length, 0);
eq('非数组字段丢弃', normalizeLivePayload({ events: 'x' }).events.length, 0);
eq('null 安全', normalizeLivePayload(null).events.length, 0);

if (problems.length) {
  console.error('book store check FAILED (' + problems.length + ' issues):');
  problems.slice(0, 40).forEach((p) => console.error('  - ' + p));
  process.exit(1);
}
console.log('book store check OK: 设置守门 / 书名与文件名清洗 / v1+v2 信封 / 导入防撞');