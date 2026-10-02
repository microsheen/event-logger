// 端到端冒烟测试：零依赖，用 CDP 直接驱动真实 Chrome。
// 验证三条硬需求：① 服务器不存任何用户数据 ② EventBook 自带周开始日 + 语言 ③ 历史版本可回放、可恢复（不可逆）。
// 用法：
//   npm run smoke                                   自带静态服务器发 dist/（并套上 public/_headers 的 CSP）
//   npm run smoke -- --url=http://localhost:3002     打已经在跑的服务器
//   npm run smoke -- --headed --keep --slow=60       有头 + 保留临时 profile + 每步慢放 60ms
//   npm run smoke -- --no-sandbox                       CI/容器里 Chrome 起不来时加（同时带 --disable-dev-shm-usage）
//   npm run smoke -- --lang=zh-CN --stop-at=2           换一个浏览器语言跑前两步：默认簿应叫「默认」且周一起始
//   npm run smoke -- --url=https://<线上域名> --proxy=http://<出口代理>:<端口>
//                                                  所在网络把线上站点拦成网关提示页时，让 Chrome 走代理复跑那 18 步。
//                                                  代理值只走命令行参数或 SMOKE_PROXY 环境变量，主机名不进仓库。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname, relative, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = argv.find((a) => a === '--' + name || a.startsWith('--' + name + '='));
  if (!hit) return dflt;
  if (hit === '--' + name) return true;
  return hit.slice(name.length + 3);
};
const num = (name, dflt) => { const v = Number(arg(name, NaN)); return Number.isFinite(v) ? v : dflt; };

// 企业/校园网的出口网关会把线上站点换成一个拦截页，症状是 title 变成域名本身、data-build 为空、#root 无子节点。
// 这时用所在网络的出口代理把 Chrome 的流量导出去，就能在办公网里直接验收线上产物。
// 代理只影响 Chrome 的页面请求；CDP 仍走 127.0.0.1 直连，自带静态服务器也留在 bypass 列表里，所以本地跑法不受影响。
const proxyArg = arg("proxy");
const PROXY = typeof proxyArg === "string" && proxyArg ? proxyArg : (process.env.SMOKE_PROXY || null);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.map': 'application/json',
  '.xml': 'application/xml', '.webp': 'image/webp',
};

function cspFromHeadersFile() {
  const file = join(ROOT, 'public', '_headers');
  if (!existsSync(file)) return null;
  const m = readFileSync(file, 'utf8').match(/^\s*Content-Security-Policy:\s*(.+)$/mi);
  return m ? m[1].trim() : null;
}

async function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => { const port = srv.address().port; srv.close(() => res(port)); });
  });
}

function startStatic(dir, csp) {
  return new Promise((res, rej) => {
    const srv = http.createServer((req, out) => {
      const url = decodeURIComponent((req.url || '/').split('?')[0]);
      let target = resolve(dir, '.' + (url === '/' ? '/index.html' : url));
      const inside = relative(dir, target).split(sep)[0] !== '..';
      let file = inside && existsSync(target) && statSync(target).isFile() ? target : null;
      if (!file && !extname(url) && existsSync(join(dir, 'index.html'))) file = resolve(dir, 'index.html');
      if (!file) { out.writeHead(404, { 'Content-Type': 'text/plain' }); out.end('not found'); return; }
      const head = { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' };
      if (csp) head['Content-Security-Policy'] = csp;
      out.writeHead(200, head);
      out.end(readFileSync(file));
    });
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port }));
  });
}
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(homedir(), 'AppData', 'Local', 'Google Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  throw new Error('找不到 Chrome/Edge，可设 CHROME_PATH 环境变量指定');
}

// 纯手写 CDP 客户端：只需要 send / on，不必引入 puppeteer
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (err) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.method + ' → ' + JSON.stringify(msg.error)));
        else res(msg.result);
        return;
      }
      if (msg.method) this.handlers.forEach((fn) => fn(msg.method, msg.params || {}));
    });
  }

  send(method, params) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }

  on(fn) { this.handlers.push(fn); }
  async close() { try { this.ws.close(); } catch (err) { /* noop */ } }
}

async function waitForPageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (err) { /* 浏览器还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('等不到 Chrome 的 page target（remote-debugging-port=' + port + '）');
}

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
    setTimeout(() => rej(new Error('CDP 连接超时')), 15000).unref?.();
  });
  return new Cdp(ws);
}
// 注入到页面里的定位助手（走 CDP 注入，不受 CSP script-src 影响）；reload 后会被重新注入。
// metaOp 是给「已连接」那一档用的：headless 里弹不出系统目录选择框，只能把句柄位（纯数据）写进 meta 再重载。
const BOOTSTRAP = `window.__smk = (function () {
  var alerts = [];
  window.alert = function (m) { alerts.push(String(m)); };
  window.confirm = function () { return true; };
  function norm(s) { return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim(); }
  function ctr(el) { var r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }; }
  function match(sel, text, exact) {
    var w = norm(text);
    var all = Array.prototype.slice.call(document.querySelectorAll(sel || '*'));
    var hit = all.filter(function (el) { return norm(el.textContent) === w; });
    if (!hit.length && !exact) hit = all.filter(function (el) { return norm(el.textContent).indexOf(w) >= 0; });
    return hit;
  }
  function pick(sel, text, idx, exact) {
    var m = match(sel, text, exact);
    var i = idx == null ? m.length - 1 : idx;
    return m[i] ? m[i] : null;
  }
  return {
    alerts: function () { return alerts.slice(); },
    bodyText: function () { return norm(document.body.innerText); },
    has: function (t) { return norm(document.body.innerText).indexOf(norm(t)) >= 0; },
    count: function (sel) { return document.querySelectorAll(sel).length; },
    attrAll: function (sel, name) { return Array.prototype.slice.call(document.querySelectorAll(sel)).map(function (e) { return e.getAttribute(name); }); },
    grid: function () {
      var q = function (sel, attr) { return Array.prototype.slice.call(document.querySelectorAll(sel)).map(function (e) { return e.getAttribute(attr); }); };
      return {
        heads: q('[data-header-date]', 'data-header-date'),
        cols: q('[data-date]', 'data-date'),
        wds: q('[data-weekday]', 'data-weekday'),
        events: Array.prototype.slice.call(document.querySelectorAll('[data-event-id]')).map(function (e) { return norm(e.textContent); }),
      };
    },
    // 月历（页面左上的日期面板）：表头与格子必须在同一次求值里读全，
    // 否则改设置/切书引发的重渲染会让两次读取落在不同帧上。
    month: function () {
      var all = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };
      return {
        heads: all('[data-cal-weekday]').map(function (e) { return norm(e.textContent); }),
        cells: all('[data-cal-date]').map(function (e) { return e.getAttribute('data-cal-date'); }),
      };
    },
    texts: function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)).map(function (e) { return norm(e.textContent); }); },
    clickable: function (sel, text) {
      var el = pick(sel, text, null, true) || pick(sel, text, null, false);
      if (!el) return { err: 'no [' + sel + '] text=' + text };
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      return ctr(el);
    },
    nth: function (sel, text, idx) {
      var m = match(sel, text, true);
      if (!m.length) m = match(sel, text, false);
      var el = m[idx];
      if (!el) return { err: 'no [' + sel + '] text=' + text + ' #' + idx + ' (only ' + m.length + ')' };
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      return ctr(el);
    },
    slot: function (date, n) {
      var el = document.querySelector('[data-date="' + date + '"] [data-slot="' + n + '"]');
      if (!el) return { err: 'no slot ' + date + ' #' + n };
      el.scrollIntoView({ block: 'center' });
      return ctr(el);
    },
    snap: function (snapId, action) {
      var el = document.querySelector('[data-snap="' + snapId + '"] [data-action="' + action + '"]');
      if (!el) return { err: 'no [data-snap=' + snapId + '] [data-action=' + action + ']' };
      el.scrollIntoView({ block: 'center' });
      return ctr(el);
    },
    act: function (action) {
      var el = document.querySelector('[data-action="' + action + '"]');
      if (!el) return { err: 'no [data-action=' + action + ']' };
      el.scrollIntoView({ block: 'center' });
      return ctr(el);
    },
    eventBars: function () { return Array.prototype.slice.call(document.querySelectorAll('[data-event-id]')).map(function (e) {
      var r = e.getBoundingClientRect();
      return { id: e.getAttribute('data-event-id'), start: Number(e.getAttribute('data-start')), end: Number(e.getAttribute('data-end')), text: norm(e.textContent), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }); },
    input: function (sel) {
      var el = document.querySelector(sel);
      if (!el) return { err: 'no input ' + sel };
      el.focus();
      if (el.select) el.select();
      return { ok: document.activeElement === el, tag: el.tagName, type: el.type };
    },
    selectSet: function (sel, value) {
      var el = document.querySelector(sel);
      if (!el) return { err: 'no select ' + sel };
      var d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
      el.focus();
      d.set.call(el, value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: el.value };
    },
    inputValue: function (sel) { var el = document.querySelector(sel); return el ? el.value : null; },
    // 顶栏菜单的结构探针：项文本 / 键盘可达性 / file input 的挂载位置
    menu: function () {
      var panel = document.querySelector('[role="menu"]');
      var input = document.querySelector('input[type="file"]');
      var items = panel ? Array.prototype.slice.call(panel.querySelectorAll('[role="menuitem"]')).map(function (e) { return norm(e.textContent); }) : [];
      return {
        open: !!panel,
        items: items,
        tabbable: panel ? panel.querySelectorAll('[role="menuitem"][tabindex="0"]').length : 0,
        triggers: document.querySelectorAll('[role="button"][aria-haspopup="menu"]').length,
        inputMounted: !!input && document.body.contains(input),
        inputInsideMenu: !!(panel && input && panel.contains(input)),
        headerButtons: document.querySelectorAll('header button').length,
      };
    },
    today: function () { var d = new Date(); var p = function (n) { return String(n).length < 2 ? '0' + n : String(n); }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); },
    idb: function (store, bookId) {
      return new Promise(function (res, rej) {
        var rq = indexedDB.open('event-logger', 1);
        rq.onerror = function () { rej(rq.error); };
        rq.onsuccess = function () {
          var db = rq.result;
          if (!db.objectStoreNames.contains(store)) { db.close(); res(null); return; }
          var g = db.transaction(store, 'readonly').objectStore(store).getAll();
          g.onerror = function () { rej(g.error); };
          g.onsuccess = function () {
            var rows = g.result || [];
            db.close();
            res(rows.filter(function (r) { return !bookId || r.bookId === bookId; }));
          };
        };
      });
    },
    metaOp: function (op, key, value) {
      return new Promise(function (res, rej) {
        var rq = indexedDB.open('event-logger', 1);
        var out;
        rq.onerror = function () { rej(rq.error); };
        rq.onsuccess = function () {
          var db = rq.result;
          if (!db.objectStoreNames.contains('meta')) { db.close(); res(null); return; }
          var t = db.transaction('meta', op === 'get' ? 'readonly' : 'readwrite');
          var st = t.objectStore('meta');
          if (op === 'get') { var g = st.get(key); g.onsuccess = function () { out = g.result; }; }
          else if (op === 'set') { st.put({ key: key, value: value }); }
          else { st['delete'](key); }
          t.oncomplete = function () { db.close(); res(op === 'get' ? (out ? out.value : null) : true); };
          t.onerror = function () { db.close(); rej(t.error || new Error('meta transaction failed')); };
          t.onabort = function () { db.close(); rej(t.error || new Error('meta transaction aborted')); };
        };
      });
    },
    idbShape: function () {
      return new Promise(function (res) {
        var rq = indexedDB.databases ? indexedDB.databases() : Promise.resolve(null);
        Promise.resolve(rq).then(function (list) { res(list ? list.map(function (d) { return d.name + '@' + d.version; }) : ['no indexedDB.databases']); });
      });
    }
  };
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 定位助手找不到目标时返回 { err: ... }，而对象本身是真值。等待条件必须把它判成「还没好」：
// 打远程站点时渲染赶在求值后面，「等按钮出现」的 until 会在第一次求值就直接放行，
// 下一步立刻抛「找不到点击目标」。本地秒开时永远撞不上，所以这个坑一直没暴露。
const ready = (v) => (v && typeof v === 'object' && v.err ? null : v);
function makeHelpers(cdp) {
  const slow = num('slow', 0);
  const expr = async (expression, awaitIt = true) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: awaitIt });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
      throw new Error('page eval: ' + (d || r.exceptionDetails.text));
    }
    return r.result.value;
  };
  const call = (fn, ...args) => expr('window.__smk.' + fn + '(' + args.map((a) => JSON.stringify(a)).join(',') + ')');
  async function until(label, fn, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 15000);
    let last = null;
    while (Date.now() < deadline) {
      try { const v = ready(await fn()); last = v; if (v) return v; } catch (err) { last = err.message; }
      await sleep(120);
    }
    throw new Error('超时等待「' + label + '」，最后值 ' + JSON.stringify(last));
  }
  const move = (x, y) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  const down = (x, y) => cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  const up = (x, y) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  async function click(p, label) {
    if (!p || p.err) throw new Error('找不到点击目标：' + (label || (p && p.err) || 'unknown'));
    if (slow) await sleep(slow);
    await move(p.x, p.y); await sleep(30);
    await down(p.x, p.y); await sleep(45);
    await up(p.x, p.y);
    if (slow) await sleep(slow);
  }
  async function drag(a, b, label) {
    if (!a || a.err || !b || b.err) throw new Error('找不到拖拽端点：' + (label || (a && a.err) || (b && b.err)));
    if (slow) await sleep(slow);
    await move(a.x, a.y); await sleep(40);
    await down(a.x, a.y); await sleep(40);
    for (let i = 1; i <= 8; i++) {
      await move(Math.round(a.x + ((b.x - a.x) * i) / 8), Math.round(a.y + ((b.y - a.y) * i) / 8));
      await sleep(16);
    }
    await sleep(50);
    await up(b.x, b.y);
    if (slow) await sleep(slow);
  }
  const type = (text) => cdp.send('Input.insertText', { text });
  const spot = (sel, text) => call('clickable', sel, text);
  const spotN = (sel, text, idx) => call('nth', sel, text, idx);
  async function clickText(sel, text, idx) {
    const p = idx == null ? await call('clickable', sel, text) : await call('nth', sel, text, idx);
    await click(p, (idx == null ? '' : '#' + idx + ' ') + sel + ' / ' + text);
  }
  async function typeInto(sel, text) {
    const r = await call('input', sel);
    if (!r || r.err || !r.ok) throw new Error('聚焦输入框失败：' + sel + ' ' + JSON.stringify(r));
    await type(text);
    const got = await call('inputValue', sel);
    if (got !== text) throw new Error('输入未生效：' + sel + ' 期望 ' + JSON.stringify(text) + ' 实际 ' + JSON.stringify(got));
  }
  // React 受控输入「整值替换」：走原生 value setter + input 事件，用来把已有内容清空（insertText 删不掉选区）
  async function setValue(sel, text) {
    const got = await expr('(function () { var el = document.querySelector(' + JSON.stringify(sel) + ');'
      + ' if (!el) return { err: "no input " + ' + JSON.stringify(sel) + ' };'
      + ' var d = Object.getOwnPropertyDescriptor(el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value");'
      + ' el.focus(); d.set.call(el, ' + JSON.stringify(text) + ');'
      + ' el.dispatchEvent(new Event("input", { bubbles: true }));'
      + ' return { ok: true, value: el.value }; })()');
    if (!got || got.err || got.value !== text) throw new Error('替换输入值失败：' + sel + ' ' + JSON.stringify(got));
  }
  return { expr, call, until, sleep, click, drag, type, spot, spotN, clickText, typeInto, setValue, move, down, up, slow };
}


// 事件收集 + 致命错误判定（/api/legacy-data 的 404 与资源加载噪声不算失败）
function watchErrors(cdp) {
  const bag = { exceptions: [], errors: [], warnings: [], csp: [], requests: [], failed: [], logs: [] };
  const ignorable = (t) => /\/api\/legacy-data|Failed to load resource|net::ERR_(ABORTED|BLOCKED|UNKNOWN)|DevTools Active|chrome:\/\//i.test(t);
  const flat = (args) => (args || []).map((a) => (a.value != null ? String(a.value) : a.description || a.type || '')).join(' ');
  cdp.on((method, params) => {
    if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails || {};
      bag.exceptions.push('exception: ' + ((d.exception && d.exception.description) || d.text || 'unknown'));
    } else if (method === 'Log.entryAdded') {
      const e = params.entry || {};
      const line = (e.source || '?') + '[' + e.level + '] ' + (e.text || e.url || '');
      if (e.source === 'security') bag.csp.push(line);
      else if (e.level === 'error') bag.errors.push(line);
      else if (e.level === 'warning') bag.warnings.push(line);
    } else if (method === 'Runtime.consoleAPICalled') {
      const line = 'console.' + params.type + ': ' + flat(params.args);
      if (params.type === 'log' || params.type === 'info') bag.logs.push(line);
      if (params.type === 'error') bag.errors.push(line);
      else if (params.type === 'warning') bag.warnings.push(line);
    } else if (method === 'Network.requestWillBeSent') {
      const r = params.request || {};
      bag.requests.push({ url: r.url, method: r.method, postData: r.postData || '', hasPostData: !!r.hasPostData });
    } else if (method === 'Network.loadingFailed') {
      bag.failed.push((params.errorText || '') + (params.blockedReason ? '(' + params.blockedReason + ')' : ''));
    }
  });
  bag.fatal = () => bag.exceptions.concat(bag.csp, bag.errors).filter((t) => !ignorable(t));
  return bag;
}

// ── 极简断言框架 ──
const results = [];
let failures = 0;
let section = '';
const ok = (name, detail) => { results.push({ section, name, pass: true, detail: detail == null ? '' : String(detail) }); console.log('  \u2713 ' + name + (detail != null ? '  \u001b[2m' + detail + '\u001b[0m' : '')); };
const bad = (name, detail) => { failures++; results.push({ section, name, pass: false, detail: String(detail == null ? '' : detail).slice(0, 400) }); console.log('  \u2717 ' + name + '  \u001b[31m' + String(detail == null ? '' : detail).slice(0, 400) + '\u001b[0m'); };
const assert = (name, cond, detail) => (cond ? ok(name, detail) : bad(name, detail == null ? '断言为假' : detail));
let stepIndex = 0;
const STOP_AT = num('stop-at', 0);
async function step(title, fn) {
  section = title;
  stepIndex++;
  if (STOP_AT && stepIndex > STOP_AT) { console.log('\n\u001b[2m\u25b8 ' + title + ' （--stop-at=' + STOP_AT + ' 已跳过）\u001b[0m'); return; }
  console.log('\n\u001b[1m\u25b8 ' + title + '\u001b[0m');
  try { await fn(); } catch (err) {
    bad(title + ' —— 流程异常', (err && (err.stack || err.message)) || String(err));
    const f = bag.fatal().slice(0, 6);
    if (f.length) console.log('   fatal: ' + f.join(' || '));
    try { console.log('   界面文字: ' + JSON.stringify(String(await H.call('bodyText')).slice(0, 400))); } catch (err) { /* 页面可能已经没了 */ }
    if (arg('applog')) bag.logs.slice(-40).forEach((l) => console.log('   app| ' + l));
  }
}
async function until(fn, label, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  let last = null;
  while (Date.now() < deadline) {
    try { const v = ready(await fn()); if (v) return v; last = v; } catch (err) { last = err.message; }
    await sleep(150);
  }
  throw new Error('等不到「' + label + '」，最后值 ' + JSON.stringify(last));
}

// ── 周口径（与 src/utils/time.js 的 getWeekRange 完全一致）──
const pad2 = (n) => (n < 10 ? '0' + n : String(n));
const dstr = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const ymd = (s) => new Date(Number(String(s).slice(0, 4)), Number(String(s).slice(5, 7)) - 1, Number(String(s).slice(8, 10)));
function weekDates(weekStartsOn, base) {
  const off = (base.getDay() - weekStartsOn + 7) % 7;
  const out = [];
  for (let i = 0; i < 7; i++) { const d = new Date(base); d.setDate(base.getDate() - off + i); out.push(dstr(d)); }
  return out;
}
const weekName = (day) => en.book.weekStartDays[day];

// ── 场景内共享状态 ──
const en = (await import('../src/i18n/locales/en.js')).default;
const zh = (await import('../src/i18n/locales/zh.js')).default;
const { REASONS, PROTECTED_REASONS, MAX_SNAPSHOTS } = await import('../src/storage/snapshots.js');
const { DB_NAME, DB_VERSION } = await import('../src/storage/idb.js');
const { DEFAULT_BOOK_ID, LANG_WEEK_START, defaultBookName } = await import('../src/storage/books.js');
const { slotRangeLabel } = await import('../src/utils/time.js');
const { CONTACT_EMAIL, REPO_ISSUES_URL, DIAG_FIELD_NAMES } = await import('../src/utils/contact.js');
let BOOKS1 = null;
let TODAY_STR = null;
let BASE = null;
let EV_ID = null;
let BOOK2_ID = null;
let LAST_MANUAL_ID = null;
let TARGET_SNAP_ID = null;
let snapsNow = null;

// ── 起一个真实的静态服务器（连带 public/_headers 里的 CSP），再用真浏览器打它 ──
const DIST = join(ROOT, 'dist');
const LEGACY_FILE = join(ROOT, 'data.json');
const statOf = (f) => (existsSync(f) ? ((s) => s.size + '@' + Math.round(s.mtimeMs))(statSync(f)) : 'absent');
function distFingerprint() {
  if (!existsSync(DIST)) return 'no-dist';
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((acc, e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return acc.concat(walk(full));
    const st = statSync(full);
    return acc.concat([e.name + ':' + st.size + ':' + Math.round(st.mtimeMs)]);
  }, []);
  return walk(DIST).sort().join('|');
}
let srv = null;
const urlArg = typeof arg('url', '') === 'string' ? arg('url', '') : '';
let targetUrl = urlArg;
if (!targetUrl) {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error('没有 dist/index.html，先跑 npm run build');
  const csp = arg("no-csp") ? null : cspFromHeadersFile();
  const s = await startStatic(DIST, csp);
  srv = s.srv;
  targetUrl = 'http://127.0.0.1:' + s.port + '/';
  console.log('静态服务器：' + targetUrl + '  CSP：' + (csp ? '已套用 public/_headers' : '未配置'));
}
const ORIGIN = new URL(targetUrl).origin;
const legacyBefore = statOf(LEGACY_FILE);
const distBefore = distFingerprint();

const chrome = findChrome();
const profile = mkdtempSync(join(tmpdir(), 'event-logger-smoke-'));
const debugPort = num('cdp-port', 0) || (await freePort());
const flags = [
  '--user-data-dir=' + profile,
  '--remote-debugging-port=' + debugPort,
  '--remote-allow-origins=*',
  '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-component-update',
  '--disable-extensions', '--disable-translate', '--hide-scrollbars', '--mute-audio',
  '--window-size=1600,1050', '--window-position=0,0',
  '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling',
  // CI/Linux 容器里 Chrome 常需要放弃沙箱才能起头less；只在显式传 --no-sandbox 时生效，本机默认路径不变。
  arg('no-sandbox') ? '--no-sandbox' : null,
  arg('no-sandbox') ? '--disable-dev-shm-usage' : null,
  // 验证「中文浏览器上首屏自动建出『默认』簿」这类场景就传 --lang=zh-CN；不传时 headless Chrome 回退 en。
  arg('lang') ? '--lang=' + arg('lang') : null,
  arg('lang') ? '--accept-lang=' + arg('lang') : null,
  // 走代理时显式保留 loopback bypass，免得自带静态服务器那条路也被导出去。
  PROXY ? '--proxy-server=' + PROXY : null,
  PROXY ? '--proxy-bypass-list=localhost,127.0.0.1,[::1]' : null,
  '--disable-renderer-backgrounding', '--disable-hang-monitor',
  arg('headed') ? null : '--headless=new',
  'about:blank',
].filter(Boolean);
console.log('浏览器：' + chrome);
console.log('临时 profile（等同一台没用过的机器）：' + profile);
if (PROXY) console.log('出口代理：' + PROXY + '（只有页面请求经它出去，CDP 与自带静态服务器直连）');
const proc = spawn(chrome, flags, { stdio: 'ignore' });
const bootTarget = await waitForPageTarget(debugPort, 40000);
const cdp = await connect(bootTarget);
const bag = watchErrors(cdp);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Log.enable');
await cdp.send('Network.enable');
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: BOOTSTRAP });
await cdp.send('Page.navigate', { url: targetUrl });
await sleep(1500);
const H = makeHelpers(cdp);

// 表头 / 日列 / weekday 出自同一次渲染，必须一次求值读全，不能拆成三次 CDP 往返：
// 建书与切书时 React 会重挂载整棵 Workspace（实测出现过 7 → 0 → 7 的帧），
// 分开读就会拿到「表头空、日列齐」这种两帧拼出来的假数据。
async function stableGrid(label, expectHeads, timeoutMs) {
  return await H.until(label, async () => {
    const g = await H.call('grid');
    if (!g || !g.heads) return null;
    if (g.heads.length !== 7 || g.cols.length !== 7 || g.wds.length !== 7) return null;
    if (JSON.stringify(g.heads) !== JSON.stringify(g.cols)) return null;
    if (expectHeads && JSON.stringify(g.heads) !== JSON.stringify(expectHeads)) return null;
    return g;
  }, timeoutMs || 25000);
}
// 助手是在 document-start 注入的，那时 document.body 还不存在。等到有 body 再往下走，
// 否则远程站点的第一个 innerText 求值会撞在 null 上，整步抛「Cannot read properties of null」。
await until(async () => await H.expr('!!window.__smk && !!document.body'), '页面装上定位助手并有 body', 20000);
const fatal = () => bag.fatal();
console.log('目标：' + targetUrl + '（同源 ' + ORIGIN + '）');
const BOOK = 'Smoke Book A';
const BOOK2 = 'Smoke Book B';
const EV_OLD = 'Alpha Standup';
const EV_NEW = 'Alpha Standup edited';
// 事件的可选描述：收尾的零存储复核把它和用户内容一起当泄露探针
const EV_DESC = 'blocker: login flow needs the SSO token';
const S1 = 6;
const S2 = 9;

// ── 启动诊断：白屏时先告诉你为什么白屏 ──
async function bootDiagnostics() {
  const info = await H.expr('JSON.stringify({ build: document.documentElement.getAttribute("data-build") || "", title: document.title, lang: document.documentElement.lang, rootChildren: document.getElementById("root") ? document.getElementById("root").children.length : -1, nodes: document.getElementsByTagName("*").length, body: (document.body ? document.body.innerText : "").replace(/\\s+/g, " ").slice(0, 160), innerHTML: document.getElementById("root") ? document.getElementById("root").innerHTML.slice(0, 160) : "" })');
  const parsed = JSON.parse(info);
  console.log('    文档：title=' + JSON.stringify(parsed.title) + ' lang=' + parsed.lang + ' 元素数=' + parsed.nodes + ' 构建号=' + parsed.build + ' root子节点=' + parsed.rootChildren);
  console.log('    root.innerHTML: ' + JSON.stringify(parsed.innerHTML));
  console.log('    body: ' + JSON.stringify(parsed.body));
  const seen = { exceptions: bag.exceptions.slice(0, 8), csp: bag.csp.slice(0, 8), errors: bag.errors.slice(0, 8), failed: bag.failed.slice(0, 8), warnings: bag.warnings.slice(0, 5) };
  console.log('    控制台异常: ' + (seen.exceptions.length ? '' : '无'));
  seen.exceptions.forEach((x) => console.log('      ! ' + x));
  console.log('    CSP/安全日志: ' + (seen.csp.length ? '' : '无'));
  seen.csp.forEach((x) => console.log('      ! ' + x));
  console.log('    其它错误: ' + (seen.errors.length ? '' : '无'));
  seen.errors.forEach((x) => console.log('      ! ' + x));
  console.log('    网络失败: ' + (seen.failed.length ? '' : '无'));
  seen.failed.forEach((x) => console.log('      ! ' + x));
  return parsed;
}

// 远程首屏要先下载几百 kB 的 bundle，React 挂载必然晚于第一次求值。先安静等挂载，再打完整诊断；
// 等不到也照样打，白屏时这一步得用人话说清为什么白，而不是丢一个 null 求值异常。
async function waitMounted(timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 25000);
  for (;;) {
    const n = await H.expr('(document.getElementById("root") ? document.getElementById("root").children.length : 0)');
    if (n > 0) return true;
    if (Date.now() >= deadline) return false;
    await sleep(200);
  }
}

await step('页面真的启动了（React 挂载成功）', async () => {
  const mounted = await waitMounted(25000);
  const parsed = await bootDiagnostics();
  assert('#root 里有渲染出来的节点', mounted && parsed.rootChildren > 0, 'rootChildren=' + parsed.rootChildren);
  assert('没有致命异常/CSP 拦截', fatal().length === 0, fatal().slice(0, 5).join(' | '));
  // 构建号是「旧壳 vs 新构建」唯一的肉眼证据：SW 预缓存 shell 时页面跑的是上一次 build 的 JS，
  // 只看界面分不清「没修好」和「没加载到新构建」。格式定义在 vite.config.js 的 resolveBuildId。
  assert('页面自报构建号（旧壳 / 新构建一眼可辨）', /^(?:[0-9a-f]{8}|dev)-\d{14}\+?$/i.test(parsed.build), 'data-build=' + JSON.stringify(parsed.build));
});

if (arg('boot-only')) {
  console.log('\n──────── boot-only：' + (failures ? failures + ' 项失败' : '启动正常') + ' ────────');
  try { await cdp.send('Browser.close'); } catch (err) { /* noop */ }
  await sleep(200);
  try { proc.kill(); } catch (err) { /* noop */ }
  if (srv) srv.close();
  if (!arg('keep')) { try { rmSync(profile, { recursive: true, force: true }); } catch (err) { /* Chrome 还没退干净 */ } }
  process.exit(failures ? 1 : 0);
}


// 默认簿的书名 / 周开始日跟着「浏览器语言」走（app 里 detectLang 的同一套映射）。
// headless Chrome 不带 --lang 时 navigator 回退 en；传 --lang=zh-CN 就能真跑一遍中文路径。
function langOf(tag) {
  const t = String(tag || '').toLowerCase();
  if (t.indexOf('zh') === 0) return 'zh';
  if (t.indexOf('ja') === 0) return 'ja';
  if (t.indexOf('en') === 0) return 'en';
  return '';
}
const BOOT_NAV = JSON.parse(await H.expr("JSON.stringify({ langs: navigator.languages || [], language: navigator.language || '' })"));
const BOOT_LANG = (BOOT_NAV.langs.length ? BOOT_NAV.langs : [BOOT_NAV.language]).map(langOf).find((x) => !!x) || 'en';
const BOOT_NAME = defaultBookName(BOOT_LANG);

// 首启引导页已经没有了：这台浏览器里一本簿都没有时，useBooks 会当场自举一本
// id=default-book、书名跟着浏览器语言本地化的默认簿，首屏直接落进周视图。
await step('需求① 零本书自举：首屏就有一本「' + BOOT_NAME + '」簿（浏览器语言 ' + BOOT_LANG + '）', async () => {
  await H.until('周视图表头 7 列', async () => (await H.call('count', '[data-header-date]')) === 7, 25000);
  ok('没有引导页，首屏即工作区', '7 个表头日');
  const rows = (await H.call('idb', 'books')) || [];
  assert('books store 恰好一本', rows.length === 1, JSON.stringify(rows.map((r) => ({ id: r.id, name: r.name }))));
  const seed = rows[0];
  assert('id 固定为 ' + DEFAULT_BOOK_ID, seed.id === DEFAULT_BOOK_ID, JSON.stringify(seed.id));
  assert('书名 = ' + BOOT_NAME, seed.name === BOOT_NAME, JSON.stringify(seed.name));
  // --lang 传了却没生效（浏览器不吃这个 flag）时这一步等于白跑，所以必须红
  const forced = typeof arg('lang', '') === 'string' ? langOf(arg('lang')) : '';
  assert('浏览器语言 ' + BOOT_LANG + ' 与 --lang 指定一致', !forced || BOOT_LANG === forced, JSON.stringify(BOOT_NAV) + ' → ' + BOOT_LANG);
  assert('语言 = 浏览器语言 ' + BOOT_LANG, seed.settings.language === BOOT_LANG, JSON.stringify(seed.settings.language));
  assert('周开始日 = ' + BOOT_LANG + ' 默认 ' + LANG_WEEK_START[BOOT_LANG], seed.settings.weekStartsOn === LANG_WEEK_START[BOOT_LANG], String(seed.settings.weekStartsOn));
  assert('时间轴默认全日 0-144', seed.settings.timelineStart === 0 && seed.settings.timelineEnd === 144, JSON.stringify([seed.settings.timelineStart, seed.settings.timelineEnd]));
  const active = await H.expr('localStorage.getItem("event-logger:active-book")');
  assert('活动簿指向默认簿', active === DEFAULT_BOOK_ID, JSON.stringify(active));
  const live = await readLive(DEFAULT_BOOK_ID);
  assert('默认簿的 live 行已附着且是空的', !!live && live.events.length === 0 && live.templates.length === 0, JSON.stringify(live && { e: live.events.length, t: live.templates.length, rev: live.rev }));
  // 自举只写第 1 版：Workspace 挂载时 useEvents/useTemplates 会各自把空数组重新 setState 一次，
  // 500ms 防抖到期后合并成一次「空内容重写」，rev 因此会再 +1（每本书都有这个既有行为）。
  // 所以这里只断言「这行是自举建出来的、内容仍是空的」，不断言具体写次数，避免时序敏感。
  assert('live 行由自举创建（rev >= 1，内容仍为空）', !!live && live.rev >= 1, live ? 'rev=' + live.rev : '没有 live 行');
  assert('顶栏簿切换器显示书名', await H.call('has', BOOT_NAME));
  assert('只有这一份同源 IndexedDB', JSON.stringify(await H.call('idbShape')) === JSON.stringify([DB_NAME + '@' + DB_VERSION]));
  assert('零 JS 异常 / 零 CSP 违规', fatal().length === 0, fatal().join(' | '));
});

await step('需求② 改这本默认簿：名字 + 周开始日 Tuesday', async () => {
  await H.clickText('header span', '🗂');
  await H.until('EventBook 菜单打开', async () => { const m = await H.call('menu'); return m.open ? true : null; }, 10000);
  await H.clickText('div', en.book.settings);
  await H.until('簿设置弹窗', () => H.call('has', en.book.settingsTitle), 10000);
  ok('默认簿也走同一套簿设置', en.book.settingsTitle);
  assert('弹窗里预填了默认书名', (await H.call('inputValue', 'input[placeholder=' + JSON.stringify(en.book.namePlaceholder) + ']')) === BOOT_NAME);
  await H.typeInto('input[placeholder=' + JSON.stringify(en.book.namePlaceholder) + ']', BOOK);
  await H.clickText('button', weekName(2));
  const preview = await H.call('clickable', 'div', 'This week');
  assert('周预览文案跟着周开始日重算', !!preview, JSON.stringify(preview));
  await H.clickText('button', en.common.save);
  await H.until('周视图表头 7 列', async () => (await H.call('count', '[data-header-date]')) === 7, 25000);
  ok('保存后仍在周视图', '7 个表头日');
  assert('顶栏显示新书名', await H.call('has', BOOK));
  // 设置写盘有 400ms 合并窗口，必须轮询 IndexedDB 而不是单次读
  const row = await until(async () => {
    const rows = (await H.call('idb', 'books')) || [];
    const r = rows.find((x) => x.id === DEFAULT_BOOK_ID);
    return r && r.name === BOOK && r.settings.weekStartsOn === 2 ? r : null;
  }, '默认簿改名 + Tuesday 落盘');
  ok('设置写进 IndexedDB', 'id=' + row.id + ' weekStartsOn=' + row.settings.weekStartsOn);
  assert('还是只有一本簿（改名不会变成新建）', ((await H.call('idb', 'books')) || []).length === 1);
});

// 月历 = 页面左上的日期面板。第 c 列的表头必须真是该列日期的星期，
// 且格子本身要落在 (weekStartsOn + c) % 7 这一列上（与 utils/time.js 同一口径）。
// en 界面下字典短名（Mo/Tu/…）是 en-US Intl 短名（Mon/Tue/…）的前缀，用这个做独立真值。
async function readMonth(label) {
  return await H.until(label, async () => {
    const m = await H.call('month');
    return m && m.heads.length === 7 && m.cells.length === 42 ? m : null;
  }, 20000);
}
function monthGridMisalign(snapshot, weekStartsOn) {
  const labels = snapshot.heads;
  const cells = snapshot.cells;
  if (labels.length !== 7) return '月历表头 ' + labels.length + ' 个（应为 7）';
  if (cells.length !== 42) return '月历格子 ' + cells.length + ' 个（应为 42）';
  const fmt = new Intl.DateTimeFormat('en-US', { weekday: 'short' });
  for (let i = 0; i < cells.length; i++) {
    const col = i % 7;
    const want = (weekStartsOn + col) % 7;
    const day = ymd(cells[i]);
    if (day.getDay() !== want) return cells[i] + ' 落在第 ' + col + ' 列，但该列应为星期 ' + want;
    const shortName = fmt.format(day);
    if (shortName.indexOf(labels[col]) !== 0) return cells[i] + '（' + shortName + '）上方的表头是 ' + labels[col];
  }
  return '';
}

await step('需求② 周开始日真的作用于整站（表头 / 日列 / weekday / 月历）', async () => {
  TODAY_STR = await H.call('today');
  BASE = ymd(TODAY_STR);
  const exp = weekDates(2, BASE);
  const g1 = await stableGrid('时间轴网格稳定（表头/日列/weekday 各 7 且互相对齐）', exp);
  const heads = g1.heads;
  const cols = g1.cols;
  const wds = g1.wds;
  const expWd = exp.map((s) => String(ymd(s).getDay()));
  assert('第一列是 Tuesday：' + heads[0], heads[0] === exp[0] && wds[0] === '2', 'heads=' + heads.join(',') + ' wd=' + wds.join(','));
  assert('7 天连续且包含今天', JSON.stringify(heads) === JSON.stringify(exp) && heads.includes(TODAY_STR), 'exp=' + exp.join(','));
  assert('日列与表头一一对应', JSON.stringify(cols) === JSON.stringify(exp), 'cols=' + cols.join(','));
  assert('weekday 序列 = 2,3,4,5,6,0,1', JSON.stringify(wds) === JSON.stringify(expWd));
  const cal1 = await readMonth('book1 的月历齐 7 列表头 + 42 格');
  const calBad = monthGridMisalign(cal1, 2);
  assert('月历每一格日期都在正确的星期列下（Tuesday 开头）', calBad === '', calBad || '42 格全对');
  assert('月历表头首列 = Tu', cal1.heads[0] === en.calendar.weekdays[1], cal1.heads.join(' '));
});

await step('需求② 语言跟随当前 EventBook（en → zh → en）', async () => {
  assert('英文界面：' + en.header.history, await H.call('has', en.header.history));
  const toZh = await H.call('selectSet', 'header select', 'zh');
  if (toZh.err) throw new Error(toZh.err);
  await H.until('中文界面', () => H.call('has', zh.header.history), 10000);
  ok('切到中文后顶栏变中文', zh.header.history);
  assert('周开始日 chip 也换语言', await H.call('has', zh.book.weekStartDays[2]));
  // 默认书名是创建瞬间的一次性快照：界面换成中文也不会把已改名的簿再换回本地化默认名
  const snapRows = (await H.call('idb', 'books')) || [];
  const snapBook = snapRows.find((r) => r.id === DEFAULT_BOOK_ID);
  assert('换语言不重算默认书名', !!snapBook && snapBook.name === BOOK, snapBook ? JSON.stringify(snapBook.name) : '默认簿不见了');
  await H.call('selectSet', 'header select', 'en');
  await H.until('回到英文', () => H.call('has', en.header.history), 10000);
  ok('切回英文', en.header.history);
  BOOKS1 = await until(async () => {
    const rows = (await H.call('idb', 'books')) || [];
    const b = rows.find((r) => r.name === BOOK);
    return b && b.settings.language === 'en' && b.settings.weekStartsOn === 2 ? b : null;
  }, 'EventBook 设置落盘');
  ok('设置写进 IndexedDB', 'weekStartsOn=' + BOOKS1.settings.weekStartsOn + ' language=' + BOOKS1.settings.language);
  assert('服务器上没有第二份数据', JSON.stringify(await H.call('idbShape')) === JSON.stringify([DB_NAME + '@' + DB_VERSION]));
});

await step('拖一个真实鼠标手势建事件（slot ' + S1 + ' → ' + S2 + '）', async () => {
  await H.drag(await H.call('slot', TODAY_STR, S1), await H.call('slot', TODAY_STR, S2), 'slot ' + S1 + '→' + S2);
  await H.until(en.dialog.createTitle, () => H.call('has', en.dialog.createTitle), 10000);
  ok('弹出新建事件框', en.dialog.createTitle);
  const NAME_SEL = 'input[placeholder=' + JSON.stringify(en.dialog.namePlaceholder) + ']';
  const TA_SEL = 'textarea[placeholder=' + JSON.stringify(en.dialog.descPlaceholder) + ']';
  assert('弹窗里有可选的多行描述框，初值为空', (await H.call('inputValue', TA_SEL)) === '', JSON.stringify(await H.call('inputValue', TA_SEL)));
  await H.typeInto(NAME_SEL, EV_OLD);
  // 先走「描述留空」这条可选路径：等价于旧事件（没有内容），tooltip 不能因此多出一行
  await H.clickText('button', en.common.create);
  const bars = await H.until('事件条渲染', async () => {
    const l = await H.call('eventBars');
    return l.length === 1 ? l : null;
  }, 10000);
  assert('时段 = [' + S1 + ',' + (S2 + 1) + ')', bars[0].start === S1 && bars[0].end === S2 + 1, JSON.stringify(bars[0]));
  assert('标题显示在时间轴上', bars[0].text.includes(EV_OLD), bars[0].text);
  // 悬停 tooltip（原生 title）是描述唯一的展示位：正文里绝不出现描述
  const tipOf = async () => String(((await H.call('attrAll', '[data-event-id]', 'title')) || [])[0] || '');
  const tipNoDesc = await tipOf();
  assert('tooltip 首行 = 名称（类别）', tipNoDesc.split('\n')[0] === EV_OLD + ' (' + en.category.work + ')', tipNoDesc);
  assert('tooltip 次行 = 区间', tipNoDesc.split('\n')[1] === slotRangeLabel(S1, S2 + 1), tipNoDesc);
  assert('描述为空时 tooltip 仍是两行（旧事件不会多出空行）', tipNoDesc.split('\n').length === 2, tipNoDesc);
  EV_ID = bars[0].id;
  const seen = [];
  let liveRow = null;
  const tEnd = Date.now() + 12000;
  while (Date.now() < tEnd) {
    const rows = (await H.call('idb', 'data')) || [];
    const sig = new Date().toISOString().slice(11, 23) + ' ' + (rows.map((r) => r.rev + 'e' + (r.events || []).length + 't' + (r.templates || []).length).join(',') || '(空)');
    if (seen[seen.length - 1] !== sig) seen.push(sig);
    const row = rows.find((r) => r.bookId === BOOKS1.id);
    if (row && Array.isArray(row.events) && row.events.length === 1 && row.events[0].name === EV_OLD) { liveRow = row; break; }
    await sleep(250);
  }
  console.log('    data store 轨迹（rev/事件数/模板数）:');
  seen.forEach((s) => console.log(      '      · ' + s));
  console.log('    books: ' + JSON.stringify(((await H.call('idb', 'books')) || []).map((b) => b.name)) + '  active=' + JSON.stringify(await H.expr('localStorage.getItem("event-logger:active-book")')));
  assert('事件写进本机 IndexedDB（12 秒内）', !!liveRow, liveRow ? 'rev=' + liveRow.rev : '仍未落盘');
  assert('描述留空也落键：description 是空串', liveRow.events[0].description === '', JSON.stringify(liveRow.events[0]));

  // 描述往返：写 → 落盘 → 重开预填 → 清空 → 落回空串 → 再写回（后面「改名」步要用它验证保存不会覆盖描述）
  const openBar = async (label) => {
    const l = await H.call('eventBars');
    await H.click({ x: l[0].x, y: l[0].y }, label);
    await H.until(en.dialog.editTitle, () => H.call('has', en.dialog.editTitle), 10000);
  };
  const waitLiveDesc = (want, label) => until(async () => {
    const row = await readLive(BOOKS1.id);
    return row && row.events && row.events[0] && row.events[0].description === want ? row : null;
  }, label);

  await openBar('事件条（补描述）');
  assert('编辑弹窗里描述框预填空串', (await H.call('inputValue', TA_SEL)) === '', JSON.stringify(await H.call('inputValue', TA_SEL)));
  await H.typeInto(TA_SEL, EV_DESC);
  await H.clickText('button', en.common.save);
  await H.until('tooltip 长出描述行', async () => ((await tipOf()).split('\n').length === 3 ? true : null), 10000);
  const tipWithDesc = await tipOf();
  assert('tooltip 第三行逐字 = 描述', tipWithDesc.split('\n')[2] === EV_DESC, tipWithDesc);
  assert('事件条正文里没有描述（只进 tooltip）', !((await H.call('eventBars'))[0].text.includes(EV_DESC)));
  await waitLiveDesc(EV_DESC, '描述写进 IndexedDB');
  ok('描述写进弹窗、tooltip 与 IndexedDB');

  await openBar('事件条（重开查预填）');
  assert('重开弹窗预填原描述', (await H.call('inputValue', TA_SEL)) === EV_DESC, String(await H.call('inputValue', TA_SEL)));
  await H.setValue(TA_SEL, '');
  await H.clickText('button', en.common.save);
  await H.until('清空后 tooltip 收回两行', async () => {
    const tp = await tipOf();
    return tp.split('\n').length === 2 && !tp.endsWith('\n') ? true : null;
  }, 10000);
  await waitLiveDesc('', '清空描述落盘');
  ok('清空描述立刻生效（保存恒写该键，展开合并不会残留旧值）');

  await openBar('事件条（把描述写回）');
  assert('清空后重开仍是空串', (await H.call('inputValue', TA_SEL)) === '', JSON.stringify(await H.call('inputValue', TA_SEL)));
  await H.typeInto(TA_SEL, EV_DESC);
  await H.clickText('button', en.common.save);
  await waitLiveDesc(EV_DESC, '描述重新落盘');

  ok('事件已写进本机 IndexedDB');
});
await step('需求① 零存储：所有请求都是同源 GET，用户内容一个字都不上线', async () => {
  const httpReqs = bag.requests.filter((r) => r.url.startsWith('http'));
  const cross = httpReqs.filter((r) => !r.url.startsWith(ORIGIN));
  const nonGet = httpReqs.filter((r) => r.method !== 'GET');
  const withBody = httpReqs.filter((r) => r.postData || r.hasPostData);
  const leak = httpReqs.filter((r) => (r.url + ' ' + (r.postData || '')).includes(EV_OLD));
  const bookLeak = httpReqs.filter((r) => (r.url + ' ' + (r.postData || '')).includes(BOOK));
  const descLeak = httpReqs.filter((r) => (r.url + ' ' + (r.postData || '')).includes(EV_DESC));
  console.log('    ' + httpReqs.length + ' 个请求：' + [...new Set(httpReqs.map((r) => r.url.replace(ORIGIN, '')))].join(' , '));
  assert('全部 GET（服务器收不到任何写入）', nonGet.length === 0, nonGet.map((r) => r.method + ' ' + r.url).join(' | '));
  assert('零请求体', withBody.length === 0, withBody.map((r) => r.url).join(' | '));
  assert('零第三方（只有 ' + ORIGIN + '）', cross.length === 0, cross.map((r) => r.url).join(' | '));
  assert('URL 里没有事件名', leak.length === 0, leak.map((r) => r.url).join(' | '));
  assert('URL 里没有 EventBook 名', bookLeak.length === 0, bookLeak.map((r) => r.url).join(' | '));
  assert('URL 里没有事件描述', descLeak.length === 0, descLeak.map((r) => r.url).join(' | '));
  assert('磁盘上的旧 data.json 没被动过', statOf(LEGACY_FILE) === legacyBefore, legacyBefore + ' → ' + statOf(LEGACY_FILE));
  assert('dist/ 没有被写入', distFingerprint() === distBefore, distBefore + ' → ' + distFingerprint());
});

// 面板开合一律幂等：遮罩会吞掉底下时间轴/统计区的点击，是全量跑最容易踩的坑
async function panelVisible() {
  const got = await H.call('act', 'archive-now');
  return !!(got && !got.err);
}
async function openHistory() {
  if (await panelVisible()) return;
  await H.clickText('button', en.header.history);
  await H.until(en.history.title, async () => ((await panelVisible()) ? true : null), 10000);
}
async function closeHistory() {
  if (!(await panelVisible())) return;
  await H.click(await H.call('act', 'panel-close'), en.history.title + ' close');
  await H.until(en.history.title + ' closed', async () => ((await panelVisible()) ? null : true), 10000);
}
async function clickSnap(snapId, action) {
  await H.click(await H.call('snap', snapId, action), 'snapshot/' + action);
}
async function archiveNow() {
  await H.click(await H.call('act', 'archive-now'), en.history.archiveNow);
}

// window.__smk.idb 永远返回行数组，单本 live 数据要取第 0 行
async function readLive(bookId) {
  const rows = (await H.call('idb', 'data', bookId)) || [];
  return rows[0] || null;
}

async function snapList(bookId) {
  const rows = (await H.call('idb', 'snapshots', bookId)) || [];
  return rows.slice().sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}


await step('需求③ 存档：手动写一份历史版本进 IndexedDB', async () => {
  BOOKS1 = BOOKS1 || (await until(async () => ((await H.call('idb', 'books')) || []).find((r) => r.name === BOOK), 'book'));
  const before = await snapList(BOOKS1.id);
  console.log('    存档前已有 ' + before.length + ' 份：' + before.map((s) => s.reason).join(','));
  await openHistory();
  ok('历史面板打开', en.history.title);
  await H.until('立即存档按钮', () => H.call('clickable', 'button', en.history.archiveNow), 10000);
  await archiveNow();
  const after = await until(async () => {
    const rows = await snapList(BOOKS1.id);
    return rows.length > before.length ? rows : null;
  }, '新快照落盘');
  ok('快照数 ' + before.length + ' → ' + after.length);
  const fresh = after[after.length - 1];
  LAST_MANUAL_ID = fresh.id;
  assert('reason=manual', fresh.reason === 'manual', fresh.reason);
  assert('manual 受保护（淘汰不得删它）', fresh.protected === true);
  assert('指纹字段齐全', /^[0-9a-f]{16}\.\d+$/.test(String(fresh.hash)) && fresh.bytes > 0 && !!fresh.iso, JSON.stringify({ hash: fresh.hash, bytes: fresh.bytes, iso: fresh.iso }));
  assert('快照内容是那一条事件', fresh.eventCount === 1 && fresh.payload.events[0].name === EV_OLD, JSON.stringify(fresh.payload.events.map((e) => e.name)));
  await H.call('clickable', 'button', en.history.archiveNow);
  await archiveNow();
  const toast = await H.until('重复存档提示', () => H.call('has', en.history.unchanged), 6000);
  ok('内容没变时按 hash 去重', String(toast) === 'true');
  const same = await snapList(BOOKS1.id);
  assert('去重后计数不变', same.length === after.length, same.length + ' vs ' + after.length);
});

await step('需求③ 历史版本结构不变量（直接读 IndexedDB）', async () => {
  const rows = await snapList(BOOKS1.id);
  const reasons = [...new Set(rows.map((s) => s.reason))];
  assert('reason 只可能是枚举值', reasons.every((r) => REASONS.indexOf(r) >= 0), reasons.join(','));
  assert('protected 位与 reason 一致', rows.every((s) => s.protected === (PROTECTED_REASONS.indexOf(s.reason) >= 0)), JSON.stringify(rows.map((s) => s.reason + ':' + s.protected)));
  assert('createdAt 严格递增、id 唯一', rows.every((s, i) => i === 0 || s.createdAt >= rows[i - 1].createdAt) && new Set(rows.map((s) => s.id)).size === rows.length);
  assert('每份都自带完整 payload（可直接回放）', rows.every((s) => s.payload && Array.isArray(s.payload.events)), 'x');
  assert('零 JS 异常 / 零 CSP 违规', fatal().length === 0, fatal().join(' | '));
});
const BANNER_HEAD = en.preview.banner.split('{')[0];
const EMPTY_A = 20;
const EMPTY_B = 23;

await step('需求③ 改内容 → 回放旧版本：整站只读', async () => {
  await closeHistory();
  const bars = await H.call('eventBars');
  await H.click({ x: bars[0].x, y: bars[0].y }, '事件条');
  await H.until(en.dialog.editTitle, () => H.call('has', en.dialog.editTitle), 10000);
  await H.typeInto('input[placeholder=' + JSON.stringify(en.dialog.namePlaceholder) + ']', EV_NEW);
  await H.clickText('button', en.common.save);
  const after = await H.until('改名生效', async () => {
    const l = await H.call('eventBars');
    return l.length === 1 && l[0].text.includes(EV_NEW) ? l : null;
  }, 10000);
  ok('事件被就地更新（id 不变）', after[0].id === EV_ID ? '同一条事件' : 'id 变了！');
  // 界面改了还不算，必须真的写进本机 IndexedDB（防「空写覆盖」）
  const renamedRow = await until(async () => {
    const row = await readLive(BOOKS1.id);
    return row && row.events && row.events[0] && row.events[0].name === EV_NEW ? row : null;
  }, '改动落盘');
  // 只改事件名也必须保住描述：保存路径恒写 description 键，不是「有才写」
  assert('改名后描述原样保留', renamedRow.events[0].description === EV_DESC, JSON.stringify(renamedRow.events[0]));
  const tipRenamedRows = await H.call('attrAll', '[data-event-id]', 'title');
  const tipRenamed = String((tipRenamedRows || [])[0] || '');
  assert('改名后 tooltip 仍带描述行', tipRenamed.split('\n').indexOf(EV_DESC) >= 0, tipRenamed);
  const beforeSnaps = await snapList(BOOKS1.id);
  await openHistory();
  await archiveNow();
  snapsNow = await until(async () => {
    const rows = await snapList(BOOKS1.id);
    return rows.length === beforeSnaps.length + 1 ? rows : null;
  }, '第二份快照');
  const oldIdx = (() => {
    for (let i = snapsNow.length - 1; i >= 0; i--) if (snapsNow[i].payload.events.some((e) => e.name === EV_OLD)) return i;
    return -1;
  })();
  assert('存在含有旧版本内容的快照', oldIdx >= 0, '没有哪份快照里有 ' + EV_OLD);
  assert('最新快照含新内容', snapsNow[snapsNow.length - 1].payload.events[0].name === EV_NEW);
  TARGET_SNAP_ID = snapsNow[oldIdx].id;
  await clickSnap(TARGET_SNAP_ID, 'view');
  await H.until('回放横幅', () => H.call('has', BANNER_HEAD), 10000);
  ok('进入回放态', BANNER_HEAD.trim());
  const replay = await H.until('回放内容', async () => {
    const l = await H.call('eventBars');
    return l.length === 1 && l[0].text.includes(EV_OLD) && !l[0].text.includes('edited') ? l : null;
  }, 10000);
  ok('整站按旧版本渲染', '时间轴上是「' + EV_OLD + '」而不是「' + EV_NEW + '」');
  assert('回放里能看到恢复入口', await H.call('has', en.history.restore));
  await H.clickText('button[aria-label=Close]', '✕');
  assert('关掉面板后仍在回放', await H.call('has', BANNER_HEAD));
});

await step('需求③ 回放期间写操作被拦（不改动任何数据）', async () => {
  await closeHistory();
  const before = await H.call('eventBars');
  await H.drag(await H.call('slot', TODAY_STR, EMPTY_A), await H.call('slot', TODAY_STR, EMPTY_B), '回放中拖空槽');
  await sleep(500);
  const now = await H.call('eventBars');
  assert('拖拽新建被拦：事件数不变', now.length === before.length, now.length + ' vs ' + before.length);
  assert('没有弹出新建框', !(await H.call('has', en.dialog.createTitle)));
  await H.click({ x: before[0].x, y: before[0].y }, '回放中点事件条');
  await sleep(400);
  assert('回放中点事件不打开编辑框', !(await H.call('has', en.dialog.editTitle)));
  await H.until('统计面板', () => H.call('clickable', 'button', en.common.month), 15000);
  await H.clickText('button', en.common.month);
  await H.until('只读提示', () => H.call('has', en.app.readOnlyBlocked), 4000);
  ok('写路径统一被 guardWrite 拦下', en.app.readOnlyBlocked);
  await sleep(900);
  const row = ((await H.call('idb', 'books')) || []).find((b) => b.id === BOOKS1.id);
  assert('被拦的设置没有落盘', row.settings.statsScope === 'week', String(row.settings.statsScope));
  const dataRow = await readLive(BOOKS1.id);
  assert('被拦的写没有污染数据', dataRow.events.length === 1 && dataRow.events[0].name === EV_NEW);
});
await step('需求③ 恢复：不可逆，且恢复前先自动存一份（追加式快照链）', async () => {
  const base = await snapList(BOOKS1.id);
  const baseIds = base.map((s) => s.id);
  await openHistory();
  await clickSnap(TARGET_SNAP_ID, 'ask-restore');
  assert('恢复前的告警讲清了不可逆', await H.call('has', en.history.restoreSafety), en.history.restoreSafety);
  await clickSnap(TARGET_SNAP_ID, 'confirm-restore');
  await H.until('恢复完成提示', () => H.call('has', en.history.restoreDone.split('{')[0]), 15000);
  assert('回放横幅已退出', !(await H.call('has', BANNER_HEAD)));
  const rows = await until(async () => {
    const r = await snapList(BOOKS1.id);
    return r.length === base.length + 2 ? r : null;
  }, '快照链追加两份', 20000);
  ok('快照数 ' + base.length + ' → ' + rows.length, 'pre-restore + restored-from');
  const baseNow = (await snapList(BOOKS1.id)).filter((s) => baseIds.indexOf(s.id) >= 0);
  assert('旧快照一份都没被删（链只追加）', baseNow.length === base.length, baseNow.length + '/' + base.length);
  const added = rows.filter((s) => baseIds.indexOf(s.id) < 0);
  assert('新增的是 pre-restore + restored-from', JSON.stringify(added.map((s) => s.reason)) === JSON.stringify(['pre-restore', 'restored-from']), added.map((s) => s.reason).join(','));
  assert('pre-restore 保住的是恢复前的新内容', added[0].payload.events[0].name === EV_NEW);
  assert('pre-restore 受保护、restored-from 可淘汰', added[0].protected === true && added[1].protected === false);
  assert('note 指回被恢复的那一份', added[0].note === TARGET_SNAP_ID && added[1].note === TARGET_SNAP_ID, added.map((s) => s.note).join(' / '));
  const live = await readLive(BOOKS1.id);
  assert('live 内容 = 被恢复的旧版本', live.events.length === 1 && live.events[0].name === EV_OLD, JSON.stringify(live.events.map((e) => e.name)));
  const bars = await H.until('时间轴回到旧版本', async () => {
    const l = await H.call('eventBars');
    return l.length === 1 && l[0].text.includes(EV_OLD) ? l : null;
  }, 10000);
  ok('界面同步回到旧版本', bars[0].text);
  assert('恢复后重新可写', !(await H.call('has', en.app.readOnlyBlocked)));
});

await step('需求② 第二本 EventBook：数据与设置各自独立', async () => {
  await H.clickText('header span', '🗂');
  await H.clickText('div', en.header.createBook);
  await H.until('设置弹窗', () => H.call('has', en.book.settingsTitle), 10000);
  ok('新建后直接进入该书设置', en.book.settingsTitle);
  const all = await until(async () => {
    const rows = ((await H.call('idb', 'books')) || []).slice().sort((a, b) => a.createdAt - b.createdAt);
    return rows.length === 2 ? rows : null;
  }, '两本 EventBook');
  const b2 = all[1];
  assert('书名自动取 ' + en.book.unnamed, b2.name.indexOf(en.book.unnamed) === 0, b2.name);
  assert('周开始日/语言继承当前界面', b2.settings.weekStartsOn === 2 && b2.settings.language === 'en', JSON.stringify(b2.settings));
  const d2 = await readLive(b2.id);
  assert('新书完全空白（数据隔离）', d2 && d2.events.length === 0 && d2.templates.length === 0, JSON.stringify(d2 && { e: d2.events.length, t: d2.templates.length }));
  assert('新书没有历史快照', ((await H.call('idb', 'snapshots', b2.id)) || []).length === 0);
  assert('时间轴也是空的', (await H.call('eventBars')).length === 0);
  await H.clickText('button', weekName(1));
  await H.clickText('button', en.common.save);
  await until(async () => {
    const rows = (await H.call('idb', 'books')) || [];
    const r = rows.find((x) => x.id === b2.id);
    return r && r.settings.weekStartsOn === 1 ? r : null;
  }, 'book2 改成 Monday');
  const g2 = await stableGrid('book2 的周口径生效（表头从 Monday 开始）', weekDates(1, BASE));
  assert('book2 的周从 Monday 开始', g2.heads[0] === weekDates(1, BASE)[0], g2.heads.join(','));
  const cal2 = await readMonth('book2 的月历齐 7 列表头 + 42 格');
  const calBad2 = monthGridMisalign(cal2, 1);
  assert('book2 的月历改成 Monday 开头', calBad2 === '', calBad2 || '42 格全对');
  assert('book2 的月历表头首列 = Mo', cal2.heads[0] === en.calendar.weekdays[0], cal2.heads.join(' '));
  await H.clickText('header span', '🗂');
  await H.clickText('div', BOOK);
  const g3 = await stableGrid('切回 book1 的周口径', weekDates(2, BASE));
  ok('同一站点内两本书两套周口径', 'book2=Mon / book1=Tue');
  assert('切回来后事件还在', g3.events.length === 1, JSON.stringify(g3.events));
  BOOK2_ID = b2.id;
});
await step('关掉再打开：数据仍在（IndexedDB 持久 + 可离线打开）', async () => {
  const before = await H.call('eventBars');
  const booksBefore = ((await H.call('idb', 'books')) || []).length;
  let loadedAt = 0;
  cdp.on((m) => { if (m === 'Page.loadEventFired') loadedAt = Date.now(); });
  await cdp.send('Page.reload', { ignoreCache: false });
  await sleep(1200);
  await H.until('重载后回到工作区', () => H.call('clickable', 'button', en.header.history), 30000);
  const gR = await stableGrid('重载后网格稳定', weekDates(2, BASE), 30000);
  assert('活动 EventBook 记忆住了', await H.call('has', BOOK));
  // 已有簿的浏览器再打开一次，绝不能又自举出一本默认簿
  const booksAfter = ((await H.call('idb', 'books')) || []).length;
  assert('重载不会再多自举一本簿', booksAfter === booksBefore, booksBefore + ' → ' + booksAfter);
  assert('事件仍在', gR.events.length === before.length && gR.events[0].includes(EV_OLD), JSON.stringify(gR.events));
  assert('周开始日仍是 Tuesday', gR.heads[0] === weekDates(2, BASE)[0], gR.heads.join(','));
  assert('重载后不残留回放态', !(await H.call('has', BANNER_HEAD)));
  const regs = await H.until('Service Worker 注册', async () => {
    const n = await H.expr("(async () => { const rs = (await navigator.serviceWorker.getRegistrations()) || []; return rs.length; })()");
    return n >= 1 ? n : null;
  }, 25000);
  ok('PWA 已注册', regs + ' 个 registration');
  const man = await H.expr("(async () => { const r = await fetch('/manifest.webmanifest'); return r.status + ':' + (await r.json()).name })()");
  assert('manifest 可取', String(man).startsWith('200:'), String(man));
  const persist = await H.expr('(async () => (navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false))()');
  console.log('    持久存储授权：' + (persist ? '已授予' : '未授予（浏览器策略）'));
  assert('零 JS 异常 / 零 CSP 违规（含重载）', fatal().length === 0, fatal().join(' | '));
});

await step('顶栏瘦身：导出/导入并入 EventBook 菜单，且 file input 不会被菜单卸载', async () => {
  await H.clickText('header span', '🗂', 0);
  const m = await until(async () => { const x = await H.call('menu'); return x.open ? x : null; }, 'EventBook 菜单打开');
  const wantExportAll = en.book.exportAll.replace('{n}', '2');
  assert('菜单里有「数据与备份」段的导出全部', m.items.indexOf(wantExportAll) >= 0, JSON.stringify(m.items));
  assert('菜单里有「导入为新的 EventBook」', m.items.indexOf(en.book.importFile) >= 0, JSON.stringify(m.items));
  assert('导出此簿仍在（单本作用域没被合并掉）', m.items.indexOf(en.book.exportOne) >= 0, JSON.stringify(m.items));
  assert('簿设置 / 删除此簿仍在原位', m.items.indexOf(en.book.settings) >= 0 && m.items.indexOf(en.book.remove) >= 0, JSON.stringify(m.items));
  assert('每个菜单项都能键盘聚焦', m.tabbable === m.items.length, m.tabbable + '/' + m.items.length);
  assert('簿切换器本身可键盘打开', m.triggers >= 1, String(m.triggers));
  assert('顶栏是历史 / 模板 / 反馈 / 帮助四个按钮（反馈与帮助都是只读入口）', m.headerButtons === 4, String(m.headerButtons));
  assert('隐藏的 file input 已挂载', m.inputMounted);
  assert('file input 不在菜单面板里', m.inputInsideMenu === false);
  await H.clickText('header span', '🗂', 0);
  const after = await until(async () => { const x = await H.call('menu'); return x.open ? null : x; }, '菜单已关闭');
  assert('关菜单后 file input 仍在（否则导入点了没反应）', after.inputMounted === true);
  ok('导出/导入入口已并入 EventBook 菜单', '共 ' + m.items.length + ' 项');
});
await step('历史面板：镜像块正文一行 + 重新镜像折叠进「查看文件夹」+ 工具栏「导出全部」（不碰系统弹窗、不触发下载）', async () => {
  const { ROOT_DIR_NAME, LATEST_FILE_NAME, SNAPSHOT_DIR_NAME } = await import('../src/storage/folderBackup.js');
  await openHistory();
  // 镜像块探针：状态 / 动作清单 / 提示 / 正文一次求值读全（重渲染会让两次读取落在不同帧上）
  const probe = () => H.expr(`(() => {
    const el = document.querySelector('[data-mirror-state]');
    if (!el) return null;
    const head = el.querySelector('[data-hint="path"]');
    const pick = el.querySelector('[data-action="mirror-pick"]');
    const open = el.querySelector('[data-action="mirror-open"]');
    const acts = Array.prototype.map.call(el.querySelectorAll('[data-action]'), (b) => b.getAttribute('data-action'));
    return {
      state: el.getAttribute('data-mirror-state'),
      actions: acts.join(','),
      pathHint: head ? head.title : null,
      pickTitle: pick ? pick.title : null,
      intervalSelect: !!el.querySelector('[data-action="mirror-interval"]'),
      resyncInBody: acts.indexOf('mirror-resync') >= 0,
      openBtn: !!open,
      openTitle: open ? open.title : null,
      openText: open ? open.textContent.trim() : null,
      openExpanded: open ? open.getAttribute('aria-expanded') : null,
      view: !!el.querySelector('[data-mirror-view]'),
      untitled: Array.prototype.filter.call(el.querySelectorAll('[data-action]'), (b) => !b.title || !b.title.trim()).map((b) => b.getAttribute('data-action')).join(','),
      text: el.textContent.replace(/\\s+/g, ' '),
    };
  })()`);
  const box = await H.until('镜像块渲染', async () => (await probe()) || null, 10000);
  const state = box.state;
  ok('镜像块当前状态：' + state);
  assert('状态取值在契约内', ['off', 'permission', 'on', 'unsupported'].indexOf(state) >= 0, String(state));
  assert('全新 profile 里绝不假装「已连接」', state !== 'on', state);
  assert('能看到镜像块的标题', box.text.includes(en.folder.title.replace(/^[^\w]+/, '')), box.text.slice(0, 60));
  const chainProbe = en.folder.chain.replace('{count}', '9').slice(0, 18);
  assert('正文瘦身：磁盘落点与版本链说明都不再占行',
    box.text.indexOf(ROOT_DIR_NAME) < 0 && box.text.indexOf(LATEST_FILE_NAME) < 0 && box.text.indexOf(chainProbe) < 0, box.text.slice(0, 140));
  assert('磁盘落点搬进标题提示（' + ROOT_DIR_NAME + ' / ' + LATEST_FILE_NAME + ' / ' + SNAPSHOT_DIR_NAME + '/）',
    !!box.pathHint && box.pathHint.indexOf(ROOT_DIR_NAME) >= 0 && box.pathHint.indexOf(LATEST_FILE_NAME) >= 0 && box.pathHint.indexOf(SNAPSHOT_DIR_NAME) >= 0, String(box.pathHint).slice(0, 180));
  assert('镜像块里每个控件都带一句话说明', box.untitled === '', box.untitled);
  assert('「重新镜像全部版本」不在镜像块正文里（已折叠进查看面板）', box.resyncInBody === false, box.actions);
  assert('未连接时不给「查看镜像文件夹」入口', box.openBtn === false && box.view === false, box.actions);
  assert('节奏下拉只在「已连接」时出现', box.intervalSelect === (state === 'on'), state + ' / select=' + box.intervalSelect);
  if (state === 'off') {
    assert('「数据只在本机」改放按钮提示里', !!box.pickTitle && box.pickTitle.indexOf(en.history.browserOnly) >= 0, String(box.pickTitle).slice(0, 160));
    assert('未连接：正文只剩一句介绍', box.text.includes(en.folder.intro.slice(0, 24)), box.text.slice(0, 140));
    assert('未连接：只给「选择文件夹」这一个入口', box.actions === 'mirror-pick', box.actions);
  } else if (state === 'unsupported') {
    assert('不支持：一个按钮都不给，只让用导出兜底', box.actions === '', box.actions);
    assert('不支持：文案指向 Export', box.text.indexOf('Export') >= 0, box.text.slice(0, 140));
  }
  assert('镜像块渲染零 JS 异常', fatal().length === 0, fatal().join(' | '));
  // 工具栏里的「导出全部」：只验结构，绝不点击（headless 点了会触发下载）
  const ea = await H.expr(`(() => {
    const b = document.querySelector('[data-action="export-all"]');
    if (!b) return null;
    const box = document.querySelector('[data-mirror-state]');
    return {
      text: b.textContent.trim(),
      disabled: b.disabled,
      outside: !(box && box.contains(b)),
      hint: b.title.length > 0,
      headerButtons: document.querySelectorAll('header button').length,
    };
  })()`);
  assert('工具栏里有「导出全部」按钮', !!ea, ea ? JSON.stringify(ea) : 'null');
  assert('它不属于镜像块（不依赖文件夹能力）', !!ea && ea.outside === true, JSON.stringify(ea));
  assert('可点且带 tooltip 说明', !!ea && ea.disabled === false && ea.hint === true, JSON.stringify(ea));
  assert('文案来自 i18n', !!ea && ea.text === en.history.exportAll, ea && ea.text);
  assert('顶栏仍是历史 / 模板 / 反馈 / 帮助四个按钮（导出/导入没被搬回去）', !!ea && ea.headerButtons === 4, ea && String(ea.headerButtons));

  // ── 「已连接」那一档必须真渲染一遍才验得到。headless 里弹不出系统目录选择框，所以把一个
  //    纯数据句柄写进 meta 再重载：checkPermission 对「没有 queryPermission 的句柄」按 granted
  //    处理（folderBackup.js 里的既有分支），状态机即进入 on。它不是真目录句柄，正好用来验
  //    查看面板的降级路径 —— 读不到镜像目录就当「还没写过副本」显示，既不报错也绝不写盘。
  const FAKE_ROOT_NAME = 'SMOKE MIRROR ROOT';
  await H.call('metaOp', 'set', 'backupDirectory', { name: FAKE_ROOT_NAME });
  await cdp.send('Page.reload', { ignoreCache: false });
  await sleep(1200);
  await H.until('重载后回到工作区（伪造的已连接态）', () => H.call('clickable', 'button', en.header.history), 30000);
  await openHistory();
  const onBox = await H.until('已连接态的镜像块', async () => { const x = await probe(); return x && x.state === 'on' ? x : null; }, 20000);
  assert('已连接：正文里同样没有「重新镜像全部版本」', onBox.resyncInBody === false, onBox.actions);
  assert('已连接：给出「查看镜像文件夹」按钮', onBox.openBtn === true, onBox.actions);
  assert('已连接：查看按钮带一句话说明', !!onBox.openTitle && onBox.openTitle.length > 12, String(onBox.openTitle).slice(0, 110));
  assert('已连接：自动镜像节奏回来了', onBox.intervalSelect === true, onBox.actions);
  assert('已连接：那一行不会自相矛盾地写「未连接」', onBox.text.indexOf(en.folder.none) < 0, onBox.text.slice(0, 240));
  assert('已连接：一次都还没写时明说「还没有写入过副本」', onBox.text.indexOf(en.folder.notYet) >= 0, onBox.text.slice(0, 240));
  assert('已连接：没点开之前不铺文件列表', onBox.view === false, onBox.actions);
  await H.click(await H.call('act', 'mirror-open'), 'mirror-open');
  const viewBox = await H.until('查看镜像文件夹面板', async () => { const x = await probe(); return x && x.view ? x : null; }, 20000);
  const wantActs = ['mirror-open', 'mirror-reselect', 'mirror-forget', 'mirror-view-refresh', 'mirror-view-close', 'mirror-resync'];
  assert('面板展开：正文 + 面板的动作齐全', wantActs.every((a) => viewBox.actions.indexOf(a) >= 0), viewBox.actions);
  assert('面板展开：「重新镜像全部版本」收在这里（折叠的逃生口）', viewBox.resyncInBody === true, viewBox.actions);
  assert('面板展开：按钮文案切成收起', viewBox.openText === en.folder.hide, String(viewBox.openText));
  assert('面板展开：aria-expanded 对得上', viewBox.openExpanded === 'true', String(viewBox.openExpanded));
  assert('面板展开：每个控件也带说明', viewBox.untitled === '', viewBox.untitled);
  const noCopyNeedle = en.folder.viewNoRoot.split('{root}')[0];
  assert('读不到镜像目录：显示「还没写过副本」而不是报错', viewBox.text.indexOf(noCopyNeedle) >= 0, viewBox.text.slice(0, 200));
  assert('面板标题里的根名来自句柄', viewBox.text.indexOf(FAKE_ROOT_NAME) >= 0, viewBox.text.slice(0, 200));
  await H.click(await H.call('act', 'mirror-view-refresh'), 'mirror-view-refresh');
  const refBox = await H.until('刷新后面板仍在', async () => { const x = await probe(); return x && x.view && x.text.indexOf(noCopyNeedle) >= 0 ? x : null; }, 20000);
  assert('刷新不改变动作集合', refBox.actions === viewBox.actions, refBox.actions);
  // 这里只断言「查看面板自己没有报读取失败」。整块文本里可能另外出现一行「镜像失败：…」，
  // 那来自应用自身的去抖存档打到这个伪造句柄上（headless 造不出真的目录句柄），不是查看逻辑写的。
  // 「查看 = 零写入 / 零读取内容」这条由 check-book-store.mjs 第 11 节用 guardDir 确定性守住：
  // 列举前后文件树完全一致、零 create:true、零 getFileHandle。
  const viewFailNeedle = en.folder.viewFailed.split('{')[0];
  assert('查看面板自己没有报读取失败（它只做只读列举）', refBox.text.indexOf(viewFailNeedle) < 0, refBox.text.slice(0, 220));
  assert('刷新后连接与面板状态没被改动', refBox.state === 'on' && refBox.view === true, refBox.state + '/' + refBox.view);
  assert('查看镜像文件夹零 JS 异常', fatal().length === 0, fatal().join(' | '));
  assert('查看不会把连接弄丢（meta 里还是那个句柄）', (await H.call('metaOp', 'get', 'backupDirectory')) !== null);
  await H.click(await H.call('act', 'mirror-view-close'), 'mirror-view-close');
  const folded = await H.until('收起查看面板', async () => { const x = await probe(); return x && !x.view ? x : null; }, 20000);
  assert('收起：面板消失，入口还在', folded.view === false && folded.openBtn === true, folded.actions);
  assert('收起：按钮文案切回「打开」', folded.openText === en.folder.open, String(folded.openText));
  assert('收起：「重新镜像」跟着一起藏回去', folded.resyncInBody === false, folded.actions);
  assert('收起：aria-expanded 回到 false', folded.openExpanded === 'false', String(folded.openExpanded));
  // 清掉假句柄，绝不把它留给后面的步骤
  await H.call('metaOp', 'del', 'backupDirectory');
  await cdp.send('Page.reload', { ignoreCache: false });
  await sleep(1200);
  await H.until('重载后回到工作区（已清理假句柄）', () => H.call('clickable', 'button', en.header.history), 30000);
  await openHistory();
  const offAgain = await H.until('回到未连接', async () => { const x = await probe(); return x && x.state === 'off' ? x : null; }, 20000);
  assert('清掉句柄后回到未连接，不再给查看入口', offAgain.openBtn === false && offAgain.view === false, offAgain.actions);
  assert('未连接：仍然只给「选择文件夹」这一个入口', offAgain.actions === 'mirror-pick', offAgain.actions);
  assert('伪造已连接 + 两次重载，全程零 JS 异常', fatal().length === 0, fatal().join(' | '));
  await closeHistory();
});

await step('使用帮助与独立反馈面板：顶栏两枚入口 / 八个小节 / 目录跳节 / 反馈只拼 href / 跟随语言 / Esc 关闭', async () => {
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  // 帮助面板探针：只读指南的结构与文字。反馈已搬去独立面板，这里必须一个反馈锚点都不剩。
  const helpProbe = () => H.expr(`(() => {
    const p = document.querySelector('[data-help-dialog]');
    if (!p) return null;
    const secs = p.querySelectorAll('[data-help-section]');
    const navs = p.querySelectorAll('[data-help-nav]');
    const scroller = p.querySelector('[data-help-scroll]');
    const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
    const attr = (list, name) => Array.prototype.map.call(list, (e) => e.getAttribute(name)).join(',');
    return {
      title: p.getAttribute('aria-label'),
      sections: secs.length,
      navs: navs.length,
      sectionKeys: attr(secs, 'data-help-section'),
      navKeys: attr(navs, 'data-help-nav'),
      sectionTitles: Array.prototype.map.call(secs, (e) => norm(e.firstElementChild ? e.firstElementChild.textContent : '')),
      navTitles: Array.prototype.map.call(navs, (e) => norm(e.textContent)),
      bullets: p.querySelectorAll('li').length,
      intro: norm((p.querySelector('[data-help-intro]') || {}).textContent),
      aboutParas: p.querySelectorAll('[data-help-about] p').length,
      about: Array.prototype.map.call(p.querySelectorAll('[data-help-about] p'), (e) => norm(e.textContent)).join(' '),
      warnTitle: norm((p.querySelector('[data-help-warn-title]') || {}).textContent),
      warnParas: p.querySelectorAll('[data-help-warn] p').length,
      warn: Array.prototype.map.call(p.querySelectorAll('[data-help-warn] p'), (e) => norm(e.textContent)).join(' '),
      warnBeforeNav: (() => {
        const w = p.querySelector('[data-help-warn]');
        const n = p.querySelector('[data-help-nav]');
        return !!(w && n) && !!(w.compareDocumentPosition(n) & 4);
      })(),
      anchors: p.querySelectorAll('a').length,
      contactAnchors: p.querySelectorAll('[data-contact-dialog],[data-help-contact],[data-contact-email],[data-contact-mail],[data-contact-issues],[data-contact-diag]').length,
      mailto: p.innerHTML.indexOf('mailto:') >= 0,
      contactOpen: !!document.querySelector('[data-contact-dialog]'),
      closeBtn: !!p.querySelector('[data-action=\\'help-close\\']'),
      scrolled: scroller ? Math.round(scroller.scrollTop) : -1,
      chars: p.innerText.replace(/\\s+/g, ' ').length,
    };
  })()`);
  // 反馈面板探针：只读结构 + 两条 href。断言里绝不点击这两枚链接 ——
  // 点下去就是真的把草稿交给系统邮件客户端 / 真的开一个新标签，等于冒烟替用户发信。
  const contactProbe = () => H.expr(`(() => {
    const p = document.querySelector('[data-contact-dialog]');
    if (!p) return null;
    const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
    const one = (sel) => p.querySelector(sel);
    const text = (sel) => { const e = one(sel); if (!e) return null; return e.tagName === 'TEXTAREA' ? e.value : norm(e.textContent); };
    const link = (sel) => { const e = one(sel); if (!e) return null; return { href: e.getAttribute('href') || '', target: e.getAttribute('target') || '', rel: e.getAttribute('rel') || '' }; };
    return {
      title: p.getAttribute('aria-label'),
      intro: text('[data-contact-intro]'),
      paras: p.querySelectorAll('[data-contact-lines] p').length,
      lines: Array.prototype.map.call(p.querySelectorAll('[data-contact-lines] p'), (e) => norm(e.textContent)).join(' '),
      emailLabel: text('[data-contact-email-label]'),
      email: text('[data-contact-email]'),
      mail: link('[data-contact-mail]'),
      mailLabel: text('[data-contact-mail]'),
      issues: link('[data-contact-issues]'),
      issuesLabel: text('[data-contact-issues]'),
      diagLabel: text('[data-contact-diag-label]'),
      diag: text('[data-contact-diag]'),
      hint: text('[data-contact-hint]'),
      li: p.querySelectorAll('li').length,
      anchors: p.querySelectorAll('a').length,
      helpOpen: !!document.querySelector('[data-help-dialog]'),
      closeBtn: !!p.querySelector('[data-action=\\'contact-close\\']'),
    };
  })()`);
  // 顶栏按钮的可见文案，按 DOM 顺序拼一条字符串：反馈必须在帮助之前
  const topBar = () => H.expr(`Array.prototype.map.call(document.querySelectorAll('header button'), (b) => b.textContent.replace(/\\s+/g, ' ').trim()).join('|')`);
  const pressEscape = async () => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  };
  const NEEDLES = [EV_OLD, EV_NEW, EV_DESC, BOOK, BOOK2];
  const orderOf = (bar, text) => bar.split('|').indexOf(text);

  // —— 顶栏：反馈是独立入口，而且排在帮助之前 ——
  const bar1 = await topBar();
  assert('英文顶栏有「' + en.contact.entry + '」这枚按钮', await H.call('has', en.contact.entry) && orderOf(bar1, en.contact.entry) >= 0, bar1);
  assert('反馈入口排在帮助入口之前：' + bar1, orderOf(bar1, en.contact.entry) >= 0 && orderOf(bar1, en.help.entry) > orderOf(bar1, en.contact.entry), bar1);

  await H.clickText('button', en.contact.entry);
  const c1 = await H.until('英文反馈面板打开且诊断块带上构建号', async () => {
    const x = await contactProbe();
    return x && x.diag && x.diag.indexOf('build=') === 0 ? x : null;
  }, 10000);
  assert('反馈面板标题来自 i18n：' + c1.title, c1.title === en.contact.title, String(c1.title));
  assert('导语与四段正文都来自字典（en ' + en.contact.lines.length + ' 段）', c1.intro === norm(en.contact.intro) && c1.paras === en.contact.lines.length && c1.lines === norm(en.contact.lines.join(' ')), c1.paras + ' 段 / ' + c1.intro.slice(0, 40));
  assert('别名、别名说明、兜底提示、关闭按钮齐备', c1.email === CONTACT_EMAIL && c1.emailLabel === norm(en.contact.emailLabel) && c1.hint === norm(en.contact.noMailHint) && c1.diagLabel === norm(en.contact.diagLabel) && c1.closeBtn === true, c1.email);
  assert('两枚入口的文案来自字典', c1.mailLabel === norm(en.contact.mailLabel) && c1.issuesLabel === norm(en.contact.issuesLabel), c1.mailLabel + ' / ' + c1.issuesLabel);
  assert('反馈面板只用段落排版、对外动作只有两枚 <a>', c1.li === 0 && c1.anchors === 2, 'li=' + c1.li + ' a=' + c1.anchors);
  assert('公开展示的只有邮箱别名：' + c1.email, c1.email === CONTACT_EMAIL, String(c1.email));
  assert('mailto 只指向别名本身，并带字典里的 subject 与 body', c1.mail.href.indexOf('mailto:' + CONTACT_EMAIL + '?') === 0 && c1.mail.href.indexOf('subject=' + encodeURIComponent(en.contact.subject)) > 0 && c1.mail.href.indexOf('body=') > 0, c1.mail.href.slice(0, 80));
  assert('邮箱入口不加 target/rel（发信发生在页面之外）', c1.mail.target === '' && c1.mail.rel === '', c1.mail.target + ' / ' + c1.mail.rel);
  assert('Issue 入口指向仓库 issues', c1.issues.href.indexOf(REPO_ISSUES_URL + '?') === 0, c1.issues.href.slice(0, 90));
  assert('Issue 入口开新标签且不带 opener', c1.issues.target === '_blank' && c1.issues.rel === 'noopener noreferrer', c1.issues.target + ' / ' + c1.issues.rel);
  const diagLines1 = c1.diag.split('\n');
  assert('诊断块恰好 ' + DIAG_FIELD_NAMES.length + ' 行，顺序与字段名等于白名单', diagLines1.length === DIAG_FIELD_NAMES.length && diagLines1.every((l, i) => l.indexOf(DIAG_FIELD_NAMES[i] + '=') === 0), diagLines1.join(' | '));
  assert('诊断块里没有事件名、书名、描述、文件夹路径', NEEDLES.every((n) => c1.diag.indexOf(n) === -1), c1.diag.replace(/\n/g, ' / '));
  assert('两条 href 编码后同样不含用户内容', NEEDLES.every((n) => c1.mail.href.indexOf(encodeURIComponent(n)) === -1 && c1.issues.href.indexOf(encodeURIComponent(n)) === -1), 'leak check');
  assert('诊断块的 lang 是当前界面语言（不是残留的 unknown）', /(^|\n)lang=(en|zh|ja)(\n|$)/.test(c1.diag), c1.diag.replace(/\n/g, ' / '));
  assert('打开反馈不会顺带把帮助也点开', c1.helpOpen === false, String(c1.helpOpen));
  // 草稿可编辑：用户改过的文本必须原样出现在两条链接里（反馈内容归用户控制）
  const edited = 'build=manual-EDIT\nlang=zh';
  await H.setValue('[data-contact-diag]', edited);
  const cd = await H.until('编辑后的草稿同时进入两条链接', async () => {
    const x = await contactProbe();
    return x && x.diag === edited && x.mail.href.indexOf(encodeURIComponent(edited)) > 0 && x.issues.href.indexOf(encodeURIComponent(edited)) > 0 ? x : null;
  }, 8000);
  assert('改动过的诊断文本覆盖自动生成值', !!cd, cd ? 'ok' : 'diag 未被覆盖');
  await pressEscape();
  assert('Esc 关闭反馈面板', (await H.until('Esc 后反馈面板消失', async () => ((await contactProbe()) === null ? true : null), 8000)) === true);

  // —— 帮助面板：八个小节，而且里面再也找不到反馈 ——
  await H.clickText('button', en.help.entry);
  const h1 = await H.until('英文帮助面板打开', async () => (await helpProbe()) || null, 10000);
  assert('面板标题来自 i18n：' + h1.title, h1.title === en.help.title, String(h1.title));
  assert('八个小节全部渲染（⑧ 常见问题是最后一节）', h1.sections === 8, h1.sectionKeys);
  assert('小节顺序等于组件里的 SECTION_ORDER', h1.sectionKeys === 'start,record,adjust,view,book,backup,privacy,faq', h1.sectionKeys);
  assert('目录 chip 也是八个且与小节一一对应', h1.navs === 8 && h1.navKeys === h1.sectionKeys, h1.navKeys + ' / ' + h1.sectionKeys);
  assert('目录 chip 文案 = 各节标题', JSON.stringify(h1.navTitles) === JSON.stringify(h1.sectionTitles), h1.navTitles.join(' | '));
  const HELP_KEYS = ['start', 'record', 'adjust', 'view', 'book', 'backup', 'privacy', 'faq'];
  assert('八节标题逐一对上英文字典',
    h1.sectionTitles.join(' || ') === HELP_KEYS.map((k) => en.help.sections[k].title).join(' || '),
    h1.sectionTitles.join(' | '));
  assert('每节都有正文（合计 ' + h1.bullets + ' 条），且成段不是空壳', h1.bullets >= 24 && h1.chars >= 1200, h1.bullets + ' 条 / ' + h1.chars + ' 字');
  assert('开头工具介绍来自字典（en 两段）', h1.aboutParas === 2 && h1.about === norm(en.help.about.join(' ')), h1.about.slice(0, 60));
  assert('导语来自字典（en）', h1.intro === norm(en.help.intro), h1.intro.slice(0, 60));
  assert('开头备份提醒来自字典（en 两段）', h1.warnTitle === norm(en.help.warnLabel) && h1.warnParas === 2 && h1.warn === norm(en.help.warn.join(' ')), h1.warnTitle + ' / ' + h1.warn.slice(0, 60));
  assert('备份提醒排在目录和小节之前', h1.warnBeforeNav === true, String(h1.warnBeforeNav));
  assert('关闭按钮存在', h1.closeBtn === true);
  assert('反馈确实已从帮助剥离：面板内没有反馈锚点、没有 <a>、没有 mailto', h1.contactAnchors === 0 && h1.anchors === 0 && h1.mailto === false, 'anchors=' + h1.contactAnchors + ' a=' + h1.anchors + ' mailto=' + h1.mailto);
  assert('开帮助时反馈面板是关着的（两个入口互不牵连）', h1.contactOpen === false, String(h1.contactOpen));

  // 目录跳节：点最后一节的 chip，面板内部必须真的滚动起来
  await H.clickText('[data-help-nav]', en.help.sections.faq.title);
  const jumped = await H.until('点目录后滚到最后一节', async () => { const x = await helpProbe(); return x && x.scrolled > 0 ? x : null; }, 8000);
  assert('跳转后滚动位置 > 0', jumped.scrolled > 0, String(jumped.scrolled));
  assert('跳转不改变结构（仍八节、标题不变）', jumped.sections === 8 && jumped.title === en.help.title);

  await pressEscape();
  assert('Esc 关闭帮助面板', (await H.until('Esc 后面板消失', async () => ((await helpProbe()) === null ? true : null), 8000)) === true);

  // 三语齐平由 i18n:check 守键集合，这里只验「界面语言一换，两个面板的正文立刻跟着换」
  await H.call('selectSet', 'header select', 'zh');
  await H.until('界面切到中文', () => H.call('has', zh.header.history), 10000);
  const bar2 = await topBar();
  assert('中文顶栏同样有「' + zh.contact.entry + '」且排在帮助之前：' + bar2, orderOf(bar2, zh.contact.entry) >= 0 && orderOf(bar2, zh.help.entry) > orderOf(bar2, zh.contact.entry), bar2);

  await H.clickText('button', zh.help.entry);
  const h2 = await H.until('中文帮助面板打开', async () => (await helpProbe()) || null, 10000);
  assert('中文标题：' + h2.title, h2.title === zh.help.title, String(h2.title));
  assert('中文八节标题逐一对上中文字典',
    h2.sectionTitles.join(' || ') === HELP_KEYS.map((k) => zh.help.sections[k].title).join(' || '),
    h2.sectionTitles.join(' | '));
  assert('开头工具介绍来自字典（zh 两段）', h2.aboutParas === 2 && h2.about === norm(zh.help.about.join(' ')), h2.about.slice(0, 60));
  assert('导语来自字典（zh）', h2.intro === norm(zh.help.intro), h2.intro.slice(0, 60));
  assert('开头备份提醒来自字典（zh 两段）', h2.warnTitle === norm(zh.help.warnLabel) && h2.warnParas === 2 && h2.warn === norm(zh.help.warn.join(' ')), h2.warnTitle + ' / ' + h2.warn.slice(0, 60));
  assert('换语言不换结构与锚点', h2.sections === 8 && h2.navs === 8 && h2.sectionKeys === h1.sectionKeys, h2.sectionKeys);
  assert('正文条数与语言无关', h2.bullets === h1.bullets, h2.bullets + ' vs ' + h1.bullets);
  assert('中文帮助同样没有反馈的痕迹', h2.contactAnchors === 0 && h2.anchors === 0 && h2.mailto === false, 'anchors=' + h2.contactAnchors);
  await H.click(await H.call('act', 'help-close'), 'help-close');
  await H.until('关闭按钮收掉帮助面板', async () => ((await helpProbe()) === null ? true : null), 8000);

  await H.clickText('button', zh.contact.entry);
  const c2 = await H.until('中文反馈面板打开', async () => {
    const x = await contactProbe();
    // 刻意不看 diag 的前缀：上一次的手改草稿同样以 build= 开头。
    // 把它当「面板打开好了」的信号，会把重开时的首帧残留掩盖成通过（CI 上就是这么红的）。
    return x && x.diag ? x : null;
  }, 10000);
  assert('中文标题：' + c2.title, c2.title === zh.contact.title, String(c2.title));
  assert('中文正文同样来自字典', c2.intro === norm(zh.contact.intro) && c2.lines === norm(zh.contact.lines.join(' ')) && c2.hint === norm(zh.contact.noMailHint), c2.intro.slice(0, 40));
  assert('中文界面上的别名与两条入口齐备', c2.email === CONTACT_EMAIL && c2.mailLabel === norm(zh.contact.mailLabel) && c2.issuesLabel === norm(zh.contact.issuesLabel) && c2.mail.href.indexOf('mailto:' + CONTACT_EMAIL + '?') === 0 && c2.issues.href.indexOf(REPO_ISSUES_URL + '?') === 0, c2.email);
  assert('邮件主题跟着语言换成中文', c2.mail.href.indexOf('subject=' + encodeURIComponent(zh.contact.subject)) > 0, c2.mail.href.slice(0, 90));
  assert('Issue 正文跟着语言换成中文主题，但绝不含用户内容', [EV_OLD, BOOK, BOOK2].every((n) => c2.issues.href.indexOf(encodeURIComponent(n)) === -1), c2.issues.href.slice(-60));
  assert('关掉再打开不残留上一次的手改草稿', c2.diag.indexOf('manual-EDIT') === -1 && c2.diag.indexOf('build=') === 0, String(c2.diag).replace(/\n/g, ' / '));
  await H.click(await H.call('act', 'contact-close'), 'contact-close');
  await H.until('关闭按钮收掉反馈面板', async () => ((await contactProbe()) === null ? true : null), 8000);

  await H.call('selectSet', 'header select', 'en');
  await H.until('切回英文', () => H.call('has', en.header.history), 10000);

  const hb = await H.call('menu');
  assert('两个入口都不搅动顶栏结构（历史 / 模板 / 反馈 / 帮助）', hb.headerButtons === 4, String(hb.headerButtons));
  assert('帮助与反馈面板全程零 JS 异常', fatal().length === 0, fatal().join(' | '));
});

await step('收尾：全程零存储复核', async () => {
  const httpReqs = bag.requests.filter((r) => r.url.startsWith('http'));
  const nonGet = httpReqs.filter((r) => r.method !== 'GET');
  const cross = httpReqs.filter((r) => !r.url.startsWith(ORIGIN));
  const bodies = httpReqs.filter((r) => r.postData || r.hasPostData);
  const needles = [EV_OLD, EV_NEW, EV_DESC, BOOK, BOOK2];
  const leak = httpReqs.filter((r) => needles.some((n) => (r.url + ' ' + (r.postData || '')).includes(n)));
  console.log('    全程 ' + httpReqs.length + ' 个请求，方法分布：' + JSON.stringify(httpReqs.reduce((a, r) => { a[r.method] = (a[r.method] || 0) + 1; return a }, {})));
  assert('全程零非 GET', nonGet.length === 0, nonGet.map((r) => r.method + ' ' + r.url).join(' | '));
  assert('全程零请求体', bodies.length === 0);
  assert('全程零跨域', cross.length === 0, cross.map((r) => r.url).slice(0, 5).join(' | '));
  assert('没有任何用户内容出现在 URL 里', leak.length === 0, leak.map((r) => r.url).slice(0, 3).join(' | '));
  assert('磁盘上旧 data.json 仍是原样', statOf(LEGACY_FILE) === legacyBefore);
  assert('dist/ 没有被服务端写过', distFingerprint() === distBefore);
  assert('原生 alert 一次都没弹（校验没走 alert）', (await H.call('alerts')).length === 0, JSON.stringify(await H.call('alerts')));
  const snaps = await snapList(BOOKS1.id);
  const ids = snaps.map((s) => s.id);
  assert('历史链仍是追加式且未越界', snaps.length >= 4 && snaps.length <= MAX_SNAPSHOTS, snaps.length + ' 份');
  console.log('    历史链：' + snaps.map((s) => s.reason + (s.protected ? '*' : '')).join(' → '));
  assert('所有 reason 合法', snaps.every((s) => REASONS.indexOf(s.reason) >= 0));
  assert('没有孤儿：每份快照都属于某本书', ids.every((id) => !!id) && snaps.every((s) => s.bookId === BOOKS1.id));
});

// —— 收工 ——
try { await cdp.send('Browser.close'); } catch (err) { /* 已经走了 */ }
await sleep(300);
try { proc.kill(); } catch (err) { /* noop */ }
if (srv) srv.close();
if (!arg('keep')) { try { rmSync(profile, { recursive: true, force: true }); } catch (err) { console.error('清理临时 profile 失败：' + err.message); } }

console.log('\n──────── ' + (failures ? failures + ' 项失败' : '全部通过') + ' ────────');
if (arg('json')) {
  writeFileSync(join(ROOT, 'smoke-report.json'), JSON.stringify({ url: BASE, results, fatal: fatal(), warnings: bag.warnings.slice(0, 20) }, null, 2));
  console.log('报告：smoke-report.json');
}
if (failures) {
  results.filter((r) => !r.pass).forEach((r) => console.log('✗ ' + r.name + '\n   ' + r.detail));
  process.exit(1);
}
console.log('Event_Logger 端到端冒烟通过：数据只在本机 IndexedDB · 每本书自己的周开始日与语言 · 历史版本可回放可恢复（不可逆）');
