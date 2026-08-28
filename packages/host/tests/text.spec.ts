import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_TEXT_BYTES, readTextHead } from '../src/fs/text.ts'

let sandbox: string

beforeEach(async () => { sandbox = await mkdtemp(join(tmpdir(), 'loopkanban-text-')) })
afterEach(async () => { await rm(sandbox, { recursive: true, force: true }) })

/** 写一个文件并回它的路径。 */
async function put(name: string, body: string | Buffer): Promise<string> {
  const path = join(sandbox, name)
  await writeFile(path, body)
  return path
}

describe('readTextHead', () => {
  it('小文件整个读出来，size 是真实大小', async () => {
    const read = await readTextHead(await put('a.md', '# 标题\n'))
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.head.content).toBe('# 标题\n')
    expect(read.head.size).toBe(Buffer.byteLength('# 标题\n'))
    expect(read.head.truncated).toBe(false)
    expect(read.head.binary).toBe(false)
  })

  it('空文件不是错，就是空的', async () => {
    const read = await readTextHead(await put('empty.txt', ''))
    expect(read).toMatchObject({ ok: true, head: { size: 0, content: '', binary: false } })
  })

  it('二进制标出来，且不解码 —— 按 UTF-8 解出来只会是一屏乱码', async () => {
    const read = await readTextHead(await put('shot.png', Buffer.from([0x89, 0x50, 0x00, 0x01])))
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.head.binary).toBe(true)
    expect(read.head.content).toBe('')
  })

  /*
   * 只嗅开头几 KB 的话，这种文件会被当成文本放出去 —— 前面是规规矩矩的 ASCII
   * 头，NUL 在很后面。整段都扫（memchr）代价可以忽略，不必为它留个漏洞。
   */
  it('NUL 出现在很后面也算二进制', async () => {
    const body = Buffer.concat([Buffer.from('x'.repeat(64 * 1024)), Buffer.from([0])])
    const read = await readTextHead(await put('late.bin', body))
    expect(read).toMatchObject({ ok: true, head: { binary: true } })
  })

  it('超上限就截断，并如实说明', async () => {
    const read = await readTextHead(await put('big.txt', 'x'.repeat(MAX_TEXT_BYTES + 100)))
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.head.truncated).toBe(true)
    expect(Buffer.byteLength(read.head.content)).toBe(MAX_TEXT_BYTES)
    // size 是文件真实大小，不是这次给出去的长度。
    expect(read.head.size).toBe(MAX_TEXT_BYTES + 100)
  })

  it('截断处不留半个多字节字符 —— 中文文档不该以一个乱码收尾', async () => {
    // 一个汉字 3 字节，上限不是 3 的倍数，截断处必然落在字符中间。
    const read = await readTextHead(await put('cjk.md', '中'.repeat(MAX_TEXT_BYTES)))
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.head.content).not.toContain('�')
    expect(read.head.content.endsWith('中')).toBe(true)
  })

  it('调用方可以自己压低上限', async () => {
    const read = await readTextHead(await put('s.txt', 'abcdef'), 3)
    expect(read).toMatchObject({ ok: true, head: { content: 'abc', truncated: true, size: 6 } })
  })

  it('不存在的路径与目录都是 no-such-file —— 两者都不是「一份能看的东西」', async () => {
    await mkdir(join(sandbox, 'dir'))
    expect(await readTextHead(join(sandbox, 'nope'))).toMatchObject({ ok: false, reason: 'no-such-file' })
    expect(await readTextHead(join(sandbox, 'dir'))).toMatchObject({ ok: false, reason: 'no-such-file' })
  })

  it('在那儿但读不动，说是权限问题 —— 不是「文件不在」，也不该抛出去', async () => {
    // root 读得动任何东西，这一条在 root 下没有意义。
    if (process.getuid?.() === 0) return
    const locked = await put('locked.md', 'secret')
    await chmod(locked, 0o000)
    expect(await readTextHead(locked)).toMatchObject({ ok: false, reason: 'unreadable' })
  })
})
