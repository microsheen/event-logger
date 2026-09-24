// 模板排序引擎检查：以纯函数为准，覆盖排序键、方向、语言排序规则与时间戳读写
// 用法：npm run sort:check
import { SORT_KEYS, defaultDirectionFor, sortTemplates } from '../src/utils/templateSort.js';
import { getUpdatedTime, normalizeTemplate, stampNewTemplate, stampUpdatedTemplate } from '../src/utils/templates.js';
import { translate } from '../src/i18n/core.js';

const problems = [];

function check(name, condition, detail) {
  if (!condition) problems.push(name + (detail ? ' -> ' + detail : ''));
}

function eq(name, actual, expected) {
  check(name, actual === expected, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
}

function make(overrides) {
  return { id: 'x', name: 'x', category: 'work', ...overrides };
}

function labeler(lang) {
  return (key) => translate(lang, 'category.' + key);
}

function sorted(templates, options) {
  return sortTemplates(templates, { categoryLabel: labeler(options.lang || 'zh'), ...options })
    .map(t => t.id);
}

const DAY = 24 * 60 * 60 * 1000;
function ago(days) {
  return new Date(Date.now() - days * DAY).toISOString();
}

// —— 1. 默认 = 插入顺序，且不受方向影响 ——
const base = [make({ id: 'b1' }), make({ id: 'b2' }), make({ id: 'b3' })];
eq('default/asc 等于插入顺序', sorted(base, { sort: 'default', direction: 'asc' }).join(','), 'b1,b2,b3');
eq('default/desc 仍等于插入顺序', sorted(base, { sort: 'default', direction: 'desc' }).join(','), 'b1,b2,b3');
eq('未知排序键回退默认', sorted(base, { sort: 'nonsense', direction: 'asc' }).join(','), 'b1,b2,b3');
eq('非数组入参返回空', sortTemplates(null, { sort: 'name' }).length, 0);

// —— 2. 名称：大小写不敏感 + numeric + 严格互逆 ——
const names = [
  make({ id: 'n-delta', name: 'delta' }),
  make({ id: 'n-Alpha', name: 'Alpha' }),
  make({ id: 'n-charlie', name: 'charlie' }),
  make({ id: 'n-Bravo', name: 'Bravo' }),
];
const nameAsc = sorted(names, { sort: 'name', direction: 'asc', lang: 'en' });
eq('名称升序忽略大小写', nameAsc.join(','), 'n-Alpha,n-Bravo,n-charlie,n-delta');
eq('名称降序是升序的严格逆序', sorted(names, { sort: 'name', direction: 'desc', lang: 'en' }).join(','),
  [...nameAsc].reverse().join(','));
const numeric = [make({ id: 't10', name: 'task10' }), make({ id: 't2', name: 'task2' }), make({ id: 't1', name: 'task1' })];
eq('名称里的数字按数值比较', sorted(numeric, { sort: 'name', lang: 'en' }).join(','), 't1,t2,t10');

// —— 3. 中日文本地排序 ——
const zhNames = [make({ id: 'zh-sh', name: '上海' }), make({ id: 'zh-bj', name: '北京' }), make({ id: 'zh-gz', name: '广州' })];
eq('中文按拼音升序', sorted(zhNames, { sort: 'name', lang: 'zh' }).join(','), 'zh-bj,zh-gz,zh-sh');
const jaNames = [make({ id: 'ja-sa', name: 'さ' }), make({ id: 'ja-a', name: 'あ' }), make({ id: 'ja-ka', name: 'か' })];
eq('日文按五十音升序', sorted(jaNames, { sort: 'name', lang: 'ja' }).join(','), 'ja-a,ja-ka,ja-sa');

// —— 4. 类别按当前语言译文排序 ——
const three = [
  make({ id: 'c-work', category: 'work', name: 'w' }),
  make({ id: 'c-life', category: 'life', name: 'l' }),
  make({ id: 'c-study', category: 'study', name: 's' }),
];
const catZh = sorted(three, { sort: 'category', lang: 'zh' });
const catEn = sorted(three, { sort: 'category', lang: 'en' });
const catJa = sorted(three, { sort: 'category', lang: 'ja' });
eq('zh 类别序 work→life→study', catZh.join(','), 'c-work,c-life,c-study');
eq('en 类别序 life→study→work', catEn.join(','), 'c-life,c-study,c-work');
eq('ja 类别序 study→work→life', catJa.join(','), 'c-study,c-work,c-life');
eq('类别降序是升序的严格逆序', sorted(three, { sort: 'category', lang: 'en', direction: 'desc' }).join(','),
  [...catEn].reverse().join(','));
const sameCat = [make({ id: 'z2', category: 'work', name: 'zzz' }), make({ id: 'z1', category: 'work', name: 'aaa' })];
eq('同类别内按名称升序', sorted(sameCat, { sort: 'category', lang: 'zh' }).join(','), 'z1,z2');
const sameName = [make({ id: 'sn-life', name: '会议', category: 'life' }), make({ id: 'sn-work', name: '会议', category: 'work' })];
eq('同名时按类别译文收尾', sorted(sameName, { sort: 'name', lang: 'zh' }).join(','), 'sn-work,sn-life');
eq('未知类别与 work 同档（getCategory 回退）',
  sorted([make({ id: 'u-sleep', category: 'sleep', name: 'bbb' }), make({ id: 'u-work', category: 'work', name: 'aaa' })],
    { sort: 'category', lang: 'zh' }).join(','), 'u-work,u-sleep');

// —— 5. 修改时间 ——
const times = [
  make({ id: 't-mid', updatedAt: ago(5) }),
  make({ id: 't-none' }),
  make({ id: 't-new', updatedAt: ago(1) }),
  make({ id: 't-old', updatedAt: ago(30) }),
];
eq('时间升序且未知时间垫底', sorted(times, { sort: 'updated', direction: 'asc' }).join(','), 't-old,t-mid,t-new,t-none');
eq('时间降序且未知时间仍垫底', sorted(times, { sort: 'updated', direction: 'desc' }).join(','), 't-new,t-mid,t-old,t-none');
eq('全为未知时间时保持插入顺序',
  sorted([make({ id: 'a1' }), make({ id: 'a2' }), make({ id: 'a3' })], { sort: 'updated', direction: 'desc' }).join(','), 'a1,a2,a3');
const tied = [make({ id: 'eq-1', updatedAt: ago(2) }), make({ id: 'eq-2', updatedAt: ago(2) }), make({ id: 'eq-0', updatedAt: ago(2) })];
eq('相同时间升序按插入顺序', sorted(tied, { sort: 'updated', direction: 'asc' }).join(','), 'eq-1,eq-2,eq-0');
eq('相同时间降序也按插入顺序', sorted(tied, { sort: 'updated', direction: 'desc' }).join(','), 'eq-1,eq-2,eq-0');
eq('非法时间戳视为未知', sorted([make({ id: 'bad-1', updatedAt: 'not-a-date' }), make({ id: 'bad-2', updatedAt: ago(9) })],
  { sort: 'updated', direction: 'desc' }).join(','), 'bad-2,bad-1');
eq('默认方向：修改时间为降序', defaultDirectionFor('updated'), 'desc');
eq('默认方向：名称为升序', defaultDirectionFor('name'), 'asc');
eq('默认方向：未知字段为升序', defaultDirectionFor('nope'), 'asc');

// —— 6. 不修改入参、不丢元素 ——
const snapshot = JSON.stringify(times);
const result = sortTemplates(times, { sort: 'updated', direction: 'desc', categoryLabel: labeler('zh') });
eq('入参数组未被改写', JSON.stringify(times), snapshot);
eq('排序结果是新数组', result !== times, true);
eq('元素数量不变', result.length, times.length);
eq('元素集合不变', [...result].sort((a, b) => a.id.localeCompare(b.id)).map(t => t.id).join(','),
  [...times].sort((a, b) => a.id.localeCompare(b.id)).map(t => t.id).join(','));

// —— 7. 时间戳读写规则 ——
const original = make({ id: 'p1', name: 'old', category: 'work', createdAt: ago(40), updatedAt: ago(20) });
const edited = stampUpdatedTemplate(original, { name: 'new', category: 'work', updatedAt: ago(1), createdAt: ago(99) });
eq('编辑刷新 updatedAt', getUpdatedTime(edited) !== getUpdatedTime(original), true);
eq('编辑不改 createdAt', edited.createdAt, original.createdAt);
check('调用方无法伪造 updatedAt（改为当前时间）', Math.abs(Date.parse(edited.updatedAt) - Date.now()) < 5000, 'got ' + edited.updatedAt);
eq('编辑保留其它字段', edited.name, 'new');
const untouched = stampUpdatedTemplate(original, { name: 'old', category: 'work' });
eq('字段未变不刷新时间', untouched.updatedAt, original.updatedAt);
const legacyEdited = stampUpdatedTemplate(make({ id: 'legacy', name: 'x', category: 'work' }), { name: 'y' });
eq('存量模板编辑后只补 updatedAt', legacyEdited.createdAt === undefined && typeof legacyEdited.updatedAt === 'string', true);
const fresh = stampNewTemplate('n', 'life');
eq('新建同时带 createdAt / updatedAt', typeof fresh.createdAt === 'string' && fresh.createdAt === fresh.updatedAt, true);
const merged = stampNewTemplate('n', 'life', { createdAt: ago(60), updatedAt: ago(3), bogus: 'x' });
eq('导入合并不伪造 createdAt', merged.createdAt, ago(60));
eq('导入合并不伪造 updatedAt', merged.updatedAt, ago(3));
const cleaned = normalizeTemplate(make({ id: 'nz', createdAt: '', updatedAt: 12345 }));
eq('清洗丢弃非法 createdAt', cleaned.createdAt === undefined, true);
eq('清洗丢弃非法 updatedAt', cleaned.updatedAt === undefined, true);
const kept = normalizeTemplate(make({ id: 'kp', createdAt: ago(3), updatedAt: ago(1) }));
eq('清洗保留合法时间戳', kept.createdAt === ago(3) && kept.updatedAt === ago(1), true);
eq('排序键集合稳定', SORT_KEYS.join(','), 'default,name,category,updated');

if (problems.length) {
  console.error('template sort check FAILED (' + problems.length + ' issues):');
  problems.forEach((p) => console.error('  - ' + p));
  process.exit(1);
}
console.log('template sort check OK: ' + SORT_KEYS.length + ' sort keys x 2 directions x 3 locales');
