/**
 * 后端客户端。
 *
 * token 首次通过 URL 带入，服务端随即转存 httpOnly cookie，之后所有请求
 * 靠 cookie 走 —— 所以这里一律 `credentials: 'same-origin'`，且不再把
 * token 拼进 URL（避免它出现在浏览器历史与日志里）。
 */

import type { Agent, Board, Run, StreamEvent, Task } from './types.ts'

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

export const api = {
  state: () => call<{ boards: Board[]; tasks: Task[] }>('/api/state'),

  agents: () => call<{ agents: Agent[] }>('/api/agents'),

  runsOf: (taskId: string) => call<{ runs: Run[] }>(`/api/tasks/${encodeURIComponent(taskId)}/runs`),

  createTask: (input: { subject: string; description?: string; acceptance?: string[]; preferredProvider?: string }) =>
    call<{ task: Task }>('/api/tasks', { method: 'POST', body: JSON.stringify(input) }),

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
