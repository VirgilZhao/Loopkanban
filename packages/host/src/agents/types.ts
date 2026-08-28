import type { SpawnSpec } from '../subprocess/index.ts'
import type { HelpSurface } from './help-parser.ts'

/** LoopKanban 的三档权限，映射到各 CLI 自己的说法。 */
export type PermissionTier = 'strict' | 'standard' | 'yolo'

/**
 * 档位名字对不上实际约束时，provider 必须说出来的那句话。
 *
 * 同一个 `standard`，codex 会被关进 workspace-write 沙箱，opencode 什么都不关 ——
 * 只显示档位名字等于让用户以为各家一样严。有话要说的 provider 才填，
 * UI 有义务如实展示，不能吞掉。
 */
export interface PermissionCaveat {
  /** 短标签，直接显示在 Agent 旁边，例如「无沙箱」。 */
  readonly label: string
  /** 展开说明，鼠标悬停时给出完整事实。 */
  readonly detail: string
}

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
  /**
   * 能否指定模型（`--model` / `-m`）。
   *
   * 和别的能力一样是**探测**出来的而不是写死的：不支持的 CLI 在界面上
   * 直接没有这一栏，而不是让用户填完再被运行时拒绝。
   */
  readonly canPickModel: boolean
  /**
   * 探测到的可用模型。**空数组表示"这个 CLI 没法枚举"**，不是"没有模型"——
   * 界面据此在下拉建议与自由输入之间取舍，但两种情况下都允许自由输入：
   * 这份清单可能不全，也可能过期，真正认不认由 CLI 说了算。
   */
  readonly models: readonly string[]
  /** 这个版本真正支持的权限档位。UI 只应展示这些。 */
  readonly permissionTiers: readonly PermissionTier[]
  /**
   * 档位语义与别家不一致时的警示；不需要提醒的 provider 不填。
   *
   * 「支持哪些档位」和「这些档位到底关不关得住」是两件事，后者藏在文档里
   * 等于没说。见 {@link PermissionCaveat}。
   */
  readonly permissionCaveat?: PermissionCaveat
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

/**
 * 一个 Agent CLI 的适配器。**接入一个新 CLI 就等于写一个这个**，
 * 除了在 {@link ALL_PROVIDERS} 里加一行，别处不该再有它的名字 ——
 * 宿主侧一切按 provider 声明的事实行事，不按 id 分支。
 */
export interface AgentProvider {
  readonly id: string
  /**
   * 可执行文件名，例如 `claude`。
   *
   * 单独声明而不是埋在 {@link probe} 里，是因为宿主也要用它：
   * 没探测到任何 CLI 时得说出「我找过谁」，而那句话不该手抄一份 id。
   */
  readonly command: string
  /**
   * `PATH` 之外还该找的目录，例如 `~/.claude/local`。
   *
   * 这类"某家 CLI 惯用的安装位置"是**这家自己的事实**，放在公共的兜底清单里
   * 会让每接一个 CLI 都得回去改 discover.ts —— 那正是这层抽象要消灭的东西。
   */
  readonly extraDirs?: readonly string[]
  /**
   * 这家在 models.dev 上的 provider 键，例如 `anthropic`。
   *
   * 只有**自己列不出模型**的 CLI 才需要（见 models-dev.ts）。能像 opencode
   * 那样用 `models` 子命令自报的，不填 —— 它自己知道装了哪些、登录了哪几家，
   * 比任何外部目录都准。
   */
  readonly catalogSource?: string
  /** 探测本机是否装了这个 CLI 以及它支持什么；没装返回 null。 */
  probe(explicitPath?: string): Promise<AgentCaps | null>
  buildStart(run: RunContext, caps: AgentCaps): SpawnSpec
  /** 该版本不支持续跑时返回 null，调用方据此降级。 */
  buildResume(run: RunContext, caps: AgentCaps, sessionId: string): SpawnSpec | null
  /**
   * 把一行原始输出翻译成归一化事件。
   *
   * **返回数组而不是单个事件**：一行里塞了两件事是常态而不是例外 —— claude 的
   * `result` 同时是"这一轮结束了"和"这一轮花了多少钱"，codex 的 `turn.completed`
   * 也一样。只能返回一个的时候，各家只好二选一，另一半要么被丢掉（claude 的
   * 成本从未入库），要么走一条只有自己知道的旁路函数（于是宿主开始按 id 分支）。
   *
   * 认不出的行返回 `[{ kind: 'raw' }]`；解析器绝不能成为执行的单点故障。
   */
  parseLine(line: string, caps: AgentCaps): readonly AgentEvent[]
}
