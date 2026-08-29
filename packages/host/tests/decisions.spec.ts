import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { asProjectId, asRunId, asTaskId, type Task } from '@loopkanban/core'
import { DecisionHub, DEFAULT_DECISION_TIMEOUT_MS } from '../src/decisions/index.ts'
import { RunBus } from '../src/server/bus.ts'
import { Storage } from '../src/storage/index.ts'

const T0 = 1_700_000_000_000
const RUN = asRunId('run-abc12345')
const TASK = asTaskId('t-abc12345')
const PROJECT = asProjectId('p-abc12345')

/** 时钟走测试推进：每调一次 now 前进一步。 */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let at = T0
  return { now: () => at, advance: (ms) => { at += ms } }
}

let store: Storage
let bus: RunBus
let tick: ReturnType<typeof clock>

beforeEach(() => {
  store = Storage.open(':memory:')
  bus = new RunBus()
  tick = clock()
})

afterEach(() => { store.close() })

function hub(timeoutMs?: number): DecisionHub {
  return new DecisionHub({
    storage: store, bus,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    now: tick.now,
  })
}

function task(): Task {
  return {
    id: TASK, projectId: PROJECT, revision: 1, column: 'running', position: 1,
    description: '做点事', acceptance: [],
    repoPath: '/tmp/repo', baseBranch: 'main',
    blockedBy: [], relatedTo: [], createdAt: T0, updatedAt: T0,
  }
}

beforeEach(() => {
  // listPendingDecisions 要 join runs 拿 task_id，得把外键链（项目 → 卡 → Run）建全。
  store.createProject({ id: PROJECT, name: '默认', repoPath: '/tmp/repo', baseBranch: 'main', createdAt: T0 })
  store.createTask(task())
  store.createRun({
    id: RUN, taskId: TASK, provider: 'claude', cliVersion: '1', worktreePath: '/tmp/wt',
    branch: 'b', status: 'running', startedAt: T0,
  })
})

describe('DecisionHub.create', () => {
  it('权限请求落库为 pending 并广播 decision 事件', () => {
    const gate = hub()
    const seen: string[] = []
    bus.subscribe(RUN, (event) => { seen.push(event.kind) })

    const decision = gate.create(RUN, { kind: 'permission', payload: { tool: 'Bash', input: { command: 'ls' } } })
    expect(decision.status).toBe('pending')
    expect(decision.kind).toBe('permission')
    expect(store.getDecision(decision.id)?.status).toBe('pending')
    expect(seen).toEqual(['decision'])
  })

  it('提问的负载原样落库', () => {
    const decision = hub().create(RUN, { kind: 'question', payload: { question: '用哪个库？', choices: ['a', 'b'] } })
    expect(decision.payload).toEqual({ question: '用哪个库？', choices: ['a', 'b'] })
  })

  it('负载不成立当场拒绝', () => {
    const gate = hub()
    expect(() => gate.create(RUN, { kind: 'permission', payload: { input: {} } })).toThrow('tool')
    expect(() => gate.create(RUN, { kind: 'question', payload: { question: '' } })).toThrow('question')
    expect(() => gate.create(RUN, { kind: 'question', payload: { question: 'q', choices: [1] } })).toThrow('choices')
  })

  it('命中"本次执行内总是允许"的记忆就不打扰人，直接以终态落库', () => {
    const gate = hub()
    const asked = gate.create(RUN, { kind: 'permission', payload: { tool: 'Bash', input: {} } })
    gate.resolve(RUN, asked.id, { status: 'allowed', answer: { decision: 'allow' } }, 'run')

    const again = gate.create(RUN, { kind: 'permission', payload: { tool: 'Bash', input: { command: 'x' } } })
    expect(again.status).toBe('allowed')
    expect((again.answer as Record<string, unknown>)['auto']).toBe(true)
    // 其他工具照旧要问。
    expect(gate.create(RUN, { kind: 'permission', payload: { tool: 'Write', input: {} } }).status).toBe('pending')
  })

  it('记忆只对这一次执行有效', () => {
    const gate = hub()
    const asked = gate.create(RUN, { kind: 'permission', payload: { tool: 'Bash', input: {} } })
    gate.resolve(RUN, asked.id, { status: 'allowed', answer: { decision: 'allow' } }, 'run')
    gate.revokeRun(RUN)

    const other = asRunId('run-other000')
    store.createRun({
      id: other, taskId: TASK, provider: 'claude', cliVersion: '1', worktreePath: '/tmp/wt',
      branch: 'b', status: 'running', startedAt: T0,
    })
    expect(gate.create(other, { kind: 'permission', payload: { tool: 'Bash', input: {} } }).status).toBe('pending')
  })
})

describe('DecisionHub.resolve', () => {
  it('放行后写终态并广播 decision_resolved', () => {
    const gate = hub()
    const seen: string[] = []
    bus.subscribe(RUN, (event) => { seen.push(event.kind) })
    const decision = gate.create(RUN, { kind: 'permission', payload: { tool: 'Bash', input: {} } })

    const settled = gate.resolve(RUN, decision.id, { status: 'allowed', answer: { decision: 'allow' } })
    expect(settled?.status).toBe('allowed')
    expect(seen).toEqual(['decision', 'decision_resolved'])
  })

  it('已处理的决策拒绝再改 —— 篡改"谁放行的"是不行的', () => {
    const gate = hub()
    const decision = gate.create(RUN, { kind: 'permission', payload: { tool: 'Bash', input: {} } })
    expect(gate.resolve(RUN, decision.id, { status: 'allowed', answer: {} })).not.toBeNull()
    expect(gate.resolve(RUN, decision.id, { status: 'denied', answer: {} })).toBeNull()
  })

  it('终态与 kind 对不上就拒绝：提问不接受 allow，权限不接受 answered', () => {
    const gate = hub()
    const question = gate.create(RUN, { kind: 'question', payload: { question: 'q' } })
    expect(gate.resolve(RUN, question.id, { status: 'allowed', answer: {} })).toBeNull()
    const permission = gate.create(RUN, { kind: 'permission', payload: { tool: 'T', input: {} } })
    expect(gate.resolve(RUN, permission.id, { status: 'answered', answer: {} })).toBeNull()
  })

  it('别的 run 的决策拿不到（防串台）', () => {
    const gate = hub()
    const decision = gate.create(RUN, { kind: 'permission', payload: { tool: 'T', input: {} } })
    expect(gate.get(asRunId('run-other000'), decision.id)).toBeNull()
  })
})

describe('DecisionHub 超时', () => {
  it('到点自动收场：权限按拒绝、提问按未获回答', async () => {
    const gate = hub(50)
    const permission = gate.create(RUN, { kind: 'permission', payload: { tool: 'T', input: {} } })
    const question = gate.create(RUN, { kind: 'question', payload: { question: 'q' } })

    tick.advance(DEFAULT_DECISION_TIMEOUT_MS)
    await new Promise((r) => setTimeout(r, 120))

    const settledPermission = store.getDecision(permission.id)
    // 状态统一记 timeout（语义由 answer 承载：权限按拒绝、提问按未获回答）。
    expect(settledPermission?.status).toBe('timeout')
    expect((settledPermission?.answer as Record<string, unknown>)['decision']).toBe('deny')
    const settledQuestion = store.getDecision(question.id)
    expect(settledQuestion?.status).toBe('timeout')
    expect(String((settledQuestion?.answer as Record<string, unknown>)['text'])).toContain('超时')
  }, 5_000)

  it('resolve 之后再不挂新定时器：收场不可被覆盖', async () => {
    const gate = hub(60)
    const decision = gate.create(RUN, { kind: 'question', payload: { question: 'q' } })
    expect(gate.resolve(RUN, decision.id, { status: 'answered', answer: { text: '好的' } })).not.toBeNull()

    tick.advance(DEFAULT_DECISION_TIMEOUT_MS)
    await new Promise((r) => setTimeout(r, 150))
    // 人的答复不被超时覆盖。
    expect((store.getDecision(decision.id)?.answer as Record<string, unknown>)['text']).toBe('好的')
  }, 5_000)
})

describe('DecisionHub.expireRun', () => {
  it('只收 pending 的，已处理的不动', () => {
    const gate = hub()
    const keep = gate.create(RUN, { kind: 'question', payload: { question: 'q' } })
    gate.resolve(RUN, keep.id, { status: 'answered', answer: { text: '好' } })
    const drop = gate.create(RUN, { kind: 'permission', payload: { tool: 'T', input: {} } })

    expect(gate.expireRun(RUN, 'cancelled')).toBe(1)
    expect(store.getDecision(keep.id)?.status).toBe('answered')
    expect(store.getDecision(drop.id)?.status).toBe('cancelled')
    expect(gate.pendingCount(RUN)).toBe(0)
  })
})

describe('DecisionHub.run token', () => {
  it('签发的 token 只属于它的 run', () => {
    const gate = hub()
    const token = gate.issueToken(RUN)
    expect(gate.runIdForToken(token)).toBe(RUN)
    expect(gate.runIdForToken('不是token')).toBeNull()
  })
})

describe('DecisionHub.pendingByTask', () => {
  it('按任务归组还在等的决策', () => {
    const gate = hub()
    gate.create(RUN, { kind: 'permission', payload: { tool: 'T', input: {} } })
    gate.create(RUN, { kind: 'question', payload: { question: 'q' } })
    const resolved = gate.create(RUN, { kind: 'question', payload: { question: 'q2' } })
    gate.resolve(RUN, resolved.id, { status: 'answered', answer: { text: '好' } })

    const pending = gate.pendingByTask()
    expect(pending.get(TASK)?.length).toBe(2)
  })
})
