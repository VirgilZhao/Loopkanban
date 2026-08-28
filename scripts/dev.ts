/**
 * 开发入口：`pnpm run dev`。
 *
 * 起两个进程 —— vite 管前端，host 管 API 与执行器 —— 但只给用户**一个** URL：
 * host 把非 `/api` 的请求（含 HMR 的 WebSocket）反代给 vite。
 *
 * 为什么不直接开 vite 的 5273：token 是 httpOnly cookie，走同一个 origin
 * 才能让开发时的鉴权路径和发布后完全一致，不必为 dev 单开一条后门。
 *
 * 顺带堵掉一个很难自己发现的坑：以前 `dev` 直接托管 `packages/web/dist`，
 * 那份产物只有跑 `build:web` 才更新，于是改完前端源码界面纹丝不动，
 * 甚至能看到早就删掉的东西。现在开发时根本不读它。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** vite 的端口，与 packages/web/vite.config.ts 里的 `server.port` 对齐。 */
const VITE_PORT = 5273
/** host 的默认端口。发布版用随机端口，但开发时它要写进 vite 的 HMR 配置，得先定下来。 */
const DEFAULT_HOST_PORT = 7373

const passthrough = process.argv.slice(2)

/** 取用户自己指定的 --port；没有就用固定的开发端口。 */
function hostPort(): number {
  const at = passthrough.indexOf('--port')
  const parsed = at < 0 ? Number.NaN : Number.parseInt(passthrough[at + 1] ?? '', 10)
  return Number.isFinite(parsed) ? parsed : DEFAULT_HOST_PORT
}

/** 等一个本地端口开始接受连接。 */
async function waitForPort(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port })
      const done = (value: boolean): void => { socket.destroy(); resolve(value) }
      socket.once('connect', () => { done(true) })
      socket.once('error', () => { done(false) })
    })
    if (ok) return
    if (Date.now() > deadline) throw new Error(`等 127.0.0.1:${String(port)} 超时，vite 没起来`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

const port = hostPort()

// vite 的启动横幅里那个 5273 的地址是**不能用**的（没有 token，也没有 API），
// 打出来只会误导人去点它。压到 warn，让 host 打印的那一个 URL 成为唯一答案。
const vite: ChildProcess = spawn(
  'pnpm',
  ['--filter', '@openkanban/web', 'exec', 'vite', '--logLevel', 'warn'],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, OPENKANBAN_HMR_CLIENT_PORT: String(port) },
    shell: process.platform === 'win32',
  },
)

let host: ChildProcess | undefined

/** 收摊。两个进程互为对方的意义，任何一个走了另一个都没必要留着。 */
let shuttingDown = false
function shutdown(code: number): void {
  if (shuttingDown) return
  shuttingDown = true
  vite.kill('SIGTERM')
  host?.kill('SIGTERM')
  process.exitCode = code
}

vite.on('error', (error) => {
  console.error(`  ✗ 起 vite 失败：${error.message}`)
  shutdown(1)
})
vite.on('exit', (code) => { shutdown(code ?? 0) })

process.on('SIGINT', () => { shutdown(0) })
process.on('SIGTERM', () => { shutdown(0) })

try {
  await waitForPort(VITE_PORT)
} catch (error) {
  console.error(`  ✗ ${error instanceof Error ? error.message : String(error)}`)
  shutdown(1)
  process.exit(1)
}
if (shuttingDown) process.exit(process.exitCode ?? 1)

host = spawn(
  process.execPath,
  [
    '--experimental-strip-types',
    join(ROOT, 'packages/host/src/bin/openkanban.ts'),
    '--web-dev', `http://127.0.0.1:${String(VITE_PORT)}`,
    '--port', String(port),
    ...passthrough,
  ],
  { cwd: process.cwd(), stdio: 'inherit' },
)
host.on('error', (error) => {
  console.error(`  ✗ 起 host 失败：${error.message}`)
  shutdown(1)
})
host.on('exit', (code) => { shutdown(code ?? 0) })
