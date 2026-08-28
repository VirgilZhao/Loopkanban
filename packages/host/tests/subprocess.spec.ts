import { describe, expect, it } from 'vitest'
import type { Readable } from 'node:stream'
import { spawnProcess } from '../src/subprocess/index.ts'

/** 读一行 stdout，用来取子进程打印出来的孙进程 pid。 */
function firstLine(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      const index = buffer.indexOf('\n')
      if (index >= 0) {
        stream.off('data', onData)
        resolve(buffer.slice(0, index).trim())
      }
    }
    stream.on('data', onData)
    stream.once('error', reject)
    stream.once('end', () => { reject(new Error('stream ended before a full line')) })
  })
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

describe('spawnProcess', () => {
  it('捕获正常退出与 stdout', async () => {
    const handle = await spawnProcess({ argv: ['sh', '-c', 'echo hi'], cwd: process.cwd() })
    const [output, outcome] = await Promise.all([readAll(handle.stdout), handle.exited])
    expect(output.trim()).toBe('hi')
    expect(outcome.code).toBe(0)
    expect(outcome.treeQuiesced).toBe(true)
  })

  it('terminate 杀掉整棵进程树，不只是直接子进程', async () => {
    // sh 后台起一个 sleep（孙进程）并打印它的 pid，自己再 sleep 住不退出。
    const handle = await spawnProcess({
      argv: ['sh', '-c', 'sleep 60 & echo $!; sleep 60'],
      cwd: process.cwd(),
      graceMs: 300,
    })
    const grandchildPid = Number(await firstLine(handle.stdout))
    expect(Number.isInteger(grandchildPid)).toBe(true)
    expect(isAlive(grandchildPid)).toBe(true)

    const outcome = await handle.terminate()

    expect(outcome.treeQuiesced).toBe(true)
    expect(isAlive(handle.pid)).toBe(false)
    // 这是整个测试的重点：孙进程必须一起死。
    expect(isAlive(grandchildPid)).toBe(false)
  })

  it('对不理会 SIGTERM 的进程升级到 SIGKILL', async () => {
    // 用 Node 显式忽略 SIGTERM：shell 的 trap 会被 exec 优化影响，不够确定。
    const handle = await spawnProcess({
      argv: [
        process.execPath,
        '-e',
        "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
      ],
      cwd: process.cwd(),
      graceMs: 200,
    })
    expect(await firstLine(handle.stdout)).toBe('ready')

    const started = Date.now()
    const outcome = await handle.terminate()

    // 先 SIGTERM、等满 grace、再 SIGKILL —— 所以耗时必须跨过 grace。
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    expect(outcome.signal).toBe('SIGKILL')
    expect(isAlive(handle.pid)).toBe(false)
  })

  it('SIGTERM 就能收掉的进程不会被无谓地等满 grace', async () => {
    // 用 Node 而非 sh+sleep：sleep 会继承调用方的信号掩码，在 worker 线程里跑
    // 测试时行为不确定；Node 自己会重设 SIGTERM 处理，结果是确定的。
    const handle = await spawnProcess({
      argv: [process.execPath, '-e', "console.log('ready'); setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      graceMs: 5_000,
    })
    expect(await firstLine(handle.stdout)).toBe('ready')

    const started = Date.now()
    const outcome = await handle.terminate()

    expect(Date.now() - started).toBeLessThan(2_000)
    expect(outcome.signal).toBe('SIGTERM')
    expect(outcome.treeQuiesced).toBe(true)
  })

  it('组长秒退但孙进程赖着不走时，在 grace 内升级到 SIGKILL', async () => {
    // 真实场景：Agent 进程跑完退出了，但它起的 dev server / 测试进程还在。
    // 只盯着组长会以为「干净退出了」，实际留下一地孤儿。
    const handle = await spawnProcess({
      argv: [
        'sh',
        '-c',
        `${process.execPath} -e "process.on('SIGTERM', () => {}); console.log('gc'); setInterval(() => {}, 1000)" &`
        + ' sleep 0.3; exit 0',
      ],
      cwd: process.cwd(),
      graceMs: 400,
    })
    expect(await firstLine(handle.stdout)).toBe('gc')

    // 组长自己先退出，此时孙进程还活着。
    await handle.exited
    const afterLeaderExit = handle.outcome()
    expect(afterLeaderExit?.treeQuiesced).toBe(false)

    const started = Date.now()
    const outcome = await handle.terminate()

    // 必须在 grace 附近升级，而不是拖到 TREE_KILL_TIMEOUT_MS（5s）。
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(outcome.treeQuiesced).toBe(true)
  })

  it('terminate 幂等，并发调用共享同一次终止', async () => {
    const handle = await spawnProcess({
      argv: ['sh', '-c', 'sleep 60'],
      cwd: process.cwd(),
      graceMs: 200,
    })
    const [a, b] = await Promise.all([handle.terminate(), handle.terminate()])
    expect(a).toBe(b)
    expect(await handle.terminate()).toBe(a)
  })

  it('AbortSignal 触发终止', async () => {
    const controller = new AbortController()
    const handle = await spawnProcess({
      argv: ['sh', '-c', 'sleep 60'],
      cwd: process.cwd(),
      graceMs: 200,
      signal: controller.signal,
    })
    controller.abort()
    const outcome = await handle.exited
    expect(outcome.code === null || outcome.code !== 0).toBe(true)
    expect(isAlive(handle.pid)).toBe(false)
  })

  it('可执行文件不存在时 spawn 直接 reject', async () => {
    await expect(spawnProcess({
      argv: ['loopkanban-definitely-not-a-real-binary'],
      cwd: process.cwd(),
    })).rejects.toThrow()
  })

  it('已 abort 的 signal 不会起进程', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(spawnProcess({
      argv: ['sh', '-c', 'echo hi'],
      cwd: process.cwd(),
      signal: controller.signal,
    })).rejects.toThrow(/aborted before spawn/)
  })
})
