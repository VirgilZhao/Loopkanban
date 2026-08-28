/**
 * 终端会话：一个活着的工作目录，加上一条正在跑的命令。
 *
 * 这是**用户自己的手**，不是 Agent 的：他在看 worktree 里的改动，想 `git log`
 * 一下、想跑一次 `npm run dev`，为此切出去开终端、再 cd 到那个七层深的
 * worktree 路径，是这个界面上最没道理的一段路。
 *
 * 比「一条命令一次请求」多出来的三件事，都是终端之所以是终端的原因：
 *
 * - **cd 留得住**。会话记着自己的 cwd，命令跑完就按它退出时的 `$PWD` 更新。
 *   所以这里的目录**不再跟着文件浏览器走** —— 想去哪儿就 `cd` 过去，和任何
 *   一个终端一样。做法是给每条命令接一段尾巴，把 `$PWD` 写进临时文件；
 *   维持一个长活的 shell 会话看起来更直接，但那要处理伪终端、并发写入、
 *   以及「一条命令把 shell 自己搞死了」之后的状态重建，代价高得多。
 * - **输出边跑边出**。`npm install` 要跑一分钟，`npm run dev` 根本不打算结束 ——
 *   等它 exit 再一次性回结果，等于把这两类命令整个排除在外。输出走 SSE，
 *   一小段一小段地推。
 * - **能按 ctrl+c**。命令跑在自己的进程组里（`spawnProcess` 的 `detached`），
 *   SIGINT 发给整组，和终端里前台进程组收到的完全一样。
 *
 * 一件它做不到的事要说在明处：**这不是伪终端**。stdout 是管道不是 tty，
 * 所以 `vim`、`top` 这类要求终端的程序在这儿跑不起来，多数工具也会自动
 * 关掉彩色输出。给 stdin 留了口子（能回答 `npm init` 的提问），但没有行编辑、
 * 没有作业控制。
 *
 * 环境**不清洗**（与 `agents/env.ts` 相反）。那边清洗是为了守住「Agent 只用
 * 你的 CLI 登录态」；这边是用户亲手敲的命令，把 `GITHUB_TOKEN` 洗掉只会让
 * `git push` 神秘地失败，而他根本不会想到是看板动的手。
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { spawnProcess, type ProcessHandle } from '../subprocess/index.ts'

/**
 * 回放缓冲最多留多少字节的输出。
 *
 * 它的用处只有一个：断线重连、或者从别的页面切回来时，屏幕上不该是空的。
 * 再往前的历史留着也没人翻 —— 真要找，`npm run dev` 的日志本来就在它自己
 * 的文件里。封顶还顺带挡住了「没人看着的会话把 host 的内存吃光」。
 */
export const SCROLLBACK_BYTES = 256 * 1024

/** 攒够这么多字节就立刻推一帧，不等下一个合帧窗口。 */
const FLUSH_BYTES = 8 * 1024

/**
 * 输出合帧间隔。
 *
 * 一条命令可能一秒吐几千个小块，逐块推给浏览器的话，光是 SSE 的帧头就比
 * 内容还多，页面还要为此重渲染几千次。40ms 在人眼里仍然是"实时"。
 */
const FLUSH_MS = 40

/** 没人看着的会话留多久。到点连同它正在跑的命令一起收掉。 */
export const DEFAULT_IDLE_MS = 10 * 60_000

/** 同时最多留几个会话。超了就先收掉闲得最久的那个。 */
export const DEFAULT_MAX_SESSIONS = 8

/** 多久扫一遍过期会话。 */
const SWEEP_MS = 30_000

/**
 * 进程退出之后，再给管道多少时间把最后一段输出交出来。
 *
 * 必须**有上限**：`npm run dev &` 这样的后台进程会一直攥着 stdout，等管道
 * 关闭等于让终端再也回不到提示符。真实终端在这件事上的做法正是这样 ——
 * 前台命令一结束就还你提示符，后台那位的输出继续往屏幕上撞。
 */
const TAIL_MS = 250

/**
 * `closed` 是会话自己的讣告，不是某条命令的事。
 *
 * 有它，订阅者才知道自己接的这条流已经没有对端了 —— 少了这一句，页面会
 * 对着一个早已不存在的会话继续显示提示符，直到用户敲下一条命令才撞上 404。
 */
export type ShellEventKind = 'began' | 'out' | 'err' | 'ended' | 'closed'

export interface ShellEvent {
  /** 会话内单调递增，断线重连时的游标。 */
  readonly seq: number
  readonly kind: ShellEventKind
  readonly payload: Record<string, unknown>
}

/** 会话此刻的样子。新订阅者先拿它对齐提示符与「有没有命令在跑」。 */
export interface ShellSnapshot {
  readonly id: string
  readonly cwd: string
  /** 给人看的 cwd：家目录以内缩成 `~/…`，绝对路径太长，提示符上放不下。 */
  readonly label: string
  /** 正在跑的命令；空闲时为 null。 */
  readonly running: string | null
  /** 已发出的最后一个 seq。 */
  readonly seq: number
}

/** 已经有命令在跑了。终端一次只跑一条 —— 第二条该等，而不是并排跑。 */
export class ShellBusyError extends Error {
  /** 正占着这个会话的那条命令。 */
  readonly running: string

  constructor(running: string) {
    super(`会话里还有一条命令在跑：${running}`)
    this.name = 'ShellBusyError'
    // 写成参数属性（`constructor(readonly running: string)`）在这里跑不起来：
    // host 是被 `node --experimental-strip-types` 直接执行的，那套模式只擦
    // 类型、不生成代码。
    this.running = running
  }
}

/**
 * 把绝对路径缩成给人看的样子。
 *
 * 提示符只有一行宽，而 worktree 的路径动辄七八层。家目录缩成 `~` 是所有
 * 终端的老规矩，认得出来。
 */
export function tilde(path: string): string {
  const home = homedir()
  if (path === home) return '~'
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path
}

/**
 * 跑命令用的 shell。
 *
 * 用非交互的 `-c`：登录 shell（`-lc`）会加载用户的 rc 文件，那里面常有
 * `nvm use`、欢迎横幅之类的东西，输出会混进命令结果里，而且每条命令都要
 * 重跑一遍。PATH 从 host 进程继承，跟 Agent CLI 探测到的是同一份，行为一致。
 */
function shellArgv(script: string): string[] {
  if (process.platform === 'win32') return ['cmd.exe', '/d', '/s', '/c', script]
  return [process.env['SHELL'] ?? '/bin/sh', '-c', script]
}

/** 单引号包一段路径，供 POSIX shell 使用。 */
function quoted(path: string): string {
  return `'${path.replaceAll("'", String.raw`'\''`)}'`
}

/**
 * 给命令接一段尾巴，把它退出时的 `$PWD` 写进 `statePath`。
 *
 * 尾巴另起一行，而不是用 `;` 接在后面：命令可能以 `#` 注释结尾，接在同一行
 * 会被整段吃掉。退出码要原样传出去 —— 尾巴自己的成败不能顶替命令的结果。
 *
 * 命令以续行符或未闭合的引号结尾时，尾巴会被当成命令的一部分吞掉，于是这次
 * 没有 cwd 可更新。那是个语法错误的命令，用户马上会看到 shell 的报错，
 * 目录停在原地是此时最不意外的结果。
 */
function scriptFor(command: string, statePath: string): string {
  if (process.platform === 'win32') {
    return `${command}\r\n@set __lk_status=%ERRORLEVEL%\r\n@cd > "${statePath}"\r\n@exit /b %__lk_status%\r\n`
  }
  // fish 不认 `$?` 也不认 `name=value`，照 POSIX 写会在**每条命令之后**都吐
  // 一行语法错误 —— 那比"记不住 cd"难解释得多。
  if (basename(process.env['SHELL'] ?? '') === 'fish') {
    return `${command}\nset -l __lk_status $status\nprintf %s $PWD > ${quoted(statePath)} 2>/dev/null\nexit $__lk_status\n`
  }
  return `${command}\n__lk_status=$?\nprintf %s "$PWD" > ${quoted(statePath)} 2>/dev/null\nexit $__lk_status\n`
}

/** 正在跑的那条命令。 */
interface Running {
  readonly command: string
  readonly startedAt: number
  /** spawn 还没回来时为 null —— 这中间到达的信号记在 `pendingSignal` 上。 */
  handle: ProcessHandle | null
  pendingSignal: NodeJS.Signals | null
  /** 用户按过 ctrl+c；结束时据此说「被中断」而不是「退出码 130」。 */
  interrupted: boolean
  readonly streams: Readable[]
}

type Listener = (event: ShellEvent) => void

/**
 * 一个终端会话。
 *
 * 生命周期由 {@link ShellHub} 管：没人订阅超过 `idleMs` 就连人带命令收掉。
 * 一个网页终端最不该干的事，是在用户关掉标签页之后，还在机器上留一个
 * 谁也看不见的 `npm run dev`。
 */
export class ShellSession {
  readonly id = randomUUID()
  readonly createdAt = Date.now()

  private currentCwd: string
  private seq = 0
  private running: Running | null = null
  private closed = false
  /**
   * 命令已经结束、但还攥着输出管道的进程树。
   *
   * 典型是 `npm run dev &`：前台的 shell 早退了，后台那位还活着。会话关掉时
   * 要连它们一起收 —— 网页终端最不该干的事就是在机器上留下没人认领的进程。
   */
  private readonly strays = new Set<ProcessHandle>()

  /** 回放缓冲，连同它当前占了多少字节。 */
  private readonly scrollback: ShellEvent[] = []
  private scrollbackBytes = 0

  private readonly listeners = new Set<Listener>()
  /** 最后一个订阅者离开的时刻；有人看着时为 null。 */
  private idleSince: number | null = Date.now()

  /** 攒着待推的输出，按到达顺序，同一路相邻的会合并。 */
  private pending: { kind: 'out' | 'err'; text: string }[] = []
  private pendingBytes = 0
  private flushTimer: NodeJS.Timeout | null = null

  /**
   * 有几个订阅者写不动了。
   *
   * 大于 0 时暂停读子进程的输出 —— 这正是终端的行为：读得慢，写的人就该
   * 被堵住。少了这一层，一条 `find /` 会在服务端攒出几百兆待发数据。
   */
  private holds = 0

  constructor(cwd: string) {
    this.currentCwd = cwd
  }

  get cwd(): string {
    return this.currentCwd
  }

  get busy(): boolean {
    return this.running !== null
  }

  /** 此刻有没有人看着。 */
  get watched(): boolean {
    return this.listeners.size > 0
  }

  /** 闲了多久（毫秒）。有人订阅时为 0。 */
  idleFor(now = Date.now()): number {
    return this.idleSince === null ? 0 : now - this.idleSince
  }

  snapshot(): ShellSnapshot {
    return {
      id: this.id,
      cwd: this.currentCwd,
      label: tilde(this.currentCwd),
      running: this.running?.command ?? null,
      seq: this.seq,
    }
  }

  /** 回放缓冲里 `after` 之后的事件。被挤掉的补不回来，那是缓冲的代价。 */
  replay(after: number): ShellEvent[] {
    return this.scrollback.filter((event) => event.seq > after)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    this.idleSince = null
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.idleSince = Date.now()
    }
  }

  /**
   * 读输出的一方写不动了，把水龙头关小。
   *
   * 与 {@link release} 成对。订阅者中途断开时**必须** release，否则子进程
   * 会被一个已经不存在的读者永远堵住。
   */
  hold(): void {
    this.holds += 1
    if (this.holds === 1) this.pauseStreams()
  }

  release(): void {
    if (this.holds === 0) return
    this.holds -= 1
    if (this.holds === 0) this.resumeStreams()
  }

  /**
   * 跑一条命令。**不等它结束** —— 输出与结局都从事件流里出去。
   *
   * @throws {ShellBusyError} 已经有命令在跑。
   */
  exec(command: string): void {
    if (this.closed) throw new Error('会话已经关了')
    if (this.running !== null) throw new ShellBusyError(this.running.command)
    const entry: Running = {
      command,
      startedAt: Date.now(),
      handle: null,
      pendingSignal: null,
      interrupted: false,
      streams: [],
    }
    // 先占住位子再去 spawn：spawn 是异步的，这中间来的第二条命令必须被拒。
    this.running = entry
    this.emit('began', { command, cwd: this.currentCwd, label: tilde(this.currentCwd) })
    void this.run(entry)
  }

  /**
   * 往正在跑的命令的 stdin 里写。
   *
   * 没有 tty 就没有回显 —— 界面自己把用户敲的那一行画出来，这里只管送。
   *
   * @param data - 原样写进去，换行也由调用方决定。
   * @param eof - 写完关掉 stdin，相当于 ctrl+d。等着读完整份输入的命令
   *   （`cat`、`sort`）不关就永远不会结束。
   * @returns 有没有送出去。命令已经结束时为 false。
   */
  input(data: string, eof = false): boolean {
    const stdin = this.running?.handle?.stdin
    if (stdin === undefined || stdin === null || stdin.destroyed) return false
    if (data.length > 0) stdin.write(data)
    if (eof) stdin.end()
    return true
  }

  /**
   * 给正在跑的命令发信号，收的是**整个进程组**。
   *
   * 这是 ctrl+c 的实现：终端按下 ctrl+c 时，tty 的线路规程把 SIGINT 发给
   * 前台进程组，而不是某一个 pid。只发给直接子进程的话，`npm run dev` 起的
   * 那串孙进程会活下来，端口继续占着。
   *
   * @returns 有没有发出去。没有命令在跑时为 false。
   */
  signal(sig: NodeJS.Signals = 'SIGINT'): boolean {
    const entry = this.running
    if (entry === null) return false
    if (sig === 'SIGINT') entry.interrupted = true
    if (entry.handle === null) {
      // spawn 还在飞。记下来，进程一到手就补发 —— 不然这一下就丢了。
      entry.pendingSignal = sig
      return true
    }
    signalGroup(entry.handle.pid, sig)
    return true
  }

  /**
   * 收掉会话：正在跑的命令连同整棵进程树一起终止。幂等。
   *
   * 最后一件事是给还接着的订阅者发一句 `closed`。**不能只是把 listeners
   * 清掉就走** —— 那样对面那条 SSE 连接还开着、心跳还在发，页面会以为
   * 终端好端端地活着，而它对应的会话已经没了。
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const entry = this.running
    // 被暂停的流不会再有 'end'，terminate 会一直等下去。先把水龙头开到底。
    this.holds = 0
    this.resumeStreams()
    const trees = [...this.strays, ...(entry?.handle == null ? [] : [entry.handle])]
    this.strays.clear()
    await Promise.all(trees.map(async (tree) => tree.terminate().catch(() => undefined)))
    // 讣告要在终止**之后**：这中间可能还会冒出最后一条 `ended`，那也是
    // 订阅者该看到的。
    this.emit('closed', {})
    this.listeners.clear()
  }

  // ── 内部 ────────────────────────────────────────────────

  private async run(entry: Running): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'loopkanban-shell-')).catch(() => null)
    const statePath = dir === null ? null : join(dir, 'cwd')
    const startedAt = entry.startedAt

    let handle: ProcessHandle
    try {
      handle = await spawnProcess({
        argv: shellArgv(statePath === null ? entry.command : scriptFor(entry.command, statePath)),
        cwd: this.currentCwd,
        stdin: 'pipe',
        // 终止时先 SIGTERM 给它收尾的机会，再 SIGKILL —— 由 spawnProcess 分级处理。
        graceMs: 2_000,
      })
    } catch (error) {
      // 起不来（cwd 刚被删掉是最常见的一种）。说清楚是哪一件事，不然界面上
      // 只剩一条永远"执行中"的命令。
      this.finish(entry, { code: null, signal: null }, startedAt, describe(error))
      if (dir !== null) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      return
    }

    entry.handle = handle
    if (this.closed) {
      // 会话在 spawn 还没回来的这一小会儿里被收掉了（关标签页、到点被回收）。
      // 不补这一刀的话，这棵刚起来的树就没人认领了 —— close() 那时手里还
      // 没有句柄，它什么也收不到。
      await handle.terminate().catch(() => undefined)
    } else if (entry.pendingSignal !== null) {
      signalGroup(handle.pid, entry.pendingSignal)
    }

    const drained = Promise.all([
      this.pipe(handle.stdout, 'out', entry),
      this.pipe(handle.stderr, 'err', entry),
    ])
    const outcome = await handle.exited
    /*
     * 进程退了不等于输出读完了：管道里最后一段往往在退出之后才被读到，
     * 立刻收尾会把它丢在结果外面。但也不能一直等 —— 命令留下的后台进程
     * （`npm run dev &`）会攥着这条管道不放，等下去就是再也回不到提示符。
     */
    const settled = await Promise.race([
      drained.then(() => true),
      new Promise<boolean>((resolve) => { setTimeout(() => { resolve(false) }, TAIL_MS).unref() }),
    ])
    if (!settled) {
      // 还有别人攥着这条管道。它的输出继续往屏幕上撞（和真实终端一样），
      // 但这棵树得记下来 —— 会话关掉时要连它一起收，否则就是留了个孤儿。
      this.strays.add(handle)
      void drained.then(() => { this.strays.delete(handle) })
    }

    if (statePath !== null) await this.adoptCwd(statePath)
    if (dir !== null) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    this.finish(entry, outcome, startedAt, null)
  }

  /** 把一路输出接进合帧队列。 */
  private pipe(stream: Readable | null, kind: 'out' | 'err', entry: Running): Promise<void> {
    if (stream === null) return Promise.resolve()
    entry.streams.push(stream)
    // 多字节字符会被切在两个块中间，逐块 toString 会把中文输出打成乱码。
    const decoder = new StringDecoder('utf8')
    if (this.holds > 0) stream.pause()
    return new Promise<void>((resolve) => {
      stream.on('data', (chunk: Buffer) => { this.push(kind, decoder.write(chunk)) })
      stream.on('error', () => { resolve() })
      stream.on('end', () => { this.push(kind, decoder.end()); resolve() })
      stream.on('close', () => { resolve() })
    })
  }

  private pauseStreams(): void {
    for (const stream of this.running?.streams ?? []) stream.pause()
  }

  private resumeStreams(): void {
    for (const stream of this.running?.streams ?? []) stream.resume()
  }

  /** 命令退出时把 cwd 换成它自己的 `$PWD`。 */
  private async adoptCwd(statePath: string): Promise<void> {
    const raw = await readFile(statePath, 'utf8').catch(() => null)
    const next = raw?.trim() ?? ''
    if (next.length === 0 || next === this.currentCwd) return
    // 目录可能在命令跑完的下一刻就没了（`cd x && rm -rf`）。留在原地比把
    // 会话钉死在一个不存在的路径上强 —— 后者会让之后每条命令都起不来。
    if (!await stat(next).then((info) => info.isDirectory(), () => false)) return
    this.currentCwd = next
  }

  private finish(
    entry: Running,
    outcome: { code: number | null; signal: NodeJS.Signals | null },
    startedAt: number,
    error: string | null,
  ): void {
    this.flush()
    this.running = null
    this.holds = 0
    this.emit('ended', {
      command: entry.command,
      code: outcome.code,
      signal: outcome.signal,
      interrupted: entry.interrupted,
      durationMs: Date.now() - startedAt,
      cwd: this.currentCwd,
      label: tilde(this.currentCwd),
      ...(error === null ? {} : { error }),
    })
  }

  private push(kind: 'out' | 'err', text: string): void {
    if (text.length === 0) return
    const last = this.pending.at(-1)
    if (last !== undefined && last.kind === kind) last.text += text
    else this.pending.push({ kind, text })
    this.pendingBytes += text.length
    if (this.pendingBytes >= FLUSH_BYTES) { this.flush(); return }
    this.flushTimer ??= setTimeout(() => { this.flush() }, FLUSH_MS).unref()
  }

  private flush(): void {
    if (this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null }
    const batch = this.pending
    this.pending = []
    this.pendingBytes = 0
    for (const part of batch) this.emit(part.kind, { text: part.text })
  }

  private emit(kind: ShellEventKind, payload: Record<string, unknown>): void {
    this.seq += 1
    const event: ShellEvent = { seq: this.seq, kind, payload }
    this.scrollback.push(event)
    this.scrollbackBytes += sizeOf(event)
    while (this.scrollbackBytes > SCROLLBACK_BYTES && this.scrollback.length > 1) {
      const dropped = this.scrollback.shift()
      if (dropped !== undefined) this.scrollbackBytes -= sizeOf(dropped)
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // 一个订阅者坏掉不能拖垮其他订阅者，更不能影响正在跑的命令。
      }
    }
  }
}

/** 一条事件在回放缓冲里占多少 —— 只算文本，其余字段是常数级的。 */
function sizeOf(event: ShellEvent): number {
  const text = event.payload['text']
  return typeof text === 'string' ? text.length : 64
}

/** 向整个进程组发信号，组已经没了就当无事发生。 */
function signalGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    // Windows 没有进程组信号；那边只能对着 pid 发，能不能收到由它自己决定。
    process.kill(process.platform === 'win32' ? pid : -pid, sig)
  } catch {
    // ESRCH：命令刚好在这一刻结束了。用户按 ctrl+c 的手速与它无关。
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface ShellHubOptions {
  /** 没人看着的会话留多久，默认 {@link DEFAULT_IDLE_MS}。 */
  readonly idleMs?: number
  /** 同时最多几个会话，默认 {@link DEFAULT_MAX_SESSIONS}。 */
  readonly maxSessions?: number
}

/**
 * 所有终端会话。
 *
 * 会话是**服务端的状态**，这是它区别于原来那个「一条命令一次请求」的地方：
 * 页面切走再切回来，`npm run dev` 还在跑，屏幕还接得上。代价是得有人负责
 * 收尸 —— 没人订阅超过 `idleMs` 就整个收掉，包括它正在跑的命令。
 */
export class ShellHub {
  private readonly sessions = new Map<string, ShellSession>()
  private readonly idleMs: number
  private readonly maxSessions: number
  private sweeper: NodeJS.Timeout | null = null

  constructor(options: ShellHubOptions = {}) {
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
  }

  /**
   * 开一个会话。
   * @param cwd - 起步目录，调用方必须已经校验过它在围栏里。
   */
  open(cwd: string): ShellSession {
    this.sweep()
    // 满了就先收掉闲得最久的那个。收的是"没人看着"里最久的一个，正在被人
    // 盯着的会话不该因为别人开了新终端而消失。
    while (this.sessions.size >= this.maxSessions) {
      const oldest = [...this.sessions.values()].sort((a, b) => b.idleFor() - a.idleFor())[0]
      if (oldest === undefined || oldest.watched) break
      void this.close(oldest.id)
    }
    const session = new ShellSession(cwd)
    this.sessions.set(session.id, session)
    this.sweeper ??= setInterval(() => { this.sweep() }, SWEEP_MS).unref()
    return session
  }

  get(id: string): ShellSession | null {
    return this.sessions.get(id) ?? null
  }

  async close(id: string): Promise<boolean> {
    const session = this.sessions.get(id)
    if (session === undefined) return false
    this.sessions.delete(id)
    await session.close()
    return true
  }

  /** 收掉过期会话。**有人看着的一律不动** —— 哪怕 `idleMs` 是 0。 */
  sweep(now = Date.now()): void {
    for (const session of [...this.sessions.values()]) {
      if (!session.watched && session.idleFor(now) >= this.idleMs) void this.close(session.id)
    }
  }

  /** 关服时把所有会话连同它们的进程树一起收掉。 */
  async dispose(): Promise<void> {
    if (this.sweeper !== null) { clearInterval(this.sweeper); this.sweeper = null }
    const all = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(all.map(async (session) => session.close()))
  }

  /** 当前会话数，供诊断。 */
  get size(): number {
    return this.sessions.size
  }
}
