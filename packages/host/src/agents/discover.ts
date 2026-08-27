/**
 * 可执行文件发现与探测执行。
 *
 * 发现顺序：显式配置路径 → `PATH` → 常见安装位置兜底。
 * 兜底不是多余的：macOS 上从桌面启动器（而非终端）拉起的进程往往拿不到
 * 用户 shell 里的 `PATH`，而 `claude` 常常就装在 `~/.local/bin`。
 */

import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { spawnProcess } from '../subprocess/index.ts'

/** 探测命令的超时；探测不该让启动挂住。 */
const PROBE_TIMEOUT_MS = 10_000

/** `PATH` 之外的兜底查找目录。 */
function fallbackDirs(): string[] {
  const home = homedir()
  return [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.codex', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.volta', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ]
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 找到可执行文件的绝对路径。
 * @param name - 可执行文件名，例如 `claude`。
 * @param explicitPath - 用户在设置里指定的绝对路径，优先于一切。
 * @returns 绝对路径；找不到返回 null。
 */
export function findExecutable(name: string, explicitPath?: string): string | null {
  if (explicitPath !== undefined && explicitPath.length > 0) {
    // 显式指定却不可用时返回 null 而不是静默回退 —— 用户明确指了路径，
    // 偷偷用别的会让「我明明指向了新版本」变成难查的怪事。
    return isAbsolute(explicitPath) && isExecutable(explicitPath) ? explicitPath : null
  }

  const pathDirs = (process.env['PATH'] ?? '').split(delimiter).filter((d) => d.length > 0)
  for (const dir of [...pathDirs, ...fallbackDirs()]) {
    const candidate = join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

export interface CaptureResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number | null
}

/**
 * 跑一条短命令并收集全部输出，用于 `--version` / `--help` 探测。
 * @param argv - 完整命令行。
 * @param timeoutMs - 超时，默认 {@link PROBE_TIMEOUT_MS}。
 */
export async function capture(argv: readonly string[], timeoutMs = PROBE_TIMEOUT_MS): Promise<CaptureResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const handle = await spawnProcess({
      argv,
      cwd: process.cwd(),
      graceMs: 500,
      signal: controller.signal,
    })
    const readAll = async (stream: NodeJS.ReadableStream | null): Promise<string> => {
      if (stream === null) return ''
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(chunk as Buffer)
      return Buffer.concat(chunks).toString('utf8')
    }
    const [stdout, stderr, outcome] = await Promise.all([
      readAll(handle.stdout),
      readAll(handle.stderr),
      handle.exited,
    ])
    return { stdout, stderr, code: outcome.code }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 探测版本号。CLI 之间不一致：有的打到 stdout，有的打到 stderr。
 * @param bin - 可执行文件绝对路径。
 * @returns 版本字符串；探测失败返回 null。
 */
export async function probeVersion(bin: string): Promise<string | null> {
  try {
    const { stdout, stderr, code } = await capture([bin, '--version'])
    if (code !== 0) return null
    const text = (stdout.trim().length > 0 ? stdout : stderr).trim()
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}
