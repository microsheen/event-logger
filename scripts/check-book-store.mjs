// EventBook 与备份检查：设置守门、名称清洗、v1/v2 信封、导入防撞、文件夹镜像与节奏、查看文件夹的只读列举（纯函数层）
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
import {
  resyncTree,
  snapshotFileName,
  ROOT_DIR_NAME,
  MANIFEST_FILE_NAME,
  LATEST_FILE_NAME,
  SNAPSHOT_DIR_NAME,
  writeLatest,
  DEFAULT_MIRROR_INTERVAL_MIN,
  MIRROR_INTERVAL_OPTIONS_MIN,
  normalizeMirrorInterval,
  resetLatestStamps,
  listMirrorTree,
  LIST_LIMIT,
} from '../src/storage/folderBackup.js';

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

// —— 9. 镜像文件夹的整链重推（用内存假句柄冒充 File System Access API）——
function fakeDir(name) {
  const files = new Map();
  const dirs = new Map();
  return {
    name,
    kind: 'directory',
    _files: files,
    _dirs: dirs,
    async getDirectoryHandle(next, opts) {
      if (opts && opts.create) { if (!dirs.has(next)) dirs.set(next, fakeDir(next)); return dirs.get(next); }
      if (!dirs.has(next)) throw new Error('NotFoundError: ' + next);
      return dirs.get(next);
    },
    async* entries() {
      for (const [name, text] of files) yield [name, { name, kind: 'file', _text: text }];
      for (const [name, sub] of dirs) yield [name, sub];
    },
    async getFileHandle(next, opts) {
      if (!(opts && opts.create) && !files.has(next)) throw new Error('NotFoundError: ' + next);
      if (!files.has(next)) files.set(next, '');
      let buf = '';
      return {
        name: next,
        kind: 'file',
        async createWritable() {
          return {
            async write(chunk) { buf += typeof chunk === 'string' ? chunk : String(chunk); },
            async close() { files.set(next, buf); },
          };
        },
      };
    },
  };
}
function treeOf(dir, prefix, out) {
  dir._files.forEach((text, name) => out.set(prefix + '/' + name, text));
  dir._dirs.forEach((sub, name) => treeOf(sub, prefix + '/' + name, out));
  return out;
}
function mirrorBook(id, name) {
  return makeBook({ id, name }, { nowMs: NOW, deviceLang: 'zh' });
}
function mirrorSnap(bookId, iso, events, note) {
  return { id: bookId + ':' + iso, bookId, createdAt: Date.parse(iso), iso, reason: 'manual', note, eventCount: events, payload: { events: [], templates: [] } };
}
const mBookA = mirrorBook('book-a', 'Alpha');
const mBookB = mirrorBook('book-b', 'Beta 2026');
const mSnapA1 = mirrorSnap('book-a', '2026-09-20T01:02:03.004Z', 2, 'first');
const mSnapA2 = mirrorSnap('book-a', '2026-09-21T00:00:00.000Z', 3, '');
const mEntries = [
  { book: mBookA, live: { events: [1, 2], templates: [3] }, snapshots: [mSnapA1, mSnapA2] },
  { book: mBookB, live: { events: [], templates: [] }, snapshots: [] },
];
const mRoot = fakeDir('picked-by-user');
const mRes = await resyncTree(mRoot, mEntries, { nowMs: NOW });
eq('重推报告：簿数', mRes.books, 2);
eq('重推报告：latest 份数', mRes.latest, 2);
eq('重推报告：快照份数', mRes.snapshots, 2);
eq('重推写了 manifest', mRes.manifest, true);
const mTree = treeOf(mRoot, '', new Map());
const mBase = '/' + ROOT_DIR_NAME;
eq('manifest 落在根目录', mTree.has(mBase + '/' + MANIFEST_FILE_NAME), true);
const mManifest = JSON.parse(mTree.get(mBase + '/' + MANIFEST_FILE_NAME));
eq('manifest 记录书名', mManifest.books.map((b) => b.name).join(','), 'Alpha,Beta 2026');
eq('manifest 的目录名 = bookSlug', mManifest.books.map((b) => b.folder).join(','), [bookSlug(mBookA), bookSlug(mBookB)].join(','));
eq('manifest 的事件计数来自 live', mManifest.books[0].events, 2);
eq('每本各一个 latest.json', mTree.has([mBase, bookSlug(mBookA), LATEST_FILE_NAME].join('/')), true);
const mLatestA = JSON.parse(mTree.get([mBase, bookSlug(mBookA), LATEST_FILE_NAME].join('/')));
eq('latest.json 带 bookId', mLatestA.bookId, 'book-a');
eq('latest.json 带全部事件', mLatestA.events.length, 2);
eq('latest.json 带设置（周口径）', typeof mLatestA.settings.weekStartsOn, 'number');
eq('B 本也有 latest.json（哪怕空的）', mTree.has([mBase, bookSlug(mBookB), LATEST_FILE_NAME].join('/')), true);
const mSnapPath = [mBase, bookSlug(mBookA), SNAPSHOT_DIR_NAME, snapshotFileName(mSnapA1.iso)].join('/');
eq('镜像文件名不含冒号（Windows 非法）', snapshotFileName(mSnapA1.iso).indexOf(':'), -1);
eq('除扩展名外不再有点', snapshotFileName(mSnapA1.iso).replace('.json', '').indexOf('.'), -1);
eq('快照逐个成文件', mTree.has(mSnapPath), true);
const mSnapFile = JSON.parse(mTree.get(mSnapPath));
eq('快照文件保留 reason', mSnapFile.reason, 'manual');
eq('快照文件保留 note', mSnapFile.note, 'first');
eq('快照文件带 payload 供离线恢复', !!mSnapFile.payload, true);
const mBefore = treeOf(mRoot, '', new Map());
const mAgain = await resyncTree(mRoot, mEntries, { nowMs: NOW + 1000 });
const mAfter = treeOf(mRoot, '', new Map());
eq('重推幂等：文件个数不变', mAfter.size, mBefore.size);
eq('重推幂等：计数一致', mAgain.snapshots, mRes.snapshots);
eq('重推不改文件名集合（只覆盖内容）', Array.from(mAfter.keys()).sort().join('|'), Array.from(mBefore.keys()).sort().join('|'));
eq('空 entries 也只写 manifest 不炸', (await resyncTree(fakeDir('x'), [], { nowMs: NOW })).books, 0);
eq('null entries 安全', (await resyncTree(fakeDir('y'), null, { nowMs: NOW })).manifest, true);

// —— 10. 自动镜像的节奏：档位守门 + latest.json 节流 ——
eq('默认节奏 = 10 分钟', DEFAULT_MIRROR_INTERVAL_MIN, 10);
check('档位全是正整数且递增', MIRROR_INTERVAL_OPTIONS_MIN.every((m, i) => (
  Number.isInteger(m) && m > 0 && (i === 0 || m > MIRROR_INTERVAL_OPTIONS_MIN[i - 1])
)), JSON.stringify(MIRROR_INTERVAL_OPTIONS_MIN));
check('默认值本身是个合法档位', MIRROR_INTERVAL_OPTIONS_MIN.indexOf(DEFAULT_MIRROR_INTERVAL_MIN) >= 0, String(DEFAULT_MIRROR_INTERVAL_MIN));
// 脏值一律归到最近的档位：0 / 负数 / 空 / 文本 / 超范围都不能把节流写死
eq('0 归到最小档', normalizeMirrorInterval(0), 1);
eq('负数归到最小档', normalizeMirrorInterval(-5), 1);
eq('空串回默认', normalizeMirrorInterval(''), DEFAULT_MIRROR_INTERVAL_MIN);
eq('null 回默认', normalizeMirrorInterval(null), DEFAULT_MIRROR_INTERVAL_MIN);
eq('undefined 回默认', normalizeMirrorInterval(undefined), DEFAULT_MIRROR_INTERVAL_MIN);
eq('文本回默认', normalizeMirrorInterval('abc'), DEFAULT_MIRROR_INTERVAL_MIN);
eq('字符串数字可用', normalizeMirrorInterval('5'), 5);
eq('7 就近取 5', normalizeMirrorInterval(7), 5);
eq('8 就近取 10', normalizeMirrorInterval(8), 10);
eq('61 截到最大档', normalizeMirrorInterval(61), 60);
eq('9999 截到最大档', normalizeMirrorInterval(9999), 60);
eq('恰好是档位时原样保留', normalizeMirrorInterval(15), 15);
eq('归一化幂等', normalizeMirrorInterval(normalizeMirrorInterval(61)), 60);
// 节流本身：窗口内跳过、窗口外重写、force 立刻穿透、换节奏清窗口
const tBook = mirrorBook('book-c', 'Gamma');
const tDir = fakeDir('throttle-root');
const tKey = '/' + [ROOT_DIR_NAME, bookSlug(tBook), LATEST_FILE_NAME].join('/');
const tPayload = { events: [1], templates: [] };
const TEN_MIN = DEFAULT_MIRROR_INTERVAL_MIN * 60 * 1000;
function latestTree() { return treeOf(tDir, '', new Map()); }
resetLatestStamps();
eq('首次镜像一定写盘', await writeLatest(tDir, tBook, tPayload, { nowMs: NOW, throttleMs: TEN_MIN }), true);
eq('latest.json 落在预期路径', latestTree().has(tKey), true);
const tSaved1 = JSON.parse(latestTree().get(tKey)).savedAt;
eq('默认节奏的窗口内跳过', await writeLatest(tDir, tBook, tPayload, { nowMs: NOW + 60000, throttleMs: TEN_MIN }), false);
eq('跳过时磁盘文件没被改', JSON.parse(latestTree().get(tKey)).savedAt, tSaved1);
eq('窗口边界外重写', await writeLatest(tDir, tBook, tPayload, { nowMs: NOW + TEN_MIN, throttleMs: TEN_MIN }), true);
const tSaved2 = JSON.parse(latestTree().get(tKey)).savedAt;
check('重写确实换了时间戳', tSaved2 !== tSaved1, tSaved1 + ' / ' + tSaved2);
eq('「立即存档 / 重新镜像」用 force 穿透节流', await writeLatest(tDir, tBook, tPayload, { nowMs: NOW + TEN_MIN + 1000, force: true, throttleMs: TEN_MIN }), true);
eq('force 之后文件已更新', JSON.parse(latestTree().get(tKey)).savedAt !== tSaved2, true);
resetLatestStamps();
eq('清窗口后立刻可写（换节奏不该再等旧窗口）', await writeLatest(tDir, tBook, tPayload, { nowMs: NOW + TEN_MIN + 2000, throttleMs: TEN_MIN }), true);
resetLatestStamps();


// —— 11. 「查看镜像文件夹」：只读列举（绝不创建、绝不写、绝不打开文件内容）——
const lTree = await listMirrorTree(mRoot);
eq('列举成功', lTree.ok, true);
eq('根名取自句柄', lTree.root, 'picked-by-user');
eq('没有 missingRoot 标记', !!lTree.missingRoot, false);
eq('列到两本簿', lTree.books.length, 2);
eq('根目录里有 manifest.json', lTree.rootFiles.indexOf(MANIFEST_FILE_NAME) >= 0, true);
const lA = lTree.books.find((b) => b.folder === bookSlug(mBookA));
const lB = lTree.books.find((b) => b.folder === bookSlug(mBookB));
eq('A 本目录里有 latest.json', lA.files.indexOf(LATEST_FILE_NAME) >= 0, true);
eq('A 本两份历史版本', lA.snapshotTotal, 2);
eq('历史版本倒序 = 最新在前', lA.snapshots[0], snapshotFileName(mSnapA2.iso));
eq('最旧的一份排在最后', lA.snapshots[1], snapshotFileName(mSnapA1.iso));
eq('B 本没有历史版本', lB.snapshotTotal, 0);
eq('B 本照样有 latest.json', lB.files.indexOf(LATEST_FILE_NAME) >= 0, true);
// 列举的副作用必须为零：前后文件名与内容一字不差
const lBefore11 = treeOf(mRoot, '', new Map());
await listMirrorTree(mRoot);
const lAfter11 = treeOf(mRoot, '', new Map());
eq('列举不新增也不删除文件（名字集合一致）',
  Array.from(lAfter11.keys()).sort().join('|'), Array.from(lBefore11.keys()).sort().join('|'));
eq('列举不改任何文件内容',
  Array.from(lAfter11.keys()).sort().map((k) => lAfter11.get(k).length).join('|'),
  Array.from(lBefore11.keys()).sort().map((k) => lBefore11.get(k).length).join('|'));
// 守卫版句柄：列一遍，看它到底调没调 create / getFileHandle
let lCreates11 = 0;
let lOpens11 = 0;
function guardDir(dir) {
  return {
    name: dir.name,
    kind: 'directory',
    entries: () => dir.entries(),
    async getDirectoryHandle(next, opts) {
      if (opts && opts.create) { lCreates11 += 1; throw new Error('create is not allowed while listing'); }
      return guardDir(await dir.getDirectoryHandle(next, opts));
    },
    async getFileHandle(next, opts) {
      lOpens11 += 1;
      throw new Error('listing must not open file contents');
    },
  };
}
const lGuard = await listMirrorTree(guardDir(mRoot));
eq('列举全程零创建目录', lCreates11, 0);
eq('列举全程零打开文件（只列名字，不读内容）', lOpens11, 0);
eq('套上守卫照样列得出两本簿', lGuard.books.length, 2);
eq('守卫版的历史版本份数一致', lGuard.books.find((b) => b.folder === bookSlug(mBookA)).snapshotTotal, 2);
// 上限：脏值回落默认，合法值截断但总数照报
eq('默认上限 = ' + LIST_LIMIT, LIST_LIMIT, 300);
const lCap1 = await listMirrorTree(mRoot, { limit: 1 });
eq('limit 生效：只列 1 个历史版本', lCap1.books.find((b) => b.folder === bookSlug(mBookA)).snapshots.length, 1);
eq('limit 截断后总数仍是真实份数', lCap1.books.find((b) => b.folder === bookSlug(mBookA)).snapshotTotal, 2);
const lCapBad = await listMirrorTree(mRoot, { limit: 0 });
eq('limit=0 回落默认而不是列空', lCapBad.books.find((b) => b.folder === bookSlug(mBookA)).snapshots.length, 2);
const lCapNeg = await listMirrorTree(mRoot, { limit: -5 });
eq('负 limit 回落默认', lCapNeg.books.find((b) => b.folder === bookSlug(mBookA)).snapshots.length, 2);
const lCapText = await listMirrorTree(mRoot, { limit: 'abc' });
eq('文本 limit 回落默认', lCapText.books.find((b) => b.folder === bookSlug(mBookA)).snapshots.length, 2);
// 异常输入：一律「原地报错」，绝不抛出去把面板炸掉
const lFresh = await listMirrorTree(fakeDir('picked-but-empty'));
eq('还没写过副本：不算失败', lFresh.ok, true);
eq('还没写过副本：missingRoot 为真', lFresh.missingRoot, true);
eq('还没写过副本：没有簿子目录', lFresh.books.length, 0);
eq('没句柄：不抛异常', (await listMirrorTree(null)).error, 'no-handle');
eq('没句柄：books 为空', (await listMirrorTree(null)).books.length, 0);
eq('不是目录句柄：当成还没写过', (await listMirrorTree({ name: 'plain-object' })).missingRoot, true);
eq('undefined 句柄也安全', (await listMirrorTree(undefined)).error, 'no-handle');
const lDenied = await listMirrorTree({
  name: 'revoked',
  async getDirectoryHandle() {
    const err = new Error('permission revoked');
    err.name = 'NotAllowedError';
    throw err;
  },
});
eq('权限被收回：回报失败而不是假装空的', lDenied.ok, false);
eq('权限被收回：错误名透出来', lDenied.error, 'NotAllowedError');
eq('权限被收回：有可读的 message', !!lDenied.message, true);
eq('权限被收回：books 仍是空数组', lDenied.books.length, 0);

if (problems.length) {
  console.error('book store check FAILED (' + problems.length + ' issues):');
  problems.slice(0, 40).forEach((p) => console.error('  - ' + p));
  process.exit(1);
}
console.log('book store check OK: 设置守门 / 书名与文件名清洗 / v1+v2 信封 / 导入防撞 / 文件夹整链重推 / 镜像节奏与节流 / 查看文件夹只读列举');