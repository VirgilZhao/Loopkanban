import { describe, expect, it } from 'vitest'
import {
  asExecutorId, checkExecutorName, executorByName, mentionedExecutors, referencedTasks,
  type Executor,
} from '../src/executor.ts'

const make = (name: string): Executor => ({
  id: asExecutorId(`e-${name}`), name, provider: 'claude', createdAt: 0, updatedAt: 0,
})

describe('执行器的名字', () => {
  it('去掉首尾空白之后落定', () => {
    expect(checkExecutorName('  大壮 ')).toEqual({ ok: true, name: '大壮' })
  })

  it('空名字不行 —— 那就没法 @ 它了', () => {
    expect(checkExecutorName('   ')).toEqual({ ok: false, problem: 'empty' })
  })

  it('名字里不许有空格、@ 或 #', () => {
    // 这不是洁癖：`@` 后面跟到哪儿算完全靠这条规矩。
    expect(checkExecutorName('大 壮')).toEqual({ ok: false, problem: 'illegal-chars' })
    expect(checkExecutorName('@大壮')).toEqual({ ok: false, problem: 'illegal-chars' })
    expect(checkExecutorName('大壮#1')).toEqual({ ok: false, problem: 'illegal-chars' })
  })

  it('重名不分大小写 —— 人打字时不会去记大小写', () => {
    expect(checkExecutorName('Ace', ['ace'])).toEqual({ ok: false, problem: 'duplicate' })
  })

  it('太长的名字在卡面和补全里都摆不下', () => {
    expect(checkExecutorName('x'.repeat(25))).toEqual({ ok: false, problem: 'too-long' })
  })

  it('按名字找人也不分大小写', () => {
    expect(executorByName([make('Ace')], 'ACE')?.name).toBe('Ace')
    expect(executorByName([make('Ace')], 'nobody')).toBeUndefined()
  })
})

describe('一段话里点了谁的名', () => {
  const crew = [make('大壮'), make('小壮'), make('ace')]

  it('认出 @ 到的那一位', () => {
    expect(mentionedExecutors('@小壮 帮我看看', crew).map((e) => e.name)).toEqual(['小壮'])
  })

  it('中文名后面直接跟标点也认得出 —— 名字的边界是名字自己，不是分词', () => {
    expect(mentionedExecutors('@大壮，这版你来', crew).map((e) => e.name)).toEqual(['大壮'])
  })

  it('不分大小写', () => {
    expect(mentionedExecutors('@ACE 接手', crew).map((e) => e.name)).toEqual(['ace'])
  })

  it('长名字优先：同时有「壮」和「大壮」时，@大壮 点的是后者', () => {
    const both = [make('壮'), make('大壮')]
    expect(mentionedExecutors('@大壮 来', both).map((e) => e.name)).toEqual(['大壮'])
  })

  it('点了两个人时按在文中出现的先后排 —— 服务端只取第一个', () => {
    expect(mentionedExecutors('先 @小壮 再 @大壮', crew).map((e) => e.name)).toEqual(['小壮', '大壮'])
  })

  it('没有 @ 的名字不算点名', () => {
    expect(mentionedExecutors('大壮昨天写的那段', crew)).toEqual([])
  })

  it('不认识的名字就是不认识，不猜', () => {
    expect(mentionedExecutors('@张三 来一下', crew)).toEqual([])
  })
})

describe('一段话里引用了哪些卡', () => {
  it('认出 #t- 开头的卡号', () => {
    expect(referencedTasks('照着 #t-f3ccd6cc 做')).toEqual(['t-f3ccd6cc'])
  })

  it('去重，按出现先后', () => {
    expect(referencedTasks('#t-aaaa 和 #t-bbbb，再看一眼 #t-aaaa'))
      .toEqual(['t-aaaa', 't-bbbb'])
  })

  it('大写照样认，归一成小写 —— 卡号本来就是小写的', () => {
    expect(referencedTasks('#T-AAAA')).toEqual(['t-aaaa'])
  })

  it('不是卡号的 # 一概不认 —— 否则一句 #1 就会变成一条查无此卡的关联', () => {
    expect(referencedTasks('#1 #fix #t')).toEqual([])
  })
})
