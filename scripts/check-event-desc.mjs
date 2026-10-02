// 事件描述（description）的归一规则检查：类型 / 换行符 / 控制字符 / 长度上限 / 幂等（纯函数层，确定性断言）
// 用法：npm run desc:check
import {
  MAX_EVENT_DESC,
  normalizeEventDescription,
  eventDescription,
} from '../src/utils/eventDescription.js';

const problems = [];

function check(name, condition, detail) {
  if (!condition) problems.push(name + (detail ? ' -> ' + detail : ''));
}

function eq(name, actual, expected) {
  check(name, actual === expected, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
}

// —— 1. 类型：描述恒为字符串，脏输入一律落成空串（旧事件没有该键就走这条路） ——
eq('缺字段读作空串', normalizeEventDescription(undefined), '');
eq('null 读作空串', normalizeEventDescription(null), '');
eq('空串仍是空串', normalizeEventDescription(''), '');
eq('数字不自动转字符串', normalizeEventDescription(2026), '');
eq('对象不自动转字符串', normalizeEventDescription({ text: 'x' }), '');
eq('布尔不自动转字符串', normalizeEventDescription(true), '');
eq('数组不自动转字符串', normalizeEventDescription(['a', 'b']), '');
eq('普通文本原样保留', normalizeEventDescription('和产品对了一下需求'), '和产品对了一下需求');

// —— 2. 换行符与控制字符：只留 \t 与 \n，其余控制字符剥掉 ——
eq('CRLF 归一为 LF', normalizeEventDescription('a\r\nb'), 'a\nb');
eq('孤 CR 归一为 LF', normalizeEventDescription('a\rb'), 'a\nb');
eq('LF 不动', normalizeEventDescription('a\nb'), 'a\nb');
eq('制表符保留', normalizeEventDescription('a\tb'), 'a\tb');
eq('NUL 被剥离', normalizeEventDescription('a\u0000b'), 'ab');
eq('垂直制表符被剥离', normalizeEventDescription('a\u000bb'), 'ab');
eq('换页符被剥离', normalizeEventDescription('a\u000cb'), 'ab');
eq('ESC 被剥离', normalizeEventDescription('a\u001bb'), 'ab');
eq('DEL 被剥离', normalizeEventDescription('a\u007fb'), 'ab');
eq('中文标点与 emoji 不受影响', normalizeEventDescription('⚙️ 上线演练（10 月）'), '⚙️ 上线演练（10 月）');

// —— 3. 长度上限：先截断到 500，再修剪首尾空白（截断后残留的空白不会把长度顶回上限之上） ——
const long600 = '长'.repeat(600);
eq('600 字符截到上限', normalizeEventDescription(long600).length, MAX_EVENT_DESC);
eq('恰好 500 字符原样保留', normalizeEventDescription('长'.repeat(MAX_EVENT_DESC)).length, MAX_EVENT_DESC);
eq('501 字符截到上限', normalizeEventDescription('长'.repeat(MAX_EVENT_DESC + 1)).length, MAX_EVENT_DESC);
eq('上限是 500', MAX_EVENT_DESC, 500);
check('截断只保留前缀', normalizeEventDescription(long600) === '长'.repeat(MAX_EVENT_DESC), '前缀不符');
const longWithTail = '长'.repeat(MAX_EVENT_DESC) + '   ';
eq('截断后再修剪尾部空白', normalizeEventDescription(longWithTail).length, MAX_EVENT_DESC);
const longWithLead = '   ' + '长'.repeat(MAX_EVENT_DESC + 5);
// 截断在修剪之前，所以首部 3 个空格照样占额度：宁可少 3 字，也不让写盘的内容超过上限
eq('首部空格占额度后被截短', normalizeEventDescription(longWithLead), '长'.repeat(MAX_EVENT_DESC - 3));
eq('首尾空格被修剪', normalizeEventDescription('  会议记录  '), '会议记录');
eq('首尾换行被修剪', normalizeEventDescription('\n\n会议\n\n'), '会议');
eq('中间换行不折叠', normalizeEventDescription('第一段\n\n第二段'), '第一段\n\n第二段');
eq('BOM 被修剪', normalizeEventDescription('\uFEFF备注'), '备注');
eq('全是空白等于空串', normalizeEventDescription(' \t\n '), '');

// —— 4. 幂等：同一条描述过两遍管线不会越改越短（写盘一次即定型） ——
const samples = ['', '  x  ', 'a\r\nb', 'a\u0000\u000bb', long600, longWithTail, '\n\n会议\t室\n', '中文 English 日本語 🎯'];
samples.forEach((s, i) => {
  const once = normalizeEventDescription(s);
  eq('幂等 #' + i, normalizeEventDescription(once), once);
  check('输出永不超上限 #' + i, once.length <= MAX_EVENT_DESC, 'len=' + once.length);
  check('输出无首尾空白 #' + i, once === once.trim(), JSON.stringify(once));
});

// —— 5. 读取侧入口：任何事件形状都取到字符串，绝不让 tooltip 拿到 undefined ——
eq('整条事件缺描述读作空串', eventDescription({ name: 'x' }), '');
eq('null 事件读作空串', eventDescription(null), '');
eq('undefined 事件读作空串', eventDescription(undefined), '');
eq('事件描述原样读出', eventDescription({ description: '上线前演练' }), '上线前演练');
eq('脏事件描述归一后读出', eventDescription({ description: '  a\r\nb\u0000  ' }), 'a\nb');

if (problems.length) {
  console.error('event description check FAILED (' + problems.length + ' issues):');
  problems.slice(0, 40).forEach((p) => console.error('  - ' + p));
  process.exit(1);
}
console.log('event description check OK: 类型 / 换行与控制字符 / ' + MAX_EVENT_DESC + ' 字上限 / 幂等 / 读取侧入口');
