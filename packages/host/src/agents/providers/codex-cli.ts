/**
 * Codex CLI provider —— 起本机 `PATH` 上的 `codex exec`，不走 API。
 *
 * 认证交给 CLI 自身（`codex login`），LoopKanban 不接受、不存储、不传递任何 key。
 *
 * 与 claude 的两点结构性差异：
 *   1. 会话 id 由 codex 自己生成（`thread.started` 事件里的 `thread_id`），
 *      我们无法预先指定，只能从输出里捞 —— 所以 `canPinSessionId` 为 false。
 *   2. 最终回答可以用 `-o` 直接落文件，完成判定不必靠猜进程退出码。
 */

import { join } from 'node:path'
import type { SpawnSpec } from '../../subprocess/index.ts'
import { capture, findExecutable, probeVersion } from '../discover.ts'
import { scrubEnv } from '../env.ts'
import { choicesOf, hasFlag, parseHelp, type HelpSurface } from '../help-parser.ts'
import type { AgentCaps, AgentEvent, AgentProvider, PermissionTier, RunContext } from '../types.ts'

/** LoopKanban 三档 → codex 的 `--sandbox` 取值。yolo 走独立的 bypass 参数。 */
const TIER_TO_SANDBOX: Record<Exclude<PermissionTier, 'yolo'>, string> = {
  strict: 'read-only',
  standard: 'workspace-write',
}

const BYPASS_FLAG = 'dangerously-bypass-approvals-and-sandbox'

/** 该 Run 的最终回答落盘位置。 */
export function codexLastMessagePath(run: RunContext): string {
  return join(run.artifactsDir, `${run.runId}-last-message.txt`)
}

function supportedTiers(sandboxes: readonly string[], help: ReturnType<typeof parseHelp>): PermissionTier[] {
  const tiers: PermissionTier[] = []
  if (sandboxes.includes(TIER_TO_SANDBOX.strict)) tiers.push('strict')
  if (sandboxes.includes(TIER_TO_SANDBOX.standard)) tiers.push('standard')
  if (hasFlag(help, BYPASS_FLAG)) tiers.push('yolo')
  return tiers
}

/**
 * 权限档位对应的参数片段。
 *
 * 注意：`--approve-for-me` 与 `--sandbox` **互斥** —— 前者自己就隐含
 * workspace-write 沙箱，同时传 `-s` 会被 clap 直接拒绝（exit 2）。
 * 这是实测踩出来的，不是文档写的。
 */
function permissionArgs(run: RunContext, surface: HelpSurface): string[] {
  if (run.permission === 'yolo') {
    return hasFlag(surface, BYPASS_FLAG) ? [`--${BYPASS_FLAG}`] : []
  }
  // 无人值守时优先把审批交给 codex 自己的自动审阅，否则审批请求会悬着没人回答。
  if (run.permission === 'standard' && hasFlag(surface, 'approve-for-me')) {
    return ['--approve-for-me']
  }
  const sandbox = TIER_TO_SANDBOX[run.permission]
  // 续跑路径上这些参数可能都不存在（codex 的 resume 就是），
  // 此时沿用该会话创建时的策略，这也是"接着上次继续"应有的语义。
  return choicesOf(surface, 'sandbox').includes(sandbox) ? ['-s', sandbox] : []
}

/**
 * 拼参数时只用该条路径**自己声明过**的参数。
 *
 * `surface` 必须是这条命令自己的 help 解析结果，不能借用主命令的 ——
 * 这正是当初决定"探测能力而不是判断版本"的同一条道理，只是粒度更细一层。
 */
function commonArgs(run: RunContext, caps: AgentCaps, surface: HelpSurface): string[] {
  const args: string[] = []
  if (caps.streaming && hasFlag(surface, 'json')) args.push('--json')
  // 没有 --cd 时靠子进程自身的 cwd（spawn 时已指向 worktree）。
  if (hasFlag(surface, 'cd')) args.push('-C', run.worktreePath)
  args.push(...permissionArgs(run, surface))
  if (hasFlag(surface, 'output-last-message')) args.push('-o', codexLastMessagePath(run))
  if (run.model !== undefined && hasFlag(surface, 'model')) args.push('-m', run.model)
  return args
}

function str(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const found = (value as Record<string, unknown>)[key]
  return typeof found === 'string' ? found : undefined
}

function num(value: unknown, key: string): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const found = (value as Record<string, unknown>)[key]
  return typeof found === 'number' ? found : undefined
}

const DIAGNOSTIC_MAX = 512

/** 把 file_change 的改动列表压成 `add a.js, modify b.js` 这样的一行。 */
function summarizeChanges(item: unknown): string | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  const changes = (item as Record<string, unknown>)['changes']
  if (!Array.isArray(changes)) return undefined
  return changes
    .map((change) => `${str(change, 'kind') ?? '?'} ${(str(change, 'path') ?? '').split('/').at(-1) ?? ''}`)
    .join(', ')
}

export const codexCliProvider: AgentProvider = {
  id: 'codex',

  async probe(explicitPath?: string): Promise<AgentCaps | null> {
    const bin = findExecutable('codex', explicitPath)
    if (bin === null) return null
    const version = await probeVersion(bin)
    if (version === null) return null

    const execHelp = await capture([bin, 'exec', '--help'])
    const help = parseHelp(`${execHelp.stdout}\n${execHelp.stderr}`)
    if (!hasFlag(help, 'cd')) return null

    // resume 是子命令而非参数，只能靠它自己的 help 是否成立来判断，
    // 并且必须单独解析它的参数面 —— 它和主命令并不一样。
    const resumeProbe = await capture([bin, 'exec', 'resume', '--help'])
    const canResume = resumeProbe.code === 0
    const resumeHelp = parseHelp(`${resumeProbe.stdout}\n${resumeProbe.stderr}`)

    return {
      id: 'codex',
      bin,
      version,
      streaming: hasFlag(help, 'json'),
      // codex 的 thread_id 由它自己生成，我们只能事后从事件里捞。
      canPinSessionId: false,
      canResume,
      canPickModel: hasFlag(help, 'model'),
      // codex 没有列模型的子命令，help 里也没写候选 —— 枚举不出来就如实
      // 给空，界面退回自由输入，而不是编一份清单出来。
      models: [],
      permissionTiers: supportedTiers(choicesOf(help, 'sandbox'), help),
      help,
      ...(canResume ? { resumeHelp } : {}),
    }
  },

  buildStart(run: RunContext, caps: AgentCaps): SpawnSpec {
    // 绝不加 --ephemeral：会话必须落盘才能续跑。
    const argv = [caps.bin, 'exec', ...commonArgs(run, caps, caps.help), run.prompt]
    return { argv, cwd: run.worktreePath, env: scrubEnv(process.env, run.envOverrides).env, stdin: 'ignore', stderr: 'pipe' }
  },

  buildResume(run: RunContext, caps: AgentCaps, sessionId: string): SpawnSpec | null {
    if (!caps.canResume) return null
    const argv = [
      caps.bin, 'exec', 'resume', sessionId,
      ...commonArgs(run, caps, caps.resumeHelp ?? caps.help),
      run.prompt,
    ]
    return { argv, cwd: run.worktreePath, env: scrubEnv(process.env, run.envOverrides).env, stdin: 'ignore', stderr: 'pipe' }
  },

  parseLine(line: string, _caps: AgentCaps): AgentEvent {
    const trimmed = line.trim()
    if (trimmed.length === 0) return { kind: 'raw', line }

    let event: unknown
    try {
      event = JSON.parse(trimmed)
    } catch {
      return { kind: 'raw', line }
    }

    const type = str(event, 'type')

    if (type === 'thread.started') {
      const sessionId = str(event, 'thread_id')
      return sessionId === undefined ? { kind: 'raw', line } : { kind: 'session', sessionId }
    }

    if (type === 'turn.completed') {
      const usage = (event as Record<string, unknown>)['usage']
      const inputTokens = num(usage, 'input_tokens')
      const outputTokens = num(usage, 'output_tokens')
      if (inputTokens !== undefined || outputTokens !== undefined) {
        return {
          kind: 'usage',
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
        }
      }
      return { kind: 'finished', ok: true }
    }

    if (type === 'turn.failed' || type === 'error') {
      const error = (event as Record<string, unknown>)['error']
      const message = str(error, 'message') ?? str(event, 'message') ?? str(error, 'type') ?? 'unknown'
      return { kind: 'finished', ok: false, diagnostic: `codex ${type}: ${message}`.slice(0, DIAGNOSTIC_MAX) }
    }

    if (type === 'item.started' || type === 'item.completed' || type === 'item.updated') {
      const item = (event as Record<string, unknown>)['item']
      const itemType = str(item, 'type')

      if (itemType === 'agent_message') {
        const text = str(item, 'text')
        return text === undefined || text.trim().length === 0
          ? { kind: 'raw', line }
          : { kind: 'text', text }
      }
      // 只在 completed 时上报为工具调用，避免同一个动作被计两次。
      if (itemType !== undefined && type === 'item.completed') {
        return { kind: 'tool', name: itemType, input: item }
      }
      // started 不能直接丢：长命令跑起来后界面会长时间没动静，让人以为卡死。
      // 但也不能把整条 JSON 倒出去，所以压成一行可读的提示。
      if (type === 'item.started' && itemType !== undefined) {
        const command = str(item, 'command')
        const detail = command ?? summarizeChanges(item) ?? ''
        return {
          kind: 'notice',
          level: 'info',
          text: `${itemType}${detail === '' ? '' : ` ${detail.slice(0, 160)}`}`,
        }
      }
      return { kind: 'raw', line }
    }

    return { kind: 'raw', line }
  },
}

/**
 * `turn.completed` 之后并没有独立的「结束」事件，完成信号由调用方结合
 * 进程退出码与 `-o` 落盘的最终回答给出。
 * @param line - 一行 JSONL。
 * @returns 该行是否表示这一轮已正常收尾。
 */
export function codexTurnCompleted(line: string): boolean {
  try {
    return str(JSON.parse(line.trim()), 'type') === 'turn.completed'
  } catch {
    return false
  }
}
