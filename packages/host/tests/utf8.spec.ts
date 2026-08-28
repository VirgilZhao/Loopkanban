import { describe, expect, it } from 'vitest'
import { decodeUtf8, trimPartialUtf8 } from '../src/fs/utf8.ts'

describe('trimPartialUtf8', () => {
  it('结尾是完整字符时一个字节都不动', () => {
    for (const text of ['', 'abc', '中文', '中文abc', '👋']) {
      const buffer = Buffer.from(text, 'utf8')
      expect(trimPartialUtf8(buffer).equals(buffer)).toBe(true)
    }
  })

  it('砍在多字节字符中间时，把那半个去掉', () => {
    // 一个汉字 3 字节：只留 1 个、留 2 个，都该被削回去。
    const cjk = Buffer.from('好', 'utf8')
    expect(trimPartialUtf8(cjk.subarray(0, 1)).length).toBe(0)
    expect(trimPartialUtf8(cjk.subarray(0, 2)).length).toBe(0)

    // 4 字节的 emoji 同理，且前面完整的字符要留住。
    const mixed = Buffer.from('ok👋', 'utf8')
    for (const keep of [3, 4, 5]) {
      expect(trimPartialUtf8(mixed.subarray(0, keep)).toString('utf8')).toBe('ok')
    }
  })
})

describe('decodeUtf8', () => {
  /*
   * 这一条是这个函数存在的理由：中文正文被按字节截断时，最后一个字会剩下
   * 一两个字节，解出来就是一个 `�`。它出现在正文末尾，读的人第一反应是
   * 「文件坏了」，而不是「这里被截断了」。
   */
  it('截断的内容不留下半个字符', () => {
    const buffer = Buffer.from('中'.repeat(10), 'utf8').subarray(0, 11)
    const text = decodeUtf8(buffer, true)
    expect(text).not.toContain('�')
    expect(text).toBe('中'.repeat(3))
  })

  /*
   * 反过来，没截断就一个字节都不许动：完整读下来的内容即便结尾就是不合法的
   * UTF-8（半个二进制文件、坏掉的日志），那也是它本来的样子。
   */
  it('没截断就原样解，哪怕结尾本来就不合法', () => {
    const broken = Buffer.from([0x61, 0xe4, 0xb8])
    expect(decodeUtf8(broken, false)).toBe('a�')
    expect(decodeUtf8(broken, true)).toBe('a')
  })
})
