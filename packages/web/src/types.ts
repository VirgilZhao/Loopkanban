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

/**
 * 一份文件该按什么方式呈现。服务端按扩展名定（见 host 的 `docs/kind.ts`）。
 *
 * `pdf` 与 `image` **没有正文**：它们的字节不走 JSON，前端拿 raw 那个口子
 * 交给浏览器自己渲染。`docx` 也没有正文，取而代之的是一棵 `doc` 文档树。
 */
export type FileKind = 'text' | 'markdown' | 'pdf' | 'docx' | 'image' | 'binary'

/** Word 文档里的一段文字，以及它身上的格式。没有的格式字段不出现。 */
export interface DocSpan {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  /** 外部链接。服务端只放行 http(s)。 */
  href?: string
}

/** Word 文档的一个块。表格的 rows 是「行 → 单元格 → 片段」三层。 */
export type DocBlock =
  | { kind: 'heading'; level: number; spans: DocSpan[] }
  | { kind: 'paragraph'; spans: DocSpan[] }
  /** `numId` 是这条属于哪一份编号定义 —— 换了一份就是换了个列表，序号重来。 */
  | { kind: 'list'; ordered: boolean; level: number; numId: string; spans: DocSpan[] }
  | { kind: 'table'; rows: DocSpan[][][] }

/** 服务端翻出来的文档树。目前只有 `.docx` 会给。 */
export interface RichDoc {
  blocks: DocBlock[]
  /** 块数太多，只给了前一段。 */
  truncated: boolean
}

/** 工作区里的一个文件。讨论里点开一条文档链接看的就是它。 */
export interface FilePreview {
  kind: FileKind
  path: string
  name: string
  /** 相对所属根目录的路径 —— 界面上显示这个，绝对路径太长读不出重点。 */
  relative: string
  /** 文件真实大小（字节），不是 content 的长度。 */
  size: number
  truncated: boolean
  /** 正文。`pdf` / `image` / `docx` 没有正文可给，是空串。 */
  content: string
  /** `docx` 专有。 */
  doc?: RichDoc
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

/**
 * 卡片带着的一个附件：图片、PDF、Word 文档之类。
 *
 * 内容不走 JSON —— 要拿它去 `/api/attachments/<id>`，那也是 `<img>` 的 src。
 */
export interface Attachment {
  id: string
  taskId: string
  filename: string
  mime: string
  size: number
  at: number
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

/**
 * 一个可浏览的工作区：项目主仓库，或某张卡派生出来的 worktree。
 *
 * worktree 才是 Agent 真正干活的地方 —— 能切过去看，「它到底改了什么」
 * 就不必只靠 diff 猜。
 */
export interface Workspace {
  path: string
  /** 当前分支；detached HEAD 或读不出来时为 null。 */
  branch: string | null
  kind: 'repo' | 'worktree'
  /** worktree 属于哪张卡。主仓库没有。 */
  taskId?: string
}

export interface FileEntry {
  name: string
  path: string
  kind: 'dir' | 'file'
  /** 目录恒为 0 —— 算目录大小要递归整棵树，代价与用处不成比例。 */
  size: number
  modifiedAt: number
}

export interface FileListing {
  /** 这次浏览的根（工作区）。 */
  root: string
  path: string
  /** 相对根的路径，根本身是空串。面包屑用它。 */
  relative: string
  /** 上一级；已经在根上时为 null —— 根就是围栏，不能再往上。 */
  parent: string | null
  entries: FileEntry[]
}

export interface FileContent {
  path: string
  relative: string
  size: number
  kind: FileKind
  /** 文件超过上限时只回了前一段。 */
  truncated: boolean
  /** 二进制文件不回正文。`kind === 'binary'` 的另一种说法。 */
  binary: boolean
  content: string
  /** `docx` 专有。 */
  doc?: RichDoc
}

/** 跑一条命令的结果。命令自己失败也是这个形状 —— 那是它的输出，不是故障。 */
export interface ExecResult {
  command: string
  cwd: string
  stdout: string
  stderr: string
  /** 被信号打断时为 null，此时看 signal。 */
  code: number | null
  signal: string | null
  /** 有一路输出撞到了上限。 */
  truncated: boolean
  timedOut: boolean
  durationMs: number
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
