/**
 * 建卡之前的那段对话。
 *
 * 过去看板右侧那块面板在没选卡时是个「写一句话就是一张卡」的输入框：一句话
 * 直接变成需求，中间没有任何人帮你想清楚。于是最常见的两种卡是「一句话写不
 * 清楚、Agent 只能猜」和「想到哪写到哪、写完自己也不确定要什么」。
 *
 * 现在它是**真的聊天**：默认执行器跟人来回问，把要做的事谈拢，然后提一份
 * 任务草案；人点头，才落成一张卡。三条设计上的选择：
 *
 * 1. **不靠 CLI 的会话续跑，每一轮把整段对话原样带过去。** 建卡前的对话
 *    本来就只有几轮，而三家 CLI 的续跑能力各不相同（能不能续、会话 id 是
 *    我们钉的还是事后捞的、换了 provider 还能不能接）。把这些差异引进来，
 *    换来的只是省几百个 token，代价却是"聊到第三句突然失忆"这种没法复现的
 *    毛病。带着整段走，每一轮都是确定的。
 *
 * 2. **草案是一个结构化的块，不是一段自然语言。** 执行器谈拢之后在回复末尾
 *    附一个 ```loopkanban-task 代码块，宿主把它摘出来变成一条 proposal 消息。
 *    人看到的是一张能直接采纳的草案卡，而不是"它好像是在说要建卡？"
 *
 * 3. **建卡这一步永远经过人。** 不给它 create_task 这类工具 —— 聊着聊着就
 *    无声地建出一堆卡，比不建更糟。
 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import {
  mentionedExecutors, referencedTasks, taskTitle,
  type Executor, type ProjectId, type Task, type TaskId,
} from '@loopkanban/core'
import type { AgentPool, DetectedAgent } from '../agents/index.ts'
import type { RunContext } from '../agents/types.ts'
import { defaultExecutor } from '../executors/index.ts'
import type { ChatMessage, Project, Storage, TaskProposal } from '../storage/index.ts'
import { spawnProcess, type ProcessHandle, type SpawnSpec } from '../subprocess/index.ts'

/** 一轮对话最多等多久。聊天不是干活，等过这个数基本就是它卡住了。 */
const TURN_TIMEOUT_MS = 5 * 60_000

/** 摘草案用的围栏语言。取一个不会和真代码撞车的名字。 */
const PROPOSAL_FENCE = 'loopkanban-task'

/** 带进 prompt 的对话上限。再往前的话对建卡这件事已经没有影响了。 */
const HISTORY_MAX = 40

export interface ChatOptions {
  readonly storage: Storage
  readonly agents: AgentPool
  /** 副产物（last-message 之类）的落脚处，与 Run 用同一个根。 */
  readonly artifactsRoot: string
  readonly spawn?: (spec: SpawnSpec) => Promise<ProcessHandle>
  readonly now?: () => number
}

/** 这个项目的对话此刻是什么状态。 */
export interface ChatState {
  readonly messages: readonly ChatMessage[]
  /** 执行器正在想。界面据此摆一个"正在输入"，并按住输入框。 */
  readonly pending: boolean
  /** 上一轮没跑成的原因。**不入库** —— 它是这一次的事故，不是对话的一部分。 */
  readonly failure?: string | undefined
  /** 眼下由谁在聊。一个执行器都没有时为空，界面据此引导人去建一个。 */
  readonly executor?: { readonly id: string; readonly name: string } | undefined
}

export class ChatService {
  private readonly options: ChatOptions
  /** 每个项目同时只有一轮在跑。第二句话得等第一句答完 —— 两轮并行会让回复错位。 */
  private readonly inFlight = new Map<string, Promise<void>>()
  /** 眼下这一轮是谁在跑。界面上那句"X 正在想…"要报真正在跑的那位，不是默认那位。 */
  private readonly running = new Map<string, Executor>()
  private readonly failures = new Map<string, string>()
  /** 每个项目上一条消息用掉的时刻。见 {@link stamp}。 */
  private readonly lastAt = new Map<string, number>()

  constructor(options: ChatOptions) {
    this.options = options
  }

  private get now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /**
   * 这条消息落在哪一刻。**同一毫秒里连着写的往后挪一格。**
   *
   * 对话是按 `at` 排的，而毫秒不够细：一轮答完顺手补一句、或者人手快连发
   * 两句，两条就会共用同一个时刻，此后它们的先后由随机的 id 决定 ——
   * 于是"最后一句人话是什么"（`speakerFor` 拿它判这一轮归谁）变成了掷骰子，
   * 界面上的气泡顺序也会跳。
   *
   * 第一次用到某个项目时从库里接上，之后在内存里往前走：进程重启后再撞上
   * 同一毫秒，得先有人在那一毫秒里重启完并说了话。
   */
  private stamp(project: Project): number {
    const key = String(project.id)
    const known = this.lastAt.get(key)
      // listChat 按 at 排，最后一条就是最大的那个。
      ?? this.options.storage.listChat(project.id).at(-1)?.at
      ?? 0
    const at = Math.max(this.now, known + 1)
    this.lastAt.set(key, at)
    return at
  }

  /** 这个项目的对话现状。 */
  state(project: Project): ChatState {
    const key = String(project.id)
    // 有一轮在跑就报**那一位**：`@小壮` 起的那一轮，界面不该写着"大壮正在想"。
    const executor = this.running.get(key) ?? defaultExecutor(this.options.storage)
    const failure = this.failures.get(key)
    return {
      messages: this.options.storage.listChat(project.id),
      pending: this.inFlight.has(key),
      ...(failure === undefined ? {} : { failure }),
      ...(executor === null || executor === undefined
        ? {}
        : { executor: { id: String(executor.id), name: executor.name } }),
    }
  }

  /** 清空这个项目的对话。已经建出来的卡不受影响 —— 它们早已是卡了。 */
  clear(project: Project): void {
    this.options.storage.clearChat(project.id)
    this.failures.delete(String(project.id))
    this.lastAt.delete(String(project.id))
  }

  /**
   * 眼下这句话该谁答：**最后一句人话**里 `@` 到的那位，没点名就是默认那位。
   *
   * 只有这一处定这条规则 —— 说一句就起一轮（`say`）和上一轮答完接着答
   * （`launch` 的 finally）走的是同一个答案。分成两处的话，"它想的时候
   * 补了一句 @小壮"就会被默认那位接走，而界面上明明写着交给小壮。
   */
  private speakerFor(project: Project): Executor | null {
    const { storage } = this.options
    const spoken = [...storage.listChat(project.id)].reverse().find((m) => m.role === 'human')
    const mentioned = spoken === undefined
      ? undefined
      : mentionedExecutors(spoken.body, storage.listExecutors())[0]
    return mentioned ?? defaultExecutor(storage)
  }

  /**
   * 说一句话，并让执行器接着答。
   *
   * **立刻返回**：一轮 CLI 要跑几十秒，把它挂在一个 HTTP 请求上，网络一抖
   * 这一轮就白跑了。人说的那句话先落库，回复由界面轮询取（与看板同一套节奏）。
   *
   * @returns 落库之后的现状；执行器不可用时 `failure` 里是原因。
   */
  say(project: Project, text: string): ChatState {
    const { storage } = this.options
    const body = text.trim()
    if (body.length === 0) return this.state(project)

    // 这一轮归谁：话里 `@` 到谁就是谁，否则默认执行器（见 speakerFor）。
    const mentioned = mentionedExecutors(body, storage.listExecutors())[0]
    const executor = mentioned ?? defaultExecutor(storage)

    storage.addChatMessage({
      id: `m-${randomUUID().slice(0, 8)}`,
      projectId: project.id,
      role: 'human',
      body,
      ...(executor === null ? {} : { executorId: executor.id }),
      at: this.stamp(project),
    })
    this.failures.delete(String(project.id))

    if (executor === null) {
      this.failures.set(String(project.id), 'no-executor')
      return this.state(project)
    }
    // 前一轮还在跑就不再起一轮：那句话已经落库了，等那一轮收场时会接着答它
    // （见 launch 的 finally）。
    if (!this.inFlight.has(String(project.id))) this.launch(project, executor)
    return this.state(project)
  }

  /** 起一轮。失败只记在 `failures` 里 —— 事故不该混进对话记录。 */
  private launch(project: Project, executor: Executor): void {
    const key = String(project.id)
    /** 这一轮的 prompt 里带了几句人话。用它判断"它想的时候人有没有又说一句"。 */
    let seen = -1
    this.running.set(key, executor)
    const turn = this.turn(project, executor)
      .then((counted) => { seen = counted })
      .catch((error: unknown) => {
        this.failures.set(key, error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        this.inFlight.delete(key)
        this.running.delete(key)
        /*
         * 它想的时候人又说了一句：那句话**没赶上**这一轮的 prompt（prompt 在
         * 开跑那一刻就定死了），所以答完要再接一轮，否则那句话就一直没有下文，
         * 人只能再打一句去把它撞醒。
         *
         * 数的是人说了几句，不是"最后一条是谁说的"—— 这一轮自己的回复就排在
         * 最后，按最后一条判永远判不出来。
         *
         * 只在这一轮成功时接：失败的话那句话还在，接下去只会原地重试同一个
         * 错误，一轮接一轮地烧。
         */
        if (seen < 0) return
        if (this.humanCount(project) <= seen) return
        // 接着答那句没赶上的话，**归它自己点的名的那位** —— 与 say 同一条规则。
        const next = this.speakerFor(project)
        if (next !== null) this.launch(project, next)
      })
    this.inFlight.set(key, turn)
  }

  /** 这段对话里人说了几句。 */
  private humanCount(project: Project): number {
    return this.options.storage.listChat(project.id).filter((m) => m.role === 'human').length
  }

  /**
   * 真正跑一轮：起 CLI、读输出、把回复与草案落库。
   * @returns 这一轮的 prompt 里带了几句人话（见 {@link launch}）。
   */
  private async turn(project: Project, executor: Executor): Promise<number> {
    const { storage, artifactsRoot } = this.options
    const agent = this.options.agents.list().find((a) => a.provider.id === executor.provider)
    if (agent === undefined) throw new Error(`未探测到 ${executor.provider}`)

    const thread = storage.listChat(project.id)
    const humans = thread.filter((message) => message.role === 'human').length
    const history = thread.slice(-HISTORY_MAX)
    // 对话里点过名的卡，把内容展开带过去 —— `#t-xxxx` 的意思就是"参考它"。
    const referenced = collectReferences(storage, history)

    const runId = `chat-${randomUUID().slice(0, 8)}`
    const artifactsDir = join(artifactsRoot, runId)
    await mkdir(artifactsDir, { recursive: true })

    // 聊天不该动仓库。这个 CLI 支持只读档就用只读档，不支持就退到 standard
    // 并在 prompt 里说清楚"别改任何文件"—— 与派活那边同一条降级规则。
    const permission = agent.caps.permissionTiers.includes('strict') ? 'strict' : 'standard'
    const context: RunContext = {
      runId,
      // 聊天在**主工作区**里进行，不建 worktree：它不产出代码，只是要看得见
      // 这个仓库长什么样。为它建一个分支再删掉，是白白在 git 里留下痕迹。
      worktreePath: project.repoPath,
      artifactsDir,
      prompt: renderChatPrompt({
        project, executor, history, referenced, readOnly: permission !== 'strict',
      }),
      permission,
      ...(executor.model === undefined ? {} : { model: executor.model }),
    }

    const spawner = this.options.spawn ?? spawnProcess
    const handle = await spawner(agent.provider.buildStart(context, agent.caps))
    const reply = await readReply(handle, agent)

    const { text, proposal } = splitProposal(reply)
    storage.addChatMessage({
      id: `m-${randomUUID().slice(0, 8)}`,
      projectId: project.id,
      role: 'agent',
      // 一个字都没说的一轮也要留痕：空白的气泡至少说明"它答过了"，
      // 而彻底不落库会让人以为自己那句话没发出去。
      body: text.length > 0 ? text : '（没有回复内容）',
      executorId: executor.id,
      at: this.stamp(project),
    })
    if (proposal !== null) {
      storage.addChatMessage({
        id: `m-${randomUUID().slice(0, 8)}`,
        projectId: project.id,
        role: 'proposal',
        body: proposal.description,
        executorId: executor.id,
        proposal,
        // 草案永远排在它那句回复后面 —— stamp 保证这一点，不必自己 +1。
        at: this.stamp(project),
      })
    }
    return humans
  }
}

/** 对话里 `#t-xxxx` 点到的卡，去重后按出现先后。 */
function collectReferences(storage: Storage, history: readonly ChatMessage[]): readonly Task[] {
  const ids: TaskId[] = []
  for (const message of history) {
    if (message.role !== 'human') continue
    for (const id of referencedTasks(message.body)) {
      if (!ids.includes(id)) ids.push(id)
    }
  }
  return ids
    .map((id) => storage.getTask(id))
    .filter((task): task is Task => task !== null)
}

/**
 * 读一轮 CLI 的输出，拼出它这次说的话。
 *
 * `finished` 带的 summary 优先（那是各家自己给的"这一轮的答复"），没有就把
 * 途中所有正文接起来 —— 有的 CLI 只逐段吐正文，不给收尾的总结。
 */
async function readReply(handle: ProcessHandle, agent: DetectedAgent): Promise<string> {
  const chunks: string[] = []
  let summary: string | undefined
  // stderr 必须持续读掉，否则管道写满后子进程会阻塞在那儿。
  const errors: string[] = []
  handle.stderr?.on('data', (chunk: Buffer) => {
    if (errors.length < 64) errors.push(chunk.toString('utf8'))
  })

  const timer = setTimeout(() => { void handle.terminate().catch(() => undefined) }, TURN_TIMEOUT_MS)
  try {
    for await (const line of createInterface({ input: handle.stdout })) {
      for (const event of agent.provider.parseLine(line, agent.caps)) {
        if (event.kind === 'text' && event.text.trim().length > 0) chunks.push(event.text)
        if (event.kind === 'finished') summary = event.summary
      }
    }
    /*
     * 等它退出这一步**必须在看门狗里面**。
     *
     * 关掉 stdout 不等于退出：一个把管道传给孙进程、或者收尾卡住的 CLI，
     * 读完输出之后仍然活着。要是这时候看门狗已经拆了，这里就是一个没人叫得醒
     * 的 await —— 这一轮永远不收场，那个项目的聊天会一直停在"正在想…"，
     * 之后每一句话都因为上一轮还"在跑"而永远派不出去，只能重启看板。
     */
    const outcome = await handle.exited
    const reply = (summary ?? chunks.join('\n')).trim()
    if (reply.length === 0 && outcome.code !== 0) {
      const detail = errors.join('').trim().split('\n').slice(-3).join('\n')
      throw new Error(detail.length > 0 ? detail : `${agent.provider.id} 退出码 ${String(outcome.code)}`)
    }
    return reply
  } catch (error) {
    // 事件流中断（stdout 炸了、解析抛了）时进程很可能还活着。不收掉它，
    // 这一轮就留下一个没人看着的 CLI 在那个仓库里跑 —— 与 runner 同一条规矩。
    await handle.terminate().catch(() => undefined)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把回复里的任务草案摘出来。
 *
 * 摘的是**最后一个**围栏块：执行器在解释自己想法时可能先贴一个例子，真正
 * 提案的那个总在末尾。摘不出来（没提案、或 JSON 写坏了）就当这一轮只是
 * 在聊天 —— 一个格式错误不该把它说的话一起吞掉。
 */
export function splitProposal(reply: string): { text: string; proposal: TaskProposal | null } {
  const fence = new RegExp(`\`\`\`${PROPOSAL_FENCE}\\s*\\n([\\s\\S]*?)\`\`\``, 'g')
  const matches = [...reply.matchAll(fence)]
  const last = matches.at(-1)
  if (last === undefined) return { text: reply.trim(), proposal: null }

  const parsed = parseProposal(last[1] ?? '')
  if (parsed === null) return { text: reply.trim(), proposal: null }
  // 草案单独成一条消息，所以把那个块从正文里拿掉 —— 同一份内容在界面上
  // 出现两次，人会以为它提了两份。
  const text = (reply.slice(0, last.index) + reply.slice(last.index + last[0].length)).trim()
  return { text, proposal: parsed }
}

function parseProposal(raw: string): TaskProposal | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const description = typeof record['description'] === 'string' ? record['description'].trim() : ''
  if (description.length === 0) return null
  const acceptance = Array.isArray(record['acceptance'])
    ? record['acceptance']
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : []
  const relatedTo = Array.isArray(record['relatedTo'])
    ? record['relatedTo'].filter((item): item is string => typeof item === 'string')
    : []
  return { description, acceptance, relatedTo }
}

interface PromptInput {
  readonly project: Project
  readonly executor: Executor
  readonly history: readonly ChatMessage[]
  readonly referenced: readonly Task[]
  /** 这个 CLI 没有只读档，只能靠交代。 */
  readonly readOnly: boolean
}

/**
 * 这一轮交给 CLI 的整段话。
 *
 * 写成一份**每轮自足**的简报（身份、仓库、参考卡片、整段对话、这一轮要做
 * 什么），而不是依赖 CLI 记得上一轮 —— 见文件头第 1 条。
 */
export function renderChatPrompt(input: PromptInput): string {
  const { project, executor, history, referenced, readOnly } = input
  const lines: string[] = []

  lines.push(`你是「${executor.name}」，一个看板（LoopKanban）上的执行器。`)
  lines.push('')
  lines.push('现在你不是在干活，是在**跟人聊需求**：他脑子里有件想做的事，还没想清楚。')
  lines.push('你的任务是把它问清楚，然后写成一张别人（也可能是你自己）照着就能干的卡片。')
  lines.push('')
  lines.push(`仓库：${project.repoPath}（基线分支 ${project.baseBranch}）`)
  lines.push('你可以读这个仓库里的代码来把话说得更具体 —— 这正是你比一个通用助手强的地方。')
  if (readOnly) {
    lines.push('**不要修改任何文件、不要执行任何会改动仓库的命令。** 这一轮只是谈话。')
  }
  lines.push('')

  if (referenced.length > 0) {
    lines.push('## 他提到的卡片')
    lines.push('')
    for (const task of referenced) {
      lines.push(`### #${String(task.id)} · ${taskTitle(task)}（${task.column}）`)
      lines.push('')
      lines.push(task.description.trim().length > 0 ? task.description.trim() : '（没有内容）')
      if (task.acceptance.length > 0) {
        lines.push('')
        lines.push('验收标准：')
        for (const item of task.acceptance) lines.push(`- ${item}`)
      }
      lines.push('')
    }
  }

  lines.push('## 到目前为止的对话')
  lines.push('')
  if (history.length === 0) {
    lines.push('（还没有）')
  } else {
    for (const message of history) {
      if (message.role === 'proposal') {
        lines.push(`你（草案）：${message.body.split('\n')[0] ?? ''}`)
        continue
      }
      lines.push(`${message.role === 'human' ? '他' : '你'}：${message.body}`)
      lines.push('')
    }
  }
  lines.push('')

  lines.push('## 现在做什么')
  lines.push('')
  lines.push('回复他最后那句话。规矩：')
  lines.push('')
  lines.push('- 用他说话的那种语言回。')
  lines.push('- **还不清楚就问**，一次问一两个关键的点，不要一口气列十条。')
  lines.push('- 想清楚了就顺手把范围复述一遍，让他确认。')
  lines.push('- 别客套，别复述这些规矩。')
  lines.push('')
  lines.push('当你判断这件事**已经足够清楚、可以开工**时，在回复的最后附上这样一个代码块：')
  lines.push('')
  lines.push('````')
  lines.push(`\`\`\`${PROPOSAL_FENCE}`)
  lines.push('{')
  lines.push('  "description": "要做的事。第一行是这张卡的名字（一句话），空一行之后写细节",')
  lines.push('  "acceptance": ["怎么算做完了，一条一句"],')
  lines.push('  "relatedTo": ["t-xxxxxxxx"]')
  lines.push('}')
  lines.push('```')
  lines.push('````')
  lines.push('')
  lines.push('这个块会变成一张待确认的草案卡，由**他**决定要不要建。所以：')
  lines.push('')
  lines.push('- 没谈拢就别附，先接着问。一轮里附了，这轮就算谈完了。')
  lines.push('- `relatedTo` 只填对话里出现过的 `#t-` 卡号；没有就给空数组。')
  lines.push('- 附了它之后，正文里不用再重复一遍草案内容 —— 他看得见。')

  return lines.join('\n')
}
