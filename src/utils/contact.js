// 反馈通道的规则层：纯函数、无 React 依赖，便于 scripts/check-contact.mjs 直接在 Node 里断言。
//
// 两条通道（邮箱别名 / GitHub Issue）在这里都只是**拼字符串**：产出一个 href 而已。
// 页面自己永远不发起任何请求，用户不点，就什么都不会发生 —— 这是 §11 那两条承诺
// （服务器永不写用户数据 / 零第三方）在反馈这件事上不被破掉的全部依据。
//
// 诊断字段是**白名单**而不是黑名单：collectDiagnostics 收数组、只吐计数，
// 所以事件名、书名、日期、文件夹路径在结构上就进不了输出（金丝雀断言见 check-contact.mjs）。

// 对外公开的只收一个域别名：私人邮箱绝不进仓库，转发关系只存在于 Cloudflare 控制台里。
export const CONTACT_EMAIL = 'hi@daily-event-logger.com';
export const REPO_ISSUES_URL = 'https://github.com/microsheen/event-logger/issues/new';

// 顺序即输出顺序；改这个数组等于改契约，必须同步改 check-contact.mjs 里的期望。
export const DIAG_FIELD_NAMES = Object.freeze(['build', 'ua', 'lang', 'books', 'events', 'snapshots', 'persisted', 'mirror']);
export const DIAG_MAX_CHARS = 600;
const UA_MAX_CHARS = 160;
const SCALAR_MAX_CHARS = 64;

function toText(raw, max) {
  if (typeof raw !== 'string') return '';
  // 换行与控制字符一律剥掉：诊断块是 key=value 逐行的格式，混进换行就会伪造出「多一行字段」
  const clean = raw.replace(/[\r\n]+/g, ' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return clean.length > max ? clean.slice(0, max) : clean;
}

// 计数入口刻意写成「数组取长度、数字直接用」：于是 collectDiagnostics 是幂等的，
// 已经collect过的对象再喂一遍（渲染路径上很容易发生）不会把数字归零。
function firstDefined(a, b) {
  return a === undefined || a === null || a === '' ? b : a;
}

function toCount(raw) {
  if (Array.isArray(raw)) return raw.length;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw >= 0 ? Math.floor(raw) : 0;
  return 0;
}

function toYesNo(raw) {
  if (raw === true || raw === 'yes') return 'yes';
  if (raw === false || raw === 'no') return 'no';
  return 'unknown';
}

// 唯一出口：任何来源（数组 / 布尔 / 字符串 / 脏值）都归一成「恰好 DIAG_FIELD_NAMES 这 8 个字段、值全是标量」。
export function collectDiagnostics(source) {
  const input = source && typeof source === 'object' ? source : {};
  const out = {};
  DIAG_FIELD_NAMES.forEach((name) => {
    out[name] = '';
  });
  // 字段名与值都接受「上一轮的输出」：collect 因此是幂等的（buildId/build、userAgent/ua、
  // mirrorConnected/mirror 同理），渲染路径上拿旧文本的字段名再算一遍，
  // 不会把已经收口的值退化成 unknown
  out.build = toText(firstDefined(input.buildId, input.build), SCALAR_MAX_CHARS) || 'unknown';
  out.ua = toText(firstDefined(input.userAgent, input.ua), UA_MAX_CHARS) || 'unknown';
  out.lang = toText(input.lang, 8) || 'unknown';
  out.books = toCount(input.books);
  out.events = toCount(input.events);
  out.snapshots = toCount(input.snapshots);
  out.persisted = toYesNo(input.persisted);
  out.mirror = toYesNo(firstDefined(input.mirrorConnected, input.mirror));
  return out;
}

// 语言无关的 ASCII 诊断文本：邮件与 Issue 都带同一份，你收到任何语言的反馈都能一眼对齐版本。
// 超长时先牺牲 ua 尾巴（它是唯一可能很长的字段），保证每行仍是完整的 key=value。
export function buildDiagnosticsText(source) {
  const fields = collectDiagnostics(source);
  const line = (name) => name + '=' + String(fields[name]);
  const lines = DIAG_FIELD_NAMES.map(line);
  let text = lines.join('\n');
  if (text.length > DIAG_MAX_CHARS) {
    const budget = DIAG_MAX_CHARS - (text.length - lines[DIAG_FIELD_NAMES.indexOf('ua')].length);
    const uaLine = 'ua=' + String(fields.ua).slice(0, Math.max(0, budget - 3)) + '...';
    text = DIAG_FIELD_NAMES.map((name) => (name === 'ua' ? uaLine : line(name))).join('\n');
  }
  return text;
}

function encode(value) {
  // encodeURIComponent 把空格编成 %20（不是 +）：mailto 与 GitHub 都只认前者
  return encodeURIComponent(String(value == null ? '' : value));
}

export function mailtoUrl(subject, body) {
  return 'mailto:' + CONTACT_EMAIL + '?subject=' + encode(subject) + '&body=' + encode(body);
}

export function issuesUrl(title, body) {
  return REPO_ISSUES_URL + '?title=' + encode(title) + '&body=' + encode(body);
}
