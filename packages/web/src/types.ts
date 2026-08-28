/** 与 `@loopkanban/core` 对应的线上形状。前端不直接依赖后端包，只依赖这份契约。 */

export const COLUMNS = ['backlog', 'ready', 'running', 'review', 'done'] as const
export type Column = (typeof COLUMNS)[number]

export interface Lease {
  runId: string
  provider: string
  acquiredAt: number
  expiresAt: number
}

export interface DiffView {
  runId: string
  branch: string
  baseBranch: string
  stat: string
  patch: string
  truncated: boolean
}

export interface Task {
  id: string
  projectId: string
  revision: number
  column: Column
  position: number
  /** 卡片的全部内容。没有单独的标题；要显示"叫什么"时取第一行。 */
  description: string
  /** 验收标准，可选。 */
  acceptance: string[]
  repoPath: string
  baseBranch: string
  preferredProvider?: string
  /** 指定模型；留空用该 CLI 自己的默认。 */
  model?: string
  blockedBy: string[]
  lease?: Lease
  /** 归档时间；缺席表示没归档。归档正交于 column，不改变卡在哪一列。 */
  archivedAt?: number
  createdAt: number
  updatedAt: number
}

/** 允许人工编辑的字段。 */
export interface TaskEdit {
  description?: string
  acceptance?: string[]
  preferredProvider?: string | undefined
  model?: string | undefined
}

/** 目录选择框的一层：当前目录、上一级、以及下面的子目录。 */
export interface DirEntry {
  name: string
  path: string
  /** 是不是 git 仓库 —— 能直接选来当项目的就是它们。 */
  isRepo: boolean
}

export interface DirListing {
  path: string
  parent: string | null
  isRepo: boolean
  entries: DirEntry[]
}

/** 一个仓库有哪些本地分支，以及推荐当基线的那条。 */
export interface BranchListing {
  path: string
  /** 本地分支，最近提交的排在前面。新仓库（还没有提交）是空的。 */
  branches: string[]
  /** 推荐值：main / master 优先，都没有才退回当前分支。 */
  base: string
}

/** 一个项目：一个 git 仓库目录 + 一条基线分支。任务挂在它下面。 */
export interface Project {
  id: string
  name: string
  repoPath: string
  baseBranch: string
  createdAt: number
}

export interface PermissionCaveat {
  label: string
  detail: string
}

export interface Agent {
  id: string
  bin: string
  version: string
  streaming: boolean
  canPinSessionId: boolean
  canResume: boolean
  /** 能否指定模型。不支持的 CLI 界面上直接没有这一栏。 */
  canPickModel: boolean
  /** 探测到的可用模型。空数组表示这个 CLI 没法枚举，此时只能自由输入。 */
  models: string[]
  permissionTiers: string[]
  /** 档位语义与别家不一致时的警示；有就必须显示出来。 */
  permissionCaveat?: PermissionCaveat
}

export interface Run {
  id: string
  taskId: string
  provider: string
  cliVersion: string
  agentSessionId?: string
  worktreePath: string
  branch: string
  status: 'running' | 'completed' | 'failed' | 'aborted'
  exitCode?: number
  diagnostic?: string
  startedAt: number
  endedAt?: number
}

/** SSE 推过来的一条事件，与 host 的 AgentEvent 对齐。 */
/** 讨论里的一条留言。人和 Agent 的往来都在这儿，也是下一次执行的上下文。 */
export interface TaskComment {
  id: string
  taskId: string
  author: 'human' | 'agent'
  body: string
  /** Agent 的回答出自哪次执行；人写的留言没有。 */
  runId?: string
  at: number
}

/** 运行中卡片的最后一条事件，看板上那行日志预览就来自它。 */
export interface LiveLine {
  kind: string
  payload: Record<string, unknown>
  at: number
}

export interface StreamEvent {
  seq: number
  kind: string
  payload: Record<string, unknown>
}

export interface ProviderStats {
  provider: string
  total: number
  completed: number
  failed: number
  medianMs: number | null
}

export interface RunStats {
  totalRuns: number
  completed: number
  failed: number
  running: number
  costUsd: number
  inputTokens: number
  outputTokens: number
  providers: ProviderStats[]
}

export interface SchedulerSettings {
  autopilot: boolean
  /** 每个执行器的并发上限 —— 不是全局上限。 */
  maxPerProvider: number
  maxPerRepo: number
}

export interface Skip {
  taskId: string
  reason: 'blocked-by-dependency' | 'provider-limit-reached' | 'repo-limit-reached' | 'provider-unavailable'
  /** 服务端自己的中文渲染。界面按 reason + params 自己组句，这条只作兜底。 */
  detail: string
  /** 句子里可变的那几段，按 reason 定序。见 core 的 `Skip`。 */
  params?: string[]
}

export interface TickReport {
  at: number
  enabled: boolean
  dispatched: { taskId: string; provider: string; runId?: string; error?: string }[]
  skipped: Skip[]
  reclaimed: string[]
}

export interface SchedulerState {
  settings: SchedulerSettings
  lastTick: TickReport | null
}

/**
 * 列的展示信息。顺序即流转顺序。
 *
 * 列名两种语言下都念 Backlog / Ready / …，所以它留在这儿；那句说明会跟着
 * 语言变，去 `lib/i18n` 里的 `column.*.hint`。
 */
export const COLUMN_META: Record<Column, { label: string; lamp: string }> = {
  backlog: { label: 'Backlog', lamp: 'idle' },
  ready:   { label: 'Ready',   lamp: 'idle' },
  running: { label: 'Running', lamp: 'running' },
  review:  { label: 'Review',  lamp: 'review' },
  done:    { label: 'Done',    lamp: 'done' },
}
