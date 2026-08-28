import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ShellHub, ShellSession, type ShellEvent } from '../src/server/shell.ts'

let sandbox: string
let hub: ShellHub

beforeEach(async () => {
  // macOS 的 /tmp 是符号链接，而 shell 报回来的 `$PWD` 是解开之后的路径 ——
  // 不解开的话，「cd 之后 cwd 变了没有」这类断言会在 mac 上全线失败。
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'loopkanban-shell-')))
  hub = new ShellHub()
})

afterEach(async () => {
  await hub.dispose()
  await rm(sandbox, { recursive: true, force: true })
})

/** 收集一个会话的事件，直到它报出这条命令的结局。 */
function collect(session: ShellSession): { events: ShellEvent[]; ended: Promise<ShellEvent> } {
  const events: ShellEvent[] = []
  let settle: (event: ShellEvent) => void
  const ended = new Promise<ShellEvent>((resolve) => { settle = resolve })
  session.subscribe((event) => {
    events.push(event)
    if (event.kind === 'ended') settle(event)
  })
  return { events, ended }
}

/** 一条命令跑完之后的全部输出，按 stdout / stderr 分开。 */
function text(events: ShellEvent[], kind: 'out' | 'err'): string {
  return events.filter((event) => event.kind === kind).map((event) => String(event.payload['text'])).join('')
}

describe('ShellSession', () => {
  it('输出边跑边出，不必等命令结束', async () => {
    const session = hub.open(sandbox)
    const seen: string[] = []
    session.subscribe((event) => { if (event.kind === 'out') seen.push(String(event.payload['text'])) })
    session.exec('echo first; sleep 0.4; echo second')

    // 第一段输出该在命令还没结束时就到了 —— 这正是「卡住输出」的命令
    // （npm install / npm run dev）唯一能用的方式。
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(seen.join('')).toContain('first')
    expect(seen.join('')).not.toContain('second')
    expect(session.busy).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(seen.join('')).toContain('second')
    expect(session.busy).toBe(false)
  })

  it('cd 留得住 —— 下一条命令跑在新目录里', async () => {
    await mkdir(join(sandbox, 'inner'), { recursive: true })
    const session = hub.open(sandbox)

    const first = collect(session)
    session.exec('cd inner')
    const ended = await first.ended
    expect(ended.payload['cwd']).toBe(join(sandbox, 'inner'))
    expect(session.cwd).toBe(join(sandbox, 'inner'))

    const second = collect(session)
    session.exec('pwd')
    await second.ended
    expect(text(second.events, 'out').trim()).toBe(join(sandbox, 'inner'))
  })

  it('cd 进了一个转身就没了的目录，会话不会被钉死在那儿', async () => {
    await mkdir(join(sandbox, 'gone'), { recursive: true })
    const session = hub.open(sandbox)
    const first = collect(session)
    session.exec(`cd gone && rm -rf ${join(sandbox, 'gone')}`)
    await first.ended
    expect(session.cwd).toBe(sandbox)

    // 关键是它还能接着用：钉在一个不存在的路径上，之后每条命令都起不来。
    const second = collect(session)
    session.exec('pwd')
    await second.ended
    expect(text(second.events, 'out').trim()).toBe(sandbox)
  })

  it('ctrl+c 收掉整棵进程树，孙进程不留在后台', async () => {
    const marker = join(sandbox, 'orphan.txt')
    const session = hub.open(sandbox)
    const run = collect(session)
    // 孙进程在被中断之后才会写文件；信号发给整个进程组的话，它写不成。
    // 只 kill 直接子进程是最常见的写法，也正是这条断言要挡住的那一种。
    session.exec(`sh -c '(sleep 2; echo alive > ${marker})'`)

    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(session.signal('SIGINT')).toBe(true)
    const ended = await run.ended
    expect(ended.payload['interrupted']).toBe(true)
    expect(ended.payload['durationMs']).toBeLessThan(2_000)
    expect(session.busy).toBe(false)

    await new Promise((resolve) => setTimeout(resolve, 2_200))
    await expect(rm(marker)).rejects.toThrow()
  })

  /*
   * shell 不给后台任务发 SIGINT（POSIX 规定非交互 shell 里的 `&` 任务忽略它），
   * 于是它会攥着 stdout 继续跑。真实终端此刻**已经把提示符还给你了** ——
   * 等管道关闭才算结束的话，一句 `npm run dev &` 就能让终端再也回不来。
   */
  it('后台进程攥着管道时，命令照样立刻结束；会话关掉时它一起收', async () => {
    const marker = join(sandbox, 'background.txt')
    const session = hub.open(sandbox)
    const run = collect(session)
    session.exec(`(sleep 2; echo alive > ${marker}) &`)
    const ended = await run.ended
    expect(ended.payload['durationMs']).toBeLessThan(1_500)
    expect(session.busy).toBe(false)

    await session.close()
    await new Promise((resolve) => setTimeout(resolve, 2_200))
    await expect(rm(marker)).rejects.toThrow()
  })

  it('中断之后还能接着跑下一条 —— 终端不会因为一次 ctrl+c 就废掉', async () => {
    const session = hub.open(sandbox)
    const first = collect(session)
    session.exec('sleep 5')
    await new Promise((resolve) => setTimeout(resolve, 200))
    session.signal('SIGINT')
    await first.ended

    const second = collect(session)
    session.exec('echo alive')
    await second.ended
    expect(text(second.events, 'out').trim()).toBe('alive')
  })

  it('命令失败不是我们的故障 —— 照实回退出码与 stderr', async () => {
    const session = hub.open(sandbox)
    const run = collect(session)
    session.exec('echo boom >&2; exit 3')
    const ended = await run.ended
    expect(ended.payload['code']).toBe(3)
    expect(ended.payload['interrupted']).toBe(false)
    expect(text(run.events, 'err').trim()).toBe('boom')
  })

  it('两路输出分得清 —— git、npm 把进度写在 stderr 上', async () => {
    const session = hub.open(sandbox)
    const run = collect(session)
    session.exec('echo out; echo err >&2')
    await run.ended
    expect(text(run.events, 'out').trim()).toBe('out')
    expect(text(run.events, 'err').trim()).toBe('err')
  })

  it('一次只跑一条命令', async () => {
    const session = hub.open(sandbox)
    const run = collect(session)
    session.exec('sleep 0.3')
    expect(() => { session.exec('echo nope') }).toThrow(/还有一条命令在跑/)
    await run.ended
  })

  it('stdin 通着 —— 会提问的命令答得上来', async () => {
    const session = hub.open(sandbox)
    const run = collect(session)
    session.exec('read -r name; echo "hi $name"')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(session.input('世界\n')).toBe(true)
    await run.ended
    expect(text(run.events, 'out').trim()).toBe('hi 世界')
  })

  it('ctrl+d 关掉 stdin，等着读完输入的命令才会结束', async () => {
    const session = hub.open(sandbox)
    const run = collect(session)
    session.exec('cat')
    await new Promise((resolve) => setTimeout(resolve, 150))
    session.input('一行\n')
    session.input('', true)
    const ended = await run.ended
    expect(ended.payload['code']).toBe(0)
    expect(text(run.events, 'out')).toBe('一行\n')
  })

  it('多字节字符被切在两个数据块中间也不会碎', async () => {
    const session = hub.open(sandbox)
    const run = collect(session)
    const long = '中文输出'.repeat(4_000)
    await writeFile(join(sandbox, 'cjk.txt'), long, 'utf8')
    session.exec('cat cjk.txt')
    await run.ended
    expect(text(run.events, 'out')).toBe(long)
  })

  it('回放缓冲让断线重连接得上，快照说清此刻在跑什么', async () => {
    const session = hub.open(sandbox)
    const run = collect(session)
    session.exec('echo remembered')
    await run.ended

    expect(session.replay(0).some((event) => String(event.payload['text'] ?? '').includes('remembered'))).toBe(true)
    const snapshot = session.snapshot()
    expect(snapshot.running).toBe(null)
    expect(snapshot.cwd).toBe(sandbox)

    const next = collect(session)
    session.exec('sleep 0.3')
    expect(session.snapshot().running).toBe('sleep 0.3')
    await next.ended
  })

  it('起不来的命令报的是原因，不是一条永远"执行中"', async () => {
    const session = hub.open(sandbox)
    await rm(sandbox, { recursive: true, force: true })
    const run = collect(session)
    session.exec('pwd')
    const ended = await run.ended
    expect(ended.payload['code']).toBe(null)
    expect(String(ended.payload['error'])).not.toBe('undefined')
    expect(session.busy).toBe(false)
  })
})

describe('ShellHub', () => {
  it('没人看着的会话到点被收掉，连同它正在跑的命令', async () => {
    const marker = join(sandbox, 'still-alive.txt')
    const shortLived = new ShellHub({ idleMs: 0 })
    const session = shortLived.open(sandbox)
    session.exec(`sleep 1.5; echo alive > ${marker}`)
    // idleMs 为 0 但当下有订阅者 —— 有人看着的会话不该被收走。
    const unsubscribe = session.subscribe(() => undefined)
    shortLived.sweep()
    expect(shortLived.get(session.id)).not.toBe(null)

    unsubscribe()
    shortLived.sweep()
    expect(shortLived.get(session.id)).toBe(null)

    await new Promise((resolve) => setTimeout(resolve, 1_800))
    await expect(rm(marker)).rejects.toThrow()
    await shortLived.dispose()
  })

  /*
   * 只把订阅者从名单上划掉是不够的：接着这条流的那一头会以为终端还活着 ——
   * 心跳照发，提示符照在，直到用户敲下一条命令才撞上 404。
   */
  it('会话被收掉时，还接着的订阅者会收到讣告', async () => {
    const session = hub.open(sandbox)
    const seen: ShellEvent[] = []
    session.subscribe((event) => { seen.push(event) })
    await hub.close(session.id)
    expect(seen.at(-1)?.kind).toBe('closed')
  })

  it('dispose 之后没有会话留下', async () => {
    const session = hub.open(sandbox)
    session.exec('sleep 5')
    await hub.dispose()
    expect(hub.size).toBe(0)
    expect(hub.get(session.id)).toBe(null)
  })
})
