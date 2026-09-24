import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
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