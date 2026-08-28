/**
 * Claude Code CLI provider —— 起本机 `PATH` 上的 `claude`，不走 API。
 *
 * 认证与配置完全交给 CLI 自身：我们不省略 `--setting-sources`，所以用户的
 * user/project/local 设置（CLAUDE.md、MCP server、权限）都照常生效。
 * LoopKanban 不接受、不存储、不传递任何 API Key。
 */

import { join } from 'node:path'
import type { SpawnSpec } from '../../subprocess/index.ts'
import { capture, findExecutable, probeVersion } from '../discover.ts'
import { scrubEnv } from '../env.ts'
import { choicesOf, describeFlag, hasFlag, parseHelp } from '../help-parser.ts'
import type { AgentCaps, AgentEvent, AgentProvider, PermissionTier, RunContext } from '../types.ts'

/**
 * LoopKanban 三档 → claude 的 `--permission-mode` 取值。
 *
 * standard 用 `auto` 而不是 `acceptEdits`：实测 `acceptEdits` 只放行文件
 * 编辑，Bash 一律 `permission_denied`，Agent 写完代码跑不了测试也跑不了
 * 构建，等于交出一份没验证过的活。`auto` 走 CLI 自己的分类器，语义上才
 * 对得上 codex 的 `--approve-for-me`。
 */
const TIER_TO_MODE: Record<PermissionTier, readonly string[]> = {
  strict: ['dontAsk'],
  // 按偏好排序，取该版本支持的第一个。
  standard: ['auto', 'acceptEdits'],
  yolo: ['bypassPermissions'],
}

/** 取该档位在当前版本上可用的取值。 */
function resolveMode(tier: PermissionTier, available: readonly string[]): string | undefined {
  return TIER_TO_MODE[tier].find((mode) => available.includes(mode))
}

function supportedTiers(modes: readonly string[]): PermissionTier[] {
  if (modes.length === 0) return []
  return (Object.keys(TIER_TO_MODE) as PermissionTier[]).filter((tier) => resolveMode(tier, modes) !== undefined)
}

/**
 * 从 `--model` 的帮助文本里捞出可用的模型名。
 *
 * claude 没有列模型的子命令，但它把别名写在描述里：
 * 「Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet')
 * or a model's full name (e.g. 'claude-fable-5')」。引号里的每一个都是
 * CLI 自己给的、当前版本认得的写法 —— 比我们硬编一份清单可靠得多，
 * 措辞变了最多是捞不到，退回自由输入，不会给出过期的错答案。
 */
export function modelsFromHelp(help: ReturnType<typeof parseHelp>): string[] {
  const block = describeFlag(help, 'model')
  if (block === undefined) return []
  const quoted = [...block.matchAll(/['"]([A-Za-z0-9][\w.-]*)['"]/g)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined)
  return [...new Set(quoted)]
}

/** 挑一个这个版本支持的输出格式，流式优先。 */
function pickFormat(formats: readonly string[]): 'stream-json' | 'json' | 'text' {
  if (formats.includes('stream-json')) return 'stream-json'
  if (formats.includes('json')) return 'json'
  return 'text'
}

function baseArgv(run: RunContext, caps: AgentCaps): string[] {
  const formats = choicesOf(caps.help, 'output-format')
  const format = pickFormat(formats)
  const argv = [caps.bin, '-p', '--output-format', format]
  // stream-json 输出在 print 模式下要求 --verbose，否则 CLI 直接拒绝。
  if (format === 'stream-json' && hasFlag(caps.help, 'verbose')) argv.push('--verbose')

  const mode = resolveMode(run.permission, choicesOf(caps.help, 'permission-mode'))
  if (mode !== undefined) argv.push('--permission-mode', mode)
  if (run.model !== undefined && hasFlag(caps.help, 'model')) argv.push('--model', run.model)
  return argv
}

/** 从任意深度的 JSON 里取一个字符串字段。 */
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

export const claudeCliProvider: AgentProvider = {
  id: 'claude',

  async probe(explicitPath?: string): Promise<AgentCaps | null> {
    const bin = findExecutable('claude', explicitPath)
    if (bin === null) return null
    const version = await probeVersion(bin)
    if (version === null) return null

    const { stdout, stderr } = await capture([bin, '--help'])
    const help = parseHelp(`${stdout}\n${stderr}`)
    if (!hasFlag(help, 'print')) return null

    return {
      id: 'claude',
      bin,
      version,
      streaming: choicesOf(help, 'output-format').includes('stream-json'),
      canPinSessionId: hasFlag(help, 'session-id'),
      canResume: hasFlag(help, 'resume'),
      canPickModel: hasFlag(help, 'model'),
      models: modelsFromHelp(help),
      permissionTiers: supportedTiers(choicesOf(help, 'permission-mode')),
      help,
    }
  },

  buildStart(run: RunContext, caps: AgentCaps): SpawnSpec {
    const argv = baseArgv(run, caps)
    // 会话必须落盘才能续跑，所以绝不加 --no-session-persistence。
    if (caps.canPinSessionId && run.sessionId !== undefined) argv.push('--session-id', run.sessionId)
    argv.push(run.prompt)
    return { argv, cwd: run.worktreePath, env: scrubEnv(process.env, run.envOverrides).env, stderr: 'pipe' }
  },

  buildResume(run: RunContext, caps: AgentCaps, sessionId: string): SpawnSpec | null {
    if (!caps.canResume) return null
    const argv = baseArgv(run, caps)
    argv.push('--resume', sessionId, run.prompt)
    return { argv, cwd: run.worktreePath, env: scrubEnv(process.env, run.envOverrides).env, stderr: 'pipe' }
  },

  parseLine(line: string, _caps: AgentCaps): AgentEvent {
    const trimmed = line.trim()
    if (trimmed.length === 0) return { kind: 'raw', line }

    let event: unknown
    try {
      event = JSON.parse(trimmed)
    } catch {
      // 解析器绝不能成为执行的单点故障：认不出就原样留着。
      return { kind: 'raw', line }
    }

    const type = str(event, 'type')

    if (type === 'system') {
      // system 下有多种 subtype，只有 init 才是会话建立；早先把所有
      // 带 session_id 的 system 事件都当成 session，会重复报同一个会话。
      const subtype = str(event, 'subtype')
      const sessionId = str(event, 'session_id')
      if (subtype === 'init' && sessionId !== undefined) {
        const model = str(event, 'model')
        const permissionMode = str(event, 'permissionMode')
        const apiKeySource = str(event, 'apiKeySource')
        return {
          kind: 'session',
          sessionId,
          ...(model === undefined ? {} : { model }),
          ...(permissionMode === undefined ? {} : { permissionMode }),
          ...(apiKeySource === undefined ? {} : { apiKeySource }),
        }
      }
      if (subtype === 'permission_denied') {
        // 这是解释「Agent 为什么没干完」的关键线索，不能当噪音丢掉。
        const tool = str(event, 'tool_name') ?? '未知工具'
        const why = str(event, 'decision_reason_type')
        return {
          kind: 'notice',
          level: 'warn',
          text: `权限拒绝：${tool}${why === undefined ? '' : ` (${why})`}`,
        }
      }
      if (subtype === 'api_retry') {
        const attempt = num(event, 'attempt')
        const max = num(event, 'max_retries')
        const status = num(event, 'error_status')
        const reason = str(event, 'error')
        return {
          kind: 'notice',
          level: 'warn',
          text: `API 重试 ${String(attempt ?? '?')}/${String(max ?? '?')}`
            + `${status === undefined ? '' : ` status=${String(status)}`}`
            + `${reason === undefined ? '' : ` ${reason}`}`,
        }
      }
      return { kind: 'raw', line }
    }

    if (type === 'rate_limit_event') {
      const info = (event as Record<string, unknown>)['rate_limit_info']
      const status = str(info, 'status')
      const window = str(info, 'rateLimitType')
      const resetsAt = num(info, 'resetsAt')
      // status 为 allowed 时只是额度播报，不值得打扰人。
      return {
        kind: 'notice',
        level: status === 'allowed' ? 'info' : 'warn',
        text: `额度 ${status ?? '?'}${window === undefined ? '' : ` window=${window}`}`
          + `${resetsAt === undefined ? '' : ` resets=${new Date(resetsAt * 1000).toISOString()}`}`,
      }
    }

    if (type === 'assistant' || type === 'user') {
      const message = (event as Record<string, unknown>)['message']
      const content = (message as Record<string, unknown> | undefined)?.['content']
      if (Array.isArray(content)) {
        for (const block of content) {
          const blockType = str(block, 'type')
          if (blockType === 'tool_use') {
            const name = str(block, 'name') ?? 'unknown'
            return { kind: 'tool', name, input: (block as Record<string, unknown>)['input'] }
          }
          const text = str(block, 'text')
          if (blockType === 'text' && text !== undefined && text.trim().length > 0) {
            return { kind: 'text', text }
          }
        }
      }
      return { kind: 'raw', line }
    }

    if (type === 'result') {
      // 完成判定只看 is_error。实测中出现过 subtype 仍是 "success" 而
      // is_error 为 true 的组合（鉴权失败），只信 subtype 会误判成功。
      const ok = (event as Record<string, unknown>)['is_error'] !== true
      const summary = str(event, 'result')
      const diagnostic = ok ? undefined : failureDiagnostic(event)
      return {
        kind: 'finished',
        ok,
        ...(summary === undefined ? {} : { summary }),
        ...(diagnostic === undefined ? {} : { diagnostic }),
      }
    }

    return { kind: 'raw', line }
  },
}

/** 诊断字符串的长度上限：结构化事实优先，原始报错不外泄。 */
const DIAGNOSTIC_MAX = 512

/** 从 `result` 事件拼出人能看懂、机器能分类的失败原因。 */
function failureDiagnostic(event: unknown): string {
  const parts: string[] = []
  const terminal = str(event, 'terminal_reason')
  const apiStatus = num(event, 'api_error_status')
  const stop = str(event, 'stop_reason')
  const subtype = str(event, 'subtype')
  if (terminal !== undefined) parts.push(`terminal=${terminal}`)
  if (apiStatus !== undefined) parts.push(`api_status=${String(apiStatus)}`)
  if (stop !== undefined) parts.push(`stop=${stop}`)
  if (subtype !== undefined) parts.push(`subtype=${subtype}`)
  return parts.join(' ').slice(0, DIAGNOSTIC_MAX)
}

/** 从 `result` 事件里另外取用量；供调用方在拿到 finished 时补记成本。 */
export function claudeUsage(line: string): AgentEvent | null {
  try {
    const event: unknown = JSON.parse(line)
    if (str(event, 'type') !== 'result') return null
    const usage = (event as Record<string, unknown>)['usage']
    const inputTokens = num(usage, 'input_tokens')
    const outputTokens = num(usage, 'output_tokens')
    const costUsd = num(event, 'total_cost_usd')
    if (inputTokens === undefined && outputTokens === undefined && costUsd === undefined) return null
    return {
      kind: 'usage',
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(costUsd === undefined ? {} : { costUsd }),
    }
  } catch {
    return null
  }
}

/** 该 Run 的产物目录里，我们约定放原始日志的位置。 */
export function claudeLogPath(run: RunContext): string {
  return join(run.artifactsDir, `${run.runId}.log`)
}
