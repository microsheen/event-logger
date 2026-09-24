// 跨标签页总线：① 每本书同一时刻只允许一个标签页写（单写者，后开始编辑者接管）
// ② 数据/快照/书目变化时通知其它标签页刷新。不支持 BroadcastChannel 时全部退化为「本标签页说了算」。
const CHANNEL_NAME = 'event-logger:bus';
const HEARTBEAT_MS = 2000;
const STALE_MS = 6000;

export const MSG = {
  claim: 'claim',
  release: 'release',
  heartbeat: 'heartbeat',
  data: 'data',
  snapshots: 'snapshots',
  books: 'books',
};

function randomTabId() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

export function isBusSupported() {
  return typeof BroadcastChannel === 'function';
}

export function createBus(options) {
  const opts = options || {};
  const tabId = opts.tabId || randomTabId();
  const supported = isBusSupported();
  const channel = supported ? new BroadcastChannel(CHANNEL_NAME) : null;
  const claims = {};
  const handlers = new Set();
  let timer = null;

  function emitLocal(type, payload) {
    handlers.forEach((h) => {
      try { h({ type: type, payload: payload || {}, fromSelf: true }); } catch (err) { /* 单个订阅者出错不影响其它 */ }
    });
  }

  function post(type, payload) {
    if (!channel) { return; }
    try { channel.postMessage(Object.assign({ type: type, tabId: tabId }, payload || {})); } catch (err) { /* 通道已关闭 */ }
  }

  function mine(bookId) {
    const claim = claims[bookId];
    return !!claim && claim.tabId === tabId;
  }

  function isWriter(bookId) {
    if (!supported) return true;
    const claim = claims[bookId];
    return !claim || claim.tabId === tabId;
  }

  function writerTab(bookId) {
    const claim = claims[bookId];
    return claim ? claim.tabId : null;
  }

  function startTimer() {
    if (timer || !supported) return;
    timer = setInterval(() => {
      const now = Date.now();
      Object.keys(claims).forEach((bookId) => {
        if (mine(bookId)) post(MSG.heartbeat, { bookId: bookId });
        else if (now - claims[bookId].at > STALE_MS) { delete claims[bookId]; emitLocal(MSG.books, {}); }
      });
      if (!Object.keys(claims).length) { clearInterval(timer); timer = null; }
    }, HEARTBEAT_MS);
  }

  function claim(bookId) {
    if (!supported || !bookId) return;
    if (mine(bookId)) { claims[bookId].at = Date.now(); return; }
    claims[bookId] = { tabId: tabId, at: Date.now() };
    post(MSG.claim, { bookId: bookId });
    startTimer();
    emitLocal(MSG.claim, { bookId: bookId });
  }

  function release(bookId) {
    if (!supported || !bookId) return;
    if (!mine(bookId)) return;
    delete claims[bookId];
    post(MSG.release, { bookId: bookId });
    emitLocal(MSG.release, { bookId: bookId });
  }

  if (channel) {
    channel.onmessage = (event) => {
      const msg = event.data;
      if (!msg || msg.tabId === tabId) return;
      const bookId = msg.bookId;
      if (msg.type === MSG.claim && bookId) {
        const current = claims[bookId];
        const theirsWins = !current
          || current.tabId === tabId
          || msg.at > current.at
          || (msg.at === current.at && String(msg.tabId) > String(current.tabId));
        if (!theirsWins) return;
        claims[bookId] = { tabId: msg.tabId, at: msg.at || Date.now() };
        emitLocal(MSG.claim, { bookId: bookId });
        return;
      }
      if (msg.type === MSG.release && bookId) {
        if (claims[bookId] && claims[bookId].tabId === msg.tabId) {
          delete claims[bookId];
          emitLocal(MSG.release, { bookId: bookId });
        }
        return;
      }
      if (msg.type === MSG.heartbeat && bookId) {
        if (claims[bookId] && claims[bookId].tabId === msg.tabId) claims[bookId].at = Date.now();
        return;
      }
      emitLocal(msg.type, msg.payload || {});
    };
  }

  function broadcast(type, payload) {
    post(type, payload);
    emitLocal(type, payload);
  }

  function on(handler) {
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  function destroy() {
    if (timer) { clearInterval(timer); timer = null; }
    Object.keys(claims).forEach((bookId) => release(bookId));
    handlers.clear();
    if (channel) { try { channel.close(); } catch (err) { /* noop */ } }
  }

  return {
    tabId: tabId,
    supported: supported,
    isWriter: isWriter,
    writerTab: writerTab,
    claim: claim,
    release: release,
    broadcast: broadcast,
    on: on,
    destroy: destroy,
  };
}