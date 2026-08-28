/**
 * 一键测试环境：把一张卡的改动在**它自己的 worktree 里跑起来**，验完自动收掉。
 *
 * 为什么要有它：Review 那一屏只能读 diff。可"这个 feature 做对了没有"很多时候
 * 读不出来 —— 得点开页面自己试。而人工试一次的成本是：找到那个七层深的 worktree
 * 路径、开终端、装依赖、起服务、还要记得端口别跟主工作区那个撞上；验完还得记得
 * 回来把它 kill 掉。这几步里任何一步忘了，代价都是一个整晚烧着 CPU 的孤儿进程。
 *
 * 所以这里的规格是围着"忘了收"写的：
 *
 * - **进程组托管**。走 `spawnProcess` 而不是 `child_process.spawn`：`pnpm dev`
 *   底下是 pnpm → node → esbuild 一串孙进程，只 kill 直接子进程会留下真正占着
 *   端口的那个，下次启动撞端口，而界面上早就显示"已停止"了。
 * - **四条自动退出的路**，一条都不能少：没人看了（{@link TestEnvOptions.idleMs}）、
 *   活得太久（{@link TestEnvOptions.maxLifetimeMs}）、验收/打回/废弃时（调用方
 *   在动 worktree 之前调 {@link TestEnvs.stop}）、host 退出时（{@link TestEnvs.stopAll}）。
 *   其中验收那条是硬的：`Review.accept` 会删掉 worktree，底下还跑着服务就是在
 *   删它脚下的地板。
 * - **端口由 host 分配**，不写死在命令里。两张卡同时试跑必然撞车，而"撞车"
 *   的现象是第二个服务起不来或者悄悄连到了第一个上 —— 后者会让人对着上一张卡
 *   的页面验收这一张卡。
 *
 * **不落库**。跑着的进程属于这个 host 进程，重启之后它们就不在了，留一行数据库
 * 记录只会让界面显示一个已经不存在的环境。代价是 host 被 SIGKILL 时收不掉树 ——
 * 那种情况下任何账本都是错的，不如不记。
 */

import { createInterface } from 'node:readline'
import { connect, createServer, type AddressInfo } from 'node:net'
import { stat } from 'node:fs/promises'
import type { TaskId } from '@loopkanban/core'
import type { Storage } from '../storage/index.ts'
import { shellArgv } from '../server/exec.ts'
import { spawnProcess, type ProcessHandle } from '../subprocess/index.ts'

/** 没人看着多久就收掉。SSE 断开即开始计时 —— 关面板、关标签页、断网都算。 */
export const DEFAULT_IDLE_MS = 60_000

/** 绝对上限。兜住"开着面板去吃饭"这种情况。 */
export const DEFAULT_MAX_LIFETIME_MS = 30 * 60_000

/** 探测端口多久算"它不打算监听"。够一次冷启动的前端构建。 */
export const DEFAULT_READY_TIMEOUT_MS = 90_000

/** 端口探活的间隔。 */
const PROBE_INTERVAL_MS = 300

/** 日志留最近多少条。够看清楚起没起来，又不至于把一个刷屏的 dev server 存进内存。 */
const LOG_KEEP = 400

/** 单行日志上限。没有换行的进度条能顶出一行几 MB 的东西来。 */
const LOG_LINE_MAX = 2_000

/**
 * 环境的状态。
 *
 * `running` 与 `ready` 的区别是**有没有监听端口**，不是"好没好"：`pnpm test:watch`
 * 这种命令永远不会监听，但它照样是一次合法的试跑，日志就是全部产出。把它判成
 * 失败是我们自作主张。
 */
export type TestEnvStatus = 'starting' | 'ready' | 'running' | 'exited'

/** 停下来的原因。界面上要说清楚是谁收的，否则"它自己没了"是最难查的一类问题。 */
export type StopReason = 'manual' | 'idle' | 'expired' | 'verdict' | 'shutdown'

export interface TestEnvView {
  readonly taskId: string
  /** 真正交给 shell 的那条命令（`{{port}}` 已经换成实际端口）。 */
  readonly command: string
  readonly cwd: string
  /** 分配给它的端口，通过 `PORT` 环境变量与 `{{port}}` 占位符交给命令。 */
  readonly port: number
  /** 端口通了才有；没监听端口的命令一直是 null。 */
  readonly url: string | null
  readonly status: TestEnvStatus
  readonly startedAt: number
  /** 到这个时刻会被绝对上限收掉。 */
  readonly expiresAt: number
  readonly exitCode?: number | undefined
  readonly signal?: string | undefined
  /** 是被谁收的；自然退出的没有。 */
  readonly stoppedBy?: StopReason | undefined
}

/** 一条事件的内容，还没编号。 */
export type TestEnvSignal =
  | { readonly kind: 'status'; readonly env: TestEnvView }
  | { readonly kind: 'log'; readonly stream: 'out' | 'err'; readonly text: string }

/**
 * 推给界面的一条事件。`seq` 单调递增，SSE 断线重连靠它补齐。
 *
 * 不写成 `Omit<…, 'seq'>`：Omit 作用在联合类型上会先把两支合成一个对象，
 * 于是 `status` 那支也接受 `text` 字段 —— 类型还在，约束没了。
 */
export type TestEnvEvent = TestEnvSignal & { readonly seq: number; readonly at: number }

export type StartFailure = {
  readonly ok: false
  readonly reason:
    | 'task-not-found' | 'task-running' | 'no-test-command' | 'no-run' | 'no-worktree' | 'spawn-failed'
  readonly detail: string
}

export type StartResult = { readonly ok: true; readonly env: TestEnvView } | StartFailure

export interface TestEnvOptions {
  readonly storage: Storage
  /** 没有订阅者多久后收掉，默认 {@link DEFAULT_IDLE_MS}。 */
  readonly idleMs?: number
  /** 绝对上限，默认 {@link DEFAULT_MAX_LIFETIME_MS}。 */
  readonly maxLifetimeMs?: number
  /** 端口探活的耐心，默认 {@link DEFAULT_READY_TIMEOUT_MS}。 */
  readonly readyTimeoutMs?: number
  readonly now?: () => number
}

type Listener = (event: TestEnvEvent) => void

interface Entry {
  view: TestEnvView
  readonly handle: ProcessHandle
  /** 没人看着时的收尸倒计时；有人看着时为 null。 */
  idle: NodeJS.Timeout | null
  readonly lifetime: NodeJS.Timeout
  /** 端口探活的取消开关。 */
  probing: boolean
  /** 正在收的那一次，保证并发调用共享同一个过程。 */
  stopping: Promise<void> | null
}

/**
 * 一张卡的事件通道：谁在看、看到哪儿了。
 *
 * **它属于卡片，不属于某一次进程**，比 {@link Entry} 活得长。反过来做过一版，
 * 结果是：停掉再启动一个新环境时，浏览器那条已经开着的连接还挂在旧进程的
 * 订阅表上 —— 连接不报错、页面不重连，界面就永远停在"启动中"，而服务端那边
 * 早就跑起来了。订阅者要的从来是"这张卡的测试环境"，不是某一个 pid。
 */
interface Channel {
  readonly listeners: Set<Listener>
  /** 最近的事件，供晚到的订阅者补历史。换环境时清空 —— 人要看的是这一次。 */
  backlog: TestEnvEvent[]
  /** 单调递增且**跨环境不重置**：SSE 的 Last-Event-ID 靠它，倒退回去就会漏。 */
  seq: number
}

/** 要一个空闲端口：让内核挑，再立刻让出来。 */
async function askKernelForPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => { resolve(port) })
    })
  })
}

/** 端口分配最多重试几次。撞上自家已用端口的概率极低，几次足够。 */
const PORT_ATTEMPTS = 20

/**
 * 分配一个端口，**并且避开我们自己已经许出去的那些**。
 *
 * 为什么不能只信内核：拿到端口之后我们立刻把它让出来，真正的 bind 发生在命令
 * 跑起来之后 —— 命令是 `pnpm install && pnpm dev` 时，这中间隔着几分钟。这段
 * 时间里同一个端口号完全可能被内核再发一次，于是两张卡拿到同一个号：先 bind
 * 的那个赢，后一个的探测会连上**别人的服务**并显示"就绪"，人就对着卡 B 的页面
 * 验收卡 A。别人机器上的进程我们管不着（那种情况下我们的服务 bind 会失败、
 * 进程退出，探测也随之停掉），但自家两张卡撞号是能挡住的，就挡在这儿。
 *
 * @param taken - 已经许出去、还没到期的端口。
 */
async function freePort(taken: ReadonlySet<number>): Promise<number> {
  let last = 0
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
    last = await askKernelForPort()
    if (!taken.has(last)) return last
  }
  // 连着二十次都撞上，说明有别的东西不对劲了；照实用最后那个，
  // 让它以 EADDRINUSE 失败并把日志给人看，好过在这儿无限转。
  return last
}

/**
 * 端口通了没有。
 *
 * 两个地址都试：我们传了 `HOST=127.0.0.1`，但不是每个框架都听这个环境变量，
 * 只探 IPv4 的话，一个只 bind 了 `::1` 的服务会被判成"没监听"，而它其实好好的。
 */
function portOpen(port: number): Promise<boolean> {
  const once = (host: string): Promise<boolean> => new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (open: boolean): void => { socket.destroy(); resolve(open) }
    socket.once('connect', () => { done(true) })
    socket.once('error', () => { done(false) })
    socket.setTimeout(1_000, () => { done(false) })
  })
  return once('127.0.0.1').then((open) => (open ? true : once('::1')))
}

export class TestEnvs {
  // 不用参数属性：`node --experimental-strip-types` 的 strip-only 模式不支持。
  private readonly options: TestEnvOptions
  private readonly envs = new Map<string, Entry>()
  private readonly channels = new Map<string, Channel>()
  /** 正在起的那一次，按卡片记。见 {@link TestEnvs.start} 里那道闸门。 */
  private readonly starting = new Map<string, Promise<StartResult>>()

  constructor(options: TestEnvOptions) {
    this.options = options
  }

  private get now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /**
   * 起一个测试环境。
   *
   * 幂等，**并发也幂等**：这张卡已经有一个活着的环境就直接把它给回去；正在起
   * 的话就等那一次的结果。
   *
   * 后半句是这里的要害。判断"有没有"是同步的，而真正起一个环境要 await 三次
   * （探目录、要端口、起进程）；只在开头看一眼账本的话，两个标签页各点一次
   * 启动就会各起一个进程，而后写入的那条把先写入的**从账本里挤掉** —— 那个
   * 进程从此没有任何东西指向它：stop 找不到、stopAll 也找不到，它会占着端口
   * 一直跑到有人手动去 kill。正是这个功能存在的理由本身。
   *
   * 所以闸门必须在第一个 await 之前落下：把进行中的那次 Promise 记在
   * `starting` 里，同步地。
   *
   * @param taskId - 目标任务。命令跑在它最近一次执行留下的 worktree 里。
   */
  async start(taskId: TaskId): Promise<StartResult> {
    const key = String(taskId)
    const alive = this.envs.get(key)
    if (alive !== undefined && alive.view.status !== 'exited') return { ok: true, env: alive.view }

    const inflight = this.starting.get(key)
    if (inflight !== undefined) return inflight

    // launch() 一路同步跑到它自己的第一个 await 才回到这里，中间没有任何
    // 别的调用能插进来 —— 所以这条登记是安全的。
    const attempt = this.launch(taskId)
    this.starting.set(key, attempt)
    try {
      return await attempt
    } finally {
      this.starting.delete(key)
    }
  }

  /** 真正把进程起起来。只许 {@link start} 调 —— 它负责挡住并发。 */
  private async launch(taskId: TaskId): Promise<StartResult> {
    const alive = this.envs.get(String(taskId))
    const { storage } = this.options
    const task = storage.getTask(taskId)
    if (task === null) return { ok: false, reason: 'task-not-found', detail: String(taskId) }

    /*
     * 正在执行的卡不给起 —— 那个 worktree 此刻正被 Agent 写着。同一个目录里
     * 并排跑两个 `pnpm install` 能装出一个两边都不认的 node_modules，而且
     * dev server 服务的会是改到一半的代码。同「正在执行的卡不能改需求、不能
     * 加附件」是同一条规矩。
     */
    if (task.column === 'running') {
      return { ok: false, reason: 'task-running', detail: '这张卡正在执行，先终止它再试跑' }
    }

    const project = storage.getProject(task.projectId)
    const command = project?.testCommand?.trim() ?? ''
    if (command.length === 0) {
      return {
        ok: false,
        reason: 'no-test-command',
        detail: '这个项目还没配启动命令 —— 在项目设置里填一条，比如 `pnpm install && pnpm dev`',
      }
    }

    // worktree 属于任务，取最近一次执行记的那个路径。
    const run = storage.listRuns(taskId)[0]
    if (run === undefined) return { ok: false, reason: 'no-run', detail: '这张卡还没跑过，没有可试的工作区' }
    const cwd = run.worktreePath
    if (!await stat(cwd).then((info) => info.isDirectory(), () => false)) {
      return { ok: false, reason: 'no-worktree', detail: `工作区已经不在了：${cwd}` }
    }

    // 上一个已经退出的环境让位。留着它的日志没有意义 —— 人要看的是这一次。
    if (alive !== undefined) this.forget(taskId)

    // 自家还活着的环境占着的号，一个都不要再发第二遍。
    const port = await freePort(new Set(
      [...this.envs.values()].filter((e) => e.view.status !== 'exited').map((e) => e.view.port),
    ))
    const resolved = command.replaceAll('{{port}}', String(port))
    const startedAt = this.now
    const maxLifetimeMs = this.options.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS

    let handle: ProcessHandle
    try {
      handle = await spawnProcess({
        argv: shellArgv(resolved),
        cwd,
        /*
         * 环境**不清洗**，同 `server/exec.ts`：这是用户自己配的命令，跑的是他
         * 自己的项目，把 `GITHUB_TOKEN`、`AWS_PROFILE` 之类洗掉只会让服务以一种
         * 与看板毫无关系的方式起不来。
         *
         * 只覆盖三样：端口（否则两张卡撞车）、绑定地址（别把 dev server 挂到
         * 局域网上去，虽然管不管用取决于框架）、以及不要自己开浏览器 ——
         * vite / CRA 默认会弹一个标签页，而这个进程是界面替人起的，
         * 人没在等一个突然跳出来的窗口。
         */
        env: {
          ...process.env,
          PORT: String(port),
          HOST: '127.0.0.1',
          BROWSER: 'none',
          // 日志要显示在浏览器里，ANSI 转义在那儿是一串乱码而不是颜色。
          NO_COLOR: '1',
          FORCE_COLOR: '0',
        },
        // dev server 收到 SIGTERM 后要关连接、清临时文件，给足时间再上 SIGKILL。
        graceMs: 3_000,
      })
    } catch (error) {
      return {
        ok: false,
        reason: 'spawn-failed',
        detail: error instanceof Error ? error.message : String(error),
      }
    }

    const entry: Entry = {
      view: {
        taskId: String(taskId), command: resolved, cwd, port, url: null,
        status: 'starting', startedAt, expiresAt: startedAt + maxLifetimeMs,
      },
      handle,
      // 还没人订阅就先开始倒计时：POST 完就关掉页面的情况也必须被收掉。
      idle: null,
      lifetime: setTimeout(() => { void this.stop(taskId, 'expired') }, maxLifetimeMs),
      probing: true,
      stopping: null,
    }
    entry.lifetime.unref()
    this.envs.set(String(taskId), entry)
    this.armIdle(taskId, entry)

    this.pipe(taskId, handle.stdout, 'out')
    if (handle.stderr !== null) this.pipe(taskId, handle.stderr, 'err')

    void handle.exited.then((outcome) => {
      entry.probing = false
      // 被我们收掉的那一路已经改过 view 了，不要用自然退出的结果盖掉停止原因。
      if (entry.stopping !== null) return
      this.update(taskId, entry, {
        status: 'exited',
        ...(outcome.code === null ? {} : { exitCode: outcome.code }),
        ...(outcome.signal === null ? {} : { signal: outcome.signal }),
      })
      clearTimeout(entry.lifetime)
      this.armIdle(taskId, entry)
    })

    void this.probeReady(taskId, entry)
    this.emit(taskId, { kind: 'status', env: entry.view })
    return { ok: true, env: entry.view }
  }

  /** 这张卡当前的环境；没有则 null。 */
  view(taskId: TaskId): TestEnvView | null {
    return this.envs.get(String(taskId))?.view ?? null
  }

  /**
   * 订阅一个环境的日志与状态。
   *
   * **这条订阅本身就是心跳**：最后一个订阅者走掉之后开始倒计时，到点收掉进程。
   * 关面板、关标签页、拔网线是同一件事，不必让前端再单独发一路心跳 ——
   * 那条路一旦漏发（页面被 bfcache 冻住就会），环境就会活到天荒地老。
   *
   * @param taskId - 目标任务。
   * @param from - 已经收到的最大 seq，只补它之后的。
   * @param listener - 回调。
   * @returns 取消订阅的函数；调用即开始倒计时。
   */
  subscribe(taskId: TaskId, from: number, listener: Listener): () => void {
    // 环境还没起来也接受订阅：界面那条连接是先开着的，随后按下启动，
    // 事件就该顺着这条连接过来 —— 而不是要它自己发现该重连。
    const channel = this.channelOf(taskId)
    channel.listeners.add(listener)

    const entry = this.envs.get(String(taskId))
    if (entry?.idle != null) { clearTimeout(entry.idle); entry.idle = null }
    for (const event of channel.backlog) if (event.seq > from) listener(event)

    return () => {
      channel.listeners.delete(listener)
      if (channel.listeners.size > 0) return
      const current = this.envs.get(String(taskId))
      if (current === undefined) { this.channels.delete(String(taskId)); return }
      this.armIdle(taskId, current)
    }
  }

  /**
   * 收掉一个环境。整棵进程树，不只是组长。
   *
   * 幂等，并发调用共享同一次终止过程 —— 「验收」和「面板关闭」几乎总是同时
   * 发生的，两条路各 kill 一次的话，第二次会打在一个已经被回收的 pid 上。
   *
   * @param taskId - 目标任务。
   * @param reason - 是谁收的，会推给界面。
   * @returns 是否真的收了；本来就没有环境时 false。
   */
  async stop(taskId: TaskId, reason: StopReason): Promise<boolean> {
    /*
     * 正在起的那一次要先等它落地。不等的话，「这一刻正好没有环境」是个骗人的
     * 答案：进程再过几十毫秒就会挂上账本，而这次 stop 早就返回 false 走了 ——
     * 于是验收删掉了 worktree、host 也关了，那个进程还在跑。
     */
    const pending = this.starting.get(String(taskId))
    if (pending !== undefined) await pending.catch(() => undefined)

    const entry = this.envs.get(String(taskId))
    if (entry === undefined) return false
    if (entry.stopping !== null) { await entry.stopping; return true }
    // 已经退了：这一下是无害的重复调用（验收路径必然会来这么一下）。但**必须
    // 重挂清理倒计时**而不是把它取消掉 —— 取消掉的话 forget() 再也不会被触发，
    // 这条 entry 连同它几百行日志会一直留到 host 进程结束。
    if (entry.view.status === 'exited') { this.armIdle(taskId, entry); return true }

    entry.probing = false
    this.disarm(entry)
    entry.stopping = (async () => {
      const outcome = await entry.handle.terminate().catch(() => null)
      this.update(taskId, entry, {
        status: 'exited',
        stoppedBy: reason,
        ...(outcome?.code === null || outcome?.code === undefined ? {} : { exitCode: outcome.code }),
        ...(outcome?.signal === null || outcome?.signal === undefined ? {} : { signal: outcome.signal }),
      })
      // 尸体留着是为了让人看清"是谁收的、日志说了什么"。人一走就清掉 ——
      // 每张点过启动的卡各留一份几百行的日志，攒起来是真的内存。
      this.armIdle(taskId, entry)
    })()
    await entry.stopping
    return true
  }

  /**
   * 收掉全部环境。host 退出时走这条 —— 不走的话端口会一直被占着，
   * 而占着它的进程已经没有任何界面能找到了。
   */
  async stopAll(reason: StopReason = 'shutdown'): Promise<void> {
    // 同 stop：先等正在起的那些落地，否则它们会正好从这次清场里溜出去，
    // 变成 host 已经退出、进程还在跑的孤儿。
    await Promise.allSettled([...this.starting.values()])
    await Promise.all([...this.envs.keys()].map((id) => this.stop(id as TaskId, reason)))
  }

  /** 当前有几个环境（含已退出但还留着日志的）。供诊断。 */
  get size(): number {
    return this.envs.size
  }

  /**
   * 把这张卡的环境从账本上抹掉。只在换新环境、或者尸体没人看时用 ——
   * 进程必须已经不在了。
   *
   * **订阅者不动**：他们订的是这张卡，换一个环境不该把他们踢下线。日志清空，
   * 因为那是上一次的输出；编号接着往下走，否则 SSE 的续传会认错位置。
   */
  private forget(taskId: TaskId): void {
    const entry = this.envs.get(String(taskId))
    if (entry !== undefined) {
      this.disarm(entry)
      this.envs.delete(String(taskId))
    }
    const channel = this.channels.get(String(taskId))
    if (channel === undefined) return
    channel.backlog = []
    // 没人看着就连通道一起收 —— 留着它等于给每张点过启动的卡各留一份账。
    if (channel.listeners.size === 0) this.channels.delete(String(taskId))
  }

  /** 取这张卡的事件通道，没有就建一个。 */
  private channelOf(taskId: TaskId): Channel {
    const existing = this.channels.get(String(taskId))
    if (existing !== undefined) return existing
    const created: Channel = { listeners: new Set<Listener>(), backlog: [], seq: 0 }
    this.channels.set(String(taskId), created)
    return created
  }

  private disarm(entry: Entry): void {
    clearTimeout(entry.lifetime)
    if (entry.idle !== null) { clearTimeout(entry.idle); entry.idle = null }
  }

  /** 起一轮"没人看着"的倒计时。已经在倒计时的话不重置。 */
  private armIdle(taskId: TaskId, entry: Entry): void {
    if (entry.idle !== null) return
    if ((this.channels.get(String(taskId))?.listeners.size ?? 0) > 0) return
    const idleMs = this.options.idleMs ?? DEFAULT_IDLE_MS
    entry.idle = setTimeout(() => {
      entry.idle = null
      // 进程已经自己退出了，那这轮倒计时的意义只是清账。
      if (entry.view.status === 'exited') { this.forget(taskId); return }
      void this.stop(taskId, 'idle')
    }, idleMs)
    entry.idle.unref()
  }

  /** 一路输出按行推给界面。 */
  private pipe(taskId: TaskId, stream: NodeJS.ReadableStream, kind: 'out' | 'err'): void {
    const lines = createInterface({ input: stream })
    lines.on('line', (line: string) => {
      this.emit(taskId, { kind: 'log', stream: kind, text: line.slice(0, LOG_LINE_MAX) })
    })
    // 流坏掉不该把 host 带走：进程已经在退出的路上，`exited` 会给出结论。
    stream.on('error', () => { lines.close() })
  }

  /**
   * 等端口通。
   *
   * 通了就是 `ready`，界面上那个链接才敢给出去 —— 在服务还没监听的时候给出
   * 链接，人点开看到的是连接被拒绝，然后开始怀疑是不是自己哪儿配错了。
   *
   * 等超时也不算失败（见 {@link TestEnvStatus}）：只是这条命令不监听端口。
   */
  private async probeReady(taskId: TaskId, entry: Entry): Promise<void> {
    const deadline = this.now + (this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)
    while (entry.probing && this.now < deadline) {
      if (await portOpen(entry.view.port)) {
        if (!entry.probing) return
        this.update(taskId, entry, { status: 'ready', url: `http://127.0.0.1:${String(entry.view.port)}` })
        return
      }
      await new Promise((resolve) => { setTimeout(resolve, PROBE_INTERVAL_MS).unref() })
    }
    if (entry.probing && entry.view.status === 'starting') this.update(taskId, entry, { status: 'running' })
  }

  /** 改状态并广播。状态是给界面看的唯一真相，改了就必须推出去。 */
  private update(taskId: TaskId, entry: Entry, patch: Partial<TestEnvView>): void {
    entry.view = { ...entry.view, ...patch }
    this.emit(taskId, { kind: 'status', env: entry.view })
  }

  private emit(taskId: TaskId, event: TestEnvSignal): void {
    const channel = this.channelOf(taskId)
    channel.seq += 1
    const full: TestEnvEvent = { ...event, seq: channel.seq, at: this.now }
    channel.backlog.push(full)
    if (channel.backlog.length > LOG_KEEP) channel.backlog.splice(0, channel.backlog.length - LOG_KEEP)
    for (const listener of channel.listeners) {
      try {
        listener(full)
      } catch {
        // 一个订阅者坏掉不能拖垮别人，更不能影响进程本身。
      }
    }
  }
}
