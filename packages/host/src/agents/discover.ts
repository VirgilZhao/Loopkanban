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

/**
 * `PATH` 之外的兜底查找目录。
 *
 * 这里只放**与具体 CLI 无关**的通用位置。某家自己惯用的安装目录
 * （`~/.claude/local` 之类）由该 provider 用 `extraDirs` 声明 ——
 * 否则每接一个新 CLI 都得回来改这个函数。
 */
function fallbackDirs(): string[] {
  const home = homedir()
  return [
    join(home, '.local', 'bin'),
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
 *
 * 顺序：`PATH` → 通用兜底目录 → 该 CLI 自己的安装位置。
 *
 * **`extraDirs` 排在最后**，不能提前：它们多半是某个版本的历史遗留
 * （`~/.claude/local` 就是 `claude migrate-installer` 留下的），当代安装器
 * 装到的是 `~/.local/bin`。谁在前面谁说了算，把遗留目录排到前面，等于让
 * 同时装过两次的人静默地跑在旧版本上 —— 而这条兜底路径专为「从桌面启动器
 * 拉起、拿不到 shell `PATH`」的场景准备，恰恰是平时不会有人发现的那条。
 *
 * @param name - 可执行文件名，例如 `claude`。
 * @param explicitPath - 用户在设置里指定的绝对路径，优先于一切。
 * @param extraDirs - 这个 CLI 自己惯用的安装位置，仅在别处都找不到时才用。
 * @returns 绝对路径；找不到返回 null。
 */
export function findExecutable(
  name: string, explicitPath?: string, extraDirs: readonly string[] = [],
): string | null {
  if (explicitPath !== undefined && explicitPath.length > 0) {
    // 显式指定却不可用时返回 null 而不是静默回退 —— 用户明确指了路径，
    // 偷偷用别的会让「我明明指向了新版本」变成难查的怪事。
    return isAbsolute(explicitPath) && isExecutable(explicitPath) ? explicitPath : null
  }

  const pathDirs = (process.env['PATH'] ?? '').split(delimiter).filter((d) => d.length > 0)
  for (const dir of [...pathDirs, ...fallbackDirs(), ...extraDirs]) {
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
 * @param cwd - 工作目录，默认本进程的。`git` 一律用 `-C` 指目录，但 `gh`
 *   只认"当前在哪个仓库里"，那条路径没法写进参数。
 */
export async function capture(
  argv: readonly string[], timeoutMs = PROBE_TIMEOUT_MS, cwd = process.cwd(),
): Promise<CaptureResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const handle = await spawnProcess({
      argv,
      cwd,
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
