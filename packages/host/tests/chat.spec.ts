import { beforeEach, describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asProjectId, asTaskId, type Task } from '@loopkanban/core'
import { AgentPool, type DetectedAgent } from '../src/agents/index.ts'
import type { AgentEvent } from '../src/agents/types.ts'
import { ChatService, renderChatPrompt, splitProposal } from '../src/chat/index.ts'
import { createExecutor } from '../src/executors/index.ts'
import { Storage, type Project } from '../src/storage/index.ts'
import type { ProcessHandle, SpawnSpec } from '../src/subprocess/index.ts'

const T0 = 1_000_000
const PROJECT = asProjectId('b1')

let store: Storage
let dir: string

const project = (): Project => ({
  id: PROJECT, name: '看板', repoPath: '/repo', baseBranch: 'main', createdAt: T0,
})

function task(patch: Omit<Partial<Task>, 'id'> & { id: string }): Task {
  const { id, ...rest } = patch
  return {
    id: asTaskId(id), projectId: PROJECT, revision: 1, column: 'ready', position: 1,
    description: id, acceptance: [], repoPath: '/repo', baseBranch: 'main',
    blockedBy: [], relatedTo: [], createdAt: T0, updatedAt: T0, ...rest,
  }
}

/**
 * 一个假的 CLI：每行输出就是一条 `text` 事件，最后一行收尾。
 *
 * 真正要测的是"这一轮说了什么、草案摘没摘出来"，不是某家 CLI 的输出格式 ——
 * 那是各自 provider 的测试该管的事。
 */
function fakeAgent(reply: string, caps: Partial<{ permissionTiers: string[] }> = {}): DetectedAgent {
  return {
    provider: {
      id: 'claude',
      buildStart: (): SpawnSpec => ({ argv: ['true'], cwd: '/' }),
      parseLine: (line: string): readonly AgentEvent[] =>
        (line === '<<done>>' ? [{ kind: 'finished', ok: true }] : [{ kind: 'text', text: line }]),
    },
    caps: {
      id: 'claude',
      version: '1',
      permissionTiers: caps.permissionTiers ?? ['strict', 'standard'],
      models: [],
    },
    // 这一份只被 ChatService 读到上面这几项。
    reply,
  } as unknown as DetectedAgent
}

/** 起一个把 `lines` 一行行吐出来、然后正常退出的假进程。 */
function fakeSpawn(lines: readonly string[]): (spec: SpawnSpec) => Promise<ProcessHandle> {
  return () => Promise.resolve({
    pid: 1,
    stdout: Readable.from([...lines, '<<done>>'].map((line) => `${line}\n`)),
    stderr: null,
    stdin: null,
    exited: Promise.resolve({ code: 0, signal: null, treeQuiesced: true }),
    terminate: () => Promise.resolve({ code: 0, signal: null, treeQuiesced: true }),
    outcome: () => ({ code: 0, signal: null, treeQuiesced: true }),
  } as unknown as ProcessHandle)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lk-chat-'))
  store = Storage.open(':memory:')
  store.createProject(project())
  createExecutor(store, { name: '大壮', provider: 'claude' }, ['claude'], T0)
  return async () => {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

describe('从回复里摘出任务草案', () => {
  it('摘出围栏里的 JSON，并把那个块从正文里拿掉', () => {
    const { text, proposal } = splitProposal([
      '那就这么定：把导出做成后台任务。',
      '',
      '```loopkanban-task',
      '{"description":"把导出做成后台任务","acceptance":["点了导出立刻有回执"],"relatedTo":[]}',
      '```',
    ].join('\n'))
    expect(proposal?.description).toBe('把导出做成后台任务')
    expect(proposal?.acceptance).toEqual(['点了导出立刻有回执'])
    // 同一份内容在界面上出现两次，人会以为它提了两份。
    expect(text).toBe('那就这么定：把导出做成后台任务。')
  })

  it('没有围栏就是"这一轮只是在聊天"', () => {
    const { text, proposal } = splitProposal('你是想批量导出，还是单条？')
    expect(proposal).toBeNull()
    expect(text).toBe('你是想批量导出，还是单条？')
  })

  it('JSON 写坏了不吞掉它说的话', () => {
    const reply = '就这样吧\n\n```loopkanban-task\n{ 这不是 JSON\n```'
    const { text, proposal } = splitProposal(reply)
    expect(proposal).toBeNull()
    expect(text).toContain('就这样吧')
  })

  it('没有 description 的草案不算草案 —— 建出来会是一张空卡', () => {
    expect(splitProposal('```loopkanban-task\n{"acceptance":["x"]}\n```').proposal).toBeNull()
  })

  it('取最后一个围栏：解释想法时贴的例子在前，真提案在末尾', () => {
    const reply = [
      '比如可以写成这样：',
      '```loopkanban-task',
      '{"description":"示例"}',
      '```',
      '不过我建议：',
      '```loopkanban-task',
      '{"description":"真正的那份"}',
      '```',
    ].join('\n')
    expect(splitProposal(reply).proposal?.description).toBe('真正的那份')
  })

  it('acceptance 里的空条目与非字符串一概丢掉', () => {
    const reply = '```loopkanban-task\n{"description":"x","acceptance":["ok","  ",3]}\n```'
    expect(splitProposal(reply).proposal?.acceptance).toEqual(['ok'])
  })
})

describe('交给 CLI 的那段话', () => {
  const executor = { id: 'e1', name: '大壮', provider: 'claude', createdAt: 0, updatedAt: 0 } as never

  it('带上仓库、身份，以及整段对话 —— 每一轮都是自足的', () => {
    const prompt = renderChatPrompt({
      project: project(),
      executor,
      history: [
        { id: 'm1', projectId: PROJECT, role: 'human', body: '导出太慢了', at: T0 },
        { id: 'm2', projectId: PROJECT, role: 'agent', body: '多少条数据？', at: T0 + 1 },
      ],
      referenced: [],
      readOnly: false,
    })
    expect(prompt).toContain('大壮')
    expect(prompt).toContain('/repo')
    expect(prompt).toContain('导出太慢了')
    expect(prompt).toContain('多少条数据？')
    expect(prompt).toContain('loopkanban-task')
  })

  it('没有只读档的 CLI 要被明确交代"别改文件"', () => {
    const prompt = renderChatPrompt({
      project: project(), executor, history: [], referenced: [], readOnly: true,
    })
    expect(prompt).toContain('不要修改任何文件')
  })

  it('引用到的卡把内容展开带过去 —— #任务id 的意思就是"参考它"', () => {
    const prompt = renderChatPrompt({
      project: project(),
      executor,
      history: [],
      referenced: [task({ id: 't-f3ccd6cc', description: '旧的导出实现', acceptance: ['有测试'] })],
      readOnly: false,
    })
    expect(prompt).toContain('#t-f3ccd6cc')
    expect(prompt).toContain('旧的导出实现')
    expect(prompt).toContain('有测试')
  })
})

describe('聊一轮', () => {
  /** 等这个项目那一轮跑完。轮次是后台跑的，状态靠轮询。 */
  const settle = async (chat: ChatService): Promise<void> => {
    for (let i = 0; i < 200 && chat.state(project()).pending; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  it('同一毫秒里连着写的消息也排得住 —— 顺序不能靠随机 id 决定', async () => {
    const chat = new ChatService({
      storage: store,
      agents: AgentPool.of([fakeAgent('')]),
      artifactsRoot: dir,
      // 时钟钉死：不这么钉，真实时钟走一格就掩盖了这件事。
      now: () => T0,
      spawn: fakeSpawn(['\u597d']),
    })
    chat.say(project(), '第一句')
    chat.say(project(), '第二句')
    await settle(chat)

    const stamps = chat.state(project()).messages.map((m) => m.at)
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b))
    expect(new Set(stamps).size).toBe(stamps.length)
    expect(chat.state(project()).messages.map((m) => m.body).slice(0, 2)).toEqual(['第一句', '第二句'])
  })

  it('人说的话先落库，回复与草案随后跟上', async () => {
    const chat = new ChatService({
      storage: store,
      agents: AgentPool.of([fakeAgent('')]),
      artifactsRoot: dir,
      spawn: fakeSpawn([
        '那就这么定。',
        '```loopkanban-task',
        '{"description":"把导出做成后台任务","acceptance":["有回执"],"relatedTo":[]}',
        '```',
      ]),
    })

    const first = chat.say(project(), '导出太慢了')
    // 人那句话是**立刻**在的：一轮 CLI 要跑几十秒，界面不该对着空白等。
    expect(first.messages.map((m) => m.role)).toEqual(['human'])
    expect(first.pending).toBe(true)

    await settle(chat)
    const after = chat.state(project())
    expect(after.messages.map((m) => m.role)).toEqual(['human', 'agent', 'proposal'])
    expect(after.messages[2]?.proposal?.description).toBe('把导出做成后台任务')
    // 草案排在它那句回复后面，不是同一毫秒里靠 id 随机决定。
    expect(after.messages[2]!.at).toBeGreaterThan(after.messages[1]!.at)
  })

  it('它想的时候人又说了一句：这一轮答完接着答那一句，而不是让它没有下文', async () => {
    const chat = new ChatService({
      storage: store, agents: AgentPool.of([fakeAgent('')]), artifactsRoot: dir, spawn: fakeSpawn(['嗯']),
    })
    chat.say(project(), '第一句')
    // 第一轮还在跑的时候说的第二句：它赶不上那一轮的 prompt。
    chat.say(project(), '第二句')
    await settle(chat)

    // 断言的是"两句都有人应"，不是它们的先后 —— 这个假 CLI 快到第一轮可能
    // 在第二句之前就答完了，那种交错顺序是测试环境的产物，不是行为的一部分。
    const roles = chat.state(project()).messages.map((m) => m.role)
    expect(roles.filter((role) => role === 'human')).toHaveLength(2)
    expect(roles.filter((role) => role === 'agent')).toHaveLength(2)
  })

  it('它想的时候补的那句 @了别人，就归别人答 —— 不是默认那位', async () => {
    createExecutor(store, { name: '小壮', provider: 'codex' }, ['claude', 'codex'], T0)
    const spoken: string[] = []
    const chat = new ChatService({
      storage: store,
      agents: AgentPool.of([fakeAgent(''), { ...fakeAgent(''), provider: { ...fakeAgent('').provider, id: 'codex' } } as never]),
      artifactsRoot: dir,
      spawn: fakeSpawn(['嗯']),
    })
    chat.say(project(), '第一句')
    chat.say(project(), '@小壮 这句你来')
    await settle(chat)

    // 两句话都有人应，其中一轮归小壮 —— 落在它那条回复的 executorId 上。
    // 断言的是"小壮答过"，不是它排第几：这个假 CLI 快到两条回复能落在同一
    // 毫秒里，那时的先后由 id 决定，与行为无关。
    const answers = chat.state(project()).messages.filter((m) => m.role === 'agent')
    expect(answers).toHaveLength(2)
    spoken.push(...answers.map((m) => String(m.executorId)))
    const small = store.listExecutors().find((e) => e.name === '小壮')
    expect(spoken).toContain(String(small?.id))
  })

  it('执行器的 CLI 没探测到时，事故记在一边，不混进对话', async () => {
    const chat = new ChatService({
      storage: store,
      agents: AgentPool.of([]),
      artifactsRoot: dir,
      spawn: fakeSpawn([]),
    })
    chat.say(project(), '在吗')
    await settle(chat)
    const after = chat.state(project())
    expect(after.messages.map((m) => m.role)).toEqual(['human'])
    expect(after.failure).toContain('claude')
  })

  it('一个执行器都没有时说清楚，而不是让那句话石沉大海', () => {
    store.deleteExecutor(store.listExecutors()[0]!.id)
    const chat = new ChatService({
      storage: store, agents: AgentPool.of([]), artifactsRoot: dir, spawn: fakeSpawn([]),
    })
    expect(chat.say(project(), '在吗').failure).toBe('no-executor')
  })

  it('清空只清对话 —— 已经建出来的卡早就是卡了', async () => {
    const chat = new ChatService({
      storage: store, agents: AgentPool.of([fakeAgent('')]), artifactsRoot: dir, spawn: fakeSpawn(['好']),
    })
    chat.say(project(), '一句话')
    await settle(chat)
    store.createTask(task({ id: 't1' }))

    chat.clear(project())
    expect(chat.state(project()).messages).toEqual([])
    expect(store.getTask(asTaskId('t1'))).not.toBeNull()
  })
})
