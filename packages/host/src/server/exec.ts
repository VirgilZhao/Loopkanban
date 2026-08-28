/**
 * 命令行工具：在某个工作区里跑一条 shell 命令，把输出原样送回界面。
 *
 * 这是**用户自己的手**，不是 Agent 的：他在看 worktree 里的改动，想 `git log`
 * 一下、想跑一次测试，为此切出去开终端、再 cd 到那个七层深的 worktree 路径，
 * 是这个界面上最没道理的一段路。
 *
 * 三条硬性约束：
 *
 * - **cwd 必须落在已登记项目的仓库里**（由调用方用 `confine` 校验后传进来）。
 *   命令本身当然能自己 `cd /`，拦不住也不打算拦 —— 这层围栏防的是路径拼接
 *   写错，不是防用户。
 * - **超时后收整棵进程树**。走 `spawnProcess` 而不是 `child_process.exec`：
 *   `npm test` 会 fork 出一串孙进程，只 kill 直接子进程会留下一地孤儿在后台
 *   继续烧 CPU，而界面上早就显示"已超时"了。
 * - **输出封顶**。`find /` 这种命令的输出是无限的，不封顶就是把 host 的内存
 *   交给一条手滑的命令。超了就停止累积但**继续排空管道** —— 不排空的话
 *   子进程会写阻塞，永远等不到它退出。
 *
 * 环境**不清洗**（与 `agents/env.ts` 相反）。那边清洗是为了守住「Agent 只用
 * 你的 CLI 登录态」；这边是用户亲手敲的命令，把 `GITHUB_TOKEN` 洗掉只会让
 * `git push` 神秘地失败，而他根本不会想到是看板动的手。
 */

import { spawnProcess } from '../subprocess/index.ts'

/** 一条命令最多跑多久。够跑一次测试，又不至于让页面上挂一个永远不回来的请求。 */
export const DEFAULT_EXEC_TIMEOUT_MS = 120_000

/** 上限：再长的超时也不许要，否则等于没有超时。 */
export const MAX_EXEC_TIMEOUT_MS = 600_000

/** stdout / stderr 各自最多回多少字节。 */
export const MAX_OUTPUT_BYTES = 256 * 1024

export interface ExecResult {
  readonly command: string
  readonly cwd: string
  readonly stdout: string
  readonly stderr: string
  /** 被信号打断时为 null，此时看 `signal`。 */
  readonly code: number | null
  readonly signal: string | null
  /** 有一路输出撞到了 {@link MAX_OUTPUT_BYTES}。 */
  readonly truncated: boolean
  readonly timedOut: boolean
  readonly durationMs: number
}

/**
 * 跑命令用的 shell。
 *
 * 用非交互的 `-c`：登录 shell（`-lc`）会加载用户的 rc 文件，那里面常有
 * `nvm use`、欢迎横幅之类的东西，输出会混进命令结果里，而且每条命令都要
 * 重跑一遍。PATH 从 host 进程继承，跟 Agent CLI 探测到的是同一份，行为一致。
 *
 * 导出是给测试环境用的（`testenv/`）：那边起的也是用户亲手配的一条命令，
 * 两处对"用哪个 shell、加不加载 rc"必须是同一个答案，否则同一条命令在
 * 命令行里跑得通、一键试跑却起不来，而人根本无从分辨差别在哪。
 */
export function shellArgv(command: string): string[] {
  if (process.platform === 'win32') return ['cmd.exe', '/d', '/s', '/c', command]
  return [process.env['SHELL'] ?? '/bin/sh', '-c', command]
}

/**
 * 读一路输出，最多留 `limit` 字节，但**始终把管道排空**。
 *
 * 早早 `destroy()` 掉流看似省事，实际会让子进程在下一次写入时拿到 EPIPE
 * 而死掉 —— 那是我们替它做的决定，不是它自己的结果。
 */
async function drain(stream: NodeJS.ReadableStream | null, limit: number): Promise<{ text: string; truncated: boolean }> {
  if (stream === null) return { text: '', truncated: false }
  const chunks: Buffer[] = []
  let kept = 0
  let truncated = false
  for await (const chunk of stream) {
    const buffer = chunk as Buffer
    if (kept >= limit) { truncated = true; continue }
    const room = limit - kept
    if (buffer.length > room) {
      chunks.push(buffer.subarray(0, room))
      kept = limit
      truncated = true
    } else {
      chunks.push(buffer)
      kept += buffer.length
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated }
}

/**
 * 在 `cwd` 里跑一条命令。
 *
 * @param command - 原样交给 shell 的命令行。
 * @param cwd - 工作目录，调用方必须已经校验过它在围栏里。
 * @param timeoutMs - 超时，默认 {@link DEFAULT_EXEC_TIMEOUT_MS}，上限 {@link MAX_EXEC_TIMEOUT_MS}。
 * @returns 命令的结果。命令自己失败（非零退出）**不抛异常** —— 那是它的
 *   输出而不是我们的故障，界面要照实显示退出码。
 */
export async function runCommand(
  command: string,
  cwd: string,
  timeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
): Promise<ExecResult> {
  const budget = Math.min(Math.max(timeoutMs, 1_000), MAX_EXEC_TIMEOUT_MS)
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, budget)
  const startedAt = Date.now()

  try {
    const handle = await spawnProcess({
      argv: shellArgv(command),
      cwd,
      // 超时后先 SIGTERM 给它收尾的机会，再 SIGKILL —— 由 spawnProcess 分级处理。
      graceMs: 2_000,
      signal: controller.signal,
    })
    const [out, err, outcome] = await Promise.all([
      drain(handle.stdout, MAX_OUTPUT_BYTES),
      drain(handle.stderr, MAX_OUTPUT_BYTES),
      handle.exited,
    ])
    return {
      command,
      cwd,
      stdout: out.text,
      stderr: err.text,
      code: outcome.code,
      signal: outcome.signal,
      truncated: out.truncated || err.truncated,
      timedOut,
      durationMs: Date.now() - startedAt,
    }
  } finally {
    clearTimeout(timer)
  }
}
