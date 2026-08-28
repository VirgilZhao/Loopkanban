import { describe, expect, it } from 'vitest'
import { doneOrder, isUntouchedDraft, projectActivity, taskClockFrom } from '../src/lib/task.ts'
import type { Column } from '../src/types.ts'

describe('isUntouchedDraft', () => {
  it('刚建出来的空白卡是草稿', () => {
    expect(isUntouchedDraft({ revision: 1, description: '', acceptance: [] })).toBe(true)
  })

  it('只有空行与空条目的卡也还是草稿 —— 编辑器默认带一条空验收标准', () => {
    expect(isUntouchedDraft({ revision: 1, description: '  \n ', acceptance: ['', '  '] })).toBe(true)
  })

  it('写了描述就不是草稿', () => {
    expect(isUntouchedDraft({ revision: 1, description: '把登录页拆开', acceptance: [] })).toBe(false)
  })

  it('只写了验收标准也不是草稿', () => {
    expect(isUntouchedDraft({ revision: 1, description: '', acceptance: ['pnpm test 全绿'] })).toBe(false)
  })

  it('存过一次的卡不是草稿 —— 哪怕存进去的内容是空的', () => {
    expect(isUntouchedDraft({ revision: 2, description: '', acceptance: [] })).toBe(false)
  })
})

describe('taskClockFrom', () => {
  const lease = { runId: 'r-1', provider: 'codex', acquiredAt: 1_000, expiresAt: 91_000 }

  it('running 的卡从拿到租约那一刻起算 —— 续租不该把计时清零', () => {
    // 跑了半小时、刚续过租：updatedAt 是心跳，acquiredAt 才是这一轮的开始。
    expect(taskClockFrom({ column: 'running', lease, updatedAt: 1_800_000 })).toBe(1_000)
  })

  it('其余的卡看 updatedAt —— 它们没有心跳在往前推这个数', () => {
    expect(taskClockFrom({ column: 'review', lease, updatedAt: 1_800_000 })).toBe(1_800_000)
    expect(taskClockFrom({ column: 'ready', lease: undefined, updatedAt: 42 })).toBe(42)
  })

  it('running 却没有租约时退回 updatedAt，而不是显示一个空数字', () => {
    expect(taskClockFrom({ column: 'running', lease: undefined, updatedAt: 42 })).toBe(42)
  })

  it('done 的卡从完成那一刻起算 —— 事后归档不该把这个数字拨回今天', () => {
    expect(taskClockFrom({ column: 'done', lease: undefined, doneAt: 1_000, updatedAt: 1_800_000 }))
      .toBe(1_000)
  })
})

describe('doneOrder', () => {
  it('就是完成时间', () => {
    expect(doneOrder({ doneAt: 1_000, updatedAt: 1_800_000 })).toBe(1_000)
  })

  it('迁移之前完成的卡没有 doneAt，退回 updatedAt', () => {
    expect(doneOrder({ updatedAt: 1_800_000 })).toBe(1_800_000)
  })

  it('拿它排出来的就是从新到旧', () => {
    const cards = [
      { id: 'old', doneAt: 1_000, updatedAt: 9_000 },
      { id: 'new', doneAt: 3_000, updatedAt: 3_000 },
      { id: 'mid', doneAt: 2_000, updatedAt: 2_000 },
    ]
    expect([...cards].sort((a, b) => doneOrder(b) - doneOrder(a)).map((c) => c.id))
      .toEqual(['new', 'mid', 'old'])
  })
})

describe('projectActivity', () => {
  /** 只喂 `projectActivity` 真正看的三个字段。 */
  const card = (projectId: string, column: Column, archivedAt?: number) => (
    archivedAt === undefined ? { projectId, column } : { projectId, column, archivedAt }
  )

  it('按项目把各列数出来', () => {
    const counted = projectActivity([
      card('p-1', 'backlog'), card('p-1', 'ready'), card('p-1', 'ready'),
      card('p-1', 'running'), card('p-1', 'review'), card('p-1', 'done'),
      card('p-2', 'review'),
    ])
    expect(counted['p-1']).toEqual({ total: 6, ready: 2, running: 1, review: 1 })
    expect(counted['p-2']).toEqual({ total: 1, ready: 0, running: 0, review: 1 })
  })

  it('归档的卡一律不算 —— 边栏的数字、灯和角标都跟着这条规矩', () => {
    const counted = projectActivity([
      card('p-1', 'running'),
      card('p-1', 'review', 1_700_000_000_000),
      card('p-1', 'ready', 1_700_000_000_000),
    ])
    expect(counted['p-1']).toEqual({ total: 1, ready: 0, running: 1, review: 0 })
  })

  it('一张卡都没有的项目不出现在表里 —— 那一行按 0 显示', () => {
    expect(projectActivity([])).toEqual({})
    expect(projectActivity([card('p-1', 'done')])['p-2']).toBeUndefined()
  })
})
