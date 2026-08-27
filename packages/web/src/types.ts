/** 与 `@openkanban/core` 对应的线上形状。前端不直接依赖后端包，只依赖这份契约。 */

export const COLUMNS = ['backlog', 'ready', 'running', 'review', 'done', 'failed'] as const
export type Column = (typeof COLUMNS)[number]

export interface Lease {
  runId: string
  provider: string
  acquiredAt: number
  expiresAt: number
}

export interface Task {
  id: string
  boardId: string
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
  writeScopes: string[]
  lease?: Lease
  createdAt: number
  updatedAt: number
}

export interface Board {
  id: string
  name: string
  repoPath: string
  baseBranch: string
  createdAt: number
}

export interface Agent {
  id: string
  bin: string
  version: string
  streaming: boolean
  canPinSessionId: boolean
  canResume: boolean
  permissionTiers: string[]
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

/** 列的展示信息。顺序即流转顺序。 */
export const COLUMN_META: Record<Column, { label: string; hint: string; lamp: string }> = {
  backlog: { label: 'Backlog', hint: '想法池 · Agent 不可领', lamp: 'idle' },
  ready:   { label: 'Ready',   hint: '队列 · 等待认领', lamp: 'idle' },
  running: { label: 'Running', hint: 'Agent 执行中', lamp: 'running' },
  review:  { label: 'Review',  hint: '等待人工验收', lamp: 'review' },
  done:    { label: 'Done',    hint: '已合并', lamp: 'done' },
  failed:  { label: 'Failed',  hint: '可改需求后重排', lamp: 'failed' },
}
