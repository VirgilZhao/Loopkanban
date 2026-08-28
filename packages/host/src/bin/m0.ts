/**
 * M0 编排穿刺脚本（无 UI）。
 *
 * 判据：命令行能让**本机安装的** CLI 在独立 worktree 分支上做完一张卡，
 * 全程零 API Key，且能随时 kill 干净。
 *
 *   node --experimental-strip-types packages/host/src/bin/m0.ts [--provider claude|codex|opencode]
 */

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { capture } from '../agents/discover.ts'
import { scrubEnv } from '../agents/env.ts'
import { detectAgents, type DetectedAgent } from '../agents/index.ts'
import { claudeUsage } from '../agents/providers/claude-cli.ts'
import type { RunContext } from '../agents/types.ts'
import { spawnProcess } from '../subprocess/index.ts'
import { branchSlug, createWorktree, worktreeDiff } from '../worktree/index.ts'

const TASK = {
  id: 'task-1',
  subject: '加一个 greet 函数',
  prompt: [
    '请在仓库根目录创建 greet.js，导出一个 greet(name) 函数，返回 `Hello, ${name}!`。',
    '同时创建 greet.test.js，用 node:test 和 node:assert 写一个断言 greet("loopkanban") 的用例。',
    '只做这件事，不要改动其他文件。完成后简短说明你做了什么。',
  ].join('\n'),
}

const C = {
  dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
}

function log(label: string, detail = ''): void {
  console.log(`${C.cyan('▸')} ${label}${detail === '' ? '' : ` ${detail}`}`)
}

/** 建一个临时 git 仓库当作被操作的目标项目。 */
async function scratchRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'loopkanban-m0-'))
  const repo = join(dir, 'repo')
  await mkdir(repo, { recursive: true })
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.email', 'm0@loopkanban.local'],
    ['config', 'user.name', 'LoopKanban M0'],
  ]) {
    await capture(['git', '-C', repo, ...args])
  }
  await writeFile(join(repo, 'README.md'), '# scratch\n', 'utf8')
  await capture(['git', '-C', repo, 'add', '-A'])
  await capture(['git', '-C', repo, 'commit', '-qm', 'initial'])
  return repo
}

function describeCaps({ provider, caps }: DetectedAgent): void {
  console.log(`  ${C.bold(provider.id)}  ${caps.bin}`)
  console.log(`    版本        ${caps.version}`)
  console.log(`    流式输出    ${caps.streaming ? '支持' : '不支持（降级为一次性输出）'}`)
  console.log(`    指定会话id  ${caps.canPinSessionId ? '支持' : '不支持（会话 id 从输出里捞）'}`)
  console.log(`    续跑        ${caps.canResume ? '支持' : '不支持（打回只能重开任务）'}`)
  console.log(`    权限档位    ${caps.permissionTiers.join(', ') || '（未探测到）'}`)
  if (caps.permissionCaveat !== undefined) {
    console.log(`    ${C.yellow('权限警示')}    ${C.yellow(caps.permissionCaveat.label)} —— ${caps.permissionCaveat.detail}`)
  }
}

async function main(): Promise<void> {
  const wanted = process.argv.includes('--provider')
    ? process.argv[process.argv.indexOf('--provider') + 1]
    : undefined

  // ── 1. 探测本机 CLI ─────────────────────────────────────────────
  log('探测本机 Agent CLI …')
  const detected = await detectAgents()
  if (detected.length === 0) {
    console.error(C.red('本机没有找到任何可用的 Agent CLI（claude / codex / opencode）。请先安装其一。'))
    process.exitCode = 1
    return
  }
  for (const agent of detected) describeCaps(agent)

  const chosen = wanted === undefined
    ? detected[0]
    : detected.find((d) => d.provider.id === wanted)
  if (chosen === undefined) {
    console.error(C.red(`没有探测到 provider "${String(wanted)}"。可用：${detected.map((d) => d.provider.id).join(', ')}`))
    process.exitCode = 1
    return
  }
  const { provider, caps } = chosen
  log('本次使用', C.bold(provider.id))

  // ── 2. 准备仓库与隔离 worktree ──────────────────────────────────
  const repo = await scratchRepo()
  const branch = branchSlug(TASK.id, TASK.subject)
  const worktree = await createWorktree(repo, join(repo, '..', 'worktrees'), TASK.id, branch, 'main')
  log('worktree', `${worktree.path}  ${C.dim(`(分支 ${worktree.branch})`)}`)

  const artifactsDir = join(repo, '..', 'artifacts')
  await mkdir(artifactsDir, { recursive: true })
  await writeFile(join(worktree.path, 'TASK.md'), `# ${TASK.subject}\n\n${TASK.prompt}\n`, 'utf8')

  // ── 3. 起 CLI 子进程 ────────────────────────────────────────────
  const run: RunContext = {
    runId: 'run-1',
    worktreePath: worktree.path,
    artifactsDir,
    prompt: TASK.prompt,
    permission: 'standard',
    ...(caps.canPinSessionId ? { sessionId: randomUUID() } : {}),
  }
  const spec = provider.buildStart(run, caps)
  log('argv', JSON.stringify(spec.argv.map((a) => (a === TASK.prompt ? '<prompt>' : a))))

  const scrub = scrubEnv(process.env, run.envOverrides)
  if (scrub.removed.length > 0) {
    log('已清洗环境', C.dim(`${String(scrub.removed.length)} 个变量：${scrub.removed.join(' ')}`))
  }
  if (scrub.endpoints.length > 0) {
    log('保留的端点变量', C.dim(scrub.endpoints.join(' ')))
  }

  const rawLines: string[] = []
  const started = Date.now()
  const handle = await spawnProcess({ ...spec, graceMs: 3_000 })

  // stderr 必须有人读：CLI 的参数错误、鉴权提示都在这里，
  // 之前只 pipe 不读，一个 exit=2 的硬失败在界面上完全看不见。
  const stderrChunks: Buffer[] = []
  handle.stderr?.on('data', (chunk: Buffer) => { stderrChunks.push(chunk) })
  log('已启动', `pid=${String(handle.pid)}  ${C.dim('Ctrl-C 可随时终止，会连同整棵进程树一起收掉')}`)

  const onSigint = (): void => {
    console.log('\n收到 Ctrl-C，正在终止整棵进程树 …')
    void handle.terminate().then((o) => {
      console.log(`已终止 signal=${String(o.signal)} 树已静默=${String(o.treeQuiesced)}`)
      process.exit(130)
    })
  }
  process.on('SIGINT', onSigint)

  console.log(`\n${C.dim('──── Agent 事件流 ────')}`)
  let sessionId: string | undefined
  let finishedOk: boolean | undefined
  const toolCounts = new Map<string, number>()

  for await (const line of createInterface({ input: handle.stdout })) {
    rawLines.push(line)
    const event = provider.parseLine(line, caps)
    switch (event.kind) {
      case 'session':
        sessionId = event.sessionId
        console.log(`${C.magenta('[session]')} ${event.sessionId}`)
        if (event.model !== undefined || event.apiKeySource !== undefined) {
          console.log(C.dim(`          model=${event.model ?? '?'} permissionMode=${event.permissionMode ?? '?'} apiKeySource=${event.apiKeySource ?? '?'}`))
        }
        if (event.apiKeySource !== undefined && event.apiKeySource !== 'none') {
          console.log(C.yellow(`          注意：CLI 报告 apiKeySource=${event.apiKeySource}，本项目要求全程零 API Key`))
        }
        break
      case 'notice':
        console.log(`${C.yellow('[notice]')} ${event.text}`)
        break
      case 'text':
        console.log(`${C.green('[text]')} ${event.text.slice(0, 300)}`)
        break
      case 'tool':
        toolCounts.set(event.name, (toolCounts.get(event.name) ?? 0) + 1)
        console.log(`${C.yellow('[tool]')} ${event.name}`)
        break
      case 'usage':
        console.log(C.dim(`[usage] in=${String(event.inputTokens)} out=${String(event.outputTokens)}${event.costUsd === undefined ? '' : ` cost=$${String(event.costUsd)}`}`))
        break
      case 'finished': {
        finishedOk = event.ok
        const tag = event.ok ? C.green('[finished]') : C.red('[finished]')
        console.log(`${tag} ok=${String(event.ok)} ${event.summary?.slice(0, 300) ?? ''}`)
        if (event.diagnostic !== undefined) console.log(C.red(`          诊断: ${event.diagnostic}`))
        if (!event.ok && (event.summary ?? '').includes('OAuth')) {
          console.log(C.yellow('          → 这是 CLI 侧的登录态过期，不是 LoopKanban 的问题。请先重新登录。'))
        }
        const usage = provider.id === 'claude' ? claudeUsage(line) : null
        if (usage?.kind === 'usage') {
          console.log(C.dim(`[usage] in=${String(usage.inputTokens)} out=${String(usage.outputTokens)} cost=$${String(usage.costUsd)}`))
        }
        break
      }
      default:
        if (line.trim().length > 0) console.log(C.dim(`[raw] ${line.slice(0, 140)}`))
        break
    }
  }

  const outcome = await handle.exited
  process.off('SIGINT', onSigint)
  console.log(`${C.dim('──── 结束 ────')}\n`)

  const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim()
  if (stderrText.length > 0) {
    console.log(C.red('──── stderr ────'))
    console.log(stderrText.slice(0, 2000))
    console.log('')
  }

  await writeFile(join(artifactsDir, 'run-1.log'), rawLines.join('\n'), 'utf8')
  if (stderrText.length > 0) await writeFile(join(artifactsDir, 'run-1.stderr.txt'), stderrText, 'utf8')

  // ── 4. 结果 ────────────────────────────────────────────────────
  log('退出', `code=${String(outcome.code)} signal=${String(outcome.signal)} 树已静默=${String(outcome.treeQuiesced)} 耗时=${String(Date.now() - started)}ms`)
  if (sessionId !== undefined) log('会话 id', `${sessionId} ${C.dim('（可用于续跑）')}`)
  if (toolCounts.size > 0) log('工具调用', [...toolCounts].map(([n, c]) => `${n}×${String(c)}`).join('  '))

  const diff = await worktreeDiff(worktree, 'main')
  const changed = diff.trim().length > 0
  console.log(`\n${C.dim('──── worktree diff（相对 main）────')}`)
  console.log(changed ? diff.slice(0, 4000) : '(无改动)')

  // ── 5. 判据 ────────────────────────────────────────────────────
  console.log(`\n${C.bold('M0 判据')}`)
  const checks: [string, boolean][] = [
    ['探测到本机 CLI 并解析出能力', true],
    ['在独立 worktree 分支上执行', true],
    ['进程退出且整棵树静默', outcome.treeQuiesced],
    ['退出码为 0', outcome.code === 0],
    ['CLI 报告执行成功', finishedOk === true || (finishedOk === undefined && outcome.code === 0)],
    ['Agent 真的改了文件（TASK.md 之外）', /^\s*(?!TASK\.md)\S+\s+\|/m.test(diff)],
  ]
  for (const [name, ok] of checks) console.log(`  ${ok ? C.green('✓') : C.red('✗')} ${name}`)
  if (!checks.every(([, ok]) => ok)) process.exitCode = 1

  log('原始日志', join(artifactsDir, 'run-1.log'))
  log('临时仓库', repo)
}

await main()
