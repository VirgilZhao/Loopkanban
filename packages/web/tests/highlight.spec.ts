import { describe, expect, it } from 'vitest'
import { highlightLines, languageOf, type Token, type TokenKind } from '@/lib/highlight.ts'

/** 把一行的词元压成 `kind:text` 的串，断言读起来才像句人话。 */
const shape = (tokens: Token[]): string => tokens.map((token) => `${token.kind}:${token.text}`).join('|')

/** 某一类词元收了哪些文字。 */
const of = (tokens: Token[], kind: TokenKind): string[] =>
  tokens.filter((token) => token.kind === kind).map((token) => token.text)

describe('languageOf', () => {
  it('按扩展名认，认不出就 plain', () => {
    expect(languageOf('src/api.ts')).toBe('ts')
    expect(languageOf('main.rs')).toBe('rust')
    expect(languageOf('a/b/style.scss')).toBe('css')
    expect(languageOf('index.html')).toBe('markup')
    expect(languageOf('方案.md')).toBe('markdown')
    expect(languageOf('LICENSE')).toBe('plain')
  })

  it('没有扩展名但名字本身说明了一切的那些', () => {
    expect(languageOf('Dockerfile')).toBe('shell')
    expect(languageOf('/repo/Makefile')).toBe('shell')
    // 以点开头的名字，最后一段是它自己，不是扩展名。
    expect(languageOf('.gitignore')).toBe('shell')
  })
})

describe('highlightLines', () => {
  it('行数与源码一致 —— 行号栏靠这个对齐', () => {
    expect(highlightLines('a\nb\n\nc', 'ts')).toHaveLength(4)
    // 结尾的换行也算开了新的一行，编辑器都是这么显示的。
    expect(highlightLines('a\n', 'ts')).toHaveLength(2)
    expect(highlightLines('', 'ts')).toHaveLength(1)
  })

  it('不管怎么切，拼回去必须和原文一模一样', () => {
    const source = 'const x = "你好" // 注释\nfunction f(a) { return a?.b ?? 1 }\n'
    for (const language of ['ts', 'python', 'json', 'markup', 'markdown', 'plain'] as const) {
      const back = highlightLines(source, language).map((line) => line.map((t) => t.text).join('')).join('\n')
      expect(back).toBe(source)
    }
  })

  it('注释、字符串、关键字、数字各归各位', () => {
    const [line] = highlightLines('const n = 42 // 说明', 'ts')
    expect(shape(line as Token[])).toBe('keyword:const|plain: n |punct:=|plain: |number:42|plain: |comment:// 说明')
  })

  it('少一个引号不该把后面整个文件都变成字符串', () => {
    const lines = highlightLines('const a = "没关上\nconst b = 1', 'ts')
    expect(of(lines[0] as Token[], 'string')).toEqual(['"没关上'])
    expect(of(lines[1] as Token[], 'keyword')).toEqual(['const'])
  })

  it('关键字按语言分，不并成一大坨', () => {
    // `func` 是 Go 的关键字，在 TS 里只是个普通名字。
    expect(of(highlightLines('func main()', 'go')[0] as Token[], 'keyword')).toEqual(['func'])
    expect(of(highlightLines('func main()', 'ts')[0] as Token[], 'keyword')).toEqual([])
  })

  it('调用位置上的名字是函数，点后面的是属性', () => {
    const [line] = highlightLines('user.name = wrap(x)', 'ts')
    expect(of(line as Token[], 'prop')).toEqual(['name'])
    expect(of(line as Token[], 'func')).toEqual(['wrap'])
  })

  it('JSON / YAML 的键单挑出来 —— 键与值糊成一片最难读', () => {
    expect(of(highlightLines('{"name": "x"}', 'json')[0] as Token[], 'prop')).toEqual(['"name"'])
    expect(of(highlightLines('port: 8080', 'yaml')[0] as Token[], 'prop')).toEqual(['port'])
  })

  it('标记语言分标签名与属性名，注释整段收走', () => {
    const [line] = highlightLines('<a href="/x">文字</a><!--注-->', 'markup')
    expect(of(line as Token[], 'tag')).toEqual(['a', 'a'])
    expect(of(line as Token[], 'attr')).toEqual(['href'])
    expect(of(line as Token[], 'string')).toEqual(['"/x"'])
    expect(of(line as Token[], 'comment')).toEqual(['<!--注-->'])
  })

  it('Markdown 原文视图把结构记号点出来，围栏里的内容不再解析', () => {
    const lines = highlightLines('# 标题\n```ts\n**不是加粗**\n```\n**是加粗**', 'markdown')
    expect(of(lines[0] as Token[], 'keyword')).toEqual(['# 标题'])
    expect(of(lines[2] as Token[], 'keyword')).toEqual([])
    expect(of(lines[4] as Token[], 'keyword')).toEqual(['**是加粗**'])
  })

  it('连着的标点并成一个记号，不碎成一堆 span', () => {
    // 一行密一点的代码本来会碎成几十个 span，DOM 白白重一倍。
    const [line] = highlightLines('a ??= b => c', 'ts')
    expect(of(line as Token[], 'punct')).toEqual(['??=', '=>'])
  })

  it('plain 就是原样一整块，一个记号都不分', () => {
    expect(highlightLines('const x = 1', 'plain')).toEqual([[{ kind: 'plain', text: 'const x = 1' }]])
  })
})
