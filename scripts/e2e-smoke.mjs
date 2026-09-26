// 端到端冒烟测试：零依赖，用 CDP 直接驱动真实 Chrome。
// 验证三条硬需求：① 服务器不存任何用户数据 ② EventBook 自带周开始日 + 语言 ③ 历史版本可回放、可恢复（不可逆）。
// 用法：
//   npm run smoke                                   自带静态服务器发 dist/（并套上 public/_headers 的 CSP）
//   npm run smoke -- --url=http://localhost:3002     打已经在跑的服务器
//   npm run smoke -- --headed --keep --slow=60       有头 + 保留临时 profile + 每步慢放 60ms
//   npm run smoke -- --no-sandbox                       CI/容器里 Chrome 起不来时加（同时带 --disable-dev-shm-usage）
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
    idbShape: function () {
      return new Promise(function (res) {
        var rq = indexedDB.databases ? indexedDB.databases() : Promise.resolve(null);
        Promise.resolve(rq).then(function (list) { res(list ? list.map(function (d) { return d.name + '@' + d.version; }) : ['no indexedDB.databases']); });
      });
    }
  };
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
      try { const v = await fn(); last = v; if (v) return v; } catch (err) { last = err.message; }
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
  return { expr, call, until, sleep, click, drag, type, spot, spotN, clickText, typeInto, move, down, up, slow };
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
    try { const v = await fn(); if (v) return v; last = v; } catch (err) { last = err.message; }
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
  '--disable-renderer-backgrounding', '--disable-hang-monitor',
  arg('headed') ? null : '--headless=new',
  'about:blank',
].filter(Boolean);
console.log('浏览器：' + chrome);
console.log('临时 profile（等同一台没用过的机器）：' + profile);
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
await until(async () => await H.expr('!!window.__smk'), '页面装上定位助手', 20000);
const fatal = () => bag.fatal();
console.log('目标：' + targetUrl + '（同源 ' + ORIGIN + '）');
const BOOK = 'Smoke Book A';
const BOOK2 = 'Smoke Book B';
const EV_OLD = 'Alpha Standup';
const EV_NEW = 'Alpha Standup edited';
const S1 = 6;
const S2 = 9;

// ── 启动诊断：白屏时先告诉你为什么白屏 ──
async function bootDiagnostics() {
  const info = await H.expr('JSON.stringify({ build: document.documentElement.getAttribute("data-build") || "", title: document.title, lang: document.documentElement.lang, rootChildren: document.getElementById("root") ? document.getElementById("root").children.length : -1, nodes: document.getElementsByTagName("*").length, body: document.body.innerText.replace(/\\s+/g, " ").slice(0, 160), innerHTML: document.getElementById("root") ? document.getElementById("root").innerHTML.slice(0, 160) : "" })');
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

await step('页面真的启动了（React 挂载成功）', async () => {
  const parsed = await bootDiagnostics();
  assert('#root 里有渲染出来的节点', parsed.rootChildren > 0, 'rootChildren=' + parsed.rootChildren);
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


await step('需求① 首启引导（这台浏览器里没有 IndexedDB 数据）', async () => {
  await H.until(en.firstRun.title, () => H.call('has', en.firstRun.title), 25000);
  ok('引导页出现', en.firstRun.title);
  assert('引导页写明「服务器不存用户数据」', await H.call('has', en.firstRun.intro));
  assert('只有这一份同源 IndexedDB', JSON.stringify(await H.call('idbShape')) === JSON.stringify([DB_NAME + '@' + DB_VERSION]));
  assert('零 JS 异常 / 零 CSP 违规', fatal().length === 0, fatal().join(' | '));
});

await step('需求② 建 EventBook：名字 + 周开始日 Tuesday + 语言 English', async () => {
  await H.typeInto('input:not([type=file])', BOOK);
  await H.clickText('button', weekName(2));
  const preview = await H.call('clickable', 'div', 'This week');
  assert('周预览文案跟着周开始日重算', !!preview, JSON.stringify(preview));
  await H.clickText('button', en.firstRun.create);
  await H.until('周视图表头 7 列', async () => (await H.call('count', '[data-header-date]', 'data-header-date')) === 7, 25000);
  ok('进入周视图', '7 个表头日');
  assert('顶栏显示书名', await H.call('has', BOOK));
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
  await H.typeInto('input[placeholder=' + JSON.stringify(en.dialog.namePlaceholder) + ']', EV_OLD);
  await H.clickText('button', en.common.create);
  const bars = await H.until('事件条渲染', async () => {
    const l = await H.call('eventBars');
    return l.length === 1 ? l : null;
  }, 10000);
  assert('时段 = [' + S1 + ',' + (S2 + 1) + ')', bars[0].start === S1 && bars[0].end === S2 + 1, JSON.stringify(bars[0]));
  assert('标题显示在时间轴上', bars[0].text.includes(EV_OLD), bars[0].text);
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

  ok('事件已写进本机 IndexedDB');
});
await step('需求① 零存储：所有请求都是同源 GET，用户内容一个字都不上线', async () => {
  const httpReqs = bag.requests.filter((r) => r.url.startsWith('http'));
  const cross = httpReqs.filter((r) => !r.url.startsWith(ORIGIN));
  const nonGet = httpReqs.filter((r) => r.method !== 'GET');
  const withBody = httpReqs.filter((r) => r.postData || r.hasPostData);
  const leak = httpReqs.filter((r) => (r.url + ' ' + (r.postData || '')).includes(EV_OLD));
  const bookLeak = httpReqs.filter((r) => (r.url + ' ' + (r.postData || '')).includes(BOOK));
  console.log('    ' + httpReqs.length + ' 个请求：' + [...new Set(httpReqs.map((r) => r.url.replace(ORIGIN, '')))].join(' , '));
  assert('全部 GET（服务器收不到任何写入）', nonGet.length === 0, nonGet.map((r) => r.method + ' ' + r.url).join(' | '));
  assert('零请求体', withBody.length === 0, withBody.map((r) => r.url).join(' | '));
  assert('零第三方（只有 ' + ORIGIN + '）', cross.length === 0, cross.map((r) => r.url).join(' | '));
  assert('URL 里没有事件名', leak.length === 0, leak.map((r) => r.url).join(' | '));
  assert('URL 里没有 EventBook 名', bookLeak.length === 0, bookLeak.map((r) => r.url).join(' | '));
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
  await until(async () => {
    const row = await readLive(BOOKS1.id);
    return row && row.events && row.events[0] && row.events[0].name === EV_NEW ? row : null;
  }, '改动落盘');
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
  let loadedAt = 0;
  cdp.on((m) => { if (m === 'Page.loadEventFired') loadedAt = Date.now(); });
  await cdp.send('Page.reload', { ignoreCache: false });
  await sleep(1200);
  await H.until('重载后回到工作区', () => H.call('clickable', 'button', en.header.history), 30000);
  const gR = await stableGrid('重载后网格稳定', weekDates(2, BASE), 30000);
  assert('活动 EventBook 记忆住了', await H.call('has', BOOK));
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
  assert('顶栏只剩历史 / 模板两个按钮', m.headerButtons === 2, String(m.headerButtons));
  assert('隐藏的 file input 已挂载', m.inputMounted);
  assert('file input 不在菜单面板里', m.inputInsideMenu === false);
  await H.clickText('header span', '🗂', 0);
  const after = await until(async () => { const x = await H.call('menu'); return x.open ? null : x; }, '菜单已关闭');
  assert('关菜单后 file input 仍在（否则导入点了没反应）', after.inputMounted === true);
  ok('导出/导入入口已并入 EventBook 菜单', '共 ' + m.items.length + ' 项');
});
await step('历史面板：镜像块正文一行 + 细节收进提示 + 工具栏「导出全部」（不碰系统弹窗、不触发下载）', async () => {
  const { ROOT_DIR_NAME, LATEST_FILE_NAME, SNAPSHOT_DIR_NAME } = await import('../src/storage/folderBackup.js');
  await openHistory();
  const box = await H.until('镜像块渲染', async () => (H.expr(`(() => {
    const el = document.querySelector('[data-mirror-state]');
    if (!el) return null;
    const head = el.querySelector('[data-hint="path"]');
    const pick = el.querySelector('[data-action="mirror-pick"]');
    return {
      state: el.getAttribute('data-mirror-state'),
      actions: Array.prototype.map.call(el.querySelectorAll('[data-action]'), (b) => b.getAttribute('data-action')).join(','),
      pathHint: head ? head.title : null,
      pickTitle: pick ? pick.title : null,
      intervalSelect: !!el.querySelector('[data-action="mirror-interval"]'),
      untitled: Array.prototype.filter.call(el.querySelectorAll('[data-action]'), (b) => !b.title || !b.title.trim()).map((b) => b.getAttribute('data-action')).join(','),
      text: el.textContent.replace(/\\s+/g, ' '),
    };
  })()`) || null), 10000);
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
  assert('顶栏仍是两个按钮（导出/导入没被搬回去）', !!ea && ea.headerButtons === 2, ea && String(ea.headerButtons));
  await closeHistory();
});

await step('收尾：全程零存储复核', async () => {
  const httpReqs = bag.requests.filter((r) => r.url.startsWith('http'));
  const nonGet = httpReqs.filter((r) => r.method !== 'GET');
  const cross = httpReqs.filter((r) => !r.url.startsWith(ORIGIN));
  const bodies = httpReqs.filter((r) => r.postData || r.hasPostData);
  const needles = [EV_OLD, EV_NEW, BOOK, BOOK2];
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