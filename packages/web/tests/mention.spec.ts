import { describe, expect, it } from 'vitest'
import { mentioned, referenced } from '../src/lib/mention.ts'
import type { Executor } from '../src/types.ts'

const make = (name: string): Executor => ({
  id: `e-${name}`, name, provider: 'claude', createdAt: 0, updatedAt: 0,
})

/**
 * 这一份规则在服务端（core 的 executor.ts）也有一份 —— 前端不依赖后端包，
 * 那是那条边界的代价。两边的行为必须一致，所以这些用例与 core 那边成对：
 * 改了一边，另一边的测试要一起改，否则界面上说的和真正生效的会不是一回事。
 */
describe('输入框里的 @ 点名', () => {
  const crew = [make('大壮'), make('小壮'), make('ace')]

  it('认出 @ 到的那一位', () => {
    expect(mentioned('@小壮 帮我看看', crew)?.name).toBe('小壮')
  })

  it('中文名后面直接跟标点也认得出', () => {
    expect(mentioned('@大壮，这版你来', crew)?.name).toBe('大壮')
  })

  it('不分大小写', () => {
    expect(mentioned('@ACE 接手', crew)?.name).toBe('ace')
  })

  it('长名字优先', () => {
    expect(mentioned('@大壮 来', [make('壮'), make('大壮')])?.name).toBe('大壮')
  })

  it('点了两个人时以先出现的那个为准 —— 服务端也是这么定的', () => {
    expect(mentioned('先 @小壮 再 @大壮', crew)?.name).toBe('小壮')
  })

  it('没有 @ 的名字不算点名', () => {
    expect(mentioned('大壮昨天写的那段', crew)).toBeUndefined()
  })

  it('不认识的名字不猜', () => {
    expect(mentioned('@张三 来一下', crew)).toBeUndefined()
  })
})

describe('输入框里的 # 引用', () => {
  it('认出卡号，去重，按出现先后', () => {
    expect(referenced('#t-aaaa 和 #t-bbbb，再看一眼 #t-aaaa')).toEqual(['t-aaaa', 't-bbbb'])
  })

  it('大写归一成小写', () => {
    expect(referenced('#T-AAAA')).toEqual(['t-aaaa'])
  })

  it('不是卡号的 # 一概不认', () => {
    expect(referenced('#1 #fix #t')).toEqual([])
  })
})
