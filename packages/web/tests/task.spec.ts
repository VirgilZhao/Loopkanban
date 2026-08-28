import { describe, expect, it } from 'vitest'
import { isUntouchedDraft } from '../src/lib/task.ts'

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
