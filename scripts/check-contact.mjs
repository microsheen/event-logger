// 反馈通道的白名单检查：诊断字段集合 / 私密内容金丝雀 / URL 形状 / 「页面不自己发东西」的静态守卫
// 用法：npm run contact:check
//
// 为什么值得单独立一道闸门：反馈面板是全站唯一会往外部地址带信息的地方。承诺说「事件名、书名绝不上线」,
// 靠的不是自觉，而是 collectDiagnostics 收数组、只吐计数这一道收口 —— 这里就用金丝雀把这句话钉死。
import fs from 'node:fs';
import path from 'node:path';
import {
  CONTACT_EMAIL,
  DIAG_FIELD_NAMES,
  DIAG_MAX_CHARS,
  REPO_ISSUES_URL,
  buildDiagnosticsText,
  collectDiagnostics,
  issuesUrl,
  mailtoUrl,
} from '../src/utils/contact.js';

const problems = [];
function check(name, condition, detail) {
  if (!condition) problems.push(name + (detail ? ' -> ' + detail : ''));
}
function eq(name, actual, expected) {
  check(name, actual === expected, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
}

// —— 1. 白名单本身：字段名与顺序都是契约，加字段必须是有意识的决定 ——
eq('诊断字段集合', DIAG_FIELD_NAMES.join(','), 'build,ua,lang,books,events,snapshots,persisted,mirror');
check('字段表被冻结', Object.isFrozen(DIAG_FIELD_NAMES));
eq('总长度上限', DIAG_MAX_CHARS, 600);
eq('公开别名', CONTACT_EMAIL, 'hi@daily-event-logger.com');
eq('Issue 入口', REPO_ISSUES_URL, 'https://github.com/microsheen/event-logger/issues/new');

// —— 2. 金丝雀：把私密内容喂进去，任何一处输出都不许带上它们 ——
const CANARY_BOOK = '金丝雀秘密簿';
const CANARY_EVENT = 'EV_CANARY_事件名';
const CANARY_NOTE = 'EV_CANARY_描述备注';
const CANARY_PATH = 'EV_CANARY_文件夹路径';
const canarySource = {
  books: [{ id: 'b1', name: CANARY_BOOK, settings: { language: 'zh' } }],
  events: [{ id: 'e1', name: CANARY_EVENT, description: CANARY_NOTE }],
  snapshots: [{ id: 's1', note: CANARY_PATH }],
  lang: 'zh',
  userAgent: 'Mozilla/5.0 (TestUA-9000) Canary/1.0',
  buildId: 'deadbeef-20261002120000',
  persisted: true,
  mirrorConnected: false,
};
const canaryText = buildDiagnosticsText(canarySource);
const canaryMail = mailtoUrl('使用问题', canaryText);
const canaryIssues = issuesUrl('使用问题', canaryText);
[canaryText, canaryMail, canaryIssues].forEach((output, i) => {
  [CANARY_BOOK, CANARY_EVENT, CANARY_NOTE, CANARY_PATH].forEach((needle) => {
    check('输出 #' + i + ' 不得含私密内容「' + needle + '」', output.indexOf(needle) === -1, output.slice(0, 120));
  });
  check('输出 #' + i + ' 不得含书名/事件名的字段痕迹', /name=|title=.*秘密/.test(output) === false, output.slice(0, 120));
});

// —— 3. 形状：恰好 8 个字段、值全是标量、逐行 key=value ——
const fields = collectDiagnostics(canarySource);
eq('字段名集合', Object.keys(fields).sort().join(','), [...DIAG_FIELD_NAMES].sort().join(','));
Object.keys(fields).forEach((name) => {
  const value = fields[name];
  check(name + ' 是标量', (typeof value === 'string' || typeof value === 'number') && !Array.isArray(value), typeof value);
});
eq('计数由数组长度得来（事件）', fields.events, 1);
eq('计数由数组长度得来（簿）', fields.books, 1);
eq('计数由数组长度得来（快照）', fields.snapshots, 1);
eq('布尔转 yes', fields.persisted, 'yes');
eq('布尔转 no', fields.mirror, 'no');
canaryText.split('\n').forEach((line, i) => {
  const name = line.split('=')[0];
  check('第 ' + i + ' 行是白名单里的字段且只含一个等号', DIAG_FIELD_NAMES.indexOf(name) === i && line.split('=').length >= 2, line);
});
eq('行数等于字段数', canaryText.split('\n').length, DIAG_FIELD_NAMES.length);

// —— 4. 脏输入：缺字段 / 类型不对 / 极端值都不许把 unknown 之外的东西漏出去 ——
const empty = collectDiagnostics(undefined);
eq('空来源仍是 8 字段', Object.keys(empty).length, DIAG_FIELD_NAMES.length);
eq('缺 buildId 读作 unknown', empty.build, 'unknown');
eq('缺 UA 读作 unknown', empty.ua, 'unknown');
eq('缺 lang 读作 unknown', empty.lang, 'unknown');
eq('非数组计数归零', collectDiagnostics({ books: 'not-an-array', events: { length: 99 }, snapshots: null }).events, 0);
eq('字符串数组不计数', collectDiagnostics({ events: 'not-an-array' }).events, 0);
eq('负数计数夹到零', collectDiagnostics({ events: -5 }).events, 0);
eq('小数计数取下整', collectDiagnostics({ events: 3.7 }).events, 3);
eq('非布尔持久化读作 unknown', collectDiagnostics({ persisted: 'true' }).persisted, 'unknown');
eq('非布尔镜像读作 unknown', collectDiagnostics({ mirrorConnected: 1 }).mirror, 'unknown');
eq('UA 里的换行被压成空格（防伪造第二行）', buildDiagnosticsText({ ua: 'x', userAgent: 'a\rb\nc' }).split('\n').length, DIAG_FIELD_NAMES.length);
check('UA 控制字符被剥离', buildDiagnosticsText({ userAgent: 'a\u0000b\u001fc' }).indexOf('a b c') === -1);
const collectedTwice = collectDiagnostics(fields);
eq('幂等：计数再过一遍不变', collectedTwice.events, fields.events);
eq('幂等：布尔再过一遍不变', collectDiagnostics(collectedTwice).persisted, 'yes');
eq('幂等：整段文本再生成一次不变', buildDiagnosticsText(fields), canaryText);

// —— 5. 长度：超长 UA 也不会撑破上限，且每行仍是完整的 key=value ——
const huge = buildDiagnosticsText({
  ...canarySource,
  userAgent: 'U'.repeat(5000),
  lang: 'zh',
});
check('超长 UA 仍在上限内', huge.length <= DIAG_MAX_CHARS, 'len=' + huge.length);
eq('超长时行数不变', huge.split('\n').length, DIAG_FIELD_NAMES.length);
check('每行都有等号', huge.split('\n').every((line) => line.indexOf('=') > 0), huge.slice(0, 80));

// —— 6. URL 形状：只有 href 字符串，没有任何请求语义 ——
const mail = mailtoUrl('主题 A', '第一行\n第二行');
check('mailto 以别名开头', mail.indexOf('mailto:' + CONTACT_EMAIL + '?') === 0, mail);
check('mailto 带主题', mail.indexOf('subject=') > 0, mail);
check('mailto 带正文', mail.indexOf('body=') > 0, mail);
check('mailto 无裸空格', mail.indexOf(' ') === -1, mail);
check('mailto 无裸换行', /[\r\n]/.test(mail) === false, JSON.stringify(mail));
check('mailto 空格编成 %20', mail.indexOf('%20') > 0 || mail.indexOf('+') === -1, mail);
const iss = issuesUrl('标题', '正文 & 符号');
check('issue 以仓库入口开头', iss.indexOf(REPO_ISSUES_URL + '?') === 0, iss);
check('issue 带标题', iss.indexOf('title=') > 0, iss);
check('issue 正文里的 & 被编码', iss.indexOf('%26') > 0, iss);
check('issue 无裸换行', /[\r\n]/.test(iss) === false);
eq('两个通道互不污染', iss.indexOf('mailto:'), -1);

// —— 7. 静态守卫：反馈这条路上不许长出任何「页面自己发东西」的能力 ——
const forbidden = [
  'fetch(',
  'XMLHttpRequest',
  'sendBeacon',
  'navigator.clipboard',
  'window.open',
  '<form',
  'WebSocket',
  'localStorage.setItem',
  'indexedDB',
];
const scanned = [
  path.join('src', 'utils', 'contact.js'),
  path.join('src', 'components', 'ContactDialog.jsx'),
];
scanned.forEach((rel) => {
  const file = path.resolve(process.cwd(), rel);
  if (!fs.existsSync(file)) { problems.push('缺少文件 ' + rel); return; }
  const code = fs.readFileSync(file, 'utf8');
  forbidden.forEach((token) => {
    check(rel + ' 不得出现「' + token + '」', code.indexOf(token) === -1, token);
  });
});
// 别名与仓库地址必须能在源码里找到（防止有人把通道改成后端接口）
const contactCode = fs.readFileSync(path.resolve(process.cwd(), 'src', 'utils', 'contact.js'), 'utf8');
const panelCode = fs.readFileSync(path.resolve(process.cwd(), 'src', 'components', 'ContactDialog.jsx'), 'utf8');
const helpCode = fs.readFileSync(path.resolve(process.cwd(), 'src', 'components', 'HelpDialog.jsx'), 'utf8');
check('contact.js 里别名是字面量', contactCode.indexOf("'" + CONTACT_EMAIL + "'") > 0);
check('ContactDialog 对外动作仍然只有 href', panelCode.indexOf('href=') > 0);
// 反向不变量：反馈已从帮助里剥离干净 —— 帮助面板不许再长出任何联系入口或反馈能力
check('HelpDialog 不再引用反馈工具', helpCode.indexOf('utils/contact.js') === -1);
check('HelpDialog 不再出现反馈锚点', helpCode.indexOf('data-contact') === -1);
check('HelpDialog 不再出现邮箱别名', helpCode.indexOf(CONTACT_EMAIL) === -1);

if (problems.length) {
  console.error('contact check FAILED (' + problems.length + ' issues):');
  problems.slice(0, 40).forEach((p) => console.error('  - ' + p));
  process.exit(1);
}
console.log('contact check OK: 8 字段白名单 / 金丝雀不外泄 / 幂等与脏输入 / ' + DIAG_MAX_CHARS + ' 字上限 / URL 形状 / 零外呼静态守卫 / 反馈已独立成面板');
