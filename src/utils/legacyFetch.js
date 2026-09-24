// 只在开发用的一次性导入通道：向本地 server.js 询问「这台电脑上还有没有 data.json」。
// 公网部署（Cloudflare Pages）没有这个接口，也没有 localhost，探测会安静地失败。
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

export function isLocalHost() {
  try {
    return LOCAL_HOSTS.indexOf(window.location.hostname) !== -1;
  } catch (err) {
    return false;
  }
}

// 返回 null 表示「没有可导入的本机旧数据」，调用方据此隐藏入口；抛错才提示失败
export async function fetchLegacyData() {
  if (!isLocalHost()) return null;
  let res;
  try {
    res = await fetch('/api/legacy-data', { credentials: 'same-origin' });
  } catch (err) {
    return null;
  }
  if (res.status === 404 || res.status === 403 || res.status === 405) return null;
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = await res.text();
  if (!text) return null;
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object') return null;
  if (!Array.isArray(parsed.events) && !Array.isArray(parsed.books)) return null;
  return parsed;
}
