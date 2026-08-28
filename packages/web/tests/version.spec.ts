import { describe, expect, it } from 'vitest'
import { shortVersion } from '../src/lib/utils.ts'

describe('shortVersion', () => {
  it('三家的 --version 格式各不相同，都得挑出版本号本身', () => {
    // 掐开头会把 codex 变成 "codex-cli"，掐结尾会把 claude 变成 "Code)"。
    expect(shortVersion('2.1.250 (Claude Code)')).toBe('2.1.250')
    expect(shortVersion('codex-cli 0.150.1')).toBe('0.150.1')
    expect(shortVersion('1.18.24')).toBe('1.18.24')
  })

  it('认不出就原样给出 —— 宁可长一点，也别给一个错的版本号', () => {
    expect(shortVersion('nightly')).toBe('nightly')
    expect(shortVersion('')).toBe('')
  })
})
