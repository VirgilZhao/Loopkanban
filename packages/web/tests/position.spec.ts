import { describe, expect, it } from 'vitest'
import { insertPosition } from '../src/lib/position.ts'
import type { Column, Task } from '../src/types.ts'

const task = (id: string, column: Column, position: number): Task => ({
  id, projectId: 'p', revision: 1, column, position,
  description: id, acceptance: [], repoPath: '/r', baseBranch: 'main',
  blockedBy: [], createdAt: 0, updatedAt: 0,
})

const board = [
  task('a', 'ready', 1),
  task('b', 'ready', 2),
  task('c', 'ready', 3),
  task('x', 'backlog', 1),
]

describe('insertPosition', () => {
  it('落在首卡上时排到它前面', () => {
    const moving = task('c', 'ready', 3)
    expect(insertPosition(board, moving, 'ready', task('a', 'ready', 1))).toBe(0)
  })

  it('落在中间卡上时取前后中点，不必重排整列', () => {
    const moving = task('a', 'ready', 1)
    // 目标列剩 b(2) c(3)，落在 c 上 → 插到 b 与 c 之间。
    expect(insertPosition(board, moving, 'ready', task('c', 'ready', 3))).toBe(2.5)
  })

  it('落在列空白处时排到列尾', () => {
    const moving = task('x', 'backlog', 1)
    expect(insertPosition(board, moving, 'ready', null)).toBe(4)
  })

  it('空列直接给 1', () => {
    const moving = task('a', 'ready', 1)
    expect(insertPosition(board, moving, 'done', null)).toBe(1)
  })

  it('落点不在本列时按列尾处理，而不是悄悄排到列首', () => {
    // 这是"拖到自己身上"曾经踩中的分支：siblings 里找不到落点，
    // findIndex 返回 -1。旧实现会把它当成 index<=0 排到最前，
    // 而 position 决定自动认领的派发顺序 —— 等于静默改了优先级。
    const moving = task('c', 'ready', 3)
    const ghost = task('不在本列', 'backlog', 9)
    expect(insertPosition(board, moving, 'ready', ghost)).toBe(3)
  })

  it('把卡拖回它原来的位置不会改变相对顺序', () => {
    const moving = task('b', 'ready', 2)
    const next = insertPosition(board, moving, 'ready', task('c', 'ready', 3))
    // 仍然夹在 a(1) 与 c(3) 之间。
    expect(next).toBeGreaterThan(1)
    expect(next).toBeLessThan(3)
  })
})
