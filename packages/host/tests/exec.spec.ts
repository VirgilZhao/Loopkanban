import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_OUTPUT_BYTES, runCommand } from '../src/server/exec.ts'

let sandbox: string

beforeEach(async () => { sandbox = await mkdtemp(join(tmpdir(), 'loopkanban-exec-')) })
afterEach(async () => { await rm(sandbox, { recursive: true, force: true }) })

describe('runCommand', () => {
  it('在指定目录里跑，回 stdout 与退出码', async () => {
    await writeFile(join(sandbox, 'hello.txt'), 'hi\n', 'utf8')
    const result = await runCommand('cat hello.txt', sandbox)
    expect(result.stdout).toBe('hi\n')
    expect(result.code).toBe(0)
    expect(result.timedOut).toBe(false)
  })

  it('命令失败不是我们的故障 —— 照实回退出码与 stderr，不抛', async () => {
    const result = await runCommand('echo boom >&2; exit 3', sandbox)
    expect(result.code).toBe(3)
    expect(result.stderr.trim()).toBe('boom')
  })

  it('输出封顶，并如实标出截断', async () => {
    const result = await runCommand(`yes x | head -c ${String(MAX_OUTPUT_BYTES * 2)}`, sandbox)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.stdout)).toBe(MAX_OUTPUT_BYTES)
  })

  /*
   * 封顶是按字节切的，切口必然落在某个汉字中间。不收尾的话每一次超长输出都
   * 以一个 `�` 收场，看着像命令自己吐了乱码 —— 而它没有。
   */
  it('输出截断处不留半个多字节字符', async () => {
    const result = await runCommand(
      `node -e 'process.stdout.write("中".repeat(${String(MAX_OUTPUT_BYTES)}))'`,
      sandbox,
    )
    expect(result.truncated).toBe(true)
    expect(result.stdout).not.toContain('\uFFFD')
    expect(result.stdout.endsWith('中')).toBe(true)
  })

  it('超时会收掉进程并标出来', async () => {
    const result = await runCommand('sleep 5', sandbox, 1_000)
    expect(result.timedOut).toBe(true)
    expect(result.durationMs).toBeLessThan(5_000)
  })

  it('超时收的是整棵树，孙进程不留在后台', async () => {
    const marker = join(sandbox, 'orphan.txt')
    // 孙进程在父进程被收掉之后才会写文件；树被收干净的话这个文件不该出现。
    const result = await runCommand(
      `sh -c '(sleep 2; echo alive > ${marker}) & wait'`,
      sandbox,
      1_000,
    )
    expect(result.timedOut).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    await expect(rm(marker)).rejects.toThrow()
  })
})
