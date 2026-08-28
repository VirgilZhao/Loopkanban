import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AttachmentStore, ATTACHMENTS_IN_WORKTREE, canInline, humanSize, listStaged, mimeOf,
  safeFilename, stageAttachments,
} from '../src/attachments/index.ts'

let sandbox: string

beforeEach(async () => { sandbox = await mkdtemp(join(tmpdir(), 'loopkanban-attach-')) })
afterEach(async () => { await rm(sandbox, { recursive: true, force: true }) })

describe('safeFilename', () => {
  it('留住中文、空格与扩展名 —— 那是人认得出这个文件的依据', () => {
    expect(safeFilename('设计稿 v2.png')).toBe('设计稿 v2.png')
  })

  it('目录穿越与路径分隔符一律出局', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd')
    expect(safeFilename('C:\\Users\\me\\a.pdf')).toBe('a.pdf')
    // 只剩 `..` 的名字会被清成空，退回兜底名而不是造出一个上级目录。
    expect(safeFilename('../..')).toBe('file')
  })

  it('前导空格挡不住剥点 —— " .." 不能活成 ".."（回归）', () => {
    // 曾经先剥点再 trim，于是 " .." 带着空格躲过剥点、trim 之后变回 ".."，
    // 而 stageAttachments 拿它直接当路径末段用，join(dir, '..') 就出了目录。
    expect(safeFilename(' ..')).toBe('file')
    expect(safeFilename('  ..')).toBe('file')
    expect(safeFilename(' ...')).toBe('file')
    expect(safeFilename(' .hidden')).toBe('hidden')
  })

  it('控制字符与 Windows 保留字符被剔掉', () => {
    expect(safeFilename('a\nb\u0000c:*?.txt')).toBe('abc.txt')
  })

  it('数字与常见符号不该被误伤', () => {
    expect(safeFilename('2026-08-28_report(1).pdf')).toBe('2026-08-28_report(1).pdf')
  })

  it('过长的名字截断但保住扩展名 —— 类型判定靠它', () => {
    const long = `${'字'.repeat(300)}.pdf`
    const safe = safeFilename(long)
    expect(safe.length).toBeLessThanOrEqual(120)
    expect(safe.endsWith('.pdf')).toBe(true)
  })
})

describe('mimeOf', () => {
  it('扩展名说了算，客户端报什么都不影响', () => {
    expect(mimeOf('a.png', 'text/html')).toBe('image/png')
    expect(mimeOf('说明.docx')).toContain('wordprocessingml')
    expect(mimeOf('单据.pdf')).toBe('application/pdf')
  })

  it('认不出扩展名时只肯认图片，别的一律当二进制下载', () => {
    expect(mimeOf('blob', 'image/jpeg')).toBe('image/jpeg')
    expect(mimeOf('blob', 'text/html')).toBe('application/octet-stream')
    expect(mimeOf('blob')).toBe('application/octet-stream')
  })

  it('SVG 不算图片 —— 它能在页面里执行脚本', () => {
    expect(mimeOf('a.svg', 'image/svg+xml')).toBe('application/octet-stream')
    expect(mimeOf('blob', 'image/svg+xml')).toBe('application/octet-stream')
  })
})

describe('canInline', () => {
  it('只有图片和 PDF 能内联；HTML 之流必须下载', () => {
    expect(canInline('image/png')).toBe(true)
    expect(canInline('application/pdf')).toBe(true)
    expect(canInline('text/html')).toBe(false)
    expect(canInline('application/octet-stream')).toBe(false)
  })
})

describe('AttachmentStore', () => {
  it('按 <root>/<taskId>/<id>-<name> 落盘，同名不互相覆盖', async () => {
    const store = new AttachmentStore(join(sandbox, 'attachments'))
    const first = await store.save('t1', 'a-1', '截图.png', Buffer.from('one'))
    const second = await store.save('t1', 'a-2', '截图.png', Buffer.from('two'))

    expect(first.path).not.toBe(second.path)
    expect(await readFile(first.path, 'utf8')).toBe('one')
    expect(await readFile(second.path, 'utf8')).toBe('two')
    expect(first.size).toBe(3)
  })

  it('删卡时整个目录一起走', async () => {
    const store = new AttachmentStore(join(sandbox, 'attachments'))
    const saved = await store.save('t1', 'a-1', 'a.txt', Buffer.from('x'))
    await store.removeTask('t1')
    await expect(readFile(saved.path, 'utf8')).rejects.toThrow()
  })

  it('拒绝删 root 之外的文件 —— 库被改坏也不该删到用户的东西', async () => {
    const outsider = join(sandbox, 'important.txt')
    await writeFile(outsider, 'keep me', 'utf8')
    await new AttachmentStore(join(sandbox, 'attachments')).remove(outsider)
    expect(await readFile(outsider, 'utf8')).toBe('keep me')
  })
})

describe('stageAttachments', () => {
  it('拷进 worktree 并给出相对路径，同名的加后缀而不是互相覆盖', async () => {
    const worktree = join(sandbox, 'wt')
    await mkdir(worktree, { recursive: true })
    const one = join(sandbox, 'one.png')
    const two = join(sandbox, 'two.png')
    await writeFile(one, 'AAA')
    await writeFile(two, 'BBBB')

    const staged = await stageAttachments(worktree, [
      { filename: '设计稿.png', mime: 'image/png', path: one },
      { filename: '设计稿.png', mime: 'image/png', path: two },
    ])

    expect(staged).toHaveLength(2)
    expect(staged[0]?.relPath).toBe('.loopkanban/attachments/设计稿.png')
    expect(staged[1]?.relPath).toBe('.loopkanban/attachments/设计稿-2.png')
    expect(staged[1]?.size).toBe(4)
    expect(await readFile(join(worktree, staged[1]?.relPath ?? ''), 'utf8')).toBe('BBBB')
  })

  it('每次先清空：撤回的附件不该留在工作区里让下一轮照着干', async () => {
    const worktree = join(sandbox, 'wt')
    await mkdir(worktree, { recursive: true })
    const file = join(sandbox, 'a.txt')
    await writeFile(file, 'x')

    await stageAttachments(worktree, [{ filename: 'a.txt', mime: 'text/plain', path: file }])
    expect(await listStaged(worktree)).toEqual(['a.txt'])

    await stageAttachments(worktree, [])
    expect(await listStaged(worktree)).toEqual([])
  })

  it('单个文件拷不动不该炸掉整次执行，它只是不出现在清单里', async () => {
    const worktree = join(sandbox, 'wt')
    await mkdir(worktree, { recursive: true })
    const alive = join(sandbox, 'alive.txt')
    await writeFile(alive, 'ok')

    const staged = await stageAttachments(worktree, [
      { filename: 'gone.txt', mime: 'text/plain', path: join(sandbox, 'gone.txt') },
      { filename: 'alive.txt', mime: 'text/plain', path: alive },
    ])
    expect(staged.map((s) => s.filename)).toEqual(['alive.txt'])
  })

  it('落点在 .loopkanban 下 —— 那条排除规则已经让它不进 diff', () => {
    expect(ATTACHMENTS_IN_WORKTREE.split(/[/\\]/)[0]).toBe('.loopkanban')
  })
})

describe('humanSize', () => {
  it('按量级换单位', () => {
    expect(humanSize(512)).toBe('512 B')
    expect(humanSize(2048)).toBe('2.0 KB')
    expect(humanSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})
