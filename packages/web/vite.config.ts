import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/** 开发时前端跑在 5273，API 转发给 host server。 */
const apiTarget = process.env['OPENKANBAN_API'] ?? 'http://127.0.0.1:7373'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  // 产物由 host server 直接托管，所以用相对路径。
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5273,
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
  },
})
