import type { SpawnSpec } from '../subprocess/index.ts'
import type { HelpSurface } from './help-parser.ts'

/** OpenKanban 的三档权限，映射到各 CLI 自己的说法。 */
export type PermissionTier = 'strict' | 'standard' | 'yolo'

/** 一个 CLI 被探测出来的事实。 */
export interface AgentCaps {
  readonly id: string
  /** 实际使用的可执行文件绝对路径。 */
  readonly bin: string
  /** `--version` 原样输出（去掉首尾空白）。 */
  readonly version: string
  /** 能否逐事件流式输出；不能则只能等结束拿一坨。 */
  readonly streaming: boolean
  /** 能否由我们指定会话 id（而不是事后从输出里捞）。 */
  readonly canPinSessionId: boolean
  /** 能否续跑上一次会话。 */
  readonly canResume: boolean
  /** 这个版本真正支持的权限档位。UI 只应展示这些。 */
  readonly permissionTiers: readonly PermissionTier[]
  /** 原始解析结果，供 provider 自己拼参数时查。 */
  readonly help: HelpSurface
  /**
   * 续跑那条路径的参数面。
   *
   * 单独探测是必须的：续跑可能是**另一个子命令**，参数集合和主命令并不一样
   * （实测 `codex exec resume` 没有 `--cd` / `--sandbox` / `--approve-for-me`，
   * 照搬主命令的参数会被 clap 直接拒绝）。缺省等于 {@link help}。
   */
  readonly resumeHelp?: HelpSurface
}

/** 一次执行需要的上下文。 */
export interface RunContext {
  readonly runId: string
  /** Agent 的工作目录，即该任务的 git worktree。 */
  readonly worktreePath: string
  /** 存放 last-message、日志等副产物的目录。 */
  readonly artifactsDir: string
  readonly prompt: string
  readonly permission: PermissionTier
  /** 我们预生成的会话 id；仅在 {@link AgentCaps.canPinSessionId} 为真时有意义。 */
  readonly sessionId?: string
  readonly model?: string
  /**
   * 显式传给子进程的环境变量。这是往子进程送变量的**唯一**通道 ——
   * 环境里自然泄漏进来的凭证会被 {@link scrubEnv} 清掉。
   */
  readonly envOverrides?: Readonly<Record<string, string>>
}

/** 归一化后的执行事件，各 CLI 的输出格式差异到此为止。 */
export type AgentEvent =
  /** 会话建立。`apiKeySource` 用于核验「零 API Key」：应为 `none`。 */
  | {
      readonly kind: 'session'
      readonly sessionId: string
      readonly model?: string
      readonly permissionMode?: string
      readonly apiKeySource?: string
    }
  /** 值得让人看见但不改变结果的事，例如 API 重试、hook 触发。 */
  | { readonly kind: 'notice'; readonly level: 'info' | 'warn'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool'; readonly name: string; readonly input?: unknown }
  | { readonly kind: 'usage'; readonly inputTokens?: number; readonly outputTokens?: number; readonly costUsd?: number }
  | {
      readonly kind: 'finished'
      readonly ok: boolean
      readonly summary?: string
      /** 结构化失败原因，长度有界，原始错误不外泄。 */
      readonly diagnostic?: string
    }
  /** 解析不了的行原样保留 —— 解析器绝不能成为执行的单点故障。 */
  | { readonly kind: 'raw'; readonly line: string }

export interface AgentProvider {
  readonly id: string
  /** 探测本机是否装了这个 CLI 以及它支持什么；没装返回 null。 */
  probe(explicitPath?: string): Promise<AgentCaps | null>
  buildStart(run: RunContext, caps: AgentCaps): SpawnSpec
  /** 该版本不支持续跑时返回 null，调用方据此降级。 */
  buildResume(run: RunContext, caps: AgentCaps, sessionId: string): SpawnSpec | null
  parseLine(line: string, caps: AgentCaps): AgentEvent
}
