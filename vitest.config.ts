import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // web 的源码用 `@/` 别名，测试里要能解析。
  resolve: {
    alias: { '@': fileURLToPath(new URL('./packages/web/src', import.meta.url)) },
  },
  test: {
    include: ['packages/*/tests/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
})
