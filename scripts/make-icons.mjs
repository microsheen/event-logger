// 生成 PWA 图标：把 public/favicon.svg 的图形栅格化成 PNG，零第三方依赖（只用 node:zlib）。
// 用法：node scripts/make-icons.mjs   （改完 favicon.svg 重跑一次，产物一并提交）
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'icons');
const VIEW = 64;          // favicon.svg 的 viewBox 边长，一切几何都在这个「单位空间」里算
const SS = 4;             // 每像素 4x4 超采样
const MASKABLE_SCALE = 0.78; // 收进 maskable 安全圆（直径 80%）：外接矩形对角 54.6 * 0.78 ≈ 42.6 < 51.2

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: None
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function rgbOf(color) {
  const m = color.replace('#', '');
  return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
}

// 图形与 favicon.svg 同源：直接读它的 <rect> 列表，第一个是底板
function loadShapes() {
  const svg = readFileSync(resolve(here, '..', 'public', 'favicon.svg'), 'utf8');
  // 必须排除前导字母：否则 rx="14" 会被当成 x="14"、width 会被当成 id=...
  const attr = (attrs, name) => {
    const m = new RegExp('(?<![A-Za-z-])' + name + '="([^"]*)"').exec(attrs);
    return m ? m[1] : null;
  };
  const num = (attrs, name, fallback) => {
    const v = attr(attrs, name);
    if (v === null) {
      if (fallback === undefined) throw new Error(`favicon.svg: <rect> 缺 ${name}`);
      return fallback;
    }
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`favicon.svg: ${name}="${v}" 不是数字`);
    return n;
  };
  return [...svg.matchAll(/<rect\b([^>]*?)\/>/g)].map(m => ({
    x: num(m[1], 'x', 0), y: num(m[1], 'y', 0),
    w: num(m[1], 'width'), h: num(m[1], 'height'),
    rx: num(m[1], 'rx', 0), fill: rgbOf(attr(m[1], 'fill')),
  }));
}

function inside(px, py, s) {
  if (px < s.x || py < s.y || px >= s.x + s.w || py >= s.y + s.h) return false;
  const r = Math.min(s.rx, s.w / 2, s.h / 2);
  if (r <= 0) return true;
  let cx = null, cy = null;
  if (px < s.x + r) cx = s.x + r; else if (px > s.x + s.w - r) cx = s.x + s.w - r;
  if (py < s.y + r) cy = s.y + r; else if (py > s.y + s.h - r) cy = s.y + s.h - r;
  if (cx === null || cy === null) return true;
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function coverage(px, py, s) {
  let hit = 0;
  for (let j = 0; j < SS; j++) {
    for (let i = 0; i < SS; i++) {
      if (inside(px + (i + 0.5) / SS, py + (j + 0.5) / SS, s)) hit++;
    }
  }
  return hit / (SS * SS);
}

function render(size, { maskable }) {
  const all = loadShapes();
  const base = all[0], glyph = all.slice(1);
  const k = size / VIEW;                 // 单位 → 像素
  const scale = maskable ? MASKABLE_SCALE : 1;
  const center = VIEW / 2;
  // maskable：图形按中心缩放收进安全圆；底板满铺，不留透明边
  const shrink = (s) => ({
    x: center + (s.x - center) * scale, y: center + (s.y - center) * scale,
    w: s.w * scale, h: s.h * scale, rx: s.rx * scale, fill: s.fill,
  });
  const shapes = maskable
    ? [{ x: 0, y: 0, w: VIEW, h: VIEW, rx: 0, fill: base.fill }, ...glyph.map(shrink)]
    : [base, ...glyph.map(shrink)];
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ux = (x + 0.5) / k, uy = (y + 0.5) / k;
      let r = 0, g = 0, b = 0, a = 0;
      for (const s of shapes) {
        const cover = coverage(ux, uy, s);
        if (cover <= 0) continue;
        const na = cover + a * (1 - cover);
        r = (s.fill[0] * cover + r * a * (1 - cover)) / na;
        g = (s.fill[1] * cover + g * a * (1 - cover)) / na;
        b = (s.fill[2] * cover + b * a * (1 - cover)) / na;
        a = na;
      }
      const o = (y * size + x) * 4;
      rgba[o] = Math.round(r); rgba[o + 1] = Math.round(g);
      rgba[o + 2] = Math.round(b); rgba[o + 3] = Math.round(a * 255);
    }
  }
  return encodePNG(size, rgba);
}

mkdirSync(outDir, { recursive: true });
for (const [name, size, maskable] of [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-192.png', 192, true],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true],
]) {
  const png = render(size, { maskable });
  writeFileSync(resolve(outDir, name), png);
  console.log(name, size + 'px', (png.length / 1024).toFixed(1) + ' kB');
}