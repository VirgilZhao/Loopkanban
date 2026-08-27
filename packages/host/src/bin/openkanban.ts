/**
 * OpenKanban 启动入口。
 *
 *   node --experimental-strip-types packages/host/src/bin/openkanban.ts [--port N] [--no-open]
 *
 * 起本地 server、探测本机 Agent CLI、打开浏览器。全程零 API Key ——
 * 所有模型访问都发生在 claude / codex 子进程内部，用你自己的登录态。
 */

import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asBoardId, asTaskId, type Task } from '@openkanban/core'
import { detectAgents } from '../agents/index.ts'
import { startServer } from '../server/index.ts'
import { Storage } from '../storage/index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 前端产物目录：packages/host/src/bin → packages/web/dist */
const STATIC_DIR = resolve(HERE, '../../../web/dist')

const C = {
  dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[38;5;214m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`)
  return at < 0 ? undefined : process.argv[at + 1]
}

/** 数据目录，遵循各平台惯例。 */
function dataDir(): string {
  const home = homedir()
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'openkanban')
  if (process.platform === 'win32') return join(process.env['APPDATA'] ?? home, 'openkanban')
  return join(process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'), 'openkanban')
}

/** 首次启动时放几张示例卡，免得看板空着无从下手。 */
function seed(storage: Storage, repoPath: string): void {
  if (storage.listBoards().length > 0) return
  const now = Date.now()
  const boardId = asBoardId('board-default')
  storage.createBoard({ id: boardId, name: '默认看板', repoPath, baseBranch: 'main', createdAt: now })

  const samples: { id: string; column: Task['column']; subject: string; acceptance: string[] }[] = [
    {
      id: 't-welcome', column: 'backlog',
      subject: '把这张卡补上验收标准，它就能进 Ready 了',
      acceptance: [],
    },
    {
      id: 't-sample-1', column: 'ready',
      subject: '给 utils 补上边界情况的单测',
      acceptance: ['新增测试覆盖空输入与超长输入', '现有测试全部通过'],
    },
    {
      id: 't-sample-2', column: 'ready',
      subject: '修掉列表页在空数据时的崩溃',
      acceptance: ['空数据时渲染占位而不是抛错', '有回归测试'],
    },
  ]
  for (const [index, sample] of samples.entries()) {
    storage.createTask({
      id: asTaskId(sample.id), boardId, revision: 1,
      column: sample.column, position: index + 1,
      subject: sample.subject, description: '',
      acceptance: sample.acceptance,
      repoPath, baseBranch: 'main',
      blockedBy: [], writeScopes: [],
      createdAt: now, updatedAt: now,
    })
  }
}

/** 打开浏览器。失败不影响 server 运行，只是少了个便利。 */
function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
    : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).unref()
  } catch {
    // 无头环境下打不开浏览器是正常的，URL 已经打印出来了。
  }
}

async function main(): Promise<void> {
  const dir = dataDir()
  await mkdir(dir, { recursive: true })
  const storage = Storage.open(join(dir, 'openkanban.db'))
  seed(storage, process.cwd())

  console.log(C.bold('\n  OPENKANBAN') + C.dim('  agent dispatch\n'))

  // ── 探测本机 CLI ─────────────────────────────────────────
  const agents = await detectAgents()
  if (agents.length === 0) {
    console.log(`  ${C.red('✗')} 未探测到任何 Agent CLI（claude / codex）`)
    console.log(C.dim('    装好其中之一再来，任务需要它们来执行。\n'))
  }
  for (const { provider, caps } of agents) {
    const missing = [
      caps.streaming ? null : '无流式',
      caps.canResume ? null : '无续跑',
    ].filter((x) => x !== null)
    console.log(
      `  ${C.green('●')} ${C.bold(provider.id.padEnd(8))} ${caps.version.padEnd(24)}`
      + C.dim(caps.bin)
      + (missing.length > 0 ? ` ${C.amber(missing.join(' '))}` : ''),
    )
  }

  // ── 起 server ────────────────────────────────────────────
  const portArg = flag('port')
  const server = await startServer({
    storage,
    agents,
    staticDir: STATIC_DIR,
    ...(portArg === undefined ? {} : { port: Number.parseInt(portArg, 10) }),
  })

  console.log(`\n  ${C.amber('▸')} ${server.url}`)
  console.log(C.dim('    只监听 127.0.0.1。远程访问请用 SSH 端口转发，不要改成 0.0.0.0。'))
  console.log(C.dim(`    数据 ${join(dir, 'openkanban.db')}\n`))

  if (!process.argv.includes('--no-open')) openBrowser(server.url)

  const shutdown = (): void => {
    console.log(C.dim('\n  正在关闭 …'))
    void server.close().then(() => {
      storage.close()
      process.exit(0)
    })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

await main()
