/**
 * 后端客户端。
 *
 * token 首次通过 URL 带入，服务端随即转存 httpOnly cookie，之后所有请求
 * 靠 cookie 走 —— 所以这里一律 `credentials: 'same-origin'`，且不再把
 * token 拼进 URL（避免它出现在浏览器历史与日志里）。
 */

import type {
  Agent, Attachment, BranchListing, DiffView, DirListing, ExecResult, FileContent, FileListing,
  FilePreview, LiveLine, PrCapability, Project, PullRequest, Run, RunStats, SchedulerSettings,
  SchedulerState, StreamEvent, Task, TaskComment, TaskEdit, TestEnv, TestEnvEvent, Workspace,
} from './types.ts'

/** 留言时能顺带改的东西：下一轮交给谁、用哪个模型。 */
export type NextRound = Pick<TaskEdit, 'preferredProvider' | 'model'>

export class ApiError extends Error {
  /**
   * @param body - 响应体原样带着。有些拒绝是**有结构的**：开 PR 撞上冲突时，
   *   服务端还会给出冲突文件与那次自动派活的 id —— 只留一句 detail 的话，
   *   界面就只能把服务端那句中文原样贴给英文用户看。
   */
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
    readonly body: Record<string, unknown> = {},
  ) {
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
    throw new ApiError(
      res.status, String(body['error'] ?? 'unknown'), String(body['detail'] ?? res.statusText), body,
    )
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
function clearable(edit: TaskEdit | NextRound): Record<string, unknown> {
  return Object.fromEntries(Object.entries(edit).map(([key, value]) => [key, value ?? null]))
}

export const api = {
  state: () => call<{
    projects: Project[]
    tasks: Task[]
    live: Record<string, LiveLine>
    /** 每张卡挂了几个附件；没有附件的卡不在里面。 */
    attachments: Record<string, number>
    /** 每张卡开过哪些 PR，新的在前；一条都没有的卡不在里面。 */
    prs: Record<string, PullRequest[]>
  }>('/api/state'),

  projects: () => call<{ projects: Project[] }>('/api/projects'),

  /**
   * 改项目名或换基线分支。仓库路径不在其列 —— 那是项目的身份，换了仓库
   * 就是另一个项目。换基线只影响此后新建的卡。
   */
  updateProject: (
    projectId: string,
    // testCommand 传 null 是"清空"。省略与清空必须分得开，否则改个名字就会
    // 顺手把启动命令抹掉。
    patch: { name?: string; baseBranch?: string; testCommand?: string | null },
  ) =>
    call<{ project: Project }>(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH', body: JSON.stringify(patch),
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

  /** 某个仓库有哪些本地分支，以及推荐当基线的那条。 */
  branches: (path: string) =>
    call<BranchListing>(`/api/branches?path=${encodeURIComponent(path)}`),

  /**
   * 新增项目。目录必须是本机上的一个 git 仓库；不给 baseBranch 就用服务端
   * 推荐的那条（main / master 优先）。
   */
  createProject: (input: { name: string; path: string; baseBranch?: string }) =>
    call<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify(input) }),

  /**
   * 一个项目能逛哪些工作区：主仓库，加上卡片留下的 worktree。
   *
   * worktree 才是 Agent 干活的地方 —— 能切过去看，「它到底改了什么」就不必
   * 只靠 diff 猜。
   */
  workspaces: (projectId: string) =>
    call<{ workspaces: Workspace[] }>(`/api/workspaces?projectId=${encodeURIComponent(projectId)}`),

  /**
   * 列一个目录。`root` 是工作区根，服务端据此重新校验围栏 —— 逛不出已登记
   * 项目的仓库。不给 `path` 就列根本身。
   */
  files: (root: string, path?: string) =>
    call<FileListing>(`/api/files?root=${encodeURIComponent(root)}${
      path === undefined ? '' : `&path=${encodeURIComponent(path)}`}`),

  /** 读一个文件的正文。太大会截断，二进制不回正文 —— 两种情况都会如实标出来。 */
  fileContent: (root: string, path: string) =>
    call<FileContent>(
      `/api/files/content?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
    ),

  /**
   * 在工作区里跑一条命令。
   *
   * **命令自己失败不会抛** —— 非零退出是它的输出而不是我们的故障，界面要
   * 照实显示退出码。只有围栏拒绝、空命令这类才是 4xx。
   */
  exec: (root: string, cwd: string, command: string) =>
    call<ExecResult>('/api/exec', {
      method: 'POST', body: JSON.stringify({ root, cwd, command }),
    }),

  agents: () => call<{ agents: Agent[] }>('/api/agents'),

  /**
   * 重新探测本机装了哪些 CLI、各自什么版本、支持什么。
   *
   * 装了个新的、升级了版本、刚登录完 —— 这些都不该逼人重启看板。POST 是
   * 因为它真的会去起一串子进程，不是一次读取。
   */
  refreshAgents: () => call<{ agents: Agent[] }>('/api/agents/refresh', { method: 'POST' }),

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

  /**
   * 读一个文件用于预览：Agent 写的方案文档就在它的 worktree 里，浏览器
   * 打不开那条路径。够得着的只有这张卡的 worktree 与项目仓库。
   */
  file: (taskId: string, path: string) =>
    call<{ file: FilePreview }>(
      `/api/tasks/${encodeURIComponent(taskId)}/file?path=${encodeURIComponent(path)}`,
    ),

  /** 验收通过。merge 为真才会动主工作区，且前置条件不满足会被明确拒绝。 */
  accept: (taskId: string, merge = false) =>
    call<{ commit: string | null; merged: boolean }>(
      `/api/tasks/${encodeURIComponent(taskId)}/accept`,
      { method: 'POST', body: JSON.stringify({ merge }) },
    ),

  /** 一张卡开过的 PR，外加"这个仓库能不能开 PR"。 */
  prs: (taskId: string) =>
    call<{ prs: PullRequest[]; capability: PrCapability }>(`/api/tasks/${encodeURIComponent(taskId)}/prs`),

  /**
   * 开一条 PR：提交这一轮的改动 → 把基线合进任务分支 → 推上去 → `gh pr create`。
   *
   * **卡不会因此进 Done**。PR 开出来只说明改动到了该被评审的地方，合不合是
   * GitHub 上那颗按钮说了算；合上之后由 {@link api.syncPrs} 或后台巡检把卡收进 Done。
   *
   * 冲突（`merge-conflict`）是**有下一步的失败**：改动已经在分支上，冲突留在
   * 工作区里，卡自动回队列，服务端还会顺手把这一轮派出去解冲突 ——
   * 响应里的 `files` 是冲突文件，`dispatched` 是那次执行的 id。
   */
  openPr: (taskId: string) =>
    call<{ pr: PullRequest; created: boolean; commit: string | null; prs: PullRequest[]; task: Task }>(
      `/api/tasks/${encodeURIComponent(taskId)}/prs`,
      { method: 'POST' },
    ),

  /** 问一遍这张卡的 PR 现在怎么样了。合上的会被收进 Done，`collected` 就是它们。 */
  syncPrs: (taskId: string) =>
    call<{ prs: PullRequest[]; collected: string[]; task: Task }>(
      `/api/tasks/${encodeURIComponent(taskId)}/prs/sync`,
      { method: 'POST' },
    ),

  /** 一张卡的讨论，按时间正序。 */
  comments: (taskId: string) =>
    call<{ comments: TaskComment[] }>(`/api/tasks/${encodeURIComponent(taskId)}/comments`),

  /**
   * 留一条言。**在 Review 或 Done 里留言就是"再改一版"**：卡自动回队列，
   * 下一次执行会带着整条讨论走。`requeued` 说明这次有没有搬动卡片。
   *
   * `next` 是顺带改掉的「下一轮交给谁、用哪个模型」。只送真正变了的字段 ——
   * 没变就别提它，免得白白顶掉一个 revision。**这个口子只认这两个字段**，
   * 所以类型也只开这两个：写成整个 TaskEdit 的话，多送的描述会被静静吃掉。
   */
  comment: (taskId: string, body: string, next: NextRound = {}) =>
    call<{ comments: TaskComment[]; requeued: boolean }>(
      `/api/tasks/${encodeURIComponent(taskId)}/comments`,
      { method: 'POST', body: JSON.stringify({ body, ...clearable(next) }) },
    ),

  /** 一张卡的附件，按上传顺序。 */
  attachments: (taskId: string) =>
    call<{ attachments: Attachment[] }>(`/api/tasks/${encodeURIComponent(taskId)}/attachments`),

  /**
   * 传一个附件。
   *
   * 一次一个文件、裸的请求体、文件名走 `x-filename` 头 —— 服务端没有
   * multipart 解析器（那是"零运行时依赖"下最不值得手写的一段代码）。
   * 文件名要 URI 编码：中文文件名直接塞进 HTTP 头是发不出去的。
   *
   * `content-type` 显式给 file.type，且**必须绕开 `call`** —— 它会给所有
   * 请求都盖上 `application/json`，那样服务端看到的类型全是错的。
   */
  upload: async (taskId: string, file: File): Promise<Attachment> => {
    const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/attachments`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': file.type.length > 0 ? file.type : 'application/octet-stream',
        'x-filename': encodeURIComponent(file.name),
      },
      body: file,
    })
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    if (!res.ok) {
      throw new ApiError(res.status, String(body['error'] ?? 'unknown'), String(body['detail'] ?? res.statusText))
    }
    return (body as { attachment: Attachment }).attachment
  },

  /** 删一个附件，连同磁盘上的字节。 */
  removeAttachment: (attachmentId: string) =>
    call<{ deleted: boolean }>(`/api/attachments/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' }),

  /** 废弃这次成果：删掉分支与 worktree，卡片回想法池。 */
  discard: (taskId: string) =>
    call(`/api/tasks/${encodeURIComponent(taskId)}/discard`, { method: 'POST' }),

  /** 这张卡当前的测试环境；没起过就是 null（不是错）。 */
  testEnv: (taskId: string) =>
    call<{ env: TestEnv | null }>(`/api/tasks/${encodeURIComponent(taskId)}/testenv`),

  /** 起一个测试环境。已经有活着的就把它给回来，不会起第二个。 */
  startTestEnv: (taskId: string) =>
    call<{ env: TestEnv }>(`/api/tasks/${encodeURIComponent(taskId)}/testenv`, { method: 'POST' }),

  stopTestEnv: (taskId: string) =>
    call<{ stopped: boolean; env: TestEnv | null }>(
      `/api/tasks/${encodeURIComponent(taskId)}/testenv`,
      { method: 'DELETE' },
    ),

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
 * 一张卡够得着的某个文件的**原始字节**的地址。`<iframe src>` / `<img src>` 用它。
 *
 * PDF 与图片不走 JSON：浏览器自带 PDF 阅读器，图片给个 URL 就完事，绕一圈
 * base64 只是凭空胖三分之一。围栏和预览接口是同一套，一个字都不松。
 */
export function taskFileUrl(taskId: string, path: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}/file/raw?path=${encodeURIComponent(path)}`
}

/** 文件浏览页里同一件事：工作区某个文件的原始字节。 */
export function workspaceFileUrl(root: string, path: string): string {
  return `/api/files/raw?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`
}

/**
 * 附件内容的地址。`<img src>`、下载链接都用它。
 *
 * 同源，token 在 httpOnly cookie 里，浏览器自己会带上 —— 不必也不该把
 * token 拼进 URL。
 */
export function attachmentUrl(attachmentId: string): string {
  return `/api/attachments/${encodeURIComponent(attachmentId)}`
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
/**
 * 订阅一个测试环境的日志与状态。
 *
 * **这条连接就是心跳**：断开之后服务端会开始倒计时，到点把环境收掉。所以
 * 返回的取消函数必须在组件卸载时调用 —— 漏掉的话那个 dev server 会一直
 * 以为还有人在看。反过来也成立：关掉面板就等于"我验完了"。
 */
export function subscribeTestEnv(taskId: string, onEvent: (event: TestEnvEvent) => void): () => void {
  const source = new EventSource(
    `/api/tasks/${encodeURIComponent(taskId)}/testenv/events`,
    { withCredentials: true },
  )
  const handle = (message: MessageEvent<string>): void => {
    try {
      onEvent(JSON.parse(message.data) as TestEnvEvent)
    } catch {
      // 半条 JSON 不该把整条流带走。
    }
  }
  // 服务端用 `event:` 分了类型，默认的 message 监听器收不到它们。
  source.addEventListener('status', handle as EventListener)
  source.addEventListener('log', handle as EventListener)
  return () => { source.close() }
}

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
