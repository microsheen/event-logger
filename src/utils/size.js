// 体积展示：快照大小、配额占比都要能一眼看懂，单位随语言切换
const UNITS = ['B', 'KB', 'MB', 'GB'];

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return n + ' B';
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return value.toFixed(digits) + ' ' + UNITS[unit];
}

export function formatPercent(ratio) {
  const n = Number(ratio);
  if (!Number.isFinite(n) || n <= 0) return '0%';
  if (n < 0.001) return '<0.1%';
  return (n * 100).toFixed(n >= 0.1 ? 0 : 1) + '%';
}
