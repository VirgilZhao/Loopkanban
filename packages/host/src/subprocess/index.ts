/**
 * 进程组持有与分级终止。
 *
 * 这是整个项目最容易写错、错了代价最大的一块：Agent CLI 会 fork 出编译器、
 * 测试进程、语言服务器等孙进程，只 kill 直接子进程会留下一地孤儿，既烧钱
 * 又占资源。所以规格写死：
 *
 *   - Unix：`detached: true` 让子进程 setsid 成为进程组组长，终止时对整个
 *     进程组发信号（`kill(-pgid)`），而不是单个 pid。
 *   - 分级升级：SIGTERM → 等 grace → SIGKILL。
 *   - **等整棵树真的退出后才宣告终止完成**。组长退出后被 reparent 的孙进程
 *     仍然保留原 pgid，所以 `kill(-pgid, 0)` 探活能发现它们。
 *   - `terminate()` 幂等，并发调用共享同一次终止过程。
 *
 * 手法参考 DeepSeek Harness 的 dsh-subprocess。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

/** 默认的分级终止宽限期。 */
export const DEFAULT_GRACE_MS = 3_000

/** SIGKILL 之后等待整棵树退出的硬上限，超过则如实上报未静默。 */
const TREE_KILL_TIMEOUT_MS = 5_000

/**
 * 进程自然退出后，给孙进程一点收尾时间再判定树是否静默。
 * 不能等太久：正常跑完的任务不该每次都卡几秒。
 */
const NATURAL_EXIT_PROBE_MS = 250

/** 探活轮询间隔。 */
const TREE_POLL_MS = 50

export interface SpawnSpec {
  /** `[可执行文件, ...参数]`，第一项必须非空。 */
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
  /** stdin 默认 `ignore`；需要向 CLI 写入时设为 `pipe`。 */
  readonly stdin?: 'pipe' | 'ignore'
  /** stderr 默认 `pipe`；调试时可设 `inherit` 直接透到终端。 */
  readonly stderr?: 'pipe' | 'inherit'
  /** SIGTERM 与 SIGKILL 之间的宽限期，默认 {@link DEFAULT_GRACE_MS}。 */
  readonly graceMs?: number
  /** 外部取消信号；触发时自动 terminate。 */
  readonly signal?: AbortSignal
}

export interface ProcessOutcome {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  /** 终止流程结束时，进程组内是否仍探测到存活成员。 */
  readonly treeQuiesced: boolean
}

export interface ProcessHandle {
  readonly pid: number
  readonly stdout: Readable
  readonly stderr: Readable | null
  readonly stdin: Writable | null
  /** 进程自然退出（或被终止）后 settle。 */
  readonly exited: Promise<ProcessOutcome>
  /** 已退出则返回结果，否则 undefined。 */
  outcome(): ProcessOutcome | undefined
  /** 幂等的分级终止；返回时整棵树已退出（或已达硬超时，见 treeQuiesced）。 */
  terminate(): Promise<ProcessOutcome>
}

/** Unix 上探测进程组内是否还有存活成员。 */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    // ESRCH = 组内已无成员；EPERM = 有成员但无权限，仍算存活。
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** 向整个进程组发信号，进程组已消失时静默返回。 */
function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

/** Windows 上没有进程组信号，用 taskkill 递归终止整棵树。 */
function taskkillTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    killer.on('error', () => { resolve() })
    killer.on('exit', () => { resolve() })
  })
}

/** 轮询等待整棵树退出，返回是否真的静默了。 */
async function waitForTreeExit(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) return true
    await delay(TREE_POLL_MS)
  }
  return !groupAlive(pgid)
}

class Handle implements ProcessHandle {
  readonly pid: number
  readonly stdout: Readable
  readonly stderr: Readable | null
  readonly stdin: Writable | null
  readonly exited: Promise<ProcessOutcome>

  private readonly graceMs: number
  private best: ProcessOutcome | undefined
  /** 子进程自身退出（尚未确认整棵树）。 */
  private readonly childExited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  private terminating: Promise<ProcessOutcome> | undefined

  constructor(child: ChildProcess, graceMs: number) {
    if (child.pid === undefined) throw new Error('subprocess: spawned child has no pid')
    this.pid = child.pid
    this.graceMs = graceMs
    this.stdout = child.stdout as Readable
    this.stderr = child.stderr
    this.stdin = child.stdin

    this.childExited = new Promise((resolve) => {
      child.once('exit', (code, signal) => { resolve({ code, signal }) })
    })

    this.exited = this.childExited.then(async ({ code, signal }) => {
      // 组长退出不等于树退出：被 reparent 的孙进程仍带着原 pgid。这里只做短探测，
      // 真正的清理由 terminate() 负责 —— 正常跑完的任务不该每次都卡几秒。
      const treeQuiesced = process.platform === 'win32'
        ? true
        : await waitForTreeExit(this.pid, NATURAL_EXIT_PROBE_MS)
      return this.record({ code, signal, treeQuiesced })
    })
  }

  outcome(): ProcessOutcome | undefined {
    return this.best
  }

  terminate(): Promise<ProcessOutcome> {
    this.terminating ??= this.runTermination()
    return this.terminating
  }

  /** 记录已知最好的结果：树已静默的判定优先于未静默的。 */
  private record(next: ProcessOutcome): ProcessOutcome {
    if (this.best === undefined || (next.treeQuiesced && !this.best.treeQuiesced)) {
      this.best = next
    }
    return this.best
  }

  private async runTermination(): Promise<ProcessOutcome> {
    if (process.platform === 'win32') {
      await taskkillTree(this.pid)
      return this.exited
    }

    signalGroup(this.pid, 'SIGTERM')

    // 关键：等的是**整棵树**而不只是组长。组长可能秒退却留下孙进程
    // （典型场景：Agent 跑完了，但它起的 dev server / 测试进程还在）。
    let quiesced = await waitForTreeExit(this.pid, this.graceMs)
    if (!quiesced) {
      signalGroup(this.pid, 'SIGKILL')
      quiesced = await waitForTreeExit(this.pid, TREE_KILL_TIMEOUT_MS)
    }

    const { code, signal } = await this.childExited
    return this.record({ code, signal, treeQuiesced: quiesced })
  }
}

/**
 * 起一个进程组隔离的子进程。
 * @param spec - 可执行文件、参数、工作目录与终止策略。
 * @returns 已就绪的句柄；spawn 本身失败时 reject。
 */
export async function spawnProcess(spec: SpawnSpec): Promise<ProcessHandle> {
  const [command, ...args] = spec.argv
  if (command === undefined || command.length === 0) {
    throw new Error('subprocess: argv is empty')
  }
  if (spec.signal?.aborted === true) {
    throw new Error('subprocess: aborted before spawn')
  }

  const child = spawn(command, args, {
    cwd: spec.cwd,
    env: spec.env ?? process.env,
    // setsid：子进程成为进程组组长，pgid === pid，整棵树可被一次信号覆盖。
    detached: process.platform !== 'win32',
    stdio: [spec.stdin ?? 'ignore', 'pipe', spec.stderr ?? 'pipe'],
    windowsHide: true,
  })

  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })

  const handle = new Handle(child, spec.graceMs ?? DEFAULT_GRACE_MS)

  if (spec.signal !== undefined) {
    const onAbort = (): void => { void handle.terminate() }
    spec.signal.addEventListener('abort', onAbort, { once: true })
    void handle.exited.finally(() => { spec.signal?.removeEventListener('abort', onAbort) })
  }

  return handle
}
