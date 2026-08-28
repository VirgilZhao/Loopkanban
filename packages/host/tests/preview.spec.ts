import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_TEXT_BYTES } from '../src/fs/index.ts'
import { readFilePreview } from '../src/server/preview.ts'

let sandbox: string
let repo: string
let worktree: string

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'loopkanban-preview-'))
  repo = join(sandbox, 'repo')
  worktree = join(repo, '.loopkanban', 'worktrees', 't-1')
  await mkdir(join(worktree, 'docs', 'plans'), { recursive: true })
})

afterEach(async () => { await rm(sandbox, { recursive: true, force: true }) })

const roots = (): string[] => [worktree, repo]

describe('readFilePreview', () => {
  it('读 worktree 里的一份文档：内容、相对路径、大小都给出来', async () => {
    const file = join(worktree, 'docs', 'plans', '方案.md')
    await writeFile(file, '# 方案\n\n照着这个做。\n')

    const found = await readFilePreview(file, roots())
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.file.content).toContain('# 方案')
    expect(found.file.name).toBe('方案.md')
    expect(found.file.relative).toBe('docs/plans/方案.md')
    expect(found.file.truncated).toBe(false)
    expect(found.file.size).toBeGreaterThan(0)
  })

  it('相对路径按每个根各试一次 —— 人手打的路径不带那一长串前缀', async () => {
    await writeFile(join(worktree, 'docs', 'plans', 'a.md'), 'hi')
    const found = await readFilePreview('docs/plans/a.md', roots())
    expect(found.ok).toBe(true)
    if (found.ok) expect(found.file.content).toBe('hi')
  })

  /*
   * 这一条是这个功能真正的价值所在：验收通过之后 worktree 会被删掉，讨论里
   * 那条绝对路径就落空了。如果只报「文件不存在」，人会以为文档丢了 ——
   * 实际上它已经合进主仓库，还在原来的相对位置上。
   */
  it('worktree 没了就拿同样的相对路径去主仓库找 —— 合并之后文档还看得见', async () => {
    const inWorktree = join(worktree, 'docs', 'plans', 'b.md')
    await mkdir(join(repo, 'docs', 'plans'), { recursive: true })
    await writeFile(join(repo, 'docs', 'plans', 'b.md'), '已经合进来了')

    const found = await readFilePreview(inWorktree, roots())
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.file.content).toBe('已经合进来了')
    expect(found.file.path).toContain(join('repo', 'docs'))
  })

  it('根以外的绝对路径一律拒绝，且与「文件不在」分开报', async () => {
    const outside = join(sandbox, 'secret.txt')
    await writeFile(outside, 'nope')

    const found = await readFilePreview(outside, roots())
    expect(found).toMatchObject({ ok: false, reason: 'outside-project' })
  })

  it('相对路径里的 ../ 爬不出去', async () => {
    await writeFile(join(sandbox, 'secret.txt'), 'nope')
    const found = await readFilePreview('../../../../secret.txt', roots())
    expect(found).toMatchObject({ ok: false, reason: 'outside-project' })
  })

  it('符号链接指到外面去也拒绝 —— 只看字面路径是查不出来的', async () => {
    const outside = join(sandbox, 'secret.txt')
    await writeFile(outside, 'nope')
    await symlink(outside, join(worktree, 'docs', 'link.md'))

    const found = await readFilePreview(join(worktree, 'docs', 'link.md'), roots())
    expect(found.ok).toBe(false)
  })

  it('目录不是文件，别当成一份能看的东西', async () => {
    const found = await readFilePreview(join(worktree, 'docs'), roots())
    expect(found).toMatchObject({ ok: false, reason: 'no-such-file' })
  })

  it('二进制明确说清楚，不给一屏乱码', async () => {
    const file = join(worktree, 'shot.png')
    await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
    const found = await readFilePreview(file, roots())
    expect(found).toMatchObject({ ok: false, reason: 'not-text' })
  })

  it('过大的文件只给前一段，并如实说它被截了', async () => {
    const file = join(worktree, 'huge.md')
    await writeFile(file, 'x'.repeat(MAX_TEXT_BYTES + 1_000))

    const found = await readFilePreview(file, roots())
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.file.truncated).toBe(true)
    expect(found.file.content.length).toBeLessThanOrEqual(MAX_TEXT_BYTES)
    // size 是文件真实大小，不是这次给出去的长度。
    expect(found.file.size).toBe(MAX_TEXT_BYTES + 1_000)
  })

  it('截断不会在多字节字符中间留半个 —— 中文文档不该以一个乱码收尾', async () => {
    const file = join(worktree, 'cjk.md')
    // 每个汉字 3 字节，上限不是 3 的倍数，截断处必然落在字符中间。
    await writeFile(file, '中'.repeat(MAX_TEXT_BYTES))

    const found = await readFilePreview(file, roots())
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.file.content).not.toContain('�')
    expect(found.file.content.endsWith('中')).toBe(true)
  })

  /*
   * 回归：根里带一层软链时，第一跳能开、第二跳被判越界。
   *
   * macOS 上 `/tmp → /private/tmp` 就是这么一层，随手把项目建在 /tmp 下面就会
   * 踩到。根因是给出去的 path 解过符号链接、而边界是按登记的根判的 —— 调用方
   * 拿着一条根本对不上根的路径来问下一份文档，必然被拒。
   */
  it('给出去的路径用登记的根表述，文档里的相对链接才接得下去', async () => {
    const real = join(sandbox, 'real-repo')
    const link = join(sandbox, 'link-repo')
    await mkdir(join(real, 'docs'), { recursive: true })
    await writeFile(join(real, 'docs', 'a.md'), '见 [b](b.md)')
    await writeFile(join(real, 'docs', 'b.md'), 'B')
    await symlink(real, link)

    const first = await readFilePreview(join(link, 'docs', 'a.md'), [link])
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.file.path.startsWith(link)).toBe(true)

    // 前端就是这么接的：拿 file.path 的目录去接文档里的相对链接。
    const next = `${first.file.path.replace(/[^/]+$/, '')}b.md`
    expect(await readFilePreview(next, [link])).toMatchObject({ ok: true })
  })

  it('在工作区里但读不动，说是权限问题 —— 不是「文件不在」，也不该抛出去', async () => {
    // root 读得动任何东西，这一条在 root 下没有意义。
    if (process.getuid?.() === 0) return
    const locked = join(worktree, 'locked.md')
    await writeFile(locked, 'secret')
    await chmod(locked, 0o000)

    const found = await readFilePreview(locked, roots())
    expect(found).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('空路径当作找不到，不去猜它想看什么', async () => {
    expect(await readFilePreview('   ', roots())).toMatchObject({ ok: false, reason: 'no-such-file' })
  })
})
