import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { confine, contains, refusalFor } from '../src/fs/fence.ts'

let sandbox: string
let root: string

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'loopkanban-fence-'))
  root = join(sandbox, 'repo')
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'main.ts'), 'export const x = 1\n', 'utf8')
})

afterEach(async () => { await rm(sandbox, { recursive: true, force: true }) })

describe('contains', () => {
  it('前缀相同但不是子目录的不算在里面', () => {
    expect(contains('/a/repo', '/a/repo/src')).toBe(true)
    expect(contains('/a/repo', '/a/repo')).toBe(true)
    expect(contains('/a/repo', '/a/repo-old/src')).toBe(false)
    expect(contains('/a/repo', '/a')).toBe(false)
  })
})

describe('confine', () => {
  it('围栏里的路径放行，外面的挡下', async () => {
    expect(await confine([root], join(root, 'src'))).not.toBeNull()
    expect(await confine([root], sandbox)).toBeNull()
  })

  it('`..` 爬不出去', async () => {
    expect(await confine([root], join(root, 'src', '..', '..', 'escape'))).toBeNull()
  })

  it('相对路径直接拒绝', async () => {
    expect(await confine([root], 'src')).toBeNull()
  })

  it('指向围栏外面的符号链接挡得住 —— 字符串前缀比较看不出它', async () => {
    const outside = join(sandbox, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.txt'), 'nope\n', 'utf8')
    await symlink(outside, join(root, 'link'))
    expect(await confine([root], join(root, 'link', 'secret.txt'))).toBeNull()
  })

  it('路径不存在不算越界 —— 那是「打不开」，由 stat 去说', async () => {
    expect(await confine([root], join(root, 'src', 'gone.ts'))).not.toBeNull()
  })

  /*
   * 根自己挂在符号链接下（macOS 的 /tmp → /private/tmp 就是这么一层）时，
   * 两边都要取真实路径才比得上 —— 只解一边会把每一次请求都判成越界。
   */
  it('根自己在符号链接下也认得出来', async () => {
    const link = join(sandbox, 'link-repo')
    await symlink(root, link)
    expect(await confine([link], join(link, 'src', 'main.ts'))).not.toBeNull()
  })
})

describe('refusalFor', () => {
  it('真的越界就是越界', async () => {
    expect(await refusalFor([root], join(sandbox, 'elsewhere'))).toBe('outside')
    expect(await refusalFor([root], 'relative')).toBe('outside')
  })

  it('根自己没了要分得出来 —— 说成「在围栏外面」会把人带偏', async () => {
    await rm(root, { recursive: true, force: true })
    expect(await refusalFor([root], join(root, 'src'))).toBe('root-missing')
    // 根没了，但问的本来就是别处的路径 —— 那还是越界。
    expect(await refusalFor([root], join(sandbox, 'elsewhere'))).toBe('outside')
  })
})
