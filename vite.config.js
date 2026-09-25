import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// 构建号：每次 build 生成「git 短 sha + 构建时刻 + 是否有未提交改动」，例 1416a951-20260925211603+。
// 为什么必须有：shell 被 Service Worker 预缓存，重新构建后「已经打开的页面」仍在跑上一次 build 的 bundle，
// 于是「修好了」和「没修好」在肉眼看来一模一样。页面自报构建号，一眼就能判定是哪一种。
function gitOut(args) {
  try {
    return execSync('git ' + args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (err) {
    return ''; // 没有 git（或拿不到）时退化成纯时间戳
  }
}

function resolveBuildId() {
  const sha = gitOut('rev-parse --short=8 HEAD') || 'dev';
  const dirty = gitOut('status --porcelain') ? '+' : '';
  const p2 = (n) => (n < 10 ? '0' + n : String(n));
  const now = new Date();
  const stamp = String(now.getFullYear()) + p2(now.getMonth() + 1) + p2(now.getDate()) + p2(now.getHours()) + p2(now.getMinutes()) + p2(now.getSeconds());
  return sha + '-' + stamp + dirty;
}

const buildId = resolveBuildId();
console.log('[build] BUILD_ID = ' + buildId);

export default defineConfig({
  // define 是构建期文本替换：源码里的 __BUILD_ID__ 会变成实际字符串（唯一出口 src/buildInfo.js）。
  // 口径固定为 (sha8|dev)-yyyymmddHHMMSS[+]，smoke 第 1 步就是按这个格式断言的。
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  plugins: [
    react(),
    VitePWA({
      // autoUpdate：新版本上线后下一次访问直接换新，不做「有更新请手动刷新」这种打扰。
      // 数据全在 IndexedDB 里，换 shell 不会动用户数据。
      registerType: 'autoUpdate',
      // 'script' 会生成独立的 /registerSW.js 并用 <script src> 引入；'inline' 往 index.html 里塞
      // 第二段内联脚本，那是 CSP script-src 'self' + sha256 不允许的（npm run csp:check 会直接报错）。
      injectRegister: 'script',

      includeAssets: ['favicon.svg', 'robots.txt', 'icons/apple-touch-icon.png'],
      manifest: {
        name: '每日事件记录器',
        short_name: 'Event Logger',
        description: '按周记录每日事件的轻量工具，数据只存在你自己的浏览器里。',
        lang: 'zh-CN',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f5f6fa',
        theme_color: '#6c5ce7',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,txt,webmanifest}'],
        // /api/legacy-data 是本机旧数据的只读探测口，永远不该被缓存
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
  server: {
    port: 5173,
    open: true,
    proxy: {
      // 端口和 server.js / start.bat 三处硬编码在一起，改一处要全改
      '/api': 'http://localhost:3002'
    }
  }
})