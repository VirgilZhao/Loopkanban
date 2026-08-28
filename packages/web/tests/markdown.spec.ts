import { describe, expect, it } from 'vitest'
import type { JSX } from 'react'
import { renderMarkdown } from '@/lib/markdown.tsx'
import { resolveFrom } from '@/lib/path.ts'

/** 把渲染结果摊平成一串节点，好按类型挑出来看。不需要 DOM。 */
function flatten(nodes: unknown): unknown[] {
  if (Array.isArray(nodes)) return nodes.flatMap(flatten)
  if (nodes === null || typeof nodes !== 'object') return nodes === undefined ? [] : [nodes]
  const element = nodes as { props?: { children?: unknown } }
  return [nodes, ...flatten(element.props?.children)]
}

function pick(tree: JSX.Element[], type: string): { props: Record<string, unknown> }[] {
  return flatten(tree).filter((node): node is { type: string; props: Record<string, unknown> } =>
    typeof node === 'object' && node !== null && (node as { type?: unknown }).type === type)
}

describe('renderMarkdown 里的文档链接', () => {
  const doc = '方案见 [方案.md](/repo/.loopkanban/worktrees/t-1/docs/方案.md)。'

  it('本机路径变成能点的按钮，点下去给出那条路径', () => {
    const opened: string[] = []
    const tree = renderMarkdown(doc, { onOpenFile: (path) => { opened.push(path) } })

    const [button] = pick(tree, 'button')
    expect(button).toBeDefined()
    ;(button?.props['onClick'] as () => void)()
    expect(opened).toEqual(['/repo/.loopkanban/worktrees/t-1/docs/方案.md'])
  })

  it('没给 onOpenFile 就退回原来的样子：一段纯文本，不假装能点', () => {
    const tree = renderMarkdown(doc)
    expect(pick(tree, 'button')).toHaveLength(0)
    expect(pick(tree, 'a')).toHaveLength(0)
  })

  it('相对路径也接：人手打的链接不带那一长串前缀', () => {
    const opened: string[] = []
    const tree = renderMarkdown('见 [计划](docs/plans/a.md)', { onOpenFile: (p) => { opened.push(p) } })
    ;(pick(tree, 'button')[0]?.props['onClick'] as () => void)()
    expect(opened).toEqual(['docs/plans/a.md'])
  })

  it('链接里的 %20 解回空格 —— 带空格的文件名不该找不到', () => {
    const opened: string[] = []
    const tree = renderMarkdown('见 [x](docs/my%20plan.md)', { onOpenFile: (p) => { opened.push(p) } })
    ;(pick(tree, 'button')[0]?.props['onClick'] as () => void)()
    expect(opened).toEqual(['docs/my plan.md'])
  })

  it('file:// 也当本机路径', () => {
    const opened: string[] = []
    const tree = renderMarkdown('见 [x](file:///repo/docs/a.md)', { onOpenFile: (p) => { opened.push(p) } })
    ;(pick(tree, 'button')[0]?.props['onClick'] as () => void)()
    expect(opened).toEqual(['/repo/docs/a.md'])
  })

  /*
   * 这条是底线：讨论里的内容是 Agent 写的，它不该有办法造出一个点了就执行的
   * 链接。多认一种「本机路径」就多一条要守住的边，所以放行的只有 file:// 和
   * 完全没有协议的路径，其余伪协议一律退回纯文本。
   */
  it('javascript: 这类伪协议一律退化成纯文本，既不是链接也不是按钮', () => {
    const tree = renderMarkdown('[点我](javascript:alert(1))', { onOpenFile: () => { /* 不该被叫到 */ } })
    expect(pick(tree, 'button')).toHaveLength(0)
    expect(pick(tree, 'a')).toHaveLength(0)
  })

  it('http(s) 还是普通外链，不走预览', () => {
    const tree = renderMarkdown('[官网](https://example.com)', { onOpenFile: () => { /* noop */ } })
    expect(pick(tree, 'a')).toHaveLength(1)
    expect(pick(tree, 'button')).toHaveLength(0)
  })
})

describe('resolveFrom', () => {
  it('文档里的相对链接接到这份文档旁边，不是接到根上', () => {
    expect(resolveFrom('/repo/docs/plans/a.md', 'b.md')).toBe('/repo/docs/plans/b.md')
    expect(resolveFrom('/repo/docs/plans/a.md', '../prd.md')).toBe('/repo/docs/plans/../prd.md')
  })

  it('绝对路径原样放行', () => {
    expect(resolveFrom('/repo/docs/a.md', '/repo/README.md')).toBe('/repo/README.md')
  })
})
