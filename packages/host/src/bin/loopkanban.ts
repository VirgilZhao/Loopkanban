/**
 * LoopKanban 启动入口。
 *
 *   node --experimental-strip-types packages/host/src/bin/loopkanban.ts [--port N] [--no-open]
 *
 * 起本地 server、探测本机 Agent CLI、打开浏览器。全程零 API Key ——
 * 所有模型访问都发生在 Agent CLI 子进程内部，用你自己的登录态。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asProjectId, asTaskId, type Task } from '@loopkanban/core'
import { AttachmentStore } from '../attachments/index.ts'
import { DecisionHub } from '../decisions/index.ts'
import { discoverBoard, serveMcp } from '../mcp/index.ts'
import { createToken } from '../server/auth.ts'
import { clearEndpoint, writeEndpoint } from '../server/endpoint.ts'
import { AgentPool, detectAgents, knownCommands, type DetectedAgent } from '../agents/index.ts'
import { RunBus } from '../server/bus.ts'
import { startServer } from '../server/index.ts'
import { Review } from '../review/index.ts'
import { Runner } from '../runner/index.ts'
import { Scheduler } from '../scheduler/index.ts'
import { installService, planService, uninstallService, type ServicePlan } from '../service/index.ts'
import { Storage } from '../storage/index.ts'
import { TestEnvs } from '../testenv/index.ts'
import { loadModelCatalog, mergeModels } from '../agents/models-dev.ts'
import { detectBaseBranch } from '../worktree/index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 前端产物目录。两种布局都要认：
 *   - 开发时  packages/host/src/bin/loopkanban.ts → packages/web/dist
 *   - 发布后  dist/loopkanban.js                  → dist/web
 */
function staticDir(): string | undefined {
  for (const candidate of [resolve(HERE, 'web'), resolve(HERE, '../../../web/dist')]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate
  }
  // 找不到就只提供 API —— 比起装作正常然后给用户一个 404 白页，说清楚更好。
  return undefined
}

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
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'loopkanban')
  if (process.platform === 'win32') return join(process.env['APPDATA'] ?? home, 'loopkanban')
  return join(process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'), 'loopkanban')
}

/**
 * 取得访问 token，持久化在数据目录里。
 *
 * 每次重启都换一个新 token 意味着用户开着的标签页立刻失效、书签永远过期，
 * 而开发时会频繁重启。token 与数据库同处一个目录、同一信任级别，
 * 存起来并把权限收到 0600 是合理的。`--new-token` 可以主动轮换。
 *
 * @param dir - 数据目录。
 * @param rotate - 强制换一个新的。
 */
async function resolveToken(dir: string, rotate: boolean): Promise<string> {
  const path = join(dir, 'token')
  if (!rotate) {
    const existing = await readFile(path, 'utf8').catch(() => null)
    if (existing !== null && existing.trim().length >= 32) return existing.trim()
  }
  const token = createToken()
  await writeFile(path, token, { encoding: 'utf8', mode: 0o600 })
  // 已存在的文件不会被 writeFile 的 mode 改动，显式收一次权限。
  await chmod(path, 0o600).catch(() => undefined)
  return token
}

/**
 * 首次启动时放几张示例卡，免得看板空着无从下手。
 *
 * **全部落 Backlog**：示例卡的需求跟用户的仓库毫无关系，如果放在 Ready，
 * 用户第一次打开自动驾驶时它们会被立刻派出去，让 Agent 对着一个陌生仓库
 * 做一堆牛头不对马嘴的活。默认值不该有这种惊吓。
 */
async function seed(storage: Storage, repoPath: string): Promise<void> {
  if (storage.listProjects().length > 0) return
  const now = Date.now()
  const projectId = asProjectId('project-default')
  const baseBranch = await detectBaseBranch(repoPath)
  storage.createProject({
    id: projectId,
    // 目录名就是项目名 —— 用户认得出的是它，不是"默认看板"。
    name: basename(repoPath),
    repoPath,
    baseBranch,
    createdAt: now,
  })

  const samples: { id: string; column: Task['column']; description: string; acceptance: string[] }[] = [
    {
      id: 't-welcome', column: 'backlog',
      description: '把这张卡改成你自己的任务 —— 卡上写什么，Agent 就照着做什么。',
      acceptance: [],
    },
    {
      id: 't-sample-1', column: 'backlog',
      description: '示例：给某个模块补上边界情况的单测',
      acceptance: ['新增测试覆盖空输入与超长输入', '现有测试全部通过'],
    },
    {
      id: 't-sample-2', column: 'backlog',
      description: '示例：验收标准是可选的，但写清楚会让 Agent 和你自己都更好判定做没做完。',
      acceptance: [],
    },
  ]
  for (const [index, sample] of samples.entries()) {
    storage.createTask({
      id: asTaskId(sample.id), projectId, revision: 1,
      column: sample.column, position: index + 1,
      description: sample.description,
      acceptance: sample.acceptance,
      repoPath, baseBranch,
      blockedBy: [], relatedTo: [],
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

const USAGE = `
用法：
  loopkanban [选项]                     起服务并打开浏览器
  loopkanban service <子命令>           开机自启
  loopkanban mcp                        起 MCP server（stdio），让 Agent 用这个看板

选项：
  --port <n>        监听端口，默认随机
  --data <dir>      数据目录，默认按平台惯例
  --no-open         不自动打开浏览器
  --new-token       轮换访问 token
  --web-dev <url>   前端交给该地址的 vite dev server（pnpm run dev 会自动带上）
  --help            显示本帮助

service 子命令：
  print             打印将要写入的服务单元与命令，不做任何改动
  install           安装并启用
  uninstall         停用并删除

mcp：接到 Claude Code / Codex 之类的客户端上，例如
  claude mcp add loopkanban -- loopkanban mcp
它连的是**正在跑的那个看板**（地址与 token 从数据目录里读），所以看板得先起着。
地址不在默认数据目录时给 --data <dir>，或者用 LOOPKANBAN_URL / LOOPKANBAN_TOKEN 直接指。
`

/**
 * 处理 `loopkanban mcp`；返回 true 表示这次调用已经处理完了。
 *
 * **一个字都不能往 stdout 写** —— 那条管道属于 MCP 协议，多一行就把客户端的
 * 解析器打断了。要说话写 stderr。
 *
 * 只认 argv 的第一个位置参数，不像 service 那样在整个 argv 里找：`--data mcp`
 * 这种参数值不该被当成子命令。
 */
async function handleMcp(): Promise<boolean> {
  if (process.argv[2] !== 'mcp') return false
  const dir = flag('data') ?? dataDir()
  try {
    const client = await discoverBoard({
      dataDir: dir,
      url: flag('url') ?? process.env['LOOPKANBAN_URL'],
      token: process.env['LOOPKANBAN_TOKEN'],
    })
    console.error(C.dim(`[loopkanban mcp] 连到 ${client.baseUrl}`))
    await serveMcp({ client })
  } catch (error) {
    // 找不到看板就直说，并且**退出**而不是端着一个每次调用都失败的 server：
    // 客户端会把这条 stderr 连同"启动失败"一起呈现，人才知道该去开看板。
    console.error(C.red(`[loopkanban mcp] ${error instanceof Error ? error.message : String(error)}`))
    process.exitCode = 1
  }
  return true
}

/** 处理 `loopkanban service …`；返回 true 表示这次调用已经处理完了。 */
async function handleService(): Promise<boolean> {
  const at = process.argv.indexOf('service')
  if (at < 0) return false
  const sub = process.argv[at + 1] ?? 'print'

  let plan: ServicePlan
  try {
    const portArg = flag('port')
    plan = planService({
      bin: process.argv[1] ?? '',
      nodePath: process.execPath,
      ...(portArg === undefined ? {} : { port: Number.parseInt(portArg, 10) }),
      ...(flag('data') === undefined ? {} : { dataDir: flag('data') as string }),
    })
  } catch (error) {
    console.error(C.red(`  ${error instanceof Error ? error.message : String(error)}`))
    process.exitCode = 1
    return true
  }

  // 无论装还是卸，都先把要做的事原样打印出来。改动用户机器上的常驻配置,
  // 不该在他看不见的地方发生。
  console.log(`\n  ${C.bold('单元文件')} ${plan.unitPath}\n`)
  console.log(C.dim(plan.unitContent.split('\n').map((l) => `    ${l}`).join('\n')))
  const commands = sub === 'uninstall' ? plan.disableCommands : plan.enableCommands
  console.log(`  ${C.bold('将要执行')}`)
  for (const command of commands) console.log(C.dim(`    ${command.join(' ')}`))

  if (sub === 'print') {
    console.log(C.dim('\n  以上只是预览。`loopkanban service install` 才会真正写入。\n'))
    return true
  }
  if (sub !== 'install' && sub !== 'uninstall') {
    console.error(C.red(`\n  未知子命令 "${sub}"。可用：print / install / uninstall\n`))
    process.exitCode = 1
    return true
  }

  const outcome = sub === 'install' ? await installService(plan) : await uninstallService(plan)
  console.log('')
  for (const step of outcome.ran) {
    const ok = step.code === 0
    console.log(`  ${ok ? C.green('✓') : C.red('✗')} ${step.argv.join(' ')}${ok ? '' : C.dim(` (code=${String(step.code)})`)}`)
  }
  console.log(sub === 'install'
    ? C.dim('\n  已安装。开机自动启动，崩溃自动重启。\n')
    : C.dim('\n  已卸载。\n'))
  return true
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(USAGE)
    return
  }
  if (await handleMcp()) return
  if (await handleService()) return

  // --data 让多个看板/临时试验各用各的库，不污染日常数据。
  const dir = flag('data') ?? dataDir()
  await mkdir(dir, { recursive: true })
  const storage = Storage.open(join(dir, 'loopkanban.db'))
  await seed(storage, process.cwd())

  console.log(C.bold('\n  LOOPKANBAN') + C.dim('  agent dispatch\n'))

  /*
   * ── 探测本机 CLI ─────────────────────────────────────────
   *
   * 探完顺手给自己列不出模型的 CLI 补上清单。补给谁由 provider 自己声明
   * （`catalogSource`），这里不点名 —— 见 agents/models-dev.ts。
   *
   * models.dev 是整个程序**唯一**的对外请求（别处只连 127.0.0.1），所以：
   * 一天最多一次、结果落盘、`--no-models` 可以彻底关掉，取不到就当没这回事
   * 继续跑。界面上点刷新走的也是这条路，那时缓存多半还热着，不会再出网。
   */
  const noModels = process.argv.includes('--no-models')
  const detect = async (): Promise<readonly DetectedAgent[]> => {
    const found = await detectAgents()
    const catalog = noModels ? {} : await loadModelCatalog({ cachePath: join(dir, 'models-dev.json') })
    return found.map((agent) => ({
      ...agent,
      caps: { ...agent.caps, models: mergeModels(agent.caps.models, catalog[agent.provider.id] ?? []) },
    }))
  }

  // 一个池子交给 server / runner / scheduler 共用：界面上刷新一次，三边同时
  // 换成新的探测结果，不必重启。
  const pool = new AgentPool(detect)
  const agents = await pool.refresh()
  if (agents.length === 0) {
    console.log(`  ${C.red('✗')} 未探测到任何 Agent CLI（${knownCommands().join(' / ')}）`)
    console.log(C.dim('    装好其中之一再来，任务需要它们来执行。\n'))
  }
  for (const { provider, caps } of agents) {
    const missing = [
      caps.streaming ? null : '无流式',
      caps.canResume ? null : '无续跑',
      // 档位语义的警示和「少了个能力」同样重要 —— 它关系到 Agent 能动多少东西。
      caps.permissionCaveat?.label ?? null,
    ].filter((x) => x !== null)
    console.log(
      `  ${C.green('●')} ${C.bold(provider.id.padEnd(8))} ${caps.version.padEnd(24)}`
      + C.dim(caps.bin)
      + (caps.models.length > 0 ? C.dim(`  ${String(caps.models.length)} 个模型`) : '')
      + (missing.length > 0 ? ` ${C.amber(missing.join(' '))}` : ''),
    )
  }

  // ── 执行器 ───────────────────────────────────────────────
  const bus = new RunBus()
  // 决策中枢：权限审批与向人提问都走它。runner 与 server 共用一个实例 ——
  // 前者签发 gate 凭据，后者校验与落路由。
  const decisions = new DecisionHub({ storage, bus })
  // server 起来之前 gate 地址是未知的；派活只发生在请求处理里，那时它必有值。
  const gateUrl: { value?: string } = {}
  const runner = new Runner({
    storage, bus, agents: pool,
    artifactsRoot: join(dir, 'runs'),
    decisions,
    gateUrl: () => gateUrl.value,
  })
  // 一键测试环境。进程只活在这个 host 里，不落库 —— 重启之后它们就不在了。
  const testEnvs = new TestEnvs({ storage })
  const review = new Review({
    storage,
    // 动这张卡的 worktree 之前，先把跑在里面的测试环境收掉。挂在这儿而不是
    // 路由上：位置很重要，它得在所有会被拒绝的校验都过完之后才开枪。
    beforeMutate: (taskId) => testEnvs.stop(taskId, 'verdict'),
  })
  // 附件的字节落在数据目录里，跟数据库同处一个信任级别。
  const attachments = new AttachmentStore(join(dir, 'attachments'))
  const scheduler = new Scheduler({ storage, runner, agents: pool })

  // 启动对账：上次进程崩溃时留下的 Run 与卡片在这里被收拾干净。
  //
  // 卡片**不等租约到期**：上一个进程没了，它起的 CLI 也跟着没了，这是查明
  // 的事实，不是猜测。等 90 秒只会让人对着一张不会有任何动静的 Running 卡
  // 干等。收回 Ready 之后，自动认领（开着的话）下一拍就把它接着派出去 ——
  // 同一个 worktree、同一个会话，接着上次干。
  const aborted = runner.reconcile()
  const reclaimed = runner.reclaimAbandoned()
  if (aborted > 0 || reclaimed.length > 0) {
    console.log(C.dim(`\n  对账：${String(aborted)} 个中断的 Run，${String(reclaimed.length)} 张卡放回 Ready 接着跑`))
  }
  // 调度器的每一轮都会回收租约过期的卡片，即使自动认领是关着的 ——
  // 没有它，一次崩溃就会让任务永远卡在 Running。
  scheduler.start()

  /*
   * PR 巡检：问一遍那些还开着的 PR 合上了没有，合上的把卡收进 Done。
   *
   * 必须有一条后台的路径，而不能只靠"打开卡片时刷一下"：人在 GitHub 上按下
   * 合并之后，多半就去干别的了，看板这边不该等到下次有人点开那张卡才发现。
   * 一分钟一轮 —— 再密就是在替用户浪费 GitHub 的额度，而这件事本来就不急。
   * 没装 gh / 没有开着的 PR 时它一次网都不出。
   */
  const prSweep = setInterval(() => {
    void review.syncPullRequests().catch(() => undefined)
  }, 60_000)
  prSweep.unref()

  // ── 起 server ────────────────────────────────────────────
  const portArg = flag('port')
  const token = await resolveToken(dir, process.argv.includes('--new-token'))
  // --web-dev 把前端交给 vite（见 scripts/dev.ts）。此时不碰 packages/web/dist ——
  // 那份产物只在构建时更新，开发时读它就是在看一个过期的界面。
  const webDev = flag('web-dev')
  const assets = webDev === undefined ? staticDir() : undefined
  if (webDev === undefined && assets === undefined) {
    console.log(C.red('  ✗ 找不到前端产物，本次只提供 API。'))
    console.log(C.dim('    从源码运行时用 `pnpm run dev`，或先跑 `pnpm run build:web`。\n'))
  }
  const server = await startServer({
    storage,
    agents: pool,
    runner,
    review,
    attachments,
    scheduler,
    testEnvs,
    decisions,
    bus,
    token,
    ...(webDev === undefined ? {} : { devServer: webDev }),
    ...(assets === undefined ? {} : { staticDir: assets }),
    ...(portArg === undefined ? {} : { port: Number.parseInt(portArg, 10) }),
  })
  // 从此刻起派活的执行都能接上 gate —— 晚了没有任何关系，地址只在
  // 启动子进程那一刻被读一次。
  gateUrl.value = `http://127.0.0.1:${String(server.port)}`

  // 把地址记在数据目录里，`loopkanban mcp` 照着它找过来 —— 端口默认是随机的，
  // 而 MCP server 是另一个进程，没人给它传参。写不进去只是少了这条线索，
  // 不该因此不让看板起来。
  await writeEndpoint(dir, {
    // 只记地址，**不记 token** —— 它已经在同一个目录的 token 文件里躺着，
    // 同一份秘密存两处只是多一个会对不上的地方。
    url: `http://127.0.0.1:${String(server.port)}`,
    port: server.port,
    pid: process.pid,
    startedAt: Date.now(),
  }).catch((error: unknown) => {
    console.log(C.dim(`    地址文件写不进去（${String(error)}），MCP 要靠 LOOPKANBAN_URL 才连得上。`))
  })

  console.log(`\n  ${C.amber('▸')} ${server.url}`)
  if (webDev !== undefined) console.log(C.dim(`    前端来自 ${webDev}，改 packages/web/src 会热更新。`))
  console.log(C.dim('    只监听 127.0.0.1。远程访问请用 SSH 端口转发，不要改成 0.0.0.0。'))
  console.log(C.dim('    token 存在数据目录里，重启后链接依然有效；`--new-token` 可轮换。'))
  console.log(C.dim(`    数据 ${join(dir, 'loopkanban.db')}`))
  console.log(scheduler.settings.autopilot
    // 两道闸都报出来：只报执行器那道的话，同一个仓库里的卡被仓库那道拦下来时看不出原因。
    ? `  ${C.amber('▸')} 自动认领${C.dim(` 开启 · 每个执行器并发 ${String(scheduler.settings.maxPerProvider)} · 每个仓库并发 ${String(scheduler.settings.maxPerRepo)}`)}\n`
    : C.dim('    自动认领当前关闭，可在界面左侧边栏底部打开。\n'))

  if (!process.argv.includes('--no-open')) openBrowser(server.url)

  const shutdown = (): void => {
    console.log(C.dim('\n  正在关闭 …'))
    scheduler.stop()
    void server.close().then(async () => {
      // 地址跟着进程走：留着它，下一个 MCP server 会照着一个没人听的端口去连。
      await clearEndpoint(dir)
      storage.close()
      process.exit(0)
    })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

await main()
