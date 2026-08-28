import { describe, expect, it } from 'vitest'
import { commonPrefix, completable, literal, matching, splitPath, tokenAt } from '../src/lib/complete.ts'

describe('tokenAt', () => {
  it('认出光标前那个词，并给出能替换的区间', () => {
    const line = 'cat packages/we'
    expect(tokenAt(line, line.length)).toMatchObject({ start: 4, end: 15, value: 'packages/we', quote: null })
  })

  it('光标停在空白上时是个空词 —— `cd ` 也该能列出目录', () => {
    expect(tokenAt('cd ', 3)).toMatchObject({ start: 3, end: 3, value: '', first: false })
  })

  it('只补光标前面那一截，后面的原样留着', () => {
    // `cat pack|ages/x`：要补的是 pack，不是整个词。
    expect(tokenAt('cat packages/x', 8)).toMatchObject({ start: 4, end: 8, value: 'pack' })
  })

  it('引号里的空格不分词', () => {
    const line = 'cp "my dir/a'
    expect(tokenAt(line, line.length)).toMatchObject({ start: 3, value: 'my dir/a', quote: '"' })
  })

  it('反斜杠转义的空格也不分词，且脱掉转义后才是路径', () => {
    const line = 'cat my\\ dir/a'
    expect(tokenAt(line, line.length)).toMatchObject({ start: 4, value: 'my dir/a', quote: null })
  })

  it('单引号里的反斜杠不是转义符', () => {
    const line = "cat 'a\\b"
    expect(tokenAt(line, line.length)).toMatchObject({ value: 'a\\b', quote: "'" })
  })

  it('行首是命令名那一位', () => {
    expect(tokenAt('gi', 2).first).toBe(true)
    expect(tokenAt('git ad', 6).first).toBe(false)
  })

  it('管道和分号之后又是命令名那一位', () => {
    expect(tokenAt('ls | gr', 7).first).toBe(true)
    expect(tokenAt('ls; ca', 6).first).toBe(true)
  })

  it('重定向的目标是文件名，不是命令名', () => {
    expect(tokenAt('ls > mar', 8).first).toBe(false)
    expect(tokenAt('cat < in', 8).first).toBe(false)
    // 行首就重定向也一样：`> out` 里的 out 还是文件名。
    expect(tokenAt('> ou', 4).first).toBe(false)
  })
})

describe('completable', () => {
  it('命令名那一位不补路径 —— 那里要的是 PATH 里的东西', () => {
    expect(completable(tokenAt('gi', 2))).toBe(false)
  })

  it('带斜杠的命令名确实是路径，照补', () => {
    expect(completable(tokenAt('./scr', 5))).toBe(true)
  })

  it('参数位一律补', () => {
    expect(completable(tokenAt('cat RE', 6))).toBe(true)
  })

  it('重定向的目标要补 —— 那恰恰是最常按 Tab 的地方', () => {
    expect(completable(tokenAt('ls > mar', 8))).toBe(true)
  })
})

describe('splitPath', () => {
  it('没有斜杠时整个都是前缀', () => {
    expect(splitPath('pack')).toEqual({ dir: '', prefix: 'pack' })
  })

  it('目录那一截带着结尾的斜杠', () => {
    expect(splitPath('packages/we')).toEqual({ dir: 'packages/', prefix: 'we' })
  })

  it('以斜杠结尾时前缀为空 —— 该列出整个目录', () => {
    expect(splitPath('packages/')).toEqual({ dir: 'packages/', prefix: '' })
  })

  it('绝对路径同样只看最后一个斜杠', () => {
    expect(splitPath('/usr/lo')).toEqual({ dir: '/usr/', prefix: 'lo' })
  })
})

describe('matching', () => {
  const entries = [
    { name: '.git' }, { name: '.github' }, { name: 'docs' }, { name: 'dist' }, { name: 'README.md' },
  ]

  it('前缀对得上才要', () => {
    expect(matching(entries, 'do').map((e) => e.name)).toEqual(['docs'])
  })

  it('空前缀列出全部，但藏起点开头的', () => {
    expect(matching(entries, '').map((e) => e.name)).toEqual(['docs', 'dist', 'README.md'])
  })

  it('显式敲了点才给点开头的', () => {
    expect(matching(entries, '.gi').map((e) => e.name)).toEqual(['.git', '.github'])
  })

  it('大小写敏感一个都对不上时退回不敏感 —— macOS 的文件系统本来就不区分', () => {
    expect(matching(entries, 'readme').map((e) => e.name)).toEqual(['README.md'])
  })

  it('有大小写敏感的匹配就不退 —— 否则精确输入反而被稀释', () => {
    expect(matching([{ name: 'Docs' }, { name: 'docs' }], 'do').map((e) => e.name)).toEqual(['docs'])
  })
})

describe('commonPrefix', () => {
  it('补到无歧义的那一段为止', () => {
    expect(commonPrefix(['packages', 'package.json'])).toBe('package')
  })

  it('没有公共部分时为空', () => {
    expect(commonPrefix(['docs', 'src'])).toBe('')
  })

  it('只有一个时就是它自己', () => {
    expect(commonPrefix(['docs'])).toBe('docs')
  })

  it('一个都没有时为空', () => {
    expect(commonPrefix([])).toBe('')
  })
})

describe('literal', () => {
  it('裸词里的空格要转义 —— 不然命令会碎在别人想不到的地方', () => {
    expect(literal('my dir/a.txt', null)).toBe('my\\ dir/a.txt')
  })

  it('裸词里的 shell 元字符一并转义', () => {
    expect(literal('a$b(c)', null)).toBe('a\\$b\\(c\\)')
  })

  it('本来带双引号的就用双引号包回去，并把闭引号补上', () => {
    expect(literal('my dir/a', '"')).toBe('"my dir/a"')
  })

  it('双引号里只有几个字符仍有意义，转义它们', () => {
    expect(literal('a$b"c', '"')).toBe('"a\\$b\\"c"')
  })

  it('单引号里什么都不转义，唯独单引号自己要退出去再拼回来', () => {
    expect(literal("it's", "'")).toBe("'it'\\''s'")
  })
})
