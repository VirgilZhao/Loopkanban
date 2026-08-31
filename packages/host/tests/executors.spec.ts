import { beforeEach, describe, expect, it } from 'vitest'
import { asExecutorId, asProjectId, asTaskId, type Task } from '@loopkanban/core'
import {
  assignmentFor, bindingFor, createExecutor, defaultExecutor, providerPins, seedExecutors,
  setDefaultExecutor, updateExecutor,
} from '../src/executors/index.ts'
import type { DetectedAgent } from '../src/agents/index.ts'
import { Storage, type Project } from '../src/storage/index.ts'

const T0 = 1_000_000
const PROJECT = asProjectId('b1')
const KNOWN = ['claude', 'codex']

let store: Storage

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

/** 一个够用的假 provider —— 这些测试只关心它的 id。 */
const agent = (id: string): DetectedAgent =>
  ({ provider: { id }, caps: { id } } as unknown as DetectedAgent)

beforeEach(() => {
  store = Storage.open(':memory:')
  store.createProject(project())
  return () => { store.close() }
})

describe('建执行器', () => {
  it('第一个建出来的自然就是默认的', () => {
    const made = createExecutor(store, { name: '大壮', provider: 'claude', model: 'opus' }, KNOWN, T0)
    expect(made.ok).toBe(true)
    expect(defaultExecutor(store)?.name).toBe('大壮')
  })

  it('后来的不抢默认位', () => {
    createExecutor(store, { name: '大壮', provider: 'claude' }, KNOWN, T0)
    createExecutor(store, { name: '小壮', provider: 'claude' }, KNOWN, T0)
    expect(defaultExecutor(store)?.name).toBe('大壮')
  })

  it('本机没探测到的 CLI 当场拒绝，而不是等到派活那一刻才炸', () => {
    const made = createExecutor(store, { name: '大壮', provider: 'gemini' }, KNOWN, T0)
    expect(made).toEqual({ ok: false, problem: 'unknown-provider' })
  })

  it('重名拒绝', () => {
    createExecutor(store, { name: '大壮', provider: 'claude' }, KNOWN, T0)
    expect(createExecutor(store, { name: '大壮', provider: 'codex' }, KNOWN, T0))
      .toEqual({ ok: false, problem: 'duplicate' })
  })

  it('模型给空串等于没给 —— 用那个 CLI 自己的默认', () => {
    const made = createExecutor(store, { name: '大壮', provider: 'claude', model: '  ' }, KNOWN, T0)
    expect(made.ok && made.executor.model).toBeUndefined()
  })
})

describe('改执行器', () => {
  it('改名不算跟自己重名', () => {
    const made = createExecutor(store, { name: '大壮', provider: 'claude' }, KNOWN, T0)
    const id = made.ok ? made.executor.id : asExecutorId('x')
    expect(updateExecutor(store, id, { name: '大壮' }, KNOWN, T0).ok).toBe(true)
  })

  it('模型给空串是"回到那个 CLI 自己的默认"', () => {
    const made = createExecutor(store, { name: '大壮', provider: 'claude', model: 'opus' }, KNOWN, T0)
    const id = made.ok ? made.executor.id : asExecutorId('x')
    const saved = updateExecutor(store, id, { model: '' }, KNOWN, T0)
    expect(saved.ok && saved.executor.model).toBeUndefined()
    expect(store.getExecutor(id)?.model).toBeUndefined()
  })
})

describe('默认执行器', () => {
  it('一个都没有时没有默认', () => {
    expect(defaultExecutor(store)).toBeNull()
  })

  it('设置里指着一个已经删掉的，退回第一个而不是就此停摆', () => {
    createExecutor(store, { name: '大壮', provider: 'claude' }, KNOWN, T0)
    store.setSetting('defaultExecutor', 'e-gone')
    expect(defaultExecutor(store)?.name).toBe('大壮')
  })

  it('指一个不存在的 id 不生效', () => {
    createExecutor(store, { name: '大壮', provider: 'claude' }, KNOWN, T0)
    expect(setDefaultExecutor(store, asExecutorId('e-nope'))).toBe(false)
  })
})

describe('删执行器', () => {
  it('引用它的卡就地解绑，卡本身一张不动', () => {
    const made = createExecutor(store, { name: '大壮', provider: 'claude' }, KNOWN, T0)
    const id = made.ok ? made.executor.id : asExecutorId('x')
    store.createTask(task({ id: 't1', executorId: id }))

    store.deleteExecutor(id)
    const after = store.getTask(asTaskId('t1'))
    expect(after).not.toBeNull()
    expect(after?.executorId).toBeUndefined()
  })
})

describe('一张卡归谁', () => {
  it('卡上写了就是它', () => {
    createExecutor(store, { name: '大壮', provider: 'claude' }, KNOWN, T0)
    const small = createExecutor(store, { name: '小壮', provider: 'codex', model: 'gpt' }, KNOWN, T0)
    const id = small.ok ? small.executor.id : asExecutorId('x')
    expect(assignmentFor(store, task({ id: 't1', executorId: id })).executor?.name).toBe('小壮')
    expect(bindingFor(store, task({ id: 't1', executorId: id })))
      .toEqual({ provider: 'codex', model: 'gpt' })
  })

  it('卡上没写就是默认那位', () => {
    createExecutor(store, { name: '大壮', provider: 'claude', model: 'opus' }, KNOWN, T0)
    expect(bindingFor(store, task({ id: 't1' }))).toEqual({ provider: 'claude', model: 'opus' })
  })

  it('卡上指着一个已经删掉的执行器时退回默认，而不是再也派不出去', () => {
    createExecutor(store, { name: '大壮', provider: 'claude', model: 'opus' }, KNOWN, T0)
    const orphan = task({ id: 't1', executorId: asExecutorId('e-gone') })
    expect(assignmentFor(store, orphan).executor?.name).toBe('大壮')
    expect(bindingFor(store, orphan)).toEqual({ provider: 'claude', model: 'opus' })
  })

  it('卡上钉过 CLI 时不认领执行器 —— 认领了下一轮就会把这次选择盖掉', () => {
    createExecutor(store, { name: '大壮', provider: 'claude' }, KNOWN, T0)
    expect(assignmentFor(store, task({ id: 't1', preferredProvider: 'codex' })).executor).toBeNull()
  })

  it('一个执行器都没有时退回卡上那两个老字段', () => {
    expect(bindingFor(store, task({ id: 't1', preferredProvider: 'codex', model: 'gpt' })))
      .toEqual({ provider: 'codex', model: 'gpt' })
  })

  it('卡上钉过 CLI 的压过默认执行器 —— 明确的选择不该被一个没设过的默认值改掉', () => {
    createExecutor(store, { name: '大壮', provider: 'claude', model: 'opus' }, KNOWN, T0)
    expect(bindingFor(store, task({ id: 't1', preferredProvider: 'codex', model: 'gpt' })))
      .toEqual({ provider: 'codex', model: 'gpt' })
  })

  it('但钉了执行器的又压过它 —— 那是界面上现在唯一的说法', () => {
    const made = createExecutor(store, { name: '大壮', provider: 'claude', model: 'opus' }, KNOWN, T0)
    const id = made.ok ? made.executor.id : asExecutorId('x')
    expect(bindingFor(store, task({ id: 't1', executorId: id, preferredProvider: 'codex' })))
      .toEqual({ provider: 'claude', model: 'opus' })
  })
})

describe('派活时那张 provider 表', () => {
  it('一个执行器都没有时是空的 —— 调度回到"挑当前跑得最少的那个"', () => {
    expect(providerPins(store, [task({ id: 't1' })]).size).toBe(0)
  })

  it('没指定的卡也钉到默认那位背后的 CLI 上', () => {
    createExecutor(store, { name: '大壮', provider: 'claude' }, KNOWN, T0)
    const pins = providerPins(store, [task({ id: 't1' })])
    expect(pins.get(asTaskId('t1'))).toBe('claude')
  })

  it('卡上钉过 CLI 的不进这张表 —— 那一条交给 planDispatch 自己看，两处别各说一遍', () => {
    createExecutor(store, { name: '大壮', provider: 'claude' }, KNOWN, T0)
    const pins = providerPins(store, [task({ id: 't1', preferredProvider: 'codex' })])
    expect(pins.has(asTaskId('t1'))).toBe(false)
  })

  it('执行器改了 CLI，下一轮就跟着换 —— 值不是建卡时拷进卡里的', () => {
    const made = createExecutor(store, { name: '大壮', provider: 'claude' }, KNOWN, T0)
    const id = made.ok ? made.executor.id : asExecutorId('x')
    store.createTask(task({ id: 't1', executorId: id }))
    updateExecutor(store, id, { provider: 'codex' }, KNOWN, T0)
    expect(providerPins(store, store.listTasks()).get(asTaskId('t1'))).toBe('codex')
  })
})

describe('照探测结果兜底建一批', () => {
  it('库里一个都没有时，探测到几个就建几个，第一个是默认', () => {
    const made = seedExecutors(store, [agent('claude'), agent('codex')], T0)
    expect(made.map((executor) => executor.name)).toEqual(['claude', 'codex'])
    expect(defaultExecutor(store)?.name).toBe('claude')
  })

  it('已经有执行器就一个都不建 —— 删光了是一个明确的选择，不该被下次启动撤销', () => {
    createExecutor(store, { name: '大壮', provider: 'claude' }, KNOWN, T0)
    expect(seedExecutors(store, [agent('codex')], T0)).toEqual([])
    expect(store.listExecutors()).toHaveLength(1)
  })
})
