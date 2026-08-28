/**
 * MCP 暴露出去的工具。
 *
 * 取舍只有一条线：**Agent 能推动卡片，但不能给自己盖章。**
 *
 * 所以查询、建卡、改需求、排队、认领执行、留言、看执行结果都在这儿；
 * 而验收通过（accept）与废弃（discard）**故意不给** —— 领域层专门堵死了
 * running → done，就是不让干活的人自己判定活干完了。把它接到 MCP 上，
 * 等于给这道门配了一把从里面开的钥匙。人要判读的东西，留在界面上。
 *
 * 每个工具都只是一次 HTTP 调用加一次形状整理：真正的规则（CAS、租约、
 * 列的流转、关联必须同项目）全都在看板那一侧，这里不复制一份 ——
 * 复制出来的第二份规则迟早和第一份对不上。
 */

import { taskTitle, type Task } from '@loopkanban/core'
import type { BoardClient } from './client.ts'

/** 一张卡在 MCP 里的摘要形状。列清单时用它，够 Agent 决定"接哪一张"。 */
interface TaskBrief {
  id: string
  title: string
  column: Task['column']
  projectId: string
  archived: boolean
  blockedBy: readonly string[]
  relatedTo: readonly string[]
  preferredProvider?: string
  model?: string
  revision: number
  updatedAt: number
}

interface StateResponse {
  projects: {
    id: string; name: string; repoPath: string; baseBranch: string; createdAt: number
  }[]
  tasks: Task[]
  attachments: Record<string, number>
}

function brief(task: Task): TaskBrief {
  return {
    id: String(task.id),
    title: taskTitle(task),
    column: task.column,
    projectId: String(task.projectId),
    archived: task.archivedAt !== undefined,
    blockedBy: task.blockedBy.map(String),
    relatedTo: task.relatedTo.map(String),
    ...(task.preferredProvider === undefined ? {} : { preferredProvider: task.preferredProvider }),
    ...(task.model === undefined ? {} : { model: task.model }),
    revision: task.revision,
    updatedAt: task.updatedAt,
  }
}

/** 参数取值。缺了就抛 —— 客户端漏字段是它的 bug，不该被当成空值默默跑下去。 */
function str(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolInputError(`缺少参数 ${key}（要一个非空字符串）`)
  }
  return value
}

function optionalStr(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ToolInputError(`${key} 要给字符串`)
  return value
}

function optionalStrList(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ToolInputError(`${key} 要给字符串数组`)
  }
  return value as string[]
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ToolInputError(`${key} 要给数字`)
  return value
}

/** 参数本身不成立。与"看板拒绝了"分开报，前者重试同样的参数没有意义。 */
export class ToolInputError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'ToolInputError'
  }
}

/**
 * 取一张卡此刻的 revision。
 *
 * 每个改动接口都要 CAS 凭据。Agent 手上多半只有一个 id，逼它先查一遍再改
 * 只是多一次往返；但**允许它显式给**：它若真的读过、并且要拒绝"读完到写入
 * 之间被人动过"的情况，那就该以它给的为准。
 */
async function revisionOf(client: BoardClient, taskId: string, given?: number): Promise<number> {
  if (given !== undefined) return given
  const { tasks } = await client.get<StateResponse>('/api/state')
  const found = tasks.find((task) => String(task.id) === taskId)
  if (found === undefined) throw new ToolInputError(`没有这张卡：${taskId}`)
  return found.revision
}

/** JSON Schema 里反复出现的那几个字段。 */
const TASK_ID = { type: 'string', description: '任务 id，形如 t-1a2b3c4d' } as const

export interface ToolSpec {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly run: (client: BoardClient, args: Record<string, unknown>) => Promise<unknown>
}

export const TOOLS: readonly ToolSpec[] = [
  {
    name: 'list_projects',
    title: '列出项目',
    description: '列出看板上的项目：每个项目就是一个 git 仓库目录加一条基线分支，任务挂在它下面。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (client) => {
      const { projects, tasks } = await client.get<StateResponse>('/api/state')
      return projects.map((project) => ({
        ...project,
        tasks: tasks.filter((task) => String(task.projectId) === project.id).length,
      }))
    },
  },
  {
    name: 'list_agents',
    title: '列出可用的执行器',
    description:
      '本机探测到的 Agent CLI 及其能力（版本、可选模型、权限档位）。claim_task 只能指定这里面的。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (client) => client.get('/api/agents'),
  },
  {
    name: 'list_tasks',
    title: '列出任务',
    description:
      '按项目 / 列筛选任务，返回摘要。归档的卡默认不出现 —— 它们是被人主动收走的，'
      + '不该在"接下来干什么"里冒出来。要看完整需求用 get_task。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '只看这个项目；不给则全部' },
        column: {
          type: 'string',
          enum: ['backlog', 'ready', 'running', 'review', 'done'],
          description: '只看这一列',
        },
        includeArchived: { type: 'boolean', description: '连归档的卡一起列出来，默认 false' },
      },
      additionalProperties: false,
    },
    run: async (client, args) => {
      const projectId = optionalStr(args, 'projectId')
      const column = optionalStr(args, 'column')
      const includeArchived = args['includeArchived'] === true
      const { tasks } = await client.get<StateResponse>('/api/state')
      return tasks
        .filter((task) => projectId === undefined || String(task.projectId) === projectId)
        .filter((task) => column === undefined || task.column === column)
        .filter((task) => includeArchived || task.archivedAt === undefined)
        .map(brief)
    },
  },
  {
    name: 'get_task',
    title: '看一张卡的全部内容',
    description:
      '一张卡的完整需求：描述、验收标准、关联的卡（**连正文一起展开**）、讨论线程、附件与执行历史。'
      + '关联卡是参考资料，不是这次要做的活。',
    inputSchema: {
      type: 'object',
      properties: { taskId: TASK_ID },
      required: ['taskId'],
      additionalProperties: false,
    },
    run: async (client, args) => {
      const taskId = str(args, 'taskId')
      const { tasks, projects, attachments } = await client.get<StateResponse>('/api/state')
      const task = tasks.find((item) => String(item.id) === taskId)
      if (task === undefined) throw new ToolInputError(`没有这张卡：${taskId}`)

      const [{ comments }, { runs }] = await Promise.all([
        client.get<{ comments: unknown[] }>(`/api/tasks/${encodeURIComponent(taskId)}/comments`),
        client.get<{ runs: unknown[] }>(`/api/tasks/${encodeURIComponent(taskId)}/runs`),
      ])
      const related = task.relatedTo
        .map((id) => tasks.find((item) => item.id === id))
        .filter((item): item is Task => item !== undefined)
        .map((item) => ({
          ...brief(item),
          description: item.description,
          acceptance: item.acceptance,
        }))

      return {
        task: { ...brief(task), description: task.description, acceptance: task.acceptance,
          repoPath: task.repoPath, baseBranch: task.baseBranch, ...(task.lease === undefined ? {} : { lease: task.lease }) },
        project: projects.find((project) => project.id === String(task.projectId)) ?? null,
        related,
        comments,
        attachmentCount: attachments[taskId] ?? 0,
        runs,
      }
    },
  },
  {
    name: 'create_task',
    title: '新建任务',
    description:
      '在某个项目下建一张卡。新卡一律落 Backlog —— 要它排队等执行，再调 move_task 到 ready。'
      + 'relatedTo 只能指向同项目的卡，派活时它们会被展开写进 TASK.md 当参考资料。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '所属项目；不给则用第一个项目' },
        description: { type: 'string', description: '任务内容。第一行会被当作这张卡的名字' },
        acceptance: { type: 'array', items: { type: 'string' }, description: '验收标准，可选' },
        relatedTo: { type: 'array', items: { type: 'string' }, description: '关联的同项目卡片 id' },
        preferredProvider: { type: 'string', description: '指定执行器；不给由调度器挑' },
        model: { type: 'string', description: '指定模型；只在指定了执行器时有意义' },
      },
      required: ['description'],
      additionalProperties: false,
    },
    run: async (client, args) => {
      const projectId = optionalStr(args, 'projectId')
      const acceptance = optionalStrList(args, 'acceptance')
      const relatedTo = optionalStrList(args, 'relatedTo')
      const preferredProvider = optionalStr(args, 'preferredProvider')
      const model = optionalStr(args, 'model')
      const { task } = await client.post<{ task: Task }>('/api/tasks', {
        description: str(args, 'description'),
        ...(projectId === undefined ? {} : { projectId }),
        ...(acceptance === undefined ? {} : { acceptance }),
        ...(relatedTo === undefined ? {} : { relatedTo }),
        ...(preferredProvider === undefined ? {} : { preferredProvider }),
        ...(model === undefined ? {} : { model }),
      })
      return { ...brief(task), description: task.description, acceptance: task.acceptance }
    },
  },
  {
    name: 'update_task',
    title: '改一张卡的需求',
    description:
      '改描述、验收标准、关联、执行器或模型。**正在执行的卡改不动** —— 那会让人和 Agent '
      + '对着两份不同的规格，要改先 cancel_run。relatedTo 给空数组就是取消全部关联。'
      + '不给 expectedRevision 时按此刻的 revision 提交；要防"读完到写入之间被人动过"就显式给。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: TASK_ID,
        description: { type: 'string' },
        acceptance: { type: 'array', items: { type: 'string' } },
        relatedTo: { type: 'array', items: { type: 'string' }, description: '关联的同项目卡片 id；空数组表示全部取消' },
        preferredProvider: { type: 'string', description: '给 null 表示不再指定' },
        model: { type: 'string', description: '给 null 表示用该 CLI 自己的默认' },
        expectedRevision: { type: 'number', description: 'CAS 凭据；不给则用此刻的' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    run: async (client, args) => {
      const taskId = str(args, 'taskId')
      const expectedRevision = await revisionOf(client, taskId, optionalNumber(args, 'expectedRevision'))
      const patch: Record<string, unknown> = { expectedRevision }
      for (const key of ['description', 'acceptance', 'relatedTo', 'preferredProvider', 'model']) {
        // null 是"清空"，缺席是"这次没提到" —— 两者在服务端含义不同，不能混。
        if (key in args) patch[key] = args[key]
      }
      const { task } = await client.patch<{ task: Task }>(`/api/tasks/${encodeURIComponent(taskId)}`, patch)
      return { ...brief(task), description: task.description, acceptance: task.acceptance }
    },
  },
  {
    name: 'move_task',
    title: '把卡移到另一列',
    description:
      '在 backlog（想法池）与 ready（排队等执行）之间搬卡，Review 里的卡也可以退回这两列重做或重想。'
      + '**只到这两列**：进 running 要拿租约，那是 claim_task 的事；'
      + '进 done 是人的判读 —— 干活的人不能给自己盖章，所以 MCP 这一侧没有这条路。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: TASK_ID,
        to: { type: 'string', enum: ['backlog', 'ready'] },
        expectedRevision: { type: 'number', description: 'CAS 凭据；不给则用此刻的' },
      },
      required: ['taskId', 'to'],
      additionalProperties: false,
    },
    run: async (client, args) => {
      const taskId = str(args, 'taskId')
      const to = str(args, 'to')
      if (to !== 'backlog' && to !== 'ready') {
        throw new ToolInputError(
          to === 'running'
            ? '进 running 要先拿到租约，用 claim_task，不是 move_task'
            : to === 'done'
              ? '验收通过只能由人在界面上做 —— 干活的人不能给自己盖章'
              : `move_task 只接受 backlog 与 ready，收到 ${to}`,
        )
      }
      const expectedRevision = await revisionOf(client, taskId, optionalNumber(args, 'expectedRevision'))
      const { task } = await client.post<{ task: Task }>(
        `/api/tasks/${encodeURIComponent(taskId)}/move`, { expectedRevision, to },
      )
      return brief(task)
    },
  },
  {
    name: 'claim_task',
    title: '认领一张卡并开始执行',
    description:
      '认领 = 拿到租约 + 在项目派生的独立 git worktree 里起一个 Agent CLI 干活。'
      + '**只有 ready 列、依赖已解开、没被别人占住的卡能认领**，两个人同时认领只会有一个成功。'
      + '执行完成（成功或失败）卡片一律进 Review 等人判读 —— 没有自动通过这条路。'
      + '这是异步的：返回一个 runId，用 run_status 跟进。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: TASK_ID,
        provider: { type: 'string', description: '指定执行器（见 list_agents）；不给则用卡上指定的或第一个可用的' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    run: async (client, args) => {
      const taskId = str(args, 'taskId')
      const provider = optionalStr(args, 'provider')
      const { run } = await client.post<{ run: Record<string, unknown> }>(
        `/api/tasks/${encodeURIComponent(taskId)}/run`,
        provider === undefined ? {} : { provider },
      )
      return run
    },
  },
  {
    name: 'run_status',
    title: '看一次执行的进展',
    description:
      '一次执行此刻的状态，外加它的事件日志。执行是异步的，认领之后靠它跟进：'
      + '反复调用时把上次返回的 lastSeq 当作 afterSeq 传进来，只会拿到新增的那几条。',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: '执行 id，claim_task 返回的那个' },
        afterSeq: { type: 'number', description: '只要 seq 大于它的事件；上次调用返回的 lastSeq' },
      },
      required: ['runId'],
      additionalProperties: false,
    },
    run: async (client, args) => {
      const runId = str(args, 'runId')
      const after = optionalNumber(args, 'afterSeq') ?? 0
      const [{ run }, log] = await Promise.all([
        client.get<{ run: Record<string, unknown> }>(`/api/runs/${encodeURIComponent(runId)}`),
        client.get<{ events: unknown[]; lastSeq: number; truncated: boolean }>(
          `/api/runs/${encodeURIComponent(runId)}/log?after=${String(after)}`,
        ),
      ])
      return { run, ...log }
    },
  },
  {
    name: 'cancel_run',
    title: '终止一次执行',
    description: '收掉整棵进程树。卡片随后进 Review，改动留在它自己的 worktree 里。',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      required: ['runId'],
      additionalProperties: false,
    },
    run: async (client, args) => client.post(`/api/runs/${encodeURIComponent(str(args, 'runId'))}/cancel`),
  },
  {
    name: 'comment_task',
    title: '在卡上留言',
    description:
      '往讨论线程里加一条。整条线程会跟着卡走进下一次执行的 TASK.md，所以这里写的是给下一轮看的话。'
      + '**在 Review 里留言就是"再改一版"**：卡会自动回到 ready 排队。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: TASK_ID,
        body: { type: 'string', description: '留言正文' },
      },
      required: ['taskId', 'body'],
      additionalProperties: false,
    },
    run: async (client, args) => {
      const taskId = str(args, 'taskId')
      const result = await client.post<{ comments: unknown[]; requeued: boolean }>(
        `/api/tasks/${encodeURIComponent(taskId)}/comments`, { body: str(args, 'body') },
      )
      return { requeued: result.requeued, comments: result.comments.length }
    },
  },
]
