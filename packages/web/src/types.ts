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
  subject: string
  description: string
  acceptance: string[]
  repoPath: string
  baseBranch: string
  preferredProvider?: string
  blockedBy: string[]
  lease?: Lease
  feedback?: string
  /** 归档时间；缺席表示没归档。归档正交于 column，不改变卡在哪一列。 */
  archivedAt?: number
  createdAt: number
  updatedAt: number
}

/** 允许人工编辑的字段。 */
export interface TaskEdit {
  subject?: string
  description?: string
  acceptance?: string[]
  preferredProvider?: string | undefined
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
  maxConcurrent: number
  maxPerRepo: number
}

export interface Skip {
  taskId: string
  reason: 'blocked-by-dependency' | 'global-limit-reached' | 'repo-limit-reached' | 'provider-unavailable'
  detail: string
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

/** 列的展示信息。顺序即流转顺序。 */
export const COLUMN_META: Record<Column, { label: string; hint: string; lamp: string }> = {
  backlog: { label: 'Backlog', hint: '想法池 · Agent 不可领', lamp: 'idle' },
  ready:   { label: 'Ready',   hint: '队列 · 等待认领', lamp: 'idle' },
  running: { label: 'Running', hint: 'Agent 执行中', lamp: 'running' },
  review:  { label: 'Review',  hint: '等待人工验收 · 成败都在这儿', lamp: 'review' },
  done:    { label: 'Done',    hint: '已合并', lamp: 'done' },
}
