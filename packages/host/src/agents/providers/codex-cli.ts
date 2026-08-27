/**
 * Codex CLI provider —— 起本机 `PATH` 上的 `codex exec`，不走 API。
 *
 * 认证交给 CLI 自身（`codex login`），OpenKanban 不接受、不存储、不传递任何 key。
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
import { choicesOf, hasFlag, parseHelp } from '../help-parser.ts'
import type { AgentCaps, AgentEvent, AgentProvider, PermissionTier, RunContext } from '../types.ts'

/** OpenKanban 三档 → codex 的 `--sandbox` 取值。yolo 走独立的 bypass 参数。 */
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
function permissionArgs(run: RunContext, caps: AgentCaps): string[] {
  if (run.permission === 'yolo') {
    return hasFlag(caps.help, BYPASS_FLAG) ? [`--${BYPASS_FLAG}`] : []
  }
  // 无人值守时优先把审批交给 codex 自己的自动审阅，否则审批请求会悬着没人回答。
  if (run.permission === 'standard' && hasFlag(caps.help, 'approve-for-me')) {
    return ['--approve-for-me']
  }
  const sandbox = TIER_TO_SANDBOX[run.permission]
  return choicesOf(caps.help, 'sandbox').includes(sandbox) ? ['-s', sandbox] : []
}

function commonArgs(run: RunContext, caps: AgentCaps): string[] {
  const args: string[] = []
  if (caps.streaming) args.push('--json')
  args.push('-C', run.worktreePath)
  args.push(...permissionArgs(run, caps))
  if (hasFlag(caps.help, 'output-last-message')) args.push('-o', codexLastMessagePath(run))
  if (run.model !== undefined && hasFlag(caps.help, 'model')) args.push('-m', run.model)
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

    // resume 是子命令而非参数，只能靠它自己的 help 是否成立来判断。
    const resumeHelp = await capture([bin, 'exec', 'resume', '--help'])
    const canResume = resumeHelp.code === 0

    return {
      id: 'codex',
      bin,
      version,
      streaming: hasFlag(help, 'json'),
      // codex 的 thread_id 由它自己生成，我们只能事后从事件里捞。
      canPinSessionId: false,
      canResume,
      permissionTiers: supportedTiers(choicesOf(help, 'sandbox'), help),
      help,
    }
  },

  buildStart(run: RunContext, caps: AgentCaps): SpawnSpec {
    // 绝不加 --ephemeral：会话必须落盘才能续跑。
    const argv = [caps.bin, 'exec', ...commonArgs(run, caps), run.prompt]
    return { argv, cwd: run.worktreePath, env: scrubEnv(process.env, run.envOverrides).env, stdin: 'ignore', stderr: 'pipe' }
  },

  buildResume(run: RunContext, caps: AgentCaps, sessionId: string): SpawnSpec | null {
    if (!caps.canResume) return null
    const argv = [caps.bin, 'exec', 'resume', sessionId, ...commonArgs(run, caps), run.prompt]
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
      // 只在 completed 时上报工具，避免同一个动作被 started/completed 报两遍。
      if (itemType !== undefined && type === 'item.completed') {
        return { kind: 'tool', name: itemType, input: item }
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
