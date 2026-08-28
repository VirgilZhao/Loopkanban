import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CaptureResult } from '../src/agents/discover.ts'
import { GitHub, parseRemote, repoArg } from '../src/pr/index.ts'

const GH = '/usr/local/bin/gh'

const OPEN_PR = {
  number: 7,
  url: 'https://github.com/acme/demo/pull/7',
  title: '加个 slugify',
  state: 'OPEN',
  mergeable: 'MERGEABLE',
  mergedAt: null,
}

const SLUG = { host: 'github.com', owner: 'acme', name: 'demo' }

/** 记下每一条命令，并按脚本给出回答。 */
function stub(answers: (argv: readonly string[]) => CaptureResult): {
  run: (argv: readonly string[], timeoutMs?: number, cwd?: string) => Promise<CaptureResult>
  calls: string[][]
} {
  const calls: string[][] = []
  return {
    calls,
    run: (argv) => {
      calls.push([...argv])
      return Promise.resolve(answers(argv))
    },
  }
}

const ok = (stdout: string): CaptureResult => ({ stdout, stderr: '', code: 0 })
const bad = (stderr: string, code = 1): CaptureResult => ({ stdout: '', stderr, code })

describe('parseRemote', () => {
  it('认得出 scp、https 与 ssh:// 三种写法', () => {
    expect(parseRemote('git@github.com:acme/demo.git')).toEqual(SLUG)
    expect(parseRemote('https://github.com/acme/demo.git')).toEqual(SLUG)
    expect(parseRemote('https://github.com/acme/demo')).toEqual(SLUG)
    expect(parseRemote('ssh://git@github.com/acme/demo.git')).toEqual(SLUG)
  })

  it('子组的路径不丢 —— GitLab 那种多层命名空间会走到这儿', () => {
    expect(parseRemote('git@example.com:group/sub/demo.git'))
      .toEqual({ host: 'example.com', owner: 'group', name: 'sub/demo' })
  })

  it('认不出来就是 null，不猜', () => {
    expect(parseRemote('')).toBeNull()
    expect(parseRemote('/tmp/some/local/bare.git')).toBeNull()
  })
})

describe('repoArg', () => {
  it('github.com 用裸的 owner/repo，企业版带上主机名', () => {
    expect(repoArg(SLUG)).toBe('acme/demo')
    expect(repoArg({ host: 'git.corp', owner: 'acme', name: 'demo' })).toBe('git.corp/acme/demo')
  })
})

describe('GitHub.view', () => {
  it('把 gh 的 JSON 翻成界面认识的形状', async () => {
    const { run } = stub(() => ok(JSON.stringify({ ...OPEN_PR, state: 'MERGED', mergedAt: '2026-08-28T10:00:00Z' })))
    const github = new GitHub({ bin: GH, capture: run })

    const found = await github.view('/repo', SLUG, 'task/t1')
    expect(found.ok && found.pr).toMatchObject({
      number: 7,
      state: 'merged',
      mergedAt: Date.parse('2026-08-28T10:00:00Z'),
    })
  })

  it('「这条分支还没有 PR」不是错误 —— 报成错误界面就永远红着', async () => {
    const { run } = stub(() => bad('no pull requests found for branch "task/t1"'))
    const github = new GitHub({ bin: GH, capture: run })

    const found = await github.view('/repo', SLUG, 'task/t1')
    expect(found).toEqual({ ok: true, pr: null })
  })

  it('gh 真的出错时如实报出来', async () => {
    const { run } = stub(() => bad('gh: 未登录'))
    const github = new GitHub({ bin: GH, capture: run })

    const found = await github.view('/repo', SLUG, 'task/t1')
    expect(found).toMatchObject({ ok: false, reason: 'gh-failed', detail: 'gh: 未登录' })
  })

  it('UNKNOWN 不算「能合」—— GitHub 还在后台算', async () => {
    const { run } = stub(() => ok(JSON.stringify({ ...OPEN_PR, mergeable: 'UNKNOWN' })))
    const github = new GitHub({ bin: GH, capture: run })

    const found = await github.view('/repo', SLUG, 'task/t1')
    expect(found.ok && found.pr?.mergeable).toBe('unknown')
  })
})

describe('GitHub.create', () => {
  it('已经有开着的 PR 就用它，不再开第二条', async () => {
    const { run, calls } = stub(() => ok(JSON.stringify(OPEN_PR)))
    const github = new GitHub({ bin: GH, capture: run })

    const opened = await github.create('/repo', SLUG, {
      head: 'task/t1', base: 'main', title: 't', body: 'b',
    })
    expect(opened).toMatchObject({ ok: true, created: false })
    expect(calls.some((argv) => argv.includes('create'))).toBe(false)
  })

  it('gh 说 already exists 时回头把现成那条查出来，而不是把这句话甩给用户', async () => {
    let seenCreate = false
    const { run } = stub((argv) => {
      if (argv.includes('create')) { seenCreate = true; return bad('a pull request for branch already exists') }
      // 第一次查（create 之前）说没有，逼它走 create 那条路。
      return seenCreate ? ok(JSON.stringify(OPEN_PR)) : bad('no pull requests found')
    })
    const github = new GitHub({ bin: GH, capture: run })

    const opened = await github.create('/repo', SLUG, {
      head: 'task/t1', base: 'main', title: 't', body: 'b',
    })
    expect(opened).toMatchObject({ ok: true, created: false })
    expect(opened.ok && opened.pr.number).toBe(7)
  })

  it('开完再查一次状态 —— create 只吐一行 URL，而要判的是它能不能合', async () => {
    let created = false
    const { run, calls } = stub((argv) => {
      if (argv.includes('create')) { created = true; return ok(OPEN_PR.url) }
      return created ? ok(JSON.stringify(OPEN_PR)) : bad('no pull requests found')
    })
    const github = new GitHub({ bin: GH, capture: run })

    const opened = await github.create('/repo', SLUG, {
      head: 'task/t1', base: 'main', title: 't', body: 'b',
    })
    expect(opened).toMatchObject({ ok: true, created: true })
    expect(opened.ok && opened.pr.mergeable).toBe('mergeable')
    // 参数里必须点名 head / base，否则 gh 会拿"当前分支"去猜 —— 而我们
    // 根本不在那个分支上。
    const create = calls.find((argv) => argv.includes('create'))
    expect(create).toContain('--head')
    expect(create).toContain('task/t1')
    expect(create).toContain('--base')
    expect(create).toContain('main')
  })
})

describe('没装 gh', () => {
  it('明确拒绝，不降级成别的做法', async () => {
    const github = new GitHub({ bin: null })
    expect(github.available()).toBe(false)

    const opened = await github.create('/repo', SLUG, {
      head: 'task/t1', base: 'main', title: 't', body: 'b',
    })
    expect(opened).toMatchObject({ ok: false, reason: 'gh-missing' })
  })
})

describe('找 gh（回归）', () => {
  let sandbox: string | null = null
  const PATH_BEFORE = process.env['PATH']

  /** 在一个临时目录里放一个能执行的 `gh`，并让 PATH 只指向它。 */
  async function installGh(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'loopkanban-gh-'))
    const bin = join(dir, 'gh')
    await writeFile(bin, '#!/bin/sh\nexit 0\n', 'utf8')
    await chmod(bin, 0o755)
    return dir
  }

  afterEach(async () => {
    process.env['PATH'] = PATH_BEFORE
    if (sandbox !== null) await rm(sandbox, { recursive: true, force: true })
    sandbox = null
  })

  it('每次调用都现找 —— 装完 / 换个位置就生效，不必重启看板', async () => {
    const first = await installGh()
    const second = await installGh()
    sandbox = first
    try {
      const { run, calls } = stub(() => bad('no pull requests found'))
      process.env['PATH'] = first
      // 实例只造一次（Review 就是开机造一次的）。
      const github = new GitHub({ capture: run })
      await github.view('/repo', SLUG, 'task/t1')
      expect(calls[0]?.[0]).toBe(join(first, 'gh'))

      // 用户把 gh 换了个位置（升级、改用别的安装方式）。同一个实例得跟上，
      // 否则界面上那句"先装上并 gh auth login"照做了也没用。
      process.env['PATH'] = second
      await github.view('/repo', SLUG, 'task/t1')
      expect(calls[1]?.[0]).toBe(join(second, 'gh'))
    } finally {
      await rm(second, { recursive: true, force: true })
    }
  })

  it('显式给了路径就用它，不受 PATH 影响（测试与自定义安装都靠这条）', () => {
    expect(new GitHub({ bin: null }).available()).toBe(false)
    expect(new GitHub({ bin: '/opt/gh' }).available()).toBe(true)
  })
})
