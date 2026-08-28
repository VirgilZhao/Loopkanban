/**
 * 后端客户端。
 *
 * token 首次通过 URL 带入，服务端随即转存 httpOnly cookie，之后所有请求
 * 靠 cookie 走 —— 所以这里一律 `credentials: 'same-origin'`，且不再把
 * token 拼进 URL（避免它出现在浏览器历史与日志里）。
 */

import type {
  Agent, DiffView, DirListing, LiveLine, Project, Run, RunStats, SchedulerSettings, SchedulerState,
  StreamEvent, Task, TaskEdit,
} from './types.ts'

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, detail: string) {
    super(detail)
    this.name = 'ApiError'
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) {
    throw new ApiError(res.status, String(body['error'] ?? 'unknown'), String(body['detail'] ?? res.statusText))
  }
  return body as T
}

/**
 * 把 `undefined` 换成 `null` 再上路。
 *
 * JSON 里没有 undefined —— `JSON.stringify` 会把这种键**整条丢掉**，于是
 * 「清空指定执行器」在服务端看起来和「这次没提到它」一模一样，永远存不下去。
 * null 是"请把它清空"的显式说法。
 */
function clearable(edit: TaskEdit): Record<string, unknown> {
  return Object.fromEntries(Object.entries(edit).map(([key, value]) => [key, value ?? null]))
}

export const api = {
  state: () => call<{ projects: Project[]; tasks: Task[]; live: Record<string, LiveLine> }>('/api/state'),

  projects: () => call<{ projects: Project[] }>('/api/projects'),

  /** 改项目名。仓库路径与基线分支是它的身份，改名不动它们。 */
  renameProject: (projectId: string, name: string) =>
    call<{ project: Project }>(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH', body: JSON.stringify({ name }),
    }),

  /**
   * 删除项目，连同它名下所有卡片、执行历史，以及这些卡留下的分支与 worktree。
   * **仓库本身不动**。还有卡在执行时会被拒绝。
   */
  deleteProject: (projectId: string) =>
    call<{ deleted: boolean; tasks: number }>(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
    }),

  /** 列出本机某个目录下的子目录，供新增项目时挑文件夹。不传则从家目录起步。 */
  browse: (path?: string) =>
    call<DirListing>(`/api/fs${path === undefined ? '' : `?path=${encodeURIComponent(path)}`}`),

  /** 新增项目。目录必须是本机上的一个 git 仓库，基线分支由它自己说了算。 */
  createProject: (input: { name: string; path: string }) =>
    call<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify(input) }),

  agents: () => call<{ agents: Agent[] }>('/api/agents'),

  runsOf: (taskId: string) => call<{ runs: Run[] }>(`/api/tasks/${encodeURIComponent(taskId)}/runs`),

  createTask: (input: {
    projectId: string
    description?: string
    acceptance?: string[]
    preferredProvider?: string
    model?: string
  }) =>
    call<{ task: Task }>('/api/tasks', { method: 'POST', body: JSON.stringify(input) }),

  /** 派活。202 表示已接受并开始执行。 */
  run: (taskId: string, provider?: string) =>
    call<{ run: Run }>(`/api/tasks/${encodeURIComponent(taskId)}/run`, {
      method: 'POST',
      body: JSON.stringify({ provider }),
    }),

  /** 取消执行，会连同整棵进程树一起收掉。 */
  cancel: (runId: string) =>
    call<{ stopped: boolean }>(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }),

  /** 编辑任务内容。执行中的卡片会被拒绝。 */
  edit: (taskId: string, expectedRevision: number, edit: TaskEdit) =>
    call<{ task: Task }>(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: 'PATCH', body: JSON.stringify({ expectedRevision, ...clearable(edit) }),
    }),

  /**
   * 删除任务。只有想法池与队列里的卡能删，连同它的执行历史与 worktree 一并抹掉。
   * `unblocked` 是被摘掉这条依赖的下游任务。
   */
  remove: (taskId: string, expectedRevision: number) =>
    call<{ deleted: boolean; unblocked: string[] }>(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: 'DELETE', body: JSON.stringify({ expectedRevision }),
    }),

  stats: () => call<RunStats>('/api/stats'),

  scheduler: () => call<SchedulerState>('/api/scheduler'),

  /** 改自动驾驶设置。服务端会立刻跑一轮，所以返回的 lastTick 是新的。 */
  setScheduler: (patch: Partial<SchedulerSettings>) =>
    call<SchedulerState>('/api/scheduler', { method: 'PATCH', body: JSON.stringify(patch) }),

  diff: (taskId: string) => call<{ diff: DiffView }>(`/api/tasks/${encodeURIComponent(taskId)}/diff`),

  /** 验收通过。merge 为真才会动主工作区，且前置条件不满足会被明确拒绝。 */
  accept: (taskId: string, merge = false) =>
    call<{ commit: string | null; merged: boolean }>(
      `/api/tasks/${encodeURIComponent(taskId)}/accept`,
      { method: 'POST', body: JSON.stringify({ merge }) },
    ),

  /** 打回重做。worktree 保留，下一次执行接着改。 */
  requestChanges: (taskId: string, feedback: string) =>
    call(`/api/tasks/${encodeURIComponent(taskId)}/request-changes`, {
      method: 'POST', body: JSON.stringify({ feedback }),
    }),

  /** 废弃这次成果：删掉分支与 worktree，卡片回想法池。 */
  discard: (taskId: string) =>
    call(`/api/tasks/${encodeURIComponent(taskId)}/discard`, { method: 'POST' }),

  /** 归档：把卡从看板上收走，列与内容原样保留。 */
  archive: (taskId: string, expectedRevision: number) =>
    call<{ task: Task }>(`/api/tasks/${encodeURIComponent(taskId)}/archive`, {
      method: 'POST', body: JSON.stringify({ expectedRevision }),
    }),

  /** 取消归档：卡回到它被搁置时所在的列与位置。 */
  unarchive: (taskId: string, expectedRevision: number) =>
    call<{ task: Task }>(`/api/tasks/${encodeURIComponent(taskId)}/unarchive`, {
      method: 'POST', body: JSON.stringify({ expectedRevision }),
    }),

  /** 移动任务。409 表示期间已被他人改动，调用方应重读后重试。 */
  move: (taskId: string, expectedRevision: number, to: string, position?: number) =>
    call<{ task: Task }>(`/api/tasks/${encodeURIComponent(taskId)}/move`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision, to, position }),
    }),
}

/**
 * 订阅某个 Run 的事件流。
 *
 * 用原生 EventSource：它自带断线重连并会带上 `Last-Event-ID`，服务端据此
 * 只补缺口而不重传全部历史。
 *
 * @param runId - 目标 Run。
 * @param onEvent - 每条事件的回调。
 * @returns 关闭订阅的函数。
 */
export function subscribeRun(runId: string, onEvent: (event: StreamEvent) => void): () => void {
  const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`, { withCredentials: true })
  const kinds = ['session', 'notice', 'text', 'tool', 'usage', 'finished', 'raw']
  for (const kind of kinds) {
    source.addEventListener(kind, (event) => {
      const message = event as MessageEvent<string>
      onEvent({
        seq: Number.parseInt(message.lastEventId, 10),
        kind,
        payload: JSON.parse(message.data) as Record<string, unknown>,
      })
    })
  }
  return () => { source.close() }
}
