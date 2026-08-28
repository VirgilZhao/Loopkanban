import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/** 开发时前端跑在 5273，API 转发给 host server。 */
const apiTarget = process.env['LOOPKANBAN_API'] ?? 'http://127.0.0.1:7373'

/**
 * `pnpm run dev` 时浏览器开的是 host 的端口，vite 只在背后被反代（见
 * scripts/dev.ts）。HMR 的 WebSocket 由页面自己发起，因此它要连的是 host
 * 那个端口，不是 vite 的 —— 不告诉它就会连回 5273，页面能开但永远不刷新。
 */
const hmrClientPort = Number.parseInt(process.env['LOOPKANBAN_HMR_CLIENT_PORT'] ?? '', 10)

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  // 产物由 host server 直接托管，所以用相对路径。
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    // 显式绑 IPv4 回环。不写的话 vite 只监听 [::1]，而 host 的反代与
    // scripts/dev.ts 的探活都走 127.0.0.1，两边就永远碰不上头。
    host: '127.0.0.1',
    port: 5273,
    // 换个端口就意味着 scripts/dev.ts 反代到了一个空地址，宁可起不来也别静默漂移。
    strictPort: true,
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
    ...(Number.isFinite(hmrClientPort) ? { hmr: { clientPort: hmrClientPort } } : {}),
  },
})
