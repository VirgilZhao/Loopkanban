/**
 * 后端客户端。
 *
 * token 首次通过 URL 带入，服务端随即转存 httpOnly cookie，之后所有请求
 * 靠 cookie 走 —— 所以这里一律 `credentials: 'same-origin'`，且不再把
 * token 拼进 URL（避免它出现在浏览器历史与日志里）。
 */

import type {
  Agent, Attachment, BranchListing, ChatState, Column, DiffView, DirListing, Executor,
  ExecutorProvider, FileContent, FileListing, FilePreview, LiveLine, PendingDecision,
  PrCapability, Project, PullRequest, Run, RunDecision, RunFailure, RunStats, SchedulerSettings,
  SchedulerState, ShellEvent, ShellSession, StreamEvent, Task, TaskComment, TaskEdit, TestEnv,
  TestEnvEvent, Workspace,
} from './types.ts'

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
function clearable(edit: TaskEdit): Record<string, unknown> {
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
    /** Review 里上一轮没跑成的卡；跑成了的、以及别的列的卡不在里面。 */
    failures: Record<string, RunFailure>
    /** 每张卡跑过几轮；一轮都没跑过的卡不在里面。 */
    rounds: Record<string, number>
    /** 全部执行器；卡面与 @ 补全按 id 说出名字要靠它。 */
    executors: Executor[]
    /** 谁是默认执行器；一个都没有时为 null。 */
    defaultExecutorId: string | null
    /** 等人拍板的决策挂在哪张卡上 —— 卡面徽标的数据源。 */
    pending: Record<string, PendingDecision[]>
  }>('/api/state'),

  projects: () => call<{ projects: Project[] }>('/api/projects'),

  /**
   * 改项目名或换基线分支。仓库路径不在其列 —— 那是项目的身份，换了仓库
   * 就是另一个项目。换基线只影响此后新建的卡。
   */
  updateProject: (
    projectId: string,
    // testCommand / testEnvFiles 传 null 是"清空"。省略与清空必须分得开，
    // 否则改个名字就会顺手把启动命令抹掉。
    patch: { name?: string; baseBranch?: string; testCommand?: string | null; testEnvFiles?: string[] | null },
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
   * 开一个终端会话。
   *
   * `root` 是工作区根，服务端据此校验起步目录在围栏里。**围栏只画在这一步**：
   * 开完之后 `cd` 去哪儿是用户自己的事。
   */
  openShell: (root: string, cwd?: string) =>
    call<{ session: ShellSession }>('/api/shell', {
      method: 'POST', body: JSON.stringify({ root, cwd }),
    }),

  /** 会话此刻的样子。页面重新挂上来时用它确认那个会话还在。 */
  shell: (id: string) =>
    call<{ session: ShellSession }>(`/api/shell/${encodeURIComponent(id)}`),

  /**
   * 跑一条命令。**不等它结束** —— 202 只表示会话收下了，输出与结局从事件流
   * 里出去。`npm run dev` 根本不打算结束，等它 exit 再回应等于把这类命令
   * 整个排除在外。
   */
  shellExec: (id: string, command: string) =>
    call<{ accepted: boolean }>(`/api/shell/${encodeURIComponent(id)}/exec`, {
      method: 'POST', body: JSON.stringify({ command }),
    }),

  /** 往正在跑的命令的 stdin 里写。`eof` 相当于 ctrl+d。 */
  shellInput: (id: string, data: string, eof = false) =>
    call<{ delivered: boolean }>(`/api/shell/${encodeURIComponent(id)}/input`, {
      method: 'POST', body: JSON.stringify({ data, eof }),
    }),

  /** ctrl+c 走这里。信号发给整个进程组，孙进程一起收到。 */
  shellSignal: (id: string, signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' = 'SIGINT') =>
    call<{ delivered: boolean }>(`/api/shell/${encodeURIComponent(id)}/signal`, {
      method: 'POST', body: JSON.stringify({ signal }),
    }),

  /**
   * 列会话当前目录下的东西，供 Tab 补全。
   *
   * 不走 `/api/files`：那条钉在某个工作区根上，而会话 `cd` 出去之后就补不出
   * 任何东西了 —— 一个补不了路径的终端，Tab 按下去什么都不动。
   */
  shellList: (id: string, dir: string) =>
    call<FileListing>(`/api/shell/${encodeURIComponent(id)}/list?dir=${encodeURIComponent(dir)}`),

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
    /** 建卡**不必**指定执行器：不给就是默认那位。 */
    executorId?: string
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

  /**
   * 一次执行的全部决策（权限审批 / 向人提问），按时间正序。
   * 面板打开时拉一遍，之后靠事件流里的 decision / decision_resolved 增量更新。
   */
  /**
   * 一次执行的事件日志（一次性读取，不开流）。
   *
   * SSE 那条是给**正在跑**的那一轮用的；历史轮次要的是"把当时的过程摊开
   * 看一眼"，为此各开一条永不结束的流，只是白占连接。服务端只回最新的
   * 一段（见 host 的 EVENT_PAGE），`truncated` 说明前面还有没给的。
   */
  runLog: (runId: string) =>
    call<{ events: StreamEvent[]; lastSeq: number; truncated: boolean }>(
      `/api/runs/${encodeURIComponent(runId)}/log`,
    ),

  decisions: (runId: string) =>
    call<{ decisions: RunDecision[] }>(`/api/runs/${encodeURIComponent(runId)}/decisions`),

  /**
   * 对一条决策拍板。
   *
   * 权限：`decision: 'allow' | 'deny'`；`scope: 'run'` 表示本次执行内对该
   * 工具不再询问。提问：`answer` 是回给 Agent 的那句话。
   */
  resolveDecision: (
    runId: string,
    id: string,
    input: { decision?: 'allow' | 'deny'; scope?: 'once' | 'run'; answer?: string },
  ) =>
    call<{ decision: RunDecision }>(
      `/api/runs/${encodeURIComponent(runId)}/decisions/${encodeURIComponent(id)}`,
      { method: 'POST', body: JSON.stringify(input) },
    ),

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
  /**
   * 留一句话。
   *
   * 「下一轮交给谁」不再是这里的参数：话里 `@大壮` 就是换人，`#t-xxxx` 就是
   * 参考那张卡，两者都由服务端从**话本身**读出来（见 host 的留言接口）。
   */
  comment: (taskId: string, body: string, attachmentIds: readonly string[] = []) =>
    call<{ comments: TaskComment[]; requeued: boolean }>(
      `/api/tasks/${encodeURIComponent(taskId)}/comments`,
      {
        method: 'POST',
        // 附件是先传好的（见 `upload` 的 `draft`），这里只把它们认领给这句话。
        body: JSON.stringify({ body, ...(attachmentIds.length === 0 ? {} : { attachmentIds }) }),
      },
    ),

  // ── 执行器 ─────────────────────────────────────────────────────

  executors: () => call<{
    executors: Executor[]
    defaultId: string | null
    /** 能选哪些 CLI —— 新建表单照着它渲染。 */
    providers: ExecutorProvider[]
  }>('/api/executors'),

  createExecutor: (input: { name: string; provider: string; model?: string }) =>
    call<{ executor: Executor }>('/api/executors', { method: 'POST', body: JSON.stringify(input) }),

  /** 改一个执行器。`model: null` 表示回到那个 CLI 自己的默认。 */
  updateExecutor: (id: string, patch: { name?: string; provider?: string; model?: string | null }) =>
    call<{ executor: Executor }>(`/api/executors/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify(patch),
    }),

  deleteExecutor: (id: string) =>
    call<{ executors: Executor[]; defaultId: string | null }>(`/api/executors/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  setDefaultExecutor: (id: string) =>
    call<{ defaultId: string }>(`/api/executors/${encodeURIComponent(id)}/default`, { method: 'POST' }),

  // ── 建卡之前的那段对话 ─────────────────────────────────────────

  chat: (projectId: string) =>
    call<ChatState>(`/api/projects/${encodeURIComponent(projectId)}/chat`),

  /**
   * 说一句话。
   *
   * **立刻返回**，执行器的回复由轮询取 —— 一轮 CLI 要跑几十秒，挂在一个
   * 请求上，网络一抖这一轮就白跑了。
   */
  say: (projectId: string, body: string) =>
    call<ChatState>(`/api/projects/${encodeURIComponent(projectId)}/chat`, {
      method: 'POST', body: JSON.stringify({ body }),
    }),

  clearChat: (projectId: string) =>
    call<ChatState>(`/api/projects/${encodeURIComponent(projectId)}/chat`, { method: 'DELETE' }),

  /** 采纳一份草案：把它变成一张卡，落在想法池或直接进队列。 */
  adopt: (messageId: string, column: Extract<Column, 'backlog' | 'ready'>) =>
    call<{ task: Task; chat: ChatState | null }>(`/api/chat/${encodeURIComponent(messageId)}/adopt`, {
      method: 'POST', body: JSON.stringify({ column }),
    }),

  /**
   * 一张卡的附件，按上传顺序。
   *
   * @param scope - `spec` 是需求带的；`draft` 是讨论里传上来、还没跟着
   *   留言发出去的那些 —— 重新打开面板时要拿它把草稿摆回去，否则人只会
   *   以为传丢了然后再传一遍。
   */
  attachments: (taskId: string, scope: 'spec' | 'draft' = 'spec') =>
    call<{ attachments: Attachment[] }>(
      `/api/tasks/${encodeURIComponent(taskId)}/attachments${scope === 'draft' ? '?scope=draft' : ''}`,
    ),

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
  upload: async (taskId: string, file: File, scope: 'spec' | 'draft' = 'spec'): Promise<Attachment> => {
    const path = `/api/tasks/${encodeURIComponent(taskId)}/attachments${scope === 'draft' ? '?scope=draft' : ''}`
    const res = await fetch(path, {
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
 * 订阅一个终端会话的输出。
 *
 * 同样用原生 EventSource：断线自动重连，并带上 `Last-Event-ID`，服务端从
 * 那之后补齐 —— 网络抖一下不该让屏幕上出现一个洞。
 *
 * 会话被回收掉之后，服务端回的是 404 而不是事件流。EventSource 遇到非
 * 200 会**永久关闭**（不再重连），`onLost` 就是为这一刻准备的：页面据此
 * 重开一个会话，而不是对着一条死掉的连接一直转圈。
 *
 * @param id - 会话 id。
 * @param onEvent - 每条事件的回调。
 * @param onLost - 连接彻底断了（多半是会话已经不在了）。
 * @param after - 页面已经画到第几号事件。**新建连接时必须给**：
 *   `Last-Event-ID` 只在浏览器自己重连时才有，不给这个参数的话，每次重新
 *   订阅都会把整个回放缓冲再倒一遍 —— 刚清掉的屏幕会自己长回来。
 * @returns 关闭订阅的函数。
 */
export function subscribeShell(
  id: string,
  onEvent: (event: ShellEvent) => void,
  onLost: () => void,
  after = 0,
): () => void {
  const source = new EventSource(
    `/api/shell/${encodeURIComponent(id)}/events?after=${String(after)}`,
    { withCredentials: true },
  )
  for (const kind of ['began', 'out', 'err', 'ended', 'state', 'closed']) {
    source.addEventListener(kind, (event) => {
      const message = event as MessageEvent<string>
      const seq = Number.parseInt(message.lastEventId, 10)
      // 服务端的形状与 ShellEvent 一一对应，这里只把 kind 与 seq 补回去。
      onEvent({
        kind,
        seq: Number.isFinite(seq) ? seq : 0,
        ...JSON.parse(message.data) as Record<string, unknown>,
      } as unknown as ShellEvent)
    })
  }
  source.addEventListener('error', () => {
    // CONNECTING 是它自己在重连，那不是"丢了"，别打扰用户。
    if (source.readyState === EventSource.CLOSED) onLost()
  })
  return () => { source.close() }
}

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
  // decision / decision_resolved 是"等人拍板"那条通道上的事 ——
  // 界面要据此把审批卡与提问卡弹出来、再把结果收掉。
  const kinds = ['session', 'notice', 'text', 'tool', 'usage', 'finished', 'raw',
    'decision', 'decision_resolved']
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
