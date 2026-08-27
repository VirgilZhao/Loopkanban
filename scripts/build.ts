/**
 * 打包发布产物。
 *
 * 开发时 `core` 与 `host` 直接跑在 `node --experimental-strip-types` 上，
 * 没有构建步骤。但**发布版必须编译成 JS**：`bin` 脚本的 shebang 里没法可靠地
 * 塞进 `--experimental-strip-types`，而要求每个用户自己带上这个 flag 是不现实的。
 *
 * 产物结构：
 *   dist/openkanban.js   单文件 ESM，core + host 全部内联
 *   dist/web/            前端静态资源
 */

import { build } from 'esbuild'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'dist')

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { version: string }

await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })

const result = await build({
  entryPoints: [join(ROOT, 'packages/host/src/bin/openkanban.ts')],
  outfile: join(OUT, 'openkanban.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  // node:sqlite 等内置模块由 platform:node 自动外置；除此之外全部内联，
  // 这样发布包不带任何运行时依赖，`npx` 冷启动只需下载一个文件。
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
  define: { 'process.env.OPENKANBAN_VERSION': JSON.stringify(pkg.version) },
  metafile: true,
  logLevel: 'warning',
})

// 前端产物随包分发；host 启动时从这里托管。
await cp(join(ROOT, 'packages/web/dist'), join(OUT, 'web'), { recursive: true })

const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0)
await writeFile(join(OUT, '.build-info'), `${pkg.version}\n${String(bytes)}\n`, 'utf8')
console.log(`✓ dist/openkanban.js  ${(bytes / 1024).toFixed(0)} KB`)
console.log(`✓ dist/web/`)
