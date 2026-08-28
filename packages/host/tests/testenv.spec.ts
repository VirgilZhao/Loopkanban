import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asProjectId, asRunId, asTaskId, type Task } from '@loopkanban/core'
import { Storage } from '../src/storage/index.ts'
import { TestEnvs, type TestEnvEvent, type TestEnvView } from '../src/testenv/index.ts'

const T0 = 1_000_000
const PROJECT = asProjectId('p1')
const TASK = asTaskId('t1')

let store: Storage
let worktree: string
let envs: TestEnvs

/** 一个会监听 `PORT` 的最小服务。跨平台，且不依赖仓库里装了什么。 */
const SERVER = "node -e \"require('http').createServer((_,r)=>r.end('ok'))"
  + ".listen(process.env.PORT,'127.0.0.1',()=>console.log('listening on '+process.env.PORT))\""

function seed(testCommand?: string): void {
  store.createProject({
    id: PROJECT, name: 'p', repoPath: '/repo', baseBranch: 'main',
    ...(testCommand === undefined ? {} : { testCommand }),
    createdAt: T0,
  })
  const task: Task = {
    id: TASK, projectId: PROJECT, revision: 1, column: 'review', position: 1,
    description: '一张卡', acceptance: [], repoPath: '/repo', baseBranch: 'main',
    blockedBy: [], createdAt: T0, updatedAt: T0,
  }
  store.createTask(task)
  store.createRun({
    id: asRunId('r1'), taskId: TASK, provider: 'claude', cliVersion: '1',
    worktreePath: worktree, branch: 'task/t1', status: 'completed', startedAt: T0, endedAt: T0,
  })
}

/** 等到 `check` 为真，或者超时抛出 —— 比固定 sleep 稳，也比它快。 */
async function until(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('等待超时')
}

/** 端口现在通不通。收尸收干净了没有，看的就是这个。 */
function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (open: boolean): void => { socket.destroy(); resolve(open) }
    socket.once('connect', () => { done(true) })
    socket.once('error', () => { done(false) })
    socket.setTimeout(1_000, () => { done(false) })
  })
}

beforeEach(async () => {
  store = Storage.open(':memory:')
  worktree = await mkdtemp(join(tmpdir(), 'loopkanban-testenv-'))
})

afterEach(async () => {
  await envs.stopAll()
  store.close()
  await rm(worktree, { recursive: true, force: true })
})

describe('TestEnvs.start', () => {
  it('把项目的启动命令跑在卡片的 worktree 里，端口通了才算就绪', async () => {
    seed(SERVER)
    envs = new TestEnvs({ storage: store })
    const started = await envs.start(TASK)
    expect(started.ok).toBe(true)
    if (!started.ok) return

    expect(started.env.cwd).toBe(worktree)
    expect(started.env.status).toBe('starting')
    // 端口没通之前不给链接：给了的话人点开看到的是连接被拒绝，
    // 然后开始怀疑是不是自己哪儿配错了。
    expect(started.env.url).toBeNull()

    await until(() => envs.view(TASK)?.status === 'ready')
    const ready = envs.view(TASK) as TestEnvView
    expect(ready.url).toBe(`http://127.0.0.1:${String(ready.port)}`)
    expect(await portOpen(ready.port)).toBe(true)
  })

  it('命令里的 {{port}} 换成实际端口', async () => {
    seed('node -e "console.log(process.argv[1])" {{port}}')
    envs = new TestEnvs({ storage: store })
    const started = await envs.start(TASK)
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.env.command).toContain(String(started.env.port))
    expect(started.env.command).not.toContain('{{port}}')
  })

  it('并发的两次 start 只起一个进程', async () => {
    // 回归：幂等检查原本在三个 await 之前读账本，两个标签页各点一次启动
    // 会各起一个进程，而后写入的那条把先写入的从账本里挤掉 ——
    // 那个进程从此 stop 与 stopAll 都够不着，占着端口一直跑。
    seed(SERVER)
    envs = new TestEnvs({ storage: store })
    const [first, second] = await Promise.all([envs.start(TASK), envs.start(TASK)])
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.env.port).toBe(first.env.port)
    expect(envs.size).toBe(1)

    // 收完之后那个端口必须真的没人占着 —— 账本里只有一条不等于只起了一个。
    await until(() => envs.view(TASK)?.status === 'ready')
    await envs.stopAll()
    expect(await portOpen(first.env.port)).toBe(false)
  })

  it('正在执行的卡不给起 —— Agent 正在写那个 worktree', async () => {
    seed(SERVER)
    const running = store.getTask(TASK)
    if (running !== null) store.commitTask({ ...running, column: 'running', revision: running.revision + 1 })
    envs = new TestEnvs({ storage: store })
    const started = await envs.start(TASK)
    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.reason).toBe('task-running')
  })

  it('没配启动命令就明确拒绝 —— 不替他猜一条', async () => {
    seed()
    envs = new TestEnvs({ storage: store })
    const started = await envs.start(TASK)
    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.reason).toBe('no-test-command')
  })

  it('工作区已经不在了（比如卡被废弃过）就拒绝，而不是在空气上起进程', async () => {
    seed(SERVER)
    await rm(worktree, { recursive: true, force: true })
    envs = new TestEnvs({ storage: store })
    const started = await envs.start(TASK)
    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.reason).toBe('no-worktree')
  })

  it('连点两下只起一个 —— 每一次多起的都是一个真的 dev server', async () => {
    seed(SERVER)
    envs = new TestEnvs({ storage: store })
    const first = await envs.start(TASK)
    const second = await envs.start(TASK)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.env.port).toBe(first.env.port)
    expect(envs.size).toBe(1)
  })
})

describe('TestEnvs 的收场', () => {
  it('停止会收掉整棵进程树，端口跟着放出来', async () => {
    // 中间隔一层 shell：只 kill 直接子进程的话，真正占着端口的孙进程会留下。
    seed(`sh -c '${SERVER.replaceAll("'", "'\\''")} & wait'`)
    envs = new TestEnvs({ storage: store })
    const started = await envs.start(TASK)
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const { port } = started.env
    await until(() => envs.view(TASK)?.status === 'ready')

    expect(await envs.stop(TASK, 'manual')).toBe(true)
    expect(envs.view(TASK)?.status).toBe('exited')
    expect(envs.view(TASK)?.stoppedBy).toBe('manual')
    expect(await portOpen(port)).toBe(false)
  })

  it('没人订阅就自己收掉 —— 关掉面板等于说"我验完了"', async () => {
    seed(SERVER)
    envs = new TestEnvs({ storage: store, idleMs: 200 })
    const started = await envs.start(TASK)
    expect(started.ok).toBe(true)
    if (!started.ok) return

    await until(() => envs.view(TASK)?.status === 'exited')
    expect(envs.view(TASK)?.stoppedBy).toBe('idle')
  })

  it('有人看着就不收；人一走才开始倒计时', async () => {
    seed(SERVER)
    envs = new TestEnvs({ storage: store, idleMs: 300 })
    await envs.start(TASK)
    const detach = envs.subscribe(TASK, 0, () => undefined)

    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(envs.view(TASK)?.status).not.toBe('exited')

    detach()
    await until(() => envs.view(TASK)?.status === 'exited')
    expect(envs.view(TASK)?.stoppedBy).toBe('idle')
  })

  it('绝对上限到点自己收，兜住"开着面板去吃饭"', async () => {
    seed(SERVER)
    envs = new TestEnvs({ storage: store, maxLifetimeMs: 200 })
    await envs.start(TASK)
    // 一直有人看着，所以收它的只可能是上限那条。
    envs.subscribe(TASK, 0, () => undefined)
    await until(() => envs.view(TASK)?.status === 'exited')
    expect(envs.view(TASK)?.stoppedBy).toBe('expired')
  })

  it('已经退出的环境上再 stop 一次，尸体照样会被清掉', async () => {
    // 回归：这一下原本会把清理倒计时取消掉且不再重挂，于是 entry 连同
    // 几百行日志一直留到 host 退出。而验收路径必然会来这么一下。
    seed('echo done')
    envs = new TestEnvs({ storage: store, idleMs: 300, readyTimeoutMs: 200 })
    await envs.start(TASK)
    await until(() => envs.view(TASK)?.status === 'exited')

    expect(await envs.stop(TASK, 'verdict')).toBe(true)
    await until(() => envs.size === 0)
  })

  it('命令自己退出时如实记下退出码，不假装是我们收的', async () => {
    seed('echo 起不来 >&2; exit 3')
    envs = new TestEnvs({ storage: store, readyTimeoutMs: 500 })
    await envs.start(TASK)
    await until(() => envs.view(TASK)?.status === 'exited')
    expect(envs.view(TASK)?.exitCode).toBe(3)
    expect(envs.view(TASK)?.stoppedBy).toBeUndefined()
  })

  it('不监听端口的命令是"运行中"，不是失败', async () => {
    seed('sleep 5')
    envs = new TestEnvs({ storage: store, readyTimeoutMs: 300 })
    await envs.start(TASK)
    await until(() => envs.view(TASK)?.status === 'running')
    expect(envs.view(TASK)?.url).toBeNull()
  })
})

describe('TestEnvs.subscribe', () => {
  it('订阅跟着卡片走，不跟着进程走 —— 换一个环境，原来那条连接照样收得到', async () => {
    // 这是回归：订阅表原本挂在进程条目上，停掉再启动之后，页面那条已经开着的
    // 连接就挂在旧条目上 —— 不报错、不重连，界面永远停在"启动中"。
    seed('sleep 5')
    envs = new TestEnvs({ storage: store, readyTimeoutMs: 300 })
    await envs.start(TASK)
    const seen: TestEnvEvent[] = []
    envs.subscribe(TASK, 0, (event) => { seen.push(event) })

    await envs.stop(TASK, 'manual')
    const before = seen.length
    await envs.start(TASK)
    await until(() => seen.length > before)

    const latest = seen.at(-1)
    expect(latest?.kind).toBe('status')
    if (latest?.kind !== 'status') return
    expect(latest.env.status).not.toBe('exited')
    // 编号不许倒退：SSE 断线重连拿 Last-Event-ID 续传，倒退回去就会漏事件。
    expect(latest.seq).toBeGreaterThan(before)
  })

  it('先订阅、后启动也收得到 —— 面板那条连接是先开着的', async () => {
    seed('echo 起来了; sleep 5')
    envs = new TestEnvs({ storage: store, readyTimeoutMs: 300 })
    const seen: TestEnvEvent[] = []
    envs.subscribe(TASK, 0, (event) => { seen.push(event) })

    await envs.start(TASK)
    await until(() => seen.some((event) => event.kind === 'log' && event.text === '起来了'))
  })


  it('推日志与状态，并把订阅之前的那几行补齐', async () => {
    seed('echo 第一行; echo 第二行 >&2; sleep 5')
    envs = new TestEnvs({ storage: store, readyTimeoutMs: 300 })
    await envs.start(TASK)
    await until(() => (envs.view(TASK)?.status) === 'running')

    // 晚到的订阅者也该看到起步时的输出 —— 否则"它为什么没起来"最关键的
    // 那几行恰好是看不到的那几行。
    const seen: TestEnvEvent[] = []
    envs.subscribe(TASK, 0, (event) => { seen.push(event) })
    const logs = seen.filter((event) => event.kind === 'log')
    expect(logs.map((event) => event.kind === 'log' ? event.text : '')).toContain('第一行')
    expect(logs.some((event) => event.kind === 'log' && event.stream === 'err')).toBe(true)
    expect(seen.some((event) => event.kind === 'status')).toBe(true)
  })
})

describe('端口分配', () => {
  it('不把同一个号发给两张卡 —— 否则后起的那个会探到别人的服务', async () => {
    seed(SERVER)
    // 第二张卡，共用同一个 worktree（跑什么不重要，要的是两个环境共存）。
    const other = asTaskId('t2')
    store.createTask({
      id: other, projectId: PROJECT, revision: 1, column: 'review', position: 2,
      description: '另一张卡', acceptance: [], repoPath: '/repo', baseBranch: 'main',
      blockedBy: [], createdAt: T0, updatedAt: T0,
    })
    store.createRun({
      id: asRunId('r2'), taskId: other, provider: 'claude', cliVersion: '1',
      worktreePath: worktree, branch: 'task/t2', status: 'completed', startedAt: T0, endedAt: T0,
    })

    envs = new TestEnvs({ storage: store })
    const first = await envs.start(TASK)
    const second = await envs.start(other)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.env.port).not.toBe(first.env.port)
  })
})
