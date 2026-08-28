/**
 * opencode CLI provider —— 起本机 `PATH` 上的 `opencode run`，不走 API。
 *
 * 认证与配置完全交给 CLI 自身（`opencode auth`），LoopKanban 不接受、不存储、
 * 不传递任何 key。
 *
 * 与另外两家的结构性差异（都是实测出来的，不是文档写的）：
 *
 *   1. **不给 `--auto` 就会永远挂住**。opencode 在 `run` 模式下遇到写文件
 *      仍然会发出权限询问，没人回答就一直等 —— 实测跑了 7 分钟，一个字节
 *      都没输出。无人值守场景下这是最坏的结局（卡片停在 Running 直到超时），
 *      所以 `--auto` 是硬性前提，探测不到就当没装。
 *   2. **没有只读模式，也没有沙箱**。`--auto` 是唯一的权限开关，没有 codex 的
 *      `read-only` / `workspace-write` 可对应，所以 strict 档不上报（UI 上直接
 *      灰掉），真被要求 strict 时**拒绝执行**而不是降级 —— 见 permissionArgs。
 *      即便是 standard 档，它也比另外两家松得多，这件事必须让用户看见 ——
 *      见 OPENCODE_PERMISSION_CAVEAT。
 *   3. **续跑就是同一条命令**（`opencode run -s <id>`），不像 codex 是另一个
 *      子命令，所以不需要单独探测 resume 的参数面。
 *   4. **没有终态成功事件**。成功那条路径上最后只有 `step_finish`，
 *      完成与否交给退出码判定（Runner 本来就是 `finished ?? exit === 0`）。
 *      失败则有独立的 `error` 事件，能给出结构化诊断。
 */

import type { SpawnSpec } from '../../subprocess/index.ts'
import { capture, findExecutable, probeVersion } from '../discover.ts'
import { scrubEnv } from '../env.ts'
import { choicesOf, hasFlag, parseHelp, type HelpSurface } from '../help-parser.ts'
import type {
  AgentCaps, AgentEvent, AgentProvider, PermissionCaveat, PermissionTier, RunContext,
} from '../types.ts'

/** 唯一的权限开关：自动批准没有被显式拒绝的请求。 */
const AUTO_FLAG = 'auto'

/**
 * `--auto` 能覆盖的档位。
 *
 * standard 与 yolo 落到同一个参数上不是偷懒 —— opencode 就只有这一个开关，
 * 两档的实际行为确实一样；把 yolo 也列出来是为了让偏好 yolo 的看板能选到它，
 * 而不是因为"更松"而多出点什么。strict 不在其中，见文件头。
 */
const AUTO_TIERS: readonly PermissionTier[] = ['standard', 'yolo']

/**
 * 必须让用户看见的那句话。
 *
 * 「支持 standard」这四个字在 opencode 身上和在 codex 身上不是一个意思：
 * codex 的 standard 会把 Agent 关进 workspace-write 沙箱，opencode 的
 * standard 什么都不关。只报档位名字，用户就会按别家的经验去理解它。
 */
export const OPENCODE_PERMISSION_CAVEAT: PermissionCaveat = {
  label: '无沙箱',
  detail: 'opencode 只有 --auto 一个权限开关：自动批准所有未被显式拒绝的请求，且没有文件系统沙箱。'
    + '同样是 standard 档，codex 会被关进 workspace-write、claude 走权限分类器，opencode 两者都没有'
    + ' —— Agent 可以改 worktree 之外的文件、跑任意命令。介意的话请派给别的 CLI。',
}

function supportedTiers(help: HelpSurface): PermissionTier[] {
  return hasFlag(help, AUTO_FLAG) ? [...AUTO_TIERS] : []
}

/**
 * 该档位对应的参数；这个 CLI 支持不了就当场拒绝，绝不降级。
 *
 * 不能沿用另外两家「探测不到就不传，交给 CLI 自己的默认值」的做法：
 * opencode 少了 `--auto` 不是变严格，而是**永远挂住**（见文件头）。于是只剩
 * 两条路 —— 要么按 `--auto` 跑（strict 就成了它的反面，还没人知道），要么
 * 明确失败。悄悄升权比一次看得见的失败糟糕得多，所以选后者：
 * 卡片照常回到 Review 让人判读，诊断里写清楚为什么。
 */
function permissionArgs(run: RunContext, caps: AgentCaps): string[] {
  if (!caps.permissionTiers.includes(run.permission)) {
    throw new Error(
      `opencode 不支持 ${run.permission} 档（它只有 --auto 一个权限开关，没有只读模式），`
      + `本次拒绝执行 —— 降级成 --auto 等于把最严的档位跑成最松的。`
      + `请把这张卡派给 ${run.permission === 'strict' ? 'claude 或 codex' : '别的 CLI'}。`,
    )
  }
  return [`--${AUTO_FLAG}`]
}

/**
 * 拼出 start 与 resume 共用的参数。
 *
 * 续跑走的是同一条 `opencode run`，参数面完全一致，所以这里不像 codex 那样
 * 需要区分两个 surface。
 */
function baseArgv(run: RunContext, caps: AgentCaps): string[] {
  const argv = [caps.bin, 'run']
  // 只有 json 才是可解析的；拿不到就退化成一堆 raw 行，会话 id、用量全都没有。
  if (caps.streaming && choicesOf(caps.help, 'format').includes('json')) argv.push('--format', 'json')
  // 档位不匹配会在这里抛出来，而不是拼出一条语义不对的命令。
  argv.push(...permissionArgs(run, caps))
  // 没有 --dir 时靠子进程自身的 cwd（spawn 时已指向 worktree）。
  if (hasFlag(caps.help, 'dir')) argv.push('--dir', run.worktreePath)
  if (run.model !== undefined && hasFlag(caps.help, 'model')) argv.push('-m', run.model)
  return argv
}

/**
 * 把提示词交出去。
 *
 * 用 `--` 隔开是必要的：提示词是 yargs 的位置参数，以 `-` 开头的一行会被
 * 当成参数解析掉。实测加了 `--` 之后位置参数照常收得到。
 */
function withPrompt(argv: string[], prompt: string): string[] {
  return [...argv, '--', prompt]
}

function spec(run: RunContext, argv: readonly string[]): SpawnSpec {
  return {
    argv,
    cwd: run.worktreePath,
    env: scrubEnv(process.env, run.envOverrides).env,
    // stdin 必须掐掉：万一某个请求逃过 --auto，也不能让它坐在那儿等人输入。
    stdin: 'ignore',
    stderr: 'pipe',
  }
}

function obj(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return (value as Record<string, unknown>)[key]
}

function str(value: unknown, key: string): string | undefined {
  const found = obj(value, key)
  return typeof found === 'string' ? found : undefined
}

function num(value: unknown, key: string): number | undefined {
  const found = obj(value, key)
  return typeof found === 'number' ? found : undefined
}

const DIAGNOSTIC_MAX = 512
/** notice 里附带的细节长度上限，别把整坨 JSON 倒进界面。 */
const DETAIL_MAX = 160

export const opencodeCliProvider: AgentProvider = {
  id: 'opencode',

  async probe(explicitPath?: string): Promise<AgentCaps | null> {
    const bin = findExecutable('opencode', explicitPath)
    if (bin === null) return null
    const version = await probeVersion(bin)
    if (version === null) return null

    // 参数面要按**每条命令**探测：主命令的 help 里没有 --format。
    const runHelp = await capture([bin, 'run', '--help'])
    const help = parseHelp(`${runHelp.stdout}\n${runHelp.stderr}`)

    // 两条硬性前提，缺一条就当没装 —— 让它在探测期失败，而不是等到
    // 某张卡片挂在 Running 上才发现。
    //   --format：没有它就没有可解析的输出。
    //   --auto  ：没有它，第一次写文件就会永远等一个没人给的答复。
    if (!hasFlag(help, 'format') || !hasFlag(help, AUTO_FLAG)) return null

    return {
      id: 'opencode',
      bin,
      version,
      streaming: choicesOf(help, 'format').includes('json'),
      // 会话 id 由 opencode 自己生成（ses_…），我们只能从事件里捞。
      canPinSessionId: false,
      canResume: hasFlag(help, 'session'),
      canPickModel: hasFlag(help, 'model'),
      permissionTiers: supportedTiers(help),
      // 档位名字对不上实际约束，这句话必须一路传到界面上。
      permissionCaveat: OPENCODE_PERMISSION_CAVEAT,
      help,
      // 续跑是同一条命令，参数面就是 help 本身，不必单独记一份。
    }
  },

  buildStart(run: RunContext, caps: AgentCaps): SpawnSpec {
    return spec(run, withPrompt(baseArgv(run, caps), run.prompt))
  },

  buildResume(run: RunContext, caps: AgentCaps, sessionId: string): SpawnSpec | null {
    if (!caps.canResume) return null
    const argv = baseArgv(run, caps)
    argv.push('-s', sessionId)
    return spec(run, withPrompt(argv, run.prompt))
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
    const part = obj(event, 'part')

    if (type === 'error') {
      const error = obj(event, 'error')
      const name = str(error, 'name') ?? 'error'
      const message = str(obj(error, 'data'), 'message') ?? str(error, 'message') ?? 'unknown'
      return { kind: 'finished', ok: false, diagnostic: `opencode ${name}: ${message}`.slice(0, DIAGNOSTIC_MAX) }
    }

    if (type === 'text') {
      const text = str(part, 'text')
      return text === undefined || text.trim().length === 0 ? { kind: 'raw', line } : { kind: 'text', text }
    }

    if (type === 'tool_use') {
      const name = str(part, 'tool') ?? 'unknown'
      const state = obj(part, 'state')
      const status = str(state, 'status')
      if (status === 'error') {
        const detail = str(state, 'error') ?? str(state, 'output') ?? ''
        return {
          kind: 'notice',
          level: 'warn',
          text: `工具失败：${name}${detail === '' ? '' : ` ${detail.slice(0, DETAIL_MAX)}`}`,
        }
      }
      // 只在 completed 时算一次工具调用，避免同一个动作被计两次。
      if (status === 'completed') return { kind: 'tool', name, input: obj(state, 'input') }
      // 实测 1.18.23 只在 completed 时报一次，连跑 12 秒的 bash 也没有中间态
      // ——所以长命令期间界面确实是静的，这点不像 codex 有 item.started。
      // 这个分支是给将来留的：真出现进行中的事件就压成一行提示，而不是丢掉。
      const title = str(state, 'title') ?? ''
      return {
        kind: 'notice',
        level: 'info',
        text: `${name}${title === '' ? '' : ` ${title.slice(0, DETAIL_MAX)}`}`,
      }
    }

    if (type === 'step_finish') {
      // 每一步都报一次自己的用量，Storage 端是累加的，正好对得上。
      const tokens = obj(part, 'tokens')
      const inputTokens = num(tokens, 'input')
      const outputTokens = num(tokens, 'output')
      const costUsd = num(part, 'cost')
      if (inputTokens === undefined && outputTokens === undefined && costUsd === undefined) {
        return { kind: 'raw', line }
      }
      return {
        kind: 'usage',
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(costUsd === undefined ? {} : { costUsd }),
      }
    }

    if (type === 'step_start') {
      // opencode 没有"会话已建立"这种独立事件，sessionID 挂在**每条**事件上。
      // 这里挑 step_start 来上报，重复的那些由 Runner 去重（同一个 id 只报一次）。
      const sessionId = str(event, 'sessionID')
      return sessionId === undefined ? { kind: 'raw', line } : { kind: 'session', sessionId }
    }

    return { kind: 'raw', line }
  },
}
