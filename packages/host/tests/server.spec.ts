import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { chmod, mkdtemp, mkdir, readFile, realpath, writeFile, rm } from 'node:fs/promises'
import { connect, type AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { asExecutorId, asProjectId, asRunId, asTaskId, type Task } from '@loopkanban/core'
import { AgentPool } from '../src/agents/index.ts'
import { AttachmentStore, MAX_ATTACHMENTS_PER_COMMENT } from '../src/attachments/index.ts'
import { DecisionHub } from '../src/decisions/index.ts'
import { Storage } from '../src/storage/index.ts'
import { GitHub } from '../src/pr/index.ts'
import { Review } from '../src/review/index.ts'
import { capture } from '../src/agents/discover.ts'
import { ensureWorktree } from '../src/worktree/index.ts'
import { TestEnvs } from '../src/testenv/index.ts'
import { startServer, type RunningServer } from '../src/server/index.ts'
import { RunBus } from '../src/server/bus.ts'

const T0 = 1_000_000
const TOKEN = 'test-token-' + 'x'.repeat(32)
const PROJECT = asProjectId('b1')

let store: Storage
let server: RunningServer
let attachmentsRoot: string

function task(patch: Omit<Partial<Task>, 'id'> & { id: string }): Task {
  const { id, ...rest } = patch
  return {
    id: asTaskId(id), projectId: PROJECT, revision: 1, column: 'ready', position: 1,
    description: id, acceptance: ['ok'], repoPath: '/repo', baseBranch: 'main',
    blockedBy: [], relatedTo: [], createdAt: T0, updatedAt: T0, ...rest,
  }
}

/** 带 cookie 的 fetch，模拟浏览器拿到 token 之后的后续请求。 */
const api = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`http://127.0.0.1:${String(server.port)}${path}`, {
    ...init,
    headers: { cookie: `loopkanban_token=${TOKEN}`, ...init.headers },
  })

/** 一条终端事件：SSE 帧里的 `id:`、`event:` 与解开的 `data:`。 */
interface ShellFrame { seq: number; kind: string; data: Record<string, unknown> }

/** 开一个终端会话，返回它的 id。 */
async function openShell(body: { root: string; cwd?: string }): Promise<string> {
  const res = await api('/api/shell', { method: 'POST', body: JSON.stringify(body) })
  expect(res.status).toBe(201)
  return (await res.json() as { session: { id: string } }).session.id
}

/**
 * 订阅一个会话的事件流，读到 `done` 说够了为止。
 *
 * 会话有回放缓冲，所以**先跑命令再订阅**也不会漏事件 —— 测试里不必和
 * "什么时候接上流"赛跑。
 */
async function shellEvents(
  id: string,
  done: (frame: ShellFrame) => boolean,
  after = 0,
): Promise<ShellFrame[]> {
  const control = new AbortController()
  const res = await api(
    `/api/shell/${encodeURIComponent(id)}/events?after=${String(after)}`,
    { signal: control.signal },
  )
  expect(res.status).toBe(200)
  const frames: ShellFrame[] = []
  // 卡死时给出一个有限的失败，而不是把整个测试跑挂在这儿。
  const guard = setTimeout(() => { control.abort() }, 10_000)
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
        const frame = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        const kind = /^event: (.+)$/m.exec(frame)?.[1]
        const data = /^data: (.*)$/m.exec(frame)?.[1]
        if (kind === undefined || data === undefined) continue
        const parsed: ShellFrame = {
          // 快照那条不带 id —— 它不是历史里的一条事件。
          seq: Number.parseInt(/^id: (\d+)$/m.exec(frame)?.[1] ?? '0', 10),
          kind,
          data: JSON.parse(data) as Record<string, unknown>,
        }
        frames.push(parsed)
        if (done(parsed)) return frames
      }
    }
    return frames
  } finally {
    clearTimeout(guard)
    control.abort()
  }
}

/** 一串事件里的 stdout。 */
function outputOf(frames: ShellFrame[]): string {
  return frames.filter((frame) => frame.kind === 'out').map((frame) => String(frame.data['text'])).join('')
}

/** 用原始 http 客户端发请求，以便伪造 Host 头（fetch 不允许覆盖）。 */
function rawRequest(headers: Record<string, string>, path = '/api/state'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: server.port, path, method: 'GET', headers },
      (res) => { res.resume(); resolve(res.statusCode ?? 0) },
    )
    req.on('error', reject)
    req.end()
  })
}

beforeEach(async () => {
  store = Storage.open(':memory:')
  store.createProject({ id: PROJECT, name: '默认', repoPath: '/repo', baseBranch: 'main', createdAt: T0 })
  attachmentsRoot = await mkdtemp(join(tmpdir(), 'loopkanban-server-attach-'))
  // 心跳调快，让「发现死连接」的延迟在测试里可控。
  server = await startServer({
    storage: store, token: TOKEN, sseHeartbeatMs: 50,
    attachments: new AttachmentStore(attachmentsRoot),
  })
})

afterEach(async () => {
  await server.close()
  store.close()
  await rm(attachmentsRoot, { recursive: true, force: true })
})

describe('POST /api/projects', () => {
  let sandbox: string
  let repo: string

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'loopkanban-projects-'))
    repo = join(sandbox, 'repo')
    await mkdir(repo, { recursive: true })
    await new Promise((resolve, reject) => {
      const child = spawn('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' })
      child.on('exit', resolve)
      child.on('error', reject)
    })
  })

  afterEach(async () => { await rm(sandbox, { recursive: true, force: true }) })

  const create = (body: unknown) =>
    api('/api/projects', { method: 'POST', body: JSON.stringify(body) })

  /** 给测试仓库做一次提交，让它真的有分支可选。 */
  const commit = async (message: string) => {
    for (const args of [
      ['config', 'user.email', 't@t'], ['config', 'user.name', 'T'],
      ['commit', '-q', '--allow-empty', '-m', message],
    ]) {
      await new Promise((resolve, reject) => {
        const child = spawn('git', ['-C', repo, ...args], { stdio: 'ignore' })
        child.on('exit', resolve)
        child.on('error', reject)
      })
    }
  }

  const checkout = (branch: string) => new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repo, 'checkout', '-q', '-b', branch], { stdio: 'ignore' })
    child.on('exit', resolve)
    child.on('error', reject)
  })

  it('新增项目：记下名字与目录，没指定基线时给 main', async () => {
    const res = await create({ name: '我的项目', path: repo })
    expect(res.status).toBe(201)
    const { project } = await res.json() as { project: { name: string; repoPath: string; baseBranch: string } }
    expect(project.name).toBe('我的项目')
    expect(project.baseBranch).toBe('main')
    expect(store.listProjects()).toHaveLength(2)
  })

  it('仓库停在别的分支上也不影响默认基线 —— 那条分支只是你上次干活的落脚点', async () => {
    await commit('init')
    await checkout('codex/some-feature')
    const res = await create({ name: '我的项目', path: repo })
    expect((await res.json() as { project: { baseBranch: string } }).project.baseBranch).toBe('main')
  })

  it('可以指定基线分支', async () => {
    await commit('init')
    await checkout('develop')
    const res = await create({ name: '我的项目', path: repo, baseBranch: 'develop' })
    expect(res.status).toBe(201)
    expect((await res.json() as { project: { baseBranch: string } }).project.baseBranch).toBe('develop')
  })

  it('指定了一条不存在的分支就拒绝 —— 不然要等第一次派活建 worktree 时才炸', async () => {
    await commit('init')
    const res = await create({ name: '我的项目', path: repo, baseBranch: '不存在' })
    expect(res.status).toBe(422)
    expect((await res.json() as { error: string }).error).toBe('no-such-branch')
    expect(store.listProjects()).toHaveLength(1)
  })

  it('GET /api/branches：列出分支并给出推荐基线', async () => {
    await commit('init')
    await checkout('develop')
    const res = await api(`/api/branches?path=${encodeURIComponent(repo)}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { branches: string[]; base: string }
    expect(body.branches).toContain('main')
    expect(body.branches).toContain('develop')
    expect(body.base).toBe('main')
  })

  it('GET /api/branches：不是仓库、或不是绝对路径，都说清楚', async () => {
    expect((await api(`/api/branches?path=${encodeURIComponent(sandbox)}`)).status).toBe(422)
    expect((await api('/api/branches?path=./repo')).status).toBe(422)
  })

  it('不是 git 仓库就拒绝 —— 任务要在它派生的 worktree 上干活，派不出来就没有意义', async () => {
    const res = await create({ name: '空目录', path: sandbox })
    expect(res.status).toBe(422)
    expect((await res.json() as { error: string }).error).toBe('not-a-repo')
  })

  it('相对路径拒绝：服务端不该去猜它相对于谁', async () => {
    const res = await create({ name: '相对', path: './repo' })
    expect(res.status).toBe(422)
    expect((await res.json() as { error: string }).error).toBe('path-not-absolute')
  })

  it('同一个目录不能加两次', async () => {
    await create({ name: '第一次', path: repo })
    const res = await create({ name: '第二次', path: repo })
    expect(res.status).toBe(409)
    expect((await res.json() as { error: string }).error).toBe('project-exists')
  })

  it('缺名字或缺目录一律 400', async () => {
    expect((await create({ path: repo })).status).toBe(400)
    expect((await create({ name: '没目录' })).status).toBe(400)
  })

  it('新建的卡跟着项目走：仓库与基线从项目取，不听建卡方的', async () => {
    const { project } = await (await create({ name: '我的项目', path: repo })).json() as
      { project: { id: string } }
    const res = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ projectId: project.id, description: '在新项目里干活' }),
    })
    expect(res.status).toBe(201)
    const { task: created } = await res.json() as { task: Task }
    expect(created.projectId).toBe(project.id)
    expect(created.repoPath).toBe(repo)
    expect(created.baseBranch).toBe('main')
  })
})

describe('PATCH /api/projects/:id', () => {
  const rename = (id: string, body: unknown) =>
    api(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) })

  it('改名字，仓库路径与基线分支不动 —— 那是它的身份', async () => {
    const res = await rename(PROJECT, { name: '改过的名字' })
    expect(res.status).toBe(200)
    const project = store.getProject(PROJECT)
    expect(project?.name).toBe('改过的名字')
    expect(project?.repoPath).toBe('/repo')
    expect(project?.baseBranch).toBe('main')
  })

  it('空名字 400 —— 边栏上一行空白没人认得出那是什么', async () => {
    expect((await rename(PROJECT, { name: '   ' })).status).toBe(400)
    expect(store.getProject(PROJECT)?.name).toBe('默认')
  })

  it('项目不存在返回 404', async () => {
    expect((await rename('nope', { name: '新名字' })).status).toBe(404)
  })

  it('换基线分支：仓库里没有这条分支就拒绝', async () => {
    const res = await rename(PROJECT, { baseBranch: 'develop' })
    expect(res.status).toBe(422)
    expect((await res.json() as { error: string }).error).toBe('no-such-branch')
    expect(store.getProject(PROJECT)?.baseBranch).toBe('main')
  })
})

describe('PATCH /api/projects/:id 换基线', () => {
  let sandbox: string
  let repo: string
  let projectId: string

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'loopkanban-rebase-'))
    repo = join(sandbox, 'repo')
    await mkdir(repo, { recursive: true })
    for (const args of [
      ['init', '-q', '-b', 'main', repo],
      ['-C', repo, 'config', 'user.email', 't@t'],
      ['-C', repo, 'config', 'user.name', 'T'],
      ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'],
      ['-C', repo, 'branch', 'develop'],
    ]) {
      await new Promise((resolve, reject) => {
        const child = spawn('git', args, { stdio: 'ignore' })
        child.on('exit', resolve)
        child.on('error', reject)
      })
    }
    const res = await api('/api/projects', {
      method: 'POST', body: JSON.stringify({ name: '真仓库', path: repo }),
    })
    projectId = (await res.json() as { project: { id: string } }).project.id
  })

  afterEach(async () => { await rm(sandbox, { recursive: true, force: true }) })

  it('换成仓库里真有的分支，此后新建的卡跟着走，已有的卡不动', async () => {
    const before = await api('/api/tasks', {
      method: 'POST', body: JSON.stringify({ projectId, description: '换基线之前建的' }),
    })
    const older = (await before.json() as { task: Task }).task

    const res = await api(`/api/projects/${projectId}`, {
      method: 'PATCH', body: JSON.stringify({ baseBranch: 'develop' }),
    })
    expect(res.status).toBe(200)

    const after = await api('/api/tasks', {
      method: 'POST', body: JSON.stringify({ projectId, description: '换基线之后建的' }),
    })
    expect((await after.json() as { task: Task }).task.baseBranch).toBe('develop')
    // 已经建出来的卡各记各的：跟着改会让一张正在 Review 的卡的 diff 与合并
    // 目标在人眼皮底下换掉。
    expect(store.getTask(asTaskId(older.id))?.baseBranch).toBe('main')
  })
})

describe('DELETE /api/projects/:id', () => {
  it('删掉项目，连同它名下的卡与执行历史', async () => {
    store.createTask(task({ id: 't1' }))
    store.createTask(task({ id: 't2', column: 'backlog' }))

    const res = await api(`/api/projects/${PROJECT}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: true, tasks: 2 })
    expect(store.listProjects()).toHaveLength(0)
    expect(store.listTasks()).toHaveLength(0)
  })

  it('还有卡在执行时拒绝 —— 账本抽走了，那个进程会继续跑到没人认识它', async () => {
    store.createTask(task({ id: 't1', column: 'running' }))
    const res = await api(`/api/projects/${PROJECT}`, { method: 'DELETE' })
    expect(res.status).toBe(422)
    expect((await res.json() as { error: string }).error).toBe('project-busy')
    // 拒绝就是什么都没动。
    expect(store.listProjects()).toHaveLength(1)
    expect(store.listTasks()).toHaveLength(1)
  })

  it('项目不存在返回 404', async () => {
    expect((await api('/api/projects/nope', { method: 'DELETE' })).status).toBe(404)
  })
})

describe('GET /api/fs', () => {
  let sandbox: string

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'loopkanban-fs-'))
    await mkdir(join(sandbox, 'a-repo'), { recursive: true })
    await mkdir(join(sandbox, 'b-plain'), { recursive: true })
    await mkdir(join(sandbox, '.hidden'), { recursive: true })
    await new Promise((resolve, reject) => {
      const child = spawn('git', ['init', '-q', join(sandbox, 'a-repo')], { stdio: 'ignore' })
      child.on('exit', resolve)
      child.on('error', reject)
    })
  })

  afterEach(async () => { await rm(sandbox, { recursive: true, force: true }) })

  it('列子目录并标出哪些是 git 仓库；点开头的不列', async () => {
    const res = await api(`/api/fs?path=${encodeURIComponent(sandbox)}`)
    expect(res.status).toBe(200)
    const listing = await res.json() as
      { path: string; parent: string | null; entries: { name: string; isRepo: boolean }[] }
    expect(listing.entries.map((e) => e.name)).toEqual(['a-repo', 'b-plain'])
    expect(listing.entries.find((e) => e.name === 'a-repo')?.isRepo).toBe(true)
    expect(listing.entries.find((e) => e.name === 'b-plain')?.isRepo).toBe(false)
    expect(listing.parent).not.toBeNull()
  })

  it('不传 path 就落在家目录', async () => {
    const listing = await (await api('/api/fs')).json() as { path: string }
    expect(listing.path).toBe(homedir())
  })

  it('打不开的目录 404，相对路径 422', async () => {
    expect((await api(`/api/fs?path=${encodeURIComponent(join(sandbox, '不存在'))}`)).status).toBe(404)
    expect((await api('/api/fs?path=./relative')).status).toBe(422)
  })
})

describe('文件浏览与命令行', () => {
  let sandbox: string
  let repo: string

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'loopkanban-browse-'))
    repo = join(sandbox, 'repo')
    await mkdir(join(repo, 'src'), { recursive: true })
    await writeFile(join(repo, 'README.md'), '# hi\n', 'utf8')
    await writeFile(join(repo, 'src', 'main.ts'), 'export const x = 1\n', 'utf8')
    await new Promise((resolve, reject) => {
      const child = spawn('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' })
      child.on('exit', resolve)
      child.on('error', reject)
    })
    store.createProject({ id: asProjectId('p-fs'), name: 'fs', repoPath: repo, baseBranch: 'main', createdAt: T0 })
  })

  afterEach(async () => { await rm(sandbox, { recursive: true, force: true }) })

  it('列出项目的工作区', async () => {
    const res = await api('/api/workspaces?projectId=p-fs')
    expect(res.status).toBe(200)
    const { workspaces } = await res.json() as { workspaces: { kind: string; branch: string | null }[] }
    expect(workspaces).toHaveLength(1)
    expect(workspaces[0]?.kind).toBe('repo')
  })

  it('项目不存在返回 404', async () => {
    expect((await api('/api/workspaces?projectId=nope')).status).toBe(404)
    expect((await api('/api/workspaces')).status).toBe(404)
  })

  it('不给 path 就列工作区根', async () => {
    const res = await api(`/api/files?root=${encodeURIComponent(repo)}`)
    expect(res.status).toBe(200)
    const listing = await res.json() as { relative: string; entries: { name: string }[] }
    expect(listing.relative).toBe('')
    expect(listing.entries.map((e) => e.name)).toEqual(['src', 'README.md'])
  })

  it('读文件正文', async () => {
    const res = await api(
      `/api/files/content?root=${encodeURIComponent(repo)}&path=${encodeURIComponent(join(repo, 'src', 'main.ts'))}`,
    )
    expect(res.status).toBe(200)
    expect((await res.json() as { content: string }).content).toBe('export const x = 1\n')
  })

  /*
   * 围栏是这组接口唯一的实质防线：token 挡得住外人，挡不住我们自己写错的
   * 路径拼接，而这几条接口一旦漏了就是把整台机器的内容摊开。
   */
  it('围栏外的路径一律 422 —— 没登记的目录、爬出去的 `..`、相对路径', async () => {
    const outside = join(sandbox, 'outside')
    await mkdir(outside, { recursive: true })
    expect((await api(`/api/files?root=${encodeURIComponent(outside)}`)).status).toBe(422)
    expect((await api(
      `/api/files?root=${encodeURIComponent(repo)}&path=${encodeURIComponent(join(repo, '..'))}`,
    )).status).toBe(422)
    expect((await api(
      `/api/files/content?root=${encodeURIComponent(repo)}&path=${encodeURIComponent('/etc/hosts')}`,
    )).status).toBe(422)
    expect((await api('/api/files?root=./relative')).status).toBe(422)
  })

  it('围栏里但打不开的路径是 404，不是 422 —— 两件事对用户是不同的话', async () => {
    const res = await api(
      `/api/files?root=${encodeURIComponent(repo)}&path=${encodeURIComponent(join(repo, '不存在'))}`,
    )
    expect(res.status).toBe(404)
  })

  it('开一个终端会话，跑一条命令，从事件流里看输出与退出码', async () => {
    const id = await openShell({ root: repo, cwd: join(repo, 'src') })
    expect((await api(`/api/shell/${id}/exec`, {
      method: 'POST', body: JSON.stringify({ command: 'cat main.ts' }),
    })).status).toBe(202)

    const events = await shellEvents(id, (event) => event.kind === 'ended')
    expect(outputOf(events)).toBe('export const x = 1\n')
    expect(events.at(-1)?.data['code']).toBe(0)
  })

  it('命令失败不是我们的故障 —— 退出码照实报，不是一次请求失败', async () => {
    const id = await openShell({ root: repo })
    await api(`/api/shell/${id}/exec`, { method: 'POST', body: JSON.stringify({ command: 'exit 7' }) })
    const events = await shellEvents(id, (event) => event.kind === 'ended')
    expect(events.at(-1)?.data['code']).toBe(7)
  })

  /*
   * 这是这次改动的重点：终端不再跟着文件浏览器的目录走，`cd` 过去就留在
   * 那儿 —— 和任何一个终端一样。
   */
  it('cd 留得住，会话记着自己在哪儿', async () => {
    const id = await openShell({ root: repo })
    await api(`/api/shell/${id}/exec`, { method: 'POST', body: JSON.stringify({ command: 'cd src' }) })
    await shellEvents(id, (event) => event.kind === 'ended')

    const { session } = await (await api(`/api/shell/${id}`)).json() as { session: { cwd: string } }
    expect(session.cwd).toBe(join(await realpath(repo), 'src'))
  })

  it('ctrl+c 把正在跑的命令中断掉', async () => {
    const id = await openShell({ root: repo })
    await api(`/api/shell/${id}/exec`, { method: 'POST', body: JSON.stringify({ command: 'sleep 30' }) })
    // 命令得先真的起来 —— 信号发给一个还没 spawn 出来的进程组是没有意义的。
    await shellEvents(id, (event) => event.kind === 'began')

    const signalled = await api(`/api/shell/${id}/signal`, {
      method: 'POST', body: JSON.stringify({ signal: 'SIGINT' }),
    })
    expect(signalled.status).toBe(200)
    expect((await signalled.json() as { delivered: boolean }).delivered).toBe(true)

    const events = await shellEvents(id, (event) => event.kind === 'ended')
    expect(events.at(-1)?.data['interrupted']).toBe(true)
  })

  it('一次只跑一条：忙着的时候第二条是 409，不是并排跑', async () => {
    const id = await openShell({ root: repo })
    await api(`/api/shell/${id}/exec`, { method: 'POST', body: JSON.stringify({ command: 'sleep 1' }) })
    const second = await api(`/api/shell/${id}/exec`, {
      method: 'POST', body: JSON.stringify({ command: 'echo nope' }),
    })
    expect(second.status).toBe(409)
    expect((await second.json() as { error: string }).error).toBe('shell-busy')
  })

  it('Tab 补全列的是会话自己的目录，不受工作区根牵制', async () => {
    const id = await openShell({ root: repo })
    const listing = await (await api(`/api/shell/${id}/list?dir=src`)).json() as
      { entries: { name: string }[] }
    expect(listing.entries.map((entry) => entry.name)).toEqual(['main.ts'])
  })

  /*
   * 每次重新订阅都从头回放的话，用户刚按下的"清空"会在下一次重订阅时自己
   * 长回来 —— 切一下界面语言就够了。
   */
  it('页面带着自己的游标重订阅，已经看过的不会再来一遍', async () => {
    const id = await openShell({ root: repo })
    await api(`/api/shell/${id}/exec`, { method: 'POST', body: JSON.stringify({ command: 'echo once' }) })
    const first = await shellEvents(id, (event) => event.kind === 'ended')
    expect(outputOf(first)).toContain('once')

    const cursor = Math.max(...first.map((frame) => frame.seq))
    const again = await shellEvents(id, (event) => event.kind === 'state', cursor)
    // 只剩下那条对齐用的快照，历史一条都不该重发。
    expect(again.map((frame) => frame.kind)).toEqual(['state'])
  })

  /*
   * 会话没了，这条流就没有对端了。只把订阅者从名单上划掉是不够的：那样
   * 连接还开着、心跳还在响，页面会以为终端好端端地活着。
   */
  it('会话被收掉时，还接着的事件流收到讣告并断开', async () => {
    const id = await openShell({ root: repo })
    // 只有流自己结束才会回来 —— 没断的话，这里会一直等到超时并失败。
    const stream = shellEvents(id, () => false)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect((await api(`/api/shell/${id}`, { method: 'DELETE' })).status).toBe(200)
    const frames = await stream
    expect(frames.at(-1)?.kind).toBe('closed')
  })

  it('会话不在了一律 404 —— 命令不该被送进一个已经回收的会话', async () => {
    const id = await openShell({ root: repo })
    expect((await api(`/api/shell/${id}`, { method: 'DELETE' })).status).toBe(200)
    const res = await api(`/api/shell/${id}/exec`, {
      method: 'POST', body: JSON.stringify({ command: 'pwd' }),
    })
    expect(res.status).toBe(404)
    expect((await res.json() as { error: string }).error).toBe('no-such-shell')
  })

  /*
   * 目录在你浏览的这会儿被删掉，是这几个接口最常见的失败 —— 废弃一张卡就会
   * 连它的 worktree 一起删。三条路都得说人话，不能一句 500 了事。
   */
  it('起步目录没了是 404，不是 500 —— spawn 的报错会把锅甩给 shell', async () => {
    const res = await api('/api/shell', {
      method: 'POST', body: JSON.stringify({ root: repo, cwd: join(repo, '走了') }),
    })
    expect(res.status).toBe(404)
    expect((await res.json() as { error: string }).error).toBe('no-such-dir')
  })

  /*
   * 仓库整个不见了，不能说成「你逛的不是你自己的项目」—— 用户送来的**正是**
   * 这个项目登记的路径，那句话会把人往完全错误的方向带。
   */
  it('仓库目录没了报 repo-missing，不是 outside-project', async () => {
    await rm(repo, { recursive: true, force: true })
    for (const path of [
      `/api/files?root=${encodeURIComponent(repo)}`,
      `/api/files/content?root=${encodeURIComponent(repo)}&path=${encodeURIComponent(join(repo, 'README.md'))}`,
    ]) {
      const res = await api(path)
      expect(res.status).toBe(410)
      expect((await res.json() as { error: string }).error).toBe('repo-missing')
    }
    const opened = await api('/api/shell', { method: 'POST', body: JSON.stringify({ root: repo }) })
    expect(opened.status).toBe(410)
    expect((await opened.json() as { error: string }).error).toBe('repo-missing')
  })

  /*
   * 围栏只画在开会话这一步。开完之后 `cd` 去哪儿是用户自己的事 —— 命令本来
   * 就能自己 `cd /`，拦不住也不打算拦；这层围栏防的是我们的路径拼接写错。
   */
  it('空命令 422，围栏外的起步目录 422', async () => {
    const id = await openShell({ root: repo })
    expect((await api(`/api/shell/${id}/exec`, {
      method: 'POST', body: JSON.stringify({ command: '   ' }),
    })).status).toBe(422)
    expect((await api('/api/shell', {
      method: 'POST', body: JSON.stringify({ root: '/etc' }),
    })).status).toBe(422)
  })
})

describe('GET /api/agents', () => {
  /** 造一个探测结果，只填这条测试关心的字段。 */
  const detected = (id: string, caveat?: { label: string; detail: string }) => ({
    provider: { id } as never,
    caps: {
      id, bin: `/fake/${id}`, version: '1.0.0',
      streaming: true, canPinSessionId: false, canResume: true,
      permissionTiers: ['standard'],
      ...(caveat === undefined ? {} : { permissionCaveat: caveat }),
      help: {
        flags: new Set<string>(),
        choices: new Map<string, readonly string[]>(),
        descriptions: new Map<string, string>(),
      },
    } as never,
  })

  const CAVEAT = { label: '无沙箱', detail: 'Agent 可以改 worktree 之外的文件。' }

  it('把权限警示如实传给界面 —— 只报档位名字会让人按别家的经验理解它', async () => {
    const withCaveat = await startServer({
      storage: store, token: TOKEN, agents: AgentPool.of([detected('opencode', CAVEAT)]),
    })
    try {
      const body = await fetch(`http://127.0.0.1:${String(withCaveat.port)}/api/agents`, {
        headers: { cookie: `loopkanban_token=${TOKEN}` },
      }).then((r) => r.json() as Promise<{ agents: { id: string; permissionCaveat?: typeof CAVEAT }[] }>)
      expect(body.agents[0]?.permissionCaveat).toEqual(CAVEAT)
    } finally {
      await withCaveat.close()
    }
  })

  it('刷新会重新探测，并把新结果按同一份字段给出去', async () => {
    let found = [detected('codex')]
    const pool = new AgentPool(() => Promise.resolve(found), found)
    const server = await startServer({ storage: store, token: TOKEN, agents: pool })
    try {
      // 装上了一个新的 CLI，此时不重启看板也该看得见。
      found = [detected('codex'), detected('opencode', CAVEAT)]
      const body = await fetch(`http://127.0.0.1:${String(server.port)}/api/agents/refresh`, {
        method: 'POST',
        headers: { cookie: `loopkanban_token=${TOKEN}` },
      }).then((r) => r.json() as Promise<{ agents: { id: string; permissionCaveat?: typeof CAVEAT }[] }>)

      expect(body.agents.map((a) => a.id)).toEqual(['codex', 'opencode'])
      // 刷新与 GET 走同一份映射：警示这类字段不能只在其中一条路上出现。
      expect(body.agents[1]?.permissionCaveat).toEqual(CAVEAT)
      expect(body.agents[0]).not.toHaveProperty('help')

      // 池子是活视图，之后的 GET 也该是新的 —— 派活的 runner 用的就是它。
      const after = await fetch(`http://127.0.0.1:${String(server.port)}/api/agents`, {
        headers: { cookie: `loopkanban_token=${TOKEN}` },
      }).then((r) => r.json() as Promise<{ agents: { id: string }[] }>)
      expect(after.agents.map((a) => a.id)).toEqual(['codex', 'opencode'])
    } finally {
      await server.close()
    }
  })

  it('刷新要 POST —— 它会真的去起一串子进程，不是一次读取', async () => {
    const server = await startServer({
      storage: store, token: TOKEN, agents: AgentPool.of([detected('codex')]),
    })
    try {
      const res = await fetch(`http://127.0.0.1:${String(server.port)}/api/agents/refresh`, {
        headers: { cookie: `loopkanban_token=${TOKEN}` },
      })
      expect(res.status).toBe(404)
    } finally {
      await server.close()
    }
  })

  it('没有警示的 CLI 不会凭空多出这个字段', async () => {
    const plain = await startServer({
      storage: store, token: TOKEN, agents: AgentPool.of([detected('codex')]),
    })
    try {
      const body = await fetch(`http://127.0.0.1:${String(plain.port)}/api/agents`, {
        headers: { cookie: `loopkanban_token=${TOKEN}` },
      }).then((r) => r.json() as Promise<{ agents: Record<string, unknown>[] }>)
      expect(body.agents[0]).not.toHaveProperty('permissionCaveat')
      // help 原文这类噪音也不该漏出去。
      expect(body.agents[0]).not.toHaveProperty('help')
    } finally {
      await plain.close()
    }
  })
})

describe('监听与访问入口', () => {
  it('只监听回环地址，随机端口', () => {
    expect(server.port).toBeGreaterThan(0)
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=/)
  })

  it('首次带 query token 访问会下发 httpOnly cookie', async () => {
    const res = await fetch(`http://127.0.0.1:${String(server.port)}/api/state?token=${TOKEN}`)
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
  })
})

describe('安全守卫', () => {
  it('没有 token 一律 401', async () => {
    expect(await rawRequest({ host: `127.0.0.1:${String(server.port)}` })).toBe(401)
  })

  it('token 错误 401', async () => {
    expect(await rawRequest({
      host: `127.0.0.1:${String(server.port)}`,
      cookie: 'loopkanban_token=wrong',
    })).toBe(401)
  })

  it('伪造的 Host 被拒 —— 即使 token 正确（DNS rebinding 防线）', async () => {
    expect(await rawRequest({
      host: 'evil.com',
      cookie: `loopkanban_token=${TOKEN}`,
    })).toBe(403)
  })

  it('跨源 Origin 被拒', async () => {
    expect(await rawRequest({
      host: `127.0.0.1:${String(server.port)}`,
      cookie: `loopkanban_token=${TOKEN}`,
      origin: 'https://evil.com',
    })).toBe(403)
  })
})

describe('GET /api/state', () => {
  it('返回项目与任务', async () => {
    store.createTask(task({ id: 't1' }))
    const body = await (await api('/api/state')).json() as { projects: unknown[]; tasks: Task[] }
    expect(body.projects).toHaveLength(1)
    expect(body.tasks.map((t) => t.id)).toEqual(['t1'])
  })

  it('未知路径 404', async () => {
    expect((await api('/api/nope')).status).toBe(404)
  })
})

describe('GET /api/state 的运行中预览', () => {
  it('运行中的卡捎上最后一条事件 —— 关着弹窗也看得出 Agent 走到哪儿了', async () => {
    const runId = asRunId('run-1')
    store.createTask(task({
      id: 't1',
      column: 'running',
      lease: { runId, provider: 'claude', acquiredAt: T0, expiresAt: T0 + 60_000 },
    }))
    store.createRun({
      id: runId, taskId: asTaskId('t1'), provider: 'claude', cliVersion: '1.0',
      worktreePath: '/wt', branch: 'task/t1', status: 'running', startedAt: T0,
    })
    store.appendEvent(runId, 'tool', { name: 'Bash' }, T0 + 1)
    store.appendEvent(runId, 'tool', { name: 'Edit' }, T0 + 2)

    const body = await (await api('/api/state')).json() as
      { live: Record<string, { kind: string; payload: { name?: string } }> }
    // 最后一条，不是第一条。
    expect(body.live['t1']).toMatchObject({ kind: 'tool', payload: { name: 'Edit' } })
  })

  it('没在跑的卡不捎 —— 它没有正在发生的事', async () => {
    store.createTask(task({ id: 't1', column: 'ready' }))
    const body = await (await api('/api/state')).json() as { live: Record<string, unknown> }
    expect(body.live).toEqual({})
  })
})

describe('GET /api/state 里 Review 的失败标记', () => {
  /** 给某张卡记一次执行。默认是跑成了的那种。 */
  const run = (id: string, taskId: string, patch: Partial<{
    status: 'running' | 'completed' | 'failed' | 'aborted'
    diagnostic: string
    startedAt: number
    endedAt: number
  }> = {}) => {
    const { status = 'completed', diagnostic, startedAt = T0, endedAt = T0 + 1_000 } = patch
    store.createRun({
      id: asRunId(id), taskId: asTaskId(taskId), provider: 'claude', cliVersion: '1.0',
      worktreePath: '/wt', branch: `task/${taskId}`, status, startedAt, endedAt,
      ...(diagnostic === undefined ? {} : { diagnostic }),
    })
  }

  const failures = async () =>
    (await (await api('/api/state')).json() as
      { failures: Record<string, { status: string; provider: string; diagnostic?: string }> }).failures

  it('这一轮跑挂的卡带上收场 —— 成败同处 Review，不标就分不出哪张该看日志', async () => {
    store.createTask(task({ id: 't1', column: 'review' }))
    run('run-1', 't1', { status: 'failed', diagnostic: '退出码 1' })

    expect(await failures()).toEqual({
      't1': { runId: 'run-1', provider: 'claude', status: 'failed', diagnostic: '退出码 1', at: T0 + 1_000 },
    })
  })

  it('被人终止的那次也算没跑成，但要认得出它不是自己挂的', async () => {
    store.createTask(task({ id: 't1', column: 'review' }))
    run('run-1', 't1', { status: 'aborted' })
    expect((await failures())['t1']).toMatchObject({ status: 'aborted' })
  })

  it('跑成了的不标 —— 那张卡等的是验收，不是查错', async () => {
    store.createTask(task({ id: 't1', column: 'review' }))
    run('run-1', 't1')
    expect(await failures()).toEqual({})
  })

  it('只看最近一轮：上一轮挂了、这一轮跑成了，标记就该消失', async () => {
    store.createTask(task({ id: 't1', column: 'review' }))
    run('run-1', 't1', { status: 'failed', startedAt: T0, endedAt: T0 + 1 })
    run('run-2', 't1', { status: 'completed', startedAt: T0 + 10_000, endedAt: T0 + 11_000 })
    expect(await failures()).toEqual({})
  })

  it('重新派出去跑的卡不标 —— 它已经不在 Review 了，红字说的是上一轮的旧闻', async () => {
    store.createTask(task({
      id: 't1',
      column: 'running',
      lease: { runId: asRunId('run-2'), provider: 'claude', acquiredAt: T0, expiresAt: T0 + 60_000 },
    }))
    run('run-1', 't1', { status: 'failed' })
    expect(await failures()).toEqual({})
  })
})

describe('POST /api/tasks/:id/move', () => {
  beforeEach(() => { store.createTask(task({ id: 't1' })) })

  const move = (body: unknown) => api('/api/tasks/t1/move', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  it('合法流转成功并自增 revision', async () => {
    const res = await move({ expectedRevision: 1, to: 'running' })
    expect(res.status).toBe(200)
    const body = await res.json() as { task: Task }
    expect(body.task).toMatchObject({ column: 'running', revision: 2 })
    expect(store.getTask(asTaskId('t1'))?.column).toBe('running')
  })

  it('revision 过期返回 409，客户端据此重读重试', async () => {
    await move({ expectedRevision: 1, to: 'running' })
    const res = await move({ expectedRevision: 1, to: 'review' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'revision-conflict' })
  })

  it('非法流转返回 422 而不是 409 —— 重试也没用，得改请求', async () => {
    const res = await move({ expectedRevision: 1, to: 'done' })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'illegal-transition' })
  })

  it('缺参数返回 400', async () => {
    expect((await move({ to: 'running' })).status).toBe(400)
  })

  it('任务不存在返回 404', async () => {
    const res = await api('/api/tasks/ghost/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, to: 'running' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/tasks/:id/archive · unarchive', () => {
  beforeEach(() => { store.createTask(task({ id: 't1' })) })

  const shelf = (action: 'archive' | 'unarchive', body: unknown, id = 't1') =>
    api(`/api/tasks/${id}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('归档后卡还在原来那一列，只是多了 archivedAt', async () => {
    const res = await shelf('archive', { expectedRevision: 1 })
    expect(res.status).toBe(200)
    const stored = store.getTask(asTaskId('t1'))
    expect(stored?.column).toBe('ready')
    expect(stored?.archivedAt).toBeGreaterThan(0)
  })

  it('取消归档后 archivedAt 落盘为空', async () => {
    await shelf('archive', { expectedRevision: 1 })
    const res = await shelf('unarchive', { expectedRevision: 2 })
    expect(res.status).toBe(200)
    expect(store.getTask(asTaskId('t1'))?.archivedAt).toBeUndefined()
  })

  it('归档的卡移不动，返回 422 而不是悄悄放行', async () => {
    await shelf('archive', { expectedRevision: 1 })
    const res = await api('/api/tasks/t1/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 2, to: 'backlog' }),
    })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'task-archived' })
  })

  it('revision 过期返回 409，缺参数 400，卡不存在 404', async () => {
    expect((await shelf('archive', { expectedRevision: 99 })).status).toBe(409)
    expect((await shelf('archive', {})).status).toBe(400)
    expect((await shelf('archive', { expectedRevision: 1 }, 'ghost')).status).toBe(404)
  })

  it('重复归档返回 422 —— 幂等地假装成功会让并发下的两次点击都以为自己赢了', async () => {
    await shelf('archive', { expectedRevision: 1 })
    const res = await shelf('archive', { expectedRevision: 2 })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'already-archived' })
  })
})

describe('POST /api/tasks', () => {
  it('建卡时就能带上关联，同项目的约束一样要过', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    const res = await api('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: PROJECT, description: '照着 t1 再来一张', relatedTo: ['t1'] }),
    })
    expect(res.status).toBe(201)
    const { task: created } = await res.json() as { task: { id: string; relatedTo: string[] } }
    expect(created.relatedTo).toEqual(['t1'])

    const bad = await api('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: PROJECT, description: 'x', relatedTo: ['t-nope'] }),
    })
    expect(bad.status).toBe(422)
    expect(await bad.json()).toMatchObject({ error: 'no-such-related-task' })
  })

  it('建卡也能带上依赖，同项目的约束一样要过', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    const res = await api('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: PROJECT, description: '排在 t1 后面', blockedBy: ['t1'] }),
    })
    expect(res.status).toBe(201)
    const { task: created } = await res.json() as { task: { id: string; blockedBy: string[] } }
    expect(created.blockedBy).toEqual(['t1'])

    const bad = await api('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: PROJECT, description: 'x', blockedBy: ['t-nope'] }),
    })
    expect(bad.status).toBe(422)
    expect(await bad.json()).toMatchObject({ error: 'no-such-blocked-task' })
  })
})

describe('PATCH /api/tasks/:id', () => {
  const edit = (id: string, body: unknown) =>
    api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) })

  it('改描述与验收标准', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    const res = await edit('t1', { expectedRevision: 1, description: '新内容', acceptance: [] })
    expect(res.status).toBe(200)
    const after = store.getTask(asTaskId('t1'))
    expect(after?.description).toBe('新内容')
    // 验收标准是可选的，清空不再被拒。
    expect(after?.acceptance).toEqual([])
  })

  it('指定执行器与模型，null 才是"清空"', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    await edit('t1', { expectedRevision: 1, preferredProvider: 'claude', model: 'opus' })
    expect(store.getTask(asTaskId('t1'))?.model).toBe('opus')

    // 字段缺席只意味着"这次没提到"，不该把它抹掉。
    await edit('t1', { expectedRevision: 2, description: '只改内容' })
    expect(store.getTask(asTaskId('t1'))?.model).toBe('opus')

    // 显式送 null 才清空 —— JSON 里没有 undefined。
    await edit('t1', { expectedRevision: 3, preferredProvider: null, model: null })
    const cleared = store.getTask(asTaskId('t1'))
    expect(cleared?.model).toBeUndefined()
    expect(cleared?.preferredProvider).toBeUndefined()
  })

  it('关联同项目的卡：存下来，去重、去掉自指', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    store.createTask(task({ id: 't2', column: 'backlog' }))
    const res = await edit('t1', { expectedRevision: 1, relatedTo: ['t2', 't2', 't1'] })
    expect(res.status).toBe(422)
    // 自指是明确的拒绝，不是悄悄过滤 —— 界面上要能说清为什么没存下去。
    expect(await res.json()).toMatchObject({ error: 'self-related' })

    const ok = await edit('t1', { expectedRevision: 1, relatedTo: ['t2', 't2'] })
    expect(ok.status).toBe(200)
    expect(store.getTask(asTaskId('t1'))?.relatedTo).toEqual(['t2'])
  })

  it('关联跨项目、或指向不存在的卡，一律拒绝', async () => {
    const other = asProjectId('p-other')
    store.createProject({
      id: other, name: '另一个', repoPath: '/other', baseBranch: 'main', createdAt: T0,
    })
    store.createTask(task({ id: 't1', column: 'backlog' }))
    store.createTask(task({ id: 'x1', column: 'backlog', projectId: other, repoPath: '/other' }))

    const cross = await edit('t1', { expectedRevision: 1, relatedTo: ['x1'] })
    expect(cross.status).toBe(422)
    expect(await cross.json()).toMatchObject({ error: 'no-such-related-task' })

    const ghost = await edit('t1', { expectedRevision: 1, relatedTo: ['t-nope'] })
    expect(ghost.status).toBe(422)
    // 一条都没存进去 —— 拒绝是整批的。
    expect(store.getTask(asTaskId('t1'))?.relatedTo).toEqual([])
  })

  it('空数组就是取消全部关联', async () => {
    store.createTask(task({ id: 't2', column: 'backlog' }))
    store.createTask(task({ id: 't1', column: 'backlog', relatedTo: [asTaskId('t2')] }))
    const res = await edit('t1', { expectedRevision: 1, relatedTo: [] })
    expect(res.status).toBe(200)
    expect(store.getTask(asTaskId('t1'))?.relatedTo).toEqual([])
  })

  it('正在执行的卡改不动关联 —— 它和改需求是同一件事', async () => {
    store.createTask(task({ id: 't2', column: 'backlog' }))
    store.createTask(task({ id: 't1', column: 'running' }))
    const res = await edit('t1', { expectedRevision: 1, relatedTo: ['t2'] })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'task-running' })
  })

  it('依赖同项目的卡：存下来、去重；自指是明确的拒绝', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    store.createTask(task({ id: 't2', column: 'backlog' }))
    const self = await edit('t1', { expectedRevision: 1, blockedBy: ['t1'] })
    expect(self.status).toBe(422)
    expect(await self.json()).toMatchObject({ error: 'self-dependency' })

    const ok = await edit('t1', { expectedRevision: 1, blockedBy: ['t2', 't2'] })
    expect(ok.status).toBe(200)
    expect(store.getTask(asTaskId('t1'))?.blockedBy).toEqual(['t2'])
  })

  it('依赖跨项目、或指向不存在的卡，一律拒绝', async () => {
    const other = asProjectId('p-other')
    store.createProject({
      id: other, name: '另一个', repoPath: '/other', baseBranch: 'main', createdAt: T0,
    })
    store.createTask(task({ id: 't1', column: 'backlog' }))
    store.createTask(task({ id: 'x1', column: 'backlog', projectId: other, repoPath: '/other' }))

    const cross = await edit('t1', { expectedRevision: 1, blockedBy: ['x1'] })
    expect(cross.status).toBe(422)
    expect(await cross.json()).toMatchObject({ error: 'no-such-blocked-task' })

    const ghost = await edit('t1', { expectedRevision: 1, blockedBy: ['t-nope'] })
    expect(ghost.status).toBe(422)
    // 一条都没存进去 —— 拒绝是整批的。
    expect(store.getTask(asTaskId('t1'))?.blockedBy).toEqual([])
  })

  it('依赖成环被拒 —— 沿着依赖链走回这张卡，环上的卡互相等，谁也不会开工', async () => {
    store.createTask(task({ id: 't1', column: 'backlog', blockedBy: [asTaskId('t2')] }))
    store.createTask(task({ id: 't2', column: 'backlog' }))
    store.createTask(task({ id: 't3', column: 'backlog' }))

    // t2 依赖 t3 不成环：t1 → t2 → t3 是一条直链。
    const ok = await edit('t2', { expectedRevision: 1, blockedBy: ['t3'] })
    expect(ok.status).toBe(200)

    // t3 再回头依赖 t1 就绕死了：t3 → t1 → t2 → t3。
    const cyclic = await edit('t3', { expectedRevision: 1, blockedBy: ['t1'] })
    expect(cyclic.status).toBe(422)
    expect(await cyclic.json()).toMatchObject({ error: 'dependency-cycle' })
    // 被拒的编辑不存半截。
    expect(store.getTask(asTaskId('t3'))?.blockedBy).toEqual([])
  })

  it('空数组就是取消全部依赖', async () => {
    store.createTask(task({ id: 't2', column: 'backlog' }))
    store.createTask(task({ id: 't1', column: 'backlog', blockedBy: [asTaskId('t2')] }))
    const res = await edit('t1', { expectedRevision: 1, blockedBy: [] })
    expect(res.status).toBe(200)
    expect(store.getTask(asTaskId('t1'))?.blockedBy).toEqual([])
  })
})

describe('执行器', () => {
  /** 一台探测到 claude 与 codex 的机器。执行器只能在这两个里面挑 CLI。 */
  const fake = (id: string) => ({
    provider: { id } as never,
    caps: {
      id, bin: `/fake/${id}`, version: '1.0.0',
      streaming: true, canPinSessionId: false, canResume: true, canPickModel: true,
      models: [`${id}-fast`],
      permissionTiers: ['standard'],
      help: {
        flags: new Set<string>(),
        choices: new Map<string, readonly string[]>(),
        descriptions: new Map<string, string>(),
      },
    } as never,
  })

  let machine: RunningServer

  /** 带 cookie 打这台"装了两个 CLI"的 server。 */
  const call = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`http://127.0.0.1:${String(machine.port)}${path}`, {
      ...init,
      headers: { cookie: `loopkanban_token=${TOKEN}`, ...init.headers },
    })

  const create = (body: unknown) =>
    call('/api/executors', { method: 'POST', body: JSON.stringify(body) })

  beforeEach(async () => {
    machine = await startServer({
      storage: store, token: TOKEN,
      agents: AgentPool.of([fake('claude'), fake('codex')]),
    })
  })

  afterEach(async () => { await machine.close() })

  it('列出来的时候把"能选哪些 CLI"一起给 —— 新建表单照着它渲染', async () => {
    const body = await (await call('/api/executors')).json() as
      { executors: unknown[]; defaultId: string | null; providers: { id: string; models: string[] }[] }
    expect(body.executors).toEqual([])
    expect(body.defaultId).toBeNull()
    expect(body.providers.map((p) => p.id)).toEqual(['claude', 'codex'])
    expect(body.providers[0]?.models).toEqual(['claude-fast'])
  })

  it('建一个，它顺带成为默认', async () => {
    const res = await create({ name: '大壮', provider: 'claude', model: 'opus' })
    expect(res.status).toBe(201)
    const listed = await (await call('/api/executors')).json() as { defaultId: string | null }
    expect(listed.defaultId).toBe(store.listExecutors()[0]?.id)
  })

  it('重名是 409 —— 那是一次冲突，不是格式错误', async () => {
    await create({ name: '大壮', provider: 'claude' })
    const again = await create({ name: '大壮', provider: 'codex' })
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: 'executor-duplicate' })
  })

  it('名字里有空格是 422，并说清楚为什么', async () => {
    const res = await create({ name: '大 壮', provider: 'claude' })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'executor-illegal-chars' })
  })

  it('本机没探测到的 CLI 当场拒绝', async () => {
    const res = await create({ name: '大壮', provider: 'gemini' })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'executor-unknown-provider' })
  })

  it('模型给 null 是"回到那个 CLI 自己的默认"', async () => {
    const { executor } = await (await create({ name: '大壮', provider: 'claude', model: 'opus' })).json() as
      { executor: { id: string } }
    const res = await call(`/api/executors/${executor.id}`, {
      method: 'PATCH', body: JSON.stringify({ model: null }),
    })
    expect(res.status).toBe(200)
    expect(store.getExecutor(asExecutorId(executor.id))?.model).toBeUndefined()
  })

  it('换默认', async () => {
    await create({ name: '大壮', provider: 'claude' })
    const { executor } = await (await create({ name: '小壮', provider: 'codex' })).json() as
      { executor: { id: string } }
    expect((await call(`/api/executors/${executor.id}/default`, { method: 'POST' })).status).toBe(200)
    const listed = await (await call('/api/executors')).json() as { defaultId: string | null }
    expect(listed.defaultId).toBe(executor.id)
  })

  it('删掉之后，指着它的卡回到"用默认执行器"，卡本身还在', async () => {
    const { executor } = await (await create({ name: '大壮', provider: 'claude' })).json() as
      { executor: { id: string } }
    store.createTask(task({ id: 't1', executorId: asExecutorId(executor.id) }))

    expect((await call(`/api/executors/${executor.id}`, { method: 'DELETE' })).status).toBe(200)
    const after = store.getTask(asTaskId('t1'))
    expect(after).not.toBeNull()
    expect(after?.executorId).toBeUndefined()
  })

  it('建卡时指一个不存在的执行器是 422，而不是存下去等派活时才炸', async () => {
    const res = await call('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ projectId: String(PROJECT), description: 'x', executorId: 'e-nope' }),
    })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'executor-not-found' })
  })

  it('看板状态里带着执行器 —— 卡面要按 id 说出名字', async () => {
    await create({ name: '大壮', provider: 'claude' })
    const body = await (await call('/api/state')).json() as
      { executors: { name: string }[]; defaultExecutorId: string | null }
    expect(body.executors.map((e) => e.name)).toEqual(['大壮'])
    expect(body.defaultExecutorId).not.toBeNull()
  })
})

describe('聊出一张卡', () => {
  it('没装对话服务时那几条接口一律 503 —— 界面据此不摆一个说了没人应的输入框', async () => {
    const res = await api(`/api/projects/${String(PROJECT)}/chat`)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'chat-unavailable' })
  })

  it('采纳一份草案：原样建成卡，落在想法池', async () => {
    store.addChatMessage({
      id: 'm1', projectId: PROJECT, role: 'proposal', body: '把导出做成后台任务',
      proposal: { description: '把导出做成后台任务', acceptance: ['有回执'], relatedTo: [] },
      at: T0,
    })
    const res = await api('/api/chat/m1/adopt', { method: 'POST', body: JSON.stringify({ column: 'backlog' }) })
    expect(res.status).toBe(201)
    const { task: made } = await res.json() as { task: { id: string; column: string; acceptance: string[] } }
    expect(made.column).toBe('backlog')
    expect(made.acceptance).toEqual(['有回执'])
    // 记下它变成了哪张卡：再点一次不该再建一张。
    expect(store.listChat(PROJECT)[0]?.taskId).toBe(made.id)
  })

  it('选"直接进 Loop"就走一次正常流转到 ready，而不是绕过建卡的规矩', async () => {
    store.addChatMessage({
      id: 'm1', projectId: PROJECT, role: 'proposal', body: 'x',
      proposal: { description: 'x', acceptance: [], relatedTo: [] }, at: T0,
    })
    const res = await api('/api/chat/m1/adopt', { method: 'POST', body: JSON.stringify({ column: 'ready' }) })
    const { task: made } = await res.json() as { task: { column: string } }
    expect(made.column).toBe('ready')
  })

  it('草案里的关联卡照旧要过一遍：查无此卡的一概不认', async () => {
    store.createTask(task({ id: 't-f3ccd6cc', column: 'done' }))
    store.addChatMessage({
      id: 'm1', projectId: PROJECT, role: 'proposal', body: 'x',
      proposal: { description: 'x', acceptance: [], relatedTo: ['t-f3ccd6cc', 't-nope'] }, at: T0,
    })
    const res = await api('/api/chat/m1/adopt', { method: 'POST', body: JSON.stringify({}) })
    const { task: made } = await res.json() as { task: { relatedTo: string[] } }
    expect(made.relatedTo).toEqual(['t-f3ccd6cc'])
  })

  it('同一份草案不会建出第二张卡', async () => {
    store.addChatMessage({
      id: 'm1', projectId: PROJECT, role: 'proposal', body: 'x',
      proposal: { description: 'x', acceptance: [], relatedTo: [] }, at: T0,
    })
    await api('/api/chat/m1/adopt', { method: 'POST', body: JSON.stringify({}) })
    const again = await api('/api/chat/m1/adopt', { method: 'POST', body: JSON.stringify({}) })
    expect(again.status).toBe(409)
    expect(store.listTasks()).toHaveLength(1)
  })

  it('两下同时点也只建一张 —— 认领那条 UPDATE 才是唯一的入场券', async () => {
    store.addChatMessage({
      id: 'm1', projectId: PROJECT, role: 'proposal', body: 'x',
      proposal: { description: 'x', acceptance: [], relatedTo: [] }, at: T0,
    })
    // 并发发出去：两边都会读到 task_id 还是空的，靠 linkChatProposal 分胜负。
    const both = await Promise.all([
      api('/api/chat/m1/adopt', { method: 'POST', body: JSON.stringify({}) }),
      api('/api/chat/m1/adopt', { method: 'POST', body: JSON.stringify({}) }),
    ])
    expect(both.map((res) => res.status).sort()).toEqual([201, 409])
    expect(store.listTasks()).toHaveLength(1)
  })
})

describe('讨论', () => {
  const say = (id: string, body: unknown) =>
    api(`/api/tasks/${id}/comments`, { method: 'POST', body: JSON.stringify(body) })

  it('在 Review 里留言 = 再改一版：卡自动回队列', async () => {
    store.createTask(task({ id: 't1', column: 'review' }))
    const res = await say('t1', { body: '中文标题被吃掉了，要保留 Unicode' })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ requeued: true })
    expect(store.getTask(asTaskId('t1'))?.column).toBe('ready')
    expect(store.listComments(asTaskId('t1'))[0]).toMatchObject({
      author: 'human', body: '中文标题被吃掉了，要保留 Unicode',
    })
  })

  it('别的列只是留个话，不动卡的位置', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    expect(await (await say('t1', { body: '顺手记一笔' })).json()).toMatchObject({ requeued: false })
    expect(store.getTask(asTaskId('t1'))?.column).toBe('backlog')
    expect(store.listComments(asTaskId('t1'))).toHaveLength(1)
  })

  it('空留言 400，卡也不该被搬走', async () => {
    store.createTask(task({ id: 't1', column: 'review' }))
    expect((await say('t1', { body: '   ' })).status).toBe(400)
    expect(store.getTask(asTaskId('t1'))?.column).toBe('review')
    expect(store.listComments(asTaskId('t1'))).toHaveLength(0)
  })

  it('按时间正序读回来 —— 这也是交给 Agent 的上下文顺序', async () => {
    store.createTask(task({ id: 't1', column: 'review' }))
    store.addComment({ id: 'c1', taskId: asTaskId('t1'), author: 'human', body: '第一句', at: T0 })
    store.addComment({ id: 'c2', taskId: asTaskId('t1'), author: 'agent', body: '答复', at: T0 + 1 })
    const body = await (await api('/api/tasks/t1/comments')).json() as
      { comments: { author: string; body: string }[] }
    expect(body.comments.map((c) => c.author)).toEqual(['human', 'agent'])
  })

  /** 造两个执行器，`@` 点名要有对象。 */
  const twoExecutors = (): void => {
    store.createExecutor({
      id: asExecutorId('e-big'), name: '大壮', provider: 'claude', model: 'opus', createdAt: T0, updatedAt: T0,
    })
    store.createExecutor({
      id: asExecutorId('e-small'), name: '小壮', provider: 'claude', model: 'sonnet', createdAt: T0, updatedAt: T0,
    })
  }

  it('话里 @ 谁，下一轮就归谁', async () => {
    twoExecutors()
    store.createTask(task({ id: 't1', column: 'review', executorId: asExecutorId('e-big') }))
    const res = await say('t1', { body: '@小壮 换个人再来一版' })
    expect(res.status).toBe(201)
    // 换人与回队列是同一次留言的两半，两边都得落地。
    expect(await res.json()).toMatchObject({ requeued: true })
    const after = store.getTask(asTaskId('t1'))
    expect(after?.executorId).toBe('e-small')
    expect(after?.column).toBe('ready')
  })

  it('不点名就不换人 —— 接着上次那位干', async () => {
    twoExecutors()
    store.createTask(task({ id: 't1', column: 'review', executorId: asExecutorId('e-big') }))
    await say('t1', { body: '只是留个话' })
    expect(store.getTask(asTaskId('t1'))?.executorId).toBe('e-big')
  })

  it('#任务id 就是"参考那张卡"，落成关联', async () => {
    store.createTask(task({ id: 't1', column: 'review' }))
    store.createTask(task({ id: 't-f3ccd6cc', column: 'done' }))
    await say('t1', { body: '照着 #t-f3ccd6cc 的做法来' })
    expect(store.getTask(asTaskId('t1'))?.relatedTo).toEqual(['t-f3ccd6cc'])
  })

  it('#后面是查无此卡时当没写过，而不是留下一条指向空的关联', async () => {
    store.createTask(task({ id: 't1', column: 'review' }))
    const res = await say('t1', { body: '参考 #t-nope 那张' })
    expect(res.status).toBe(201)
    expect(store.getTask(asTaskId('t1'))?.relatedTo).toEqual([])
  })

  it('执行中的卡上带个 #引用，那句话照样发得出去 —— 只是这轮不记那条关联', async () => {
    store.createTask(task({ id: 't1', column: 'running' }))
    store.createTask(task({ id: 't-f3ccd6cc', column: 'done' }))
    const res = await say('t1', { body: '跑完看看 #t-f3ccd6cc 那张' })
    expect(res.status).toBe(201)
    expect(store.listComments(asTaskId('t1'))).toHaveLength(1)
    // 卡正跑着，改不动 —— 关联没记上，但那句话（连同卡号）留下来了。
    expect(store.getTask(asTaskId('t1'))?.relatedTo).toEqual([])
  })

  it('执行中的卡换不了人，那条话也不该留下', async () => {
    twoExecutors()
    store.createTask(task({ id: 't1', column: 'running', executorId: asExecutorId('e-big') }))
    const res = await say('t1', { body: '@小壮 接手' })
    expect(res.status).toBe(422)
    expect(store.getTask(asTaskId('t1'))?.executorId).toBe('e-big')
    expect(store.listComments(asTaskId('t1'))).toHaveLength(0)
  })

  it('执行中的卡仍然可以只留个话', async () => {
    store.createTask(task({ id: 't1', column: 'running' }))
    expect((await say('t1', { body: '跑完看看这里' })).status).toBe(201)
    expect(store.listComments(asTaskId('t1'))).toHaveLength(1)
  })

  it('卡不存在 404', async () => {
    expect((await say('nope', { body: 'x' })).status).toBe(404)
  })
})

describe('讨论里的附件', () => {
  /** 走讨论那一路传一个文件：`scope=draft`，先落地、等留言发出去再认领。 */
  const put = (id: string, filename: string, body: string, type = 'text/plain') =>
    api(`/api/tasks/${id}/attachments?scope=draft`, {
      method: 'POST',
      headers: { 'content-type': type, 'x-filename': encodeURIComponent(filename) },
      body,
    })

  const say = (id: string, body: unknown) =>
    api(`/api/tasks/${id}/comments`, { method: 'POST', body: JSON.stringify(body) })

  it('传上去先是草稿，发出去才挂到那条留言上', async () => {
    store.createTask(task({ id: 't1', column: 'review' }))
    const { attachment } = await (await put('t1', '截图.png', 'IMG', 'image/png')).json() as
      { attachment: { id: string; commentId: string } }
    // 空串 = 还没发出去。前端靠它分辨这个文件撤不撤得回。
    expect(attachment.commentId).toBe('')

    // 规格清单里没有它 —— 讨论里贴的图不是需求的一部分。
    const spec = await (await api('/api/tasks/t1/attachments')).json() as { attachments: unknown[] }
    expect(spec.attachments).toHaveLength(0)
    // 草稿清单里有：重新打开面板要靠它把没发出去的文件摆回去。
    const draft = await (await api('/api/tasks/t1/attachments?scope=draft')).json() as
      { attachments: { id: string }[] }
    expect(draft.attachments.map((a) => a.id)).toEqual([attachment.id])

    const res = await say('t1', { body: '这儿为什么长这样？', attachmentIds: [attachment.id] })
    expect(res.status).toBe(201)
    const { comments } = await res.json() as
      { comments: { id: string; attachments?: { filename: string }[] }[] }
    // 附件跟着那条话一起回来：前端不必自己对齐两份列表。
    expect(comments[0]?.attachments?.map((a) => a.filename)).toEqual(['截图.png'])
    expect(store.getAttachment(attachment.id)?.commentId).toBe(comments[0]?.id)
    // 认领完就不再是草稿了，下次打开不该又冒出来。
    expect(store.listDraftAttachments(asTaskId('t1'))).toHaveLength(0)
  })

  it('执行中的卡也能在讨论里带文件 —— 它和那句话一起等下一轮', async () => {
    store.createTask(task({ id: 't1', column: 'running' }))
    // 规格附件此刻是冻的（需求不能改），讨论不受这条约束 —— 留言本来就不受。
    expect((await api('/api/tasks/t1/attachments', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-filename': 'a.txt' },
      body: 'x',
    })).status).toBe(422)
    expect((await put('t1', 'b.txt', 'x')).status).toBe(201)
  })

  it('草稿撤得回，发出去的撤不回 —— 讨论是一份记录', async () => {
    store.createTask(task({ id: 't1', column: 'review' }))
    const first = await (await put('t1', 'a.txt', 'x')).json() as { attachment: { id: string } }
    const second = await (await put('t1', 'b.txt', 'y')).json() as { attachment: { id: string } }

    expect((await api(`/api/attachments/${first.attachment.id}`, { method: 'DELETE' })).status).toBe(200)

    await say('t1', { body: '看这个', attachmentIds: [second.attachment.id] })
    const res = await api(`/api/attachments/${second.attachment.id}`, { method: 'DELETE' })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'attachment-sent' })
    expect(store.getAttachment(second.attachment.id)).not.toBeNull()
  })

  it('id 太多在留言落库之前就拒掉 —— 不然留言写进去了却回一个 500', async () => {
    store.createTask(task({ id: 't1', column: 'review' }))
    const ids = Array.from({ length: MAX_ATTACHMENTS_PER_COMMENT + 1 }, (_, n) => `a-${String(n)}`)
    const res = await say('t1', { body: '带一堆', attachmentIds: ids })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'too-many-attachments' })
    // 关键在这儿：话没留下、卡也没被搬走，重试一次不会多出一条重复留言。
    expect(store.listComments(asTaskId('t1'))).toHaveLength(0)
    expect(store.getTask(asTaskId('t1'))?.column).toBe('review')
  })

  it('只认自己这张卡的草稿：别处的 id 塞进来不生效', async () => {
    store.createTask(task({ id: 't1', column: 'review' }))
    store.createTask(task({ id: 't2', column: 'review' }))
    const other = await (await put('t2', 'a.txt', 'x')).json() as { attachment: { id: string } }

    await say('t1', { body: '试图搬走别人的文件', attachmentIds: [other.attachment.id] })
    // 它还在 t2 的草稿里，没被 t1 那条留言领走。
    expect(store.getAttachment(other.attachment.id)?.commentId).toBe('')
  })

  it('一条留言带的文件数有上限，挡的是"把整个文件夹拖进来"', async () => {
    store.createTask(task({ id: 't1', column: 'review' }))
    for (let n = 0; n < MAX_ATTACHMENTS_PER_COMMENT; n += 1) {
      expect((await put('t1', `f${String(n)}.txt`, 'x')).status).toBe(201)
    }
    const res = await put('t1', 'one-more.txt', 'x')
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'too-many-attachments' })
    // 这道闸不占规格附件的名额：讨论是一轮轮长出来的，让它去分一份固定额度，
    // 结果就是聊到第五轮突然传不了图了。
    expect((await api('/api/tasks/t1/attachments', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-filename': 'spec.txt' },
      body: 'x',
    })).status).toBe(201)
  })
})

describe('附件', () => {
  /** 传一个文件：裸的请求体 + x-filename 头，与前端走的是同一条路。 */
  const put = (id: string, filename: string, body: string, type = 'text/plain') =>
    api(`/api/tasks/${id}/attachments`, {
      method: 'POST',
      headers: { 'content-type': type, 'x-filename': encodeURIComponent(filename) },
      body,
    })

  it('传上去、读回来，磁盘上确有其文件', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    const res = await put('t1', '设计稿.png', 'PNGDATA', 'image/png')
    expect(res.status).toBe(201)
    const { attachment } = await res.json() as { attachment: { id: string; mime: string; size: number } }
    expect(attachment.mime).toBe('image/png')
    expect(attachment.size).toBe(7)

    const listed = await (await api('/api/tasks/t1/attachments')).json() as
      { attachments: { filename: string }[] }
    expect(listed.attachments.map((a) => a.filename)).toEqual(['设计稿.png'])

    const record = store.getAttachment(attachment.id)
    if (record === null) throw new Error('setup')
    expect(await readFile(record.path, 'utf8')).toBe('PNGDATA')
  })

  it('不把磁盘路径漏给前端 —— 那是服务端的内部事实', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    const body = await (await put('t1', 'a.txt', 'x')).json() as { attachment: Record<string, unknown> }
    expect(body.attachment['path']).toBeUndefined()
  })

  it('取内容时带上类型与 nosniff；图片内联，别的一律下载', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    const png = await (await put('t1', '图.png', 'IMG', 'image/png')).json() as { attachment: { id: string } }
    const doc = await (await put('t1', '页面.html', '<script>', 'text/html')).json() as
      { attachment: { id: string } }

    const first = await api(`/api/attachments/${png.attachment.id}`)
    expect(first.headers.get('content-type')).toBe('image/png')
    expect(first.headers.get('x-content-type-options')).toBe('nosniff')
    expect(first.headers.get('content-disposition')).toContain('inline')
    expect(await first.text()).toBe('IMG')

    // 上传的是 HTML，但扩展名不在允许清单里 —— 只能当二进制下载，
    // 绝不能让它在本地源上跑起来（cookie 就在那儿）。
    const second = await api(`/api/attachments/${doc.attachment.id}`)
    expect(second.headers.get('content-type')).toBe('application/octet-stream')
    expect(second.headers.get('content-disposition')).toContain('attachment')
  })

  it('文件名里的目录穿越落盘前就被压掉', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    const body = await (await put('t1', '../../evil.sh', 'rm -rf')).json() as
      { attachment: { id: string } }
    const record = store.getAttachment(body.attachment.id)
    if (record === null) throw new Error('setup')
    expect(record.path.startsWith(attachmentsRoot)).toBe(true)
    expect(record.path).not.toContain('..')
  })

  it('正在执行的卡不能加附件 —— 附件就是需求的一部分', async () => {
    store.createTask(task({ id: 't1', column: 'running' }))
    const res = await put('t1', 'a.txt', 'x')
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'task-running' })
    expect(store.listAttachments(asTaskId('t1'))).toHaveLength(0)
  })

  it('归档的卡同理，冻结就是冻结', async () => {
    store.createTask(task({ id: 't1', column: 'backlog', archivedAt: T0 }))
    expect((await put('t1', 'a.txt', 'x')).status).toBe(422)
  })

  it('缺文件名 400、空文件 400', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    const noName = await api('/api/tasks/t1/attachments', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x',
    })
    expect(noName.status).toBe(400)
    expect((await put('t1', 'a.txt', '')).status).toBe(400)
  })

  it('删掉之后记录与磁盘上的字节一起没', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    const body = await (await put('t1', 'a.txt', 'x')).json() as { attachment: { id: string } }
    const record = store.getAttachment(body.attachment.id)
    if (record === null) throw new Error('setup')

    expect((await api(`/api/attachments/${body.attachment.id}`, { method: 'DELETE' })).status).toBe(200)
    expect(store.getAttachment(body.attachment.id)).toBeNull()
    await expect(readFile(record.path, 'utf8')).rejects.toThrow()
  })

  /*
   * 读不出来的附件曾经能把整个进程带走：老代码先 stat 再 createReadStream，
   * 两步之间的失败会变成一个没人接的 'error' 事件 —— pipe 不转发源端错误，
   * 路由外面的 try/catch 也接不到，于是 uncaughtException 直接杀掉 host。
   * 这条用例真的会跑挂整个测试进程，所以它比断言本身更值钱。
   */
  it('打不开的附件回 410，而不是把整个 host 带走（回归）', async () => {
    // root 无视文件权限位，这条用例在 root 下测不出东西。
    if (process.getuid?.() === 0) return
    store.createTask(task({ id: 't1', column: 'backlog' }))
    const body = await (await put('t1', 'a.txt', 'x')).json() as { attachment: { id: string } }
    const record = store.getAttachment(body.attachment.id)
    if (record === null) throw new Error('setup')
    await chmod(record.path, 0o000)

    try {
      const res = await api(`/api/attachments/${body.attachment.id}`)
      expect(res.status).toBe(410)
      // 进程还活着，下一个请求照常服务 —— 这才是这条用例真正在测的东西。
      expect((await api('/api/state')).status).toBe(200)
    } finally {
      await chmod(record.path, 0o600)
    }
  })

  it('归档的卡不能删附件 —— 和不能加附件是同一条规矩（回归）', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    const body = await (await put('t1', 'a.txt', 'x')).json() as { attachment: { id: string } }
    // 传完再归档：归档的卡本来就传不上去。
    const fresh = store.getTask(asTaskId('t1'))
    if (fresh === null) throw new Error('setup')
    store.commitTask({ ...fresh, archivedAt: T0, revision: fresh.revision + 1 })

    const res = await api(`/api/attachments/${body.attachment.id}`, { method: 'DELETE' })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'task-archived' })
    expect(store.getAttachment(body.attachment.id)).not.toBeNull()
  })

  it('文件被外力删掉时说清楚是哪一种缺失，而不是回一个空响应', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    const body = await (await put('t1', 'a.txt', 'x')).json() as { attachment: { id: string } }
    const record = store.getAttachment(body.attachment.id)
    if (record === null) throw new Error('setup')
    await rm(record.path)
    const res = await api(`/api/attachments/${body.attachment.id}`)
    expect(res.status).toBe(410)
    expect(await res.json()).toMatchObject({ error: 'attachment-gone' })
  })

  it('看板状态捎上每张卡的附件数，卡片上那枚回形针靠它', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    store.createTask(task({ id: 't2', column: 'backlog' }))
    await put('t1', 'a.txt', 'x')
    const state = await (await api('/api/state')).json() as { attachments: Record<string, number> }
    expect(state.attachments).toEqual({ t1: 1 })
  })

  it('删卡时磁盘上的字节跟着走', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    const body = await (await put('t1', 'a.txt', 'x')).json() as { attachment: { id: string } }
    const record = store.getAttachment(body.attachment.id)
    if (record === null) throw new Error('setup')

    const removed = await api('/api/tasks/t1?expectedRevision=1', { method: 'DELETE' })
    expect(removed.status).toBe(200)
    await expect(readFile(record.path, 'utf8')).rejects.toThrow()
  })

  it('卡不存在 404，附件不存在也是 404', async () => {
    expect((await put('nope', 'a.txt', 'x')).status).toBe(404)
    expect((await api('/api/attachments/a-nope')).status).toBe(404)
  })

  it('没配附件存储时明确 503，而不是让上传看起来成功了', async () => {
    const bare = await startServer({ storage: store, token: TOKEN })
    try {
      store.createTask(task({ id: 't1', column: 'backlog' }))
      const res = await fetch(`http://127.0.0.1:${String(bare.port)}/api/tasks/t1/attachments`, {
        method: 'POST',
        headers: { cookie: `loopkanban_token=${TOKEN}`, 'x-filename': 'a.txt', 'content-type': 'text/plain' },
        body: 'x',
      })
      expect(res.status).toBe(503)
      expect(store.listAttachments(asTaskId('t1'))).toHaveLength(0)
    } finally {
      await bare.close()
    }
  })
})

describe('GET /api/tasks/:id/file', () => {
  let sandbox: string
  let repo: string
  let worktree: string

  const ask = (id: string, path: string) =>
    api(`/api/tasks/${id}/file?path=${encodeURIComponent(path)}`)

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'loopkanban-file-'))
    repo = join(sandbox, 'repo')
    worktree = join(repo, '.loopkanban', 'worktrees', 't-1')
    await mkdir(join(worktree, 'docs'), { recursive: true })

    store.createTask(task({ id: 't1', column: 'review', repoPath: repo }))
    store.createRun({
      id: asRunId('run-1'), taskId: asTaskId('t1'), provider: 'claude', cliVersion: '2.1.247',
      worktreePath: worktree, branch: 'task/t1', status: 'completed', startedAt: T0,
    })
  })

  afterEach(async () => { await rm(sandbox, { recursive: true, force: true }) })

  it('把 Agent 写在自己 worktree 里的文档读回来 —— 那条链接浏览器打不开', async () => {
    await writeFile(join(worktree, 'docs', '方案.md'), '# 方案\n\n照着这个做。\n')

    const res = await ask('t1', join(worktree, 'docs', '方案.md'))
    expect(res.status).toBe(200)
    const body = await res.json() as { file: { name: string; relative: string; content: string } }
    expect(body.file.name).toBe('方案.md')
    expect(body.file.relative).toBe('docs/方案.md')
    expect(body.file.content).toContain('照着这个做')
  })

  it('项目仓库里的文件也够得着 —— 合并之后文档就在那儿', async () => {
    await mkdir(join(repo, 'docs'), { recursive: true })
    await writeFile(join(repo, 'docs', 'prd.md'), 'PRD')

    const res = await ask('t1', 'docs/prd.md')
    expect(res.status).toBe(200)
    expect((await res.json() as { file: { content: string } }).file.content).toBe('PRD')
  })

  it('工作区之外的路径 422 —— 这不是「文件不在」，是这个请求本身不成立', async () => {
    await writeFile(join(sandbox, 'secret.txt'), 'nope')
    const res = await ask('t1', join(sandbox, 'secret.txt'))
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'path-outside-workspace' })
  })

  it('看不了的二进制 415，不给一屏乱码', async () => {
    await writeFile(join(worktree, 'a.out'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00]))
    const res = await ask('t1', 'a.out')
    expect(res.status).toBe(415)
    expect(await res.json()).toMatchObject({ error: 'not-text' })
  })

  it('图片报成 image，字节不进 JSON —— 那是 raw 口子的事', async () => {
    await writeFile(join(worktree, 'shot.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]))
    const res = await ask('t1', 'shot.png')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ file: { kind: 'image', content: '' } })
  })

  it('读不动的文件 403 —— 说清楚是权限，别让它变成一条 500', async () => {
    if (process.getuid?.() === 0) return
    const locked = join(worktree, 'locked.md')
    await writeFile(locked, 'secret')
    await chmod(locked, 0o000)

    const res = await ask('t1', 'locked.md')
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'unreadable' })
  })

  it('不存在的文件 404', async () => {
    const res = await ask('t1', 'docs/nope.md')
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'no-such-file' })
  })

  it('卡不存在就 404，不去读任何文件', async () => {
    expect((await ask('t404', 'docs/x.md')).status).toBe(404)
  })

  it('只够得着自己那张卡的地方 —— 别人的 worktree 不算', async () => {
    const other = join(sandbox, 'other-repo')
    await mkdir(other, { recursive: true })
    await writeFile(join(other, 'plan.md'), '别人的')
    store.createTask(task({ id: 't2', repoPath: other }))

    const res = await ask('t1', join(other, 'plan.md'))
    expect(res.status).toBe(422)
  })
})

describe('GET /api/tasks/:id/file/raw', () => {
  let sandbox: string
  let repo: string
  let worktree: string

  const raw = (id: string, path: string) =>
    api(`/api/tasks/${id}/file/raw?path=${encodeURIComponent(path)}`)

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'loopkanban-raw-'))
    repo = join(sandbox, 'repo')
    worktree = join(repo, '.loopkanban', 'worktrees', 't-1')
    await mkdir(join(worktree, 'docs'), { recursive: true })

    store.createTask(task({ id: 't1', column: 'review', repoPath: repo }))
    store.createRun({
      id: asRunId('run-1'), taskId: asTaskId('t1'), provider: 'claude', cliVersion: '2.1.247',
      worktreePath: worktree, branch: 'task/t1', status: 'completed', startedAt: T0,
    })
  })

  afterEach(async () => { await rm(sandbox, { recursive: true, force: true }) })

  it('PDF 与图片的字节直接流出去，类型和 nosniff 都带上', async () => {
    await writeFile(join(worktree, 'docs', '规格.pdf'), Buffer.from('%PDF-1.4'))
    const res = await raw('t1', join(worktree, 'docs', '规格.pdf'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-disposition')).toContain('inline')
    expect(await res.text()).toBe('%PDF-1.4')
  })

  /*
   * 这一条是这个口子存在的全部前提。
   *
   * 这些字节和看板同源：一个能内联渲染的 `.html` 就能拿着 cookie 调本机的
   * 执行接口 —— 「看一眼文件」会变成「在你机器上跑任意命令」。所以类型是
   * 一份允许清单，不在里面的一律拒绝，哪怕它就在围栏里躺着。
   */
  it('只有图片和 PDF 能内联。HTML 与 SVG 一律拒，它们能跑脚本', async () => {
    for (const name of ['evil.html', 'icon.svg', 'notes.md']) {
      await writeFile(join(worktree, name), '<script>fetch("/api/state")</script>')
      const res = await raw('t1', name)
      expect(res.status).toBe(415)
      expect(await res.json()).toMatchObject({ error: 'not-inlineable' })
    }
  })

  it('围栏跟预览接口一样严 —— 工作区之外 422', async () => {
    await writeFile(join(sandbox, 'secret.png'), Buffer.from([0x89, 0x50]))
    const res = await raw('t1', join(sandbox, 'secret.png'))
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'path-outside-workspace' })
  })

  it('不存在的文件 404', async () => {
    expect((await raw('t1', 'docs/没有.pdf')).status).toBe(404)
  })
})

describe('DELETE /api/tasks/:id', () => {
  const del = (id: string, body?: unknown, query = '') =>
    api(`/api/tasks/${id}${query}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

  it('删掉想法池里的卡，连它的执行历史一起', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    store.createRun({
      id: asRunId('run-1'), taskId: asTaskId('t1'), provider: 'claude', cliVersion: '2.1.247',
      worktreePath: '/wt', branch: 'task/t1', status: 'failed', exitCode: 1, startedAt: T0,
    })
    store.appendEvent(asRunId('run-1'), 'text', { text: 'hi' }, T0)

    const res = await del('t1', { expectedRevision: 1 })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ deleted: true, unblocked: [] })
    expect(store.getTask(asTaskId('t1'))).toBeNull()
    expect(store.getRun(asRunId('run-1'))).toBeNull()
  })

  it('队列里的卡也能删', async () => {
    store.createTask(task({ id: 't1', column: 'ready' }))
    expect((await del('t1', { expectedRevision: 1 })).status).toBe(200)
  })

  it('别的卡对它的关联一并摘掉 —— 悬空的关联会变成一段没法照做的需求', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    store.createTask(task({ id: 't2', column: 'ready', relatedTo: [asTaskId('t1')] }))
    store.createTask(task({ id: 't3', column: 'ready', blockedBy: [asTaskId('t1')] }))

    expect((await del('t1', { expectedRevision: 1 })).status).toBe(200)
    expect(store.getTask(asTaskId('t2'))?.relatedTo).toEqual([])
    expect(store.getTask(asTaskId('t3'))?.blockedBy).toEqual([])
  })

  it('Agent 动过仓库的卡返回 422，库里原样不动', async () => {
    store.createTask(task({ id: 't1', column: 'review' }))
    const res = await del('t1', { expectedRevision: 1 })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'not-deletable' })
    expect(store.getTask(asTaskId('t1'))).not.toBeNull()
  })

  it('下游对它的依赖被一并摘掉 —— 否则那张卡会永远停在"依赖未完成"', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    store.createTask(task({ id: 't2', blockedBy: [asTaskId('t1')] }))

    const res = await del('t1', { expectedRevision: 1 })
    expect(await res.json()).toMatchObject({ unblocked: ['t2'] })
    const downstream = store.getTask(asTaskId('t2'))
    expect(downstream?.blockedBy).toEqual([])
    // 摘依赖也是一次变更，revision 必须跟着走，否则别人的 CAS 会打在陈旧的值上。
    expect(downstream?.revision).toBe(2)
  })

  it('查询串里的 expectedRevision 与请求体等价', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    expect((await del('t1', undefined, '?expectedRevision=1')).status).toBe(200)
  })

  it('revision 过期返回 409，缺参数 400，卡不存在 404', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    expect((await del('t1', { expectedRevision: 99 })).status).toBe(409)
    expect((await del('t1', {})).status).toBe(400)
    expect((await del('ghost', { expectedRevision: 1 })).status).toBe(404)
  })
})

describe('GET /api/runs/:id/log', () => {
  const RUN = asRunId('run-log')

  beforeEach(() => {
    store.createTask(task({ id: 't1' }))
    store.createRun({
      id: RUN, taskId: asTaskId('t1'), provider: 'claude', cliVersion: '2.1.247',
      worktreePath: '/wt', branch: 'task/t1', status: 'running', startedAt: T0,
    })
  })

  it('一次性读出事件，并给出下次接着问的游标', async () => {
    store.appendEvent(RUN, 'text', { text: '第一句' }, T0)
    store.appendEvent(RUN, 'text', { text: '第二句' }, T0 + 1)

    const res = await api(`/api/runs/${RUN}/log`)
    expect(res.status).toBe(200)
    const body = await res.json() as { events: { seq: number }[]; lastSeq: number; truncated: boolean }
    expect(body.events).toHaveLength(2)
    expect(body.lastSeq).toBe(2)
    expect(body.truncated).toBe(false)

    // 拿着游标再问，只会拿到新增的那条 —— 轮询的调用方不必每次重读全部历史。
    store.appendEvent(RUN, 'text', { text: '第三句' }, T0 + 2)
    const next = await api(`/api/runs/${RUN}/log?after=${String(body.lastSeq)}`)
    const tail = await next.json() as { events: { seq: number }[] }
    expect(tail.events.map((event) => event.seq)).toEqual([3])
  })

  it('事件太多时只回最近的一段，并明说截断了', async () => {
    for (let index = 0; index < 260; index += 1) {
      store.appendEvent(RUN, 'text', { text: String(index) }, T0 + index)
    }
    const body = await (await api(`/api/runs/${RUN}/log`)).json() as
      { events: { seq: number }[]; truncated: boolean; lastSeq: number }
    expect(body.truncated).toBe(true)
    // 留的是最新的那一段：Agent 要的是"现在到哪儿了"。
    expect(body.events).toHaveLength(200)
    expect(body.events[0]?.seq).toBe(61)
    expect(body.lastSeq).toBe(260)
  })

  it('游标不是数字时退回从头读，但 lastSeq 仍然是个数 —— null 会让调用方重头再来', async () => {
    const empty = await (await api(`/api/runs/${RUN}/log?after=abc`)).json() as { lastSeq: number }
    expect(empty.lastSeq).toBe(0)

    store.appendEvent(RUN, 'text', { text: 'hi' }, T0)
    const one = await (await api(`/api/runs/${RUN}/log?after=abc`)).json() as
      { events: unknown[]; lastSeq: number }
    expect(one.events).toHaveLength(1)
    expect(one.lastSeq).toBe(1)
  })

  it('没有这次执行就是 404，而不是一个空日志', async () => {
    expect((await api('/api/runs/run-nope/log')).status).toBe(404)
  })
})

describe('SSE 事件流', () => {
  const RUN = asRunId('run-1')

  beforeEach(() => {
    store.createTask(task({ id: 't1' }))
    store.createRun({
      id: RUN, taskId: asTaskId('t1'), provider: 'claude', cliVersion: '2.1.247',
      worktreePath: '/wt', branch: 'task/t1', status: 'running', startedAt: T0,
    })
  })

  /** 读到累计出现 count 条 `id:` 为止。 */
  async function readEvents(res: Response, count: number): Promise<string> {
    const reader = res.body?.getReader()
    if (reader === undefined) throw new Error('no body')
    const decoder = new TextDecoder()
    let text = ''
    while ((text.match(/^id: /gm) ?? []).length < count) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    await reader.cancel()
    return text
  }

  it('连上先补历史事件', async () => {
    store.appendEvent(RUN, 'session', { sessionId: 's1' }, T0)
    store.appendEvent(RUN, 'text', { text: '干活中' }, T0 + 1)

    const text = await readEvents(await api('/api/runs/run-1/events'), 2)
    expect(text).toContain('id: 1')
    expect(text).toContain('event: session')
    expect(text).toContain('干活中')
  })

  it('补完历史后接实时推送', async () => {
    store.appendEvent(RUN, 'text', { text: '历史' }, T0)
    const res = await api('/api/runs/run-1/events')

    // 先确保历史那条已经收到，再发实时的，避免竞态。
    const reader = res.body?.getReader()
    if (reader === undefined) throw new Error('no body')
    const decoder = new TextDecoder()
    let text = ''
    while (!text.includes('历史')) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }

    const seq = store.appendEvent(RUN, 'tool', { name: 'Bash' }, T0 + 5)
    server.bus.publish({ runId: RUN, seq, kind: 'tool', payload: { name: 'Bash' }, at: T0 + 5 })

    while (!text.includes('Bash')) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    await reader.cancel()
    expect(text).toContain('event: tool')
  })

  it('Last-Event-ID 只补缺口，不重传全部历史', async () => {
    for (let i = 1; i <= 5; i += 1) store.appendEvent(RUN, 'text', { i }, T0 + i)

    const res = await fetch(`http://127.0.0.1:${String(server.port)}/api/runs/run-1/events`, {
      headers: { cookie: `loopkanban_token=${TOKEN}`, 'last-event-id': '3' },
    })
    const text = await readEvents(res, 2)
    expect(text).toContain('id: 4')
    expect(text).toContain('id: 5')
    expect(text).not.toContain('id: 1')
  })

  it('断开后订阅被清理，不泄漏监听器', async () => {
    const res = await api('/api/runs/run-1/events')
    const reader = res.body?.getReader()
    await reader?.read()
    expect(server.bus.size).toBeGreaterThan(0)
    await reader?.cancel()
    // 等几个心跳周期，服务端靠写入失败察觉对端已走。
    const deadline = Date.now() + 3_000
    while (server.bus.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(server.bus.size).toBe(0)
  })
})

describe('静态资源托管', () => {
  let staticServer: RunningServer
  let root: string
  let outside: string

  beforeEach(async () => {
    // 自建固件：测试不能依赖机器上恰好存在的文件。
    const sandbox = await mkdtemp(join(tmpdir(), 'loopkanban-static-'))
    root = join(sandbox, 'dist')
    outside = join(sandbox, 'secret.txt')
    await mkdir(join(root, 'assets'), { recursive: true })
    await writeFile(join(root, 'index.html'), '<!doctype html><title>app</title>', 'utf8')
    await writeFile(join(root, 'assets', 'app.css'), 'body{}', 'utf8')
    // 放在 root 的兄弟目录，正是穿越攻击想读到的位置。
    await writeFile(outside, 'SECRET', 'utf8')

    staticServer = await startServer({
      storage: store, token: TOKEN, sseHeartbeatMs: 50, staticDir: root,
    })
  })

  afterEach(async () => {
    await staticServer.close()
    await rm(join(root, '..'), { recursive: true, force: true })
  })

  const get = (path: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${String(staticServer.port)}${path}`, {
      headers: { cookie: `loopkanban_token=${TOKEN}` },
    })

  it('根路径返回 index.html', async () => {
    const res = await get('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('<title>app</title>')
  })

  it('带内容哈希的资源长缓存，index.html 绝不缓存', async () => {
    expect((await get('/assets/app.css')).headers.get('cache-control')).toContain('immutable')
    expect((await get('/')).headers.get('cache-control')).toBe('no-store')
  })

  it('目录穿越被挡住 —— 不能借静态路由读到 root 之外的文件', async () => {
    // 必须走原始 socket：fetch 会在发送前把 `..` 规范化掉，
    // 用它测出来的"通过"只证明了客户端做了事，服务端可能毫无防护。
    const raw = (path: string): Promise<string> => new Promise((resolve) => {
      const socket = connect(staticServer.port, '127.0.0.1', () => {
        socket.write(
          `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${String(staticServer.port)}\r\n`
          + `Cookie: loopkanban_token=${TOKEN}\r\nConnection: close\r\n\r\n`,
        )
      })
      let buffer = ''
      socket.on('data', (chunk) => { buffer += String(chunk) })
      socket.on('end', () => { resolve(buffer) })
    })

    for (const attack of [
      '/../secret.txt',
      '/assets/../../secret.txt',
      '/./../secret.txt',
      '/..%2fsecret.txt',
      `/..${outside}`,
    ]) {
      expect(await raw(attack), `${attack} 泄漏了 root 之外的文件`).not.toContain('SECRET')
    }
  })

  it('找不到的路径回落到 index.html，交给前端路由', async () => {
    const res = await get('/board/some-id')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<title>app</title>')
  })

  it('静态托管不会吃掉 /api 路径', async () => {
    expect((await get('/api/nope')).status).toBe(404)
    expect((await get('/api/state')).status).toBe(200)
  })
})

describe('错误处理（回归）', () => {
  it('请求体不是合法 JSON 时返回 400 而不是 500', async () => {
    const res = await api('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"description": ',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'bad-request' })
  })

  it('内部异常不把原始信息回给调用方', async () => {
    // 让 listProjects 抛一个带敏感路径的异常。
    const real = store.listProjects.bind(store)
    store.listProjects = (() => { throw new Error('ENOENT /Users/someone/.ssh/id_rsa') }) as typeof store.listProjects
    const res = await api('/api/state')
    store.listProjects = real

    expect(res.status).toBe(500)
    const body = await res.text()
    expect(body).not.toContain('id_rsa')
    expect(body).toContain('internal-error')
  })
})

describe('开发模式：把前端转发给 vite', () => {
  let upstream: ReturnType<typeof createHttpServer>
  let upstreamPort: number
  let dev: RunningServer
  /** upstream 收到的请求，用来断言转发的忠实程度。 */
  let seen: { url: string; host: string | undefined }[]

  beforeEach(async () => {
    seen = []
    upstream = createHttpServer((req, res) => {
      seen.push({ url: req.url ?? '', host: req.headers.host })
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html>vite:${req.url ?? ''}`)
    })
    // 假装自己是 vite 的 HMR ws server：认下升级，回一句能被断言的内容。
    upstream.on('upgrade', (req, socket) => {
      seen.push({ url: req.url ?? '', host: req.headers.host })
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'
        + `Connection: Upgrade\r\nx-echo-url: ${req.url ?? ''}\r\n\r\n`,
      )
      socket.end()
    })
    await new Promise<void>((resolve) => { upstream.listen(0, '127.0.0.1', resolve) })
    upstreamPort = (upstream.address() as AddressInfo).port

    dev = await startServer({
      storage: store, token: TOKEN, sseHeartbeatMs: 50,
      devServer: `http://127.0.0.1:${String(upstreamPort)}`,
    })
  })

  afterEach(async () => {
    await dev.close()
    await new Promise<void>((resolve) => { upstream.close(() => { resolve() }) })
  })

  const get = (path: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${String(dev.port)}${path}`, {
      headers: { cookie: `loopkanban_token=${TOKEN}` },
    })

  it('非 /api 的请求原样转给 vite', async () => {
    const res = await get('/src/main.tsx')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('vite:/src/main.tsx')
    expect(seen[0]?.host).toBe(`127.0.0.1:${String(upstreamPort)}`)
  })

  it('/api 仍由 host 自己处理，不会被转走', async () => {
    const res = await get('/api/state')
    expect(res.status).toBe(200)
    expect(await res.json()).toHaveProperty('projects')
    expect(seen).toHaveLength(0)
  })

  it('vite 挂了时说清楚是哪一环，而不是给一个白页', async () => {
    await new Promise<void>((resolve) => { upstream.close(() => { resolve() }) })
    const res = await get('/')
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: 'dev-server-unreachable' })
  })

  /**
   * 发一个 WebSocket 升级请求，返回 upstream 回声出来的路径。
   * @param cookie - 是否带上 token cookie。
   */
  function upgrade(cookie: boolean): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1', port: dev.port,
        // vite 的 HMR 会往 ws URL 上挂它自己的同名 token，这里一并复现。
        path: '/?token=vite-hmr-handshake',
        headers: {
          ...(cookie ? { cookie: `loopkanban_token=${TOKEN}` } : {}),
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        },
      })
      req.on('upgrade', (res, socket) => {
        socket.destroy()
        resolve(res.headers['x-echo-url'] as string | undefined)
      })
      // 被 guard 挡下时 host 直接 destroy socket，这里体现为连接被掐断。
      req.on('error', () => { resolve(undefined) })
      req.on('response', (res) => { res.resume(); reject(new Error(`没有升级，返回 ${String(res.statusCode)}`)) })
      req.end()
    })
  }

  it('WebSocket 升级也照转 —— 少了它 HMR 连不上，改代码不刷新', async () => {
    // 连 vite 自己的那个 ?token= 都要原样带过去，否则它会拒绝握手。
    expect(await upgrade(true)).toBe('/?token=vite-hmr-handshake')
  })

  it('升级请求同样要过 token 关，没 cookie 一律掐断', async () => {
    expect(await upgrade(false)).toBeUndefined()
  })
})

describe('静态资源路径（回归）', () => {
  it('嵌套资源按原路径返回，而不是回落到 index.html', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'loopkanban-nested-'))
    const root = join(sandbox, 'dist')
    await mkdir(join(root, 'assets', 'deep'), { recursive: true })
    await writeFile(join(root, 'index.html'), '<!doctype html><title>app</title>', 'utf8')
    await writeFile(join(root, 'assets', 'deep', 'app.js'), 'export const x = 1', 'utf8')

    const nested = await startServer({ storage: store, token: TOKEN, sseHeartbeatMs: 50, staticDir: root })
    try {
      const res = await fetch(`http://127.0.0.1:${String(nested.port)}/assets/deep/app.js`, {
        headers: { cookie: `loopkanban_token=${TOKEN}` },
      })
      // 越界判断若写死分隔符（Windows 上是反斜杠），这里会拿到 index.html。
      expect(res.headers.get('content-type')).toContain('javascript')
      expect(await res.text()).toContain('export const x')
    } finally {
      await nested.close()
      await rm(sandbox, { recursive: true, force: true })
    }
  })
})


describe('一键测试环境', () => {
  let sandbox: string
  let envs: TestEnvs
  let host: RunningServer

  /** 带 cookie 打这台临时 server。 */
  const call = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`http://127.0.0.1:${String(host.port)}${path}`, {
      ...init,
      headers: { cookie: `loopkanban_token=${TOKEN}`, ...init.headers },
    })

  async function boot(testCommand?: string): Promise<void> {
    store.createTask(task({ id: 'te-1', column: 'review' }))
    store.createRun({
      id: asRunId('te-run'), taskId: asTaskId('te-1'), provider: 'claude', cliVersion: '1',
      worktreePath: sandbox, branch: 'task/te-1', status: 'completed', startedAt: T0, endedAt: T0,
    })
    if (testCommand !== undefined) store.updateProject(PROJECT, { testCommand })
    envs = new TestEnvs({ storage: store })
    host = await startServer({ storage: store, token: TOKEN, sseHeartbeatMs: 50, testEnvs: envs })
  }

  beforeEach(async () => { sandbox = await mkdtemp(join(tmpdir(), 'loopkanban-http-env-')) })

  afterEach(async () => {
    await host.close()
    await rm(sandbox, { recursive: true, force: true })
  })

  it('没配启动命令时明确拒绝，并说清楚缺的是什么', async () => {
    await boot()
    const res = await call('/api/tasks/te-1/testenv', { method: 'POST' })
    expect(res.status).toBe(422)
    expect((await res.json() as { error: string }).error).toBe('no-test-command')
  })

  it('起 → 查 → 停，停完端口就还回去了', async () => {
    await boot('sleep 30')
    const started = await call('/api/tasks/te-1/testenv', { method: 'POST' })
    expect(started.status).toBe(201)
    const { env } = await started.json() as { env: { port: number; cwd: string } }
    expect(env.cwd).toBe(sandbox)

    const looked = await (await call('/api/tasks/te-1/testenv')).json() as { env: { status: string } | null }
    expect(looked.env?.status).not.toBe('exited')

    const stopped = await call('/api/tasks/te-1/testenv', { method: 'DELETE' })
    expect(stopped.status).toBe(200)
    expect(envs.view(asTaskId('te-1'))?.status).toBe('exited')
  })

  it('没起过环境不是错 —— 界面据此显示"未启动"', async () => {
    await boot('sleep 30')
    const res = await call('/api/tasks/te-1/testenv')
    expect(res.status).toBe(200)
    expect((await res.json() as { env: unknown }).env).toBeNull()
  })

  it('停一个本来就没有的环境不是错 —— 回 200，不回一个没有 error 字段的 404', async () => {
    await boot('sleep 30')
    const res = await call('/api/tasks/te-1/testenv', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ stopped: false, env: null })
  })

  it('把卡拖出 Review 就等于判完了，环境跟着收掉', async () => {
    await boot('sleep 30')
    await call('/api/tasks/te-1/testenv', { method: 'POST' })
    expect(envs.view(asTaskId('te-1'))?.status).not.toBe('exited')

    const moved = await call('/api/tasks/te-1/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, to: 'done' }),
    })
    expect(moved.status).toBe(200)
    expect(envs.view(asTaskId('te-1'))?.stoppedBy).toBe('verdict')
  })

  it('server 关掉时把环境一起收掉 —— 不然那个进程就没人认识了', async () => {
    await boot('sleep 30')
    await call('/api/tasks/te-1/testenv', { method: 'POST' })
    await host.close()
    expect(envs.view(asTaskId('te-1'))?.stoppedBy).toBe('shutdown')
    // afterEach 会再关一次；close 幂等，这里先把它变成一次无害的重复调用。
    host = await startServer({ storage: store, token: TOKEN, sseHeartbeatMs: 50 })
  })
})

describe('测试环境未启用时', () => {
  it('那几条接口一律 503，界面据此把按钮收起来', async () => {
    const res = await api('/api/tasks/whatever/testenv', { method: 'POST' })
    expect(res.status).toBe(503)
    expect((await res.json() as { error: string }).error).toBe('no-testenv')
  })
})
describe('Pull Request 接口', () => {
  /** 起一个带验收器、但本机"没装 gh"的 server —— 能力探测那条路要走得通。 */
  const withReview = () => startServer({
    storage: store, token: TOKEN,
    review: new Review({ storage: store, github: new GitHub({ bin: null }) }),
  })

  const at = (server: RunningServer, path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${String(server.port)}${path}`, {
      ...init,
      headers: { cookie: `loopkanban_token=${TOKEN}`, ...init.headers },
    })

  it('没配验收器时明确 503 —— 界面据此知道这台实例根本开不了 PR', async () => {
    store.createTask(task({ id: 't1', column: 'review' }))
    expect((await api('/api/tasks/t1/prs')).status).toBe(503)
  })

  it('列 PR 时一并回"这个仓库能不能开 PR"，开不了要说清楚卡在哪儿', async () => {
    const server2 = await withReview()
    try {
      store.createTask(task({ id: 't1', column: 'review' }))
      const res = await at(server2, '/api/tasks/t1/prs')
      expect(res.status).toBe(200)

      const body = await res.json() as { prs: unknown[]; capability: Record<string, unknown> }
      expect(body.prs).toEqual([])
      expect(body.capability).toMatchObject({ gh: false, ready: false, reason: 'gh-missing' })
      // 原因要能直接读给人看，不能只有一个 code。
      expect(String(body.capability['detail'])).toContain('gh')
    } finally {
      await server2.close()
    }
  })

  it('开 PR 被拒时是 422（这个请求本身不成立），不是 500', async () => {
    const server2 = await withReview()
    try {
      store.createTask(task({ id: 't1', column: 'review' }))
      store.createRun({
        id: asRunId('run-1'), taskId: asTaskId('t1'), provider: 'codex', cliVersion: '0.1',
        worktreePath: '/nope', branch: 'task/t1', status: 'completed', startedAt: T0,
      })
      const res = await at(server2, '/api/tasks/t1/prs', { method: 'POST' })
      expect(res.status).toBe(422)
      expect(await res.json()).toMatchObject({ error: 'no-worktree' })
      expect(store.getTask(asTaskId('t1'))?.column).toBe('review')
    } finally {
      await server2.close()
    }
  })

  it('看板状态里捎上每张卡的 PR —— 卡面上那枚标记靠它，不必一张卡问一次', async () => {
    store.createTask(task({ id: 't1', column: 'done' }))
    store.upsertPullRequest({
      id: 'pr-1', taskId: asTaskId('t1'), number: 7, url: 'https://github.com/acme/demo/pull/7',
      branch: 'task/t1', baseBranch: 'main', state: 'merged', mergeable: 'unknown',
      mergedAt: T0 + 10, createdAt: T0, updatedAt: T0 + 10,
    })

    const body = await (await api('/api/state')).json() as { prs: Record<string, unknown[]> }
    expect(body.prs['t1']).toMatchObject([{ number: 7, state: 'merged' }])
  })
})

describe('开 PR 撞上冲突', () => {
  let sandbox: string
  let repo: string

  /** gh 的替身：远端认成 GitHub，PR 一条都还没有。 */
  const github = () => new GitHub({
    bin: '/usr/local/bin/gh',
    capture: (argv) => Promise.resolve(
      argv.includes('get-url')
        ? { stdout: 'git@github.com:acme/demo.git\n', stderr: '', code: 0 }
        : { stdout: '', stderr: 'no pull requests found', code: 1 },
    ),
  })

  const git = (cwd: string, ...args: string[]) => capture(['git', '-C', cwd, ...args])

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'loopkanban-pr-conflict-'))
    repo = join(sandbox, 'repo')
    await capture(['git', 'init', '-q', '-b', 'main', repo])
    for (const args of [['config', 'user.email', 't@t'], ['config', 'user.name', 'T']]) await git(repo, ...args)
    await writeFile(join(repo, 'README.md'), '# demo\n', 'utf8')
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-qm', 'init')
    // 得有个真远端 —— 能力探测问的是 git，只有"这是不是 GitHub"才是假的。
    const bare = join(sandbox, 'origin.git')
    await capture(['git', 'init', '-q', '--bare', bare])
    await git(repo, 'remote', 'add', 'origin', bare)
    await git(repo, 'push', '-q', 'origin', 'main')
  })

  afterEach(async () => { await rm(sandbox, { recursive: true, force: true }) })

  it('422 里带上冲突文件与"卡已经回队列"，界面据此知道下一步在哪儿', async () => {
    const server2 = await startServer({
      storage: store, token: TOKEN,
      review: new Review({ storage: store, github: github() }),
    })
    try {
      store.createTask(task({ id: 't1', column: 'review', repoPath: repo }))
      const wt = await ensureWorktree(repo, 't1', 'task/t1', 'main')
      await writeFile(join(wt.path, 'README.md'), '# 我改的\n', 'utf8')
      store.createRun({
        id: asRunId('run-1'), taskId: asTaskId('t1'), provider: 'codex', cliVersion: '0.1',
        worktreePath: wt.path, branch: wt.branch, status: 'completed', startedAt: T0,
      })
      // 基线那边动了同一处，而且**已经推上去了** —— 这正是冲突的来处：
      // 卡是从旧的基线派生的，主干在这期间往前走了。
      await writeFile(join(repo, 'README.md'), '# 他改的\n', 'utf8')
      await git(repo, 'commit', '-qam', 'base moved')
      await git(repo, 'push', '-q', 'origin', 'main')

      const res = await fetch(`http://127.0.0.1:${String(server2.port)}/api/tasks/t1/prs`, {
        method: 'POST', headers: { cookie: `loopkanban_token=${TOKEN}` },
      })
      expect(res.status).toBe(422)
      expect(await res.json()).toMatchObject({
        error: 'merge-conflict', files: ['README.md'], requeued: true,
      })
      // 没配执行器就派不出去 —— 但结论不变：冲突这件事已经如实报了。
      expect(store.getTask(asTaskId('t1'))?.column).toBe('ready')
      expect(store.listComments(asTaskId('t1'))[0]?.body).toContain('README.md')
    } finally {
      await server2.close()
    }
  })

  it('上一轮的冲突还没解完：照样 422，但明说卡没回队列（它还在 Review）', async () => {
    const server2 = await startServer({
      storage: store, token: TOKEN,
      review: new Review({ storage: store, github: github() }),
    })
    try {
      store.createTask(task({ id: 't1', column: 'review', repoPath: repo }))
      const wt = await ensureWorktree(repo, 't1', 'task/t1', 'main')
      store.createRun({
        id: asRunId('run-1'), taskId: asTaskId('t1'), provider: 'codex', cliVersion: '0.1',
        worktreePath: wt.path, branch: wt.branch, status: 'completed', startedAt: T0,
      })
      // 造出"解冲突那一轮跑砸了"的样子：工作区里还留着冲突标记。
      await writeFile(join(wt.path, 'README.md'), '# 我改的\n', 'utf8')
      await git(wt.path, 'add', '-A')
      await git(wt.path, 'commit', '-qm', 'mine')
      await writeFile(join(repo, 'README.md'), '# 他改的\n', 'utf8')
      await git(repo, 'commit', '-qam', 'base moved')
      await git(wt.path, 'merge', '--no-edit', 'main')

      const res = await fetch(`http://127.0.0.1:${String(server2.port)}/api/tasks/t1/prs`, {
        method: 'POST', headers: { cookie: `loopkanban_token=${TOKEN}` },
      })
      // 这一条以前是抛出去、被兜成 500 的"服务端出错"。
      expect(res.status).toBe(422)
      expect(await res.json()).toMatchObject({
        error: 'merge-conflict', files: ['README.md'], requeued: false,
      })
      expect(store.getTask(asTaskId('t1'))?.column).toBe('review')
    } finally {
      await server2.close()
    }
  })
})

describe('Done 里的二次执行', () => {
  it('对一张已完成的卡说一句，它就回队列 —— 合完才发现还差一条，是同一张卡的下一轮', async () => {
    store.createTask(task({ id: 't1', column: 'done' }))

    const res = await api('/api/tasks/t1/comments', {
      method: 'POST', body: JSON.stringify({ body: '还差一个测试' }),
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ requeued: true })
    expect(store.getTask(asTaskId('t1'))?.column).toBe('ready')
    // 话留着，下一轮带着整条讨论走。
    expect(store.listComments(asTaskId('t1'))[0]?.body).toBe('还差一个测试')
  })

  it('别的列只是留个话，不动卡的位置', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    const res = await api('/api/tasks/t1/comments', {
      method: 'POST', body: JSON.stringify({ body: '记一笔' }),
    })
    expect(await res.json()).toMatchObject({ requeued: false })
    expect(store.getTask(asTaskId('t1'))?.column).toBe('backlog')
  })
})

// ── 决策：权限审批 / 向人提问 ───────────────────────────────
//
// 公共用例的 server 没接决策中枢，这一组换成带中枢的：签发的 gate token
// 限权到"只够创建/轮询自己这次的决策"，人的拍板走 cookie。

describe('决策路由（gate + 人工拍板）', () => {
  let hub: DecisionHub
  let gateToken: string
  const RUN = asRunId('run-dec1')

  const gateApi = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`http://127.0.0.1:${String(server.port)}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${gateToken}`, 'content-type': 'application/json', ...init.headers },
    })

  beforeEach(async () => {
    await server.close()
    const bus = new RunBus()
    hub = new DecisionHub({ storage: store, bus })
    server = await startServer({ storage: store, token: TOKEN, bus, decisions: hub })
    gateToken = hub.issueToken(RUN)
    // 外键链：项目已在公共 beforeEach 里建好，这里补卡与 Run。
    store.createTask(task({ id: 't1', column: 'running' }))
    store.createRun({
      id: RUN, taskId: asTaskId('t1'), provider: 'claude', cliVersion: '1',
      worktreePath: '/repo', branch: 'b', status: 'running', startedAt: T0,
    })
  })

  it('shim 用限权 token 创建决策，并轮询到它', async () => {
    const created = await gateApi(`/api/runs/${RUN}/decisions`, {
      method: 'POST', body: JSON.stringify({ kind: 'question', payload: { question: '用哪个方案？' } }),
    })
    expect(created.status).toBe(201)
    const { decision } = await created.json() as { decision: { id: string } }

    const polled = await gateApi(`/api/runs/${RUN}/decisions/${decision.id}`)
    expect(await polled.json()).toMatchObject({ decision: { status: 'pending' } })
  })

  it('token 只对自己的 run 有效：拿它打别的 run 的决策路由会被拒', async () => {
    const other = asRunId('run-other')
    const res = await gateApi(`/api/runs/${other}/decisions`, {
      method: 'POST', body: JSON.stringify({ kind: 'question', payload: { question: 'q' } }),
    })
    expect(res.status).toBe(401)
  })

  it('没有 token 的人也创建不了 —— 创建只属于 gate 通道', async () => {
    const res = await fetch(`http://127.0.0.1:${String(server.port)}/api/runs/${RUN}/decisions`, {
      method: 'POST', body: JSON.stringify({ kind: 'question', payload: { question: 'q' } }),
    })
    expect(res.status).toBe(401)
  })

  it('负载不成立回 422', async () => {
    const res = await gateApi(`/api/runs/${RUN}/decisions`, {
      method: 'POST', body: JSON.stringify({ kind: 'question', payload: { question: '' } }),
    })
    expect(res.status).toBe(422)
  })

  it('人拍板放行权限；再点一下是 409', async () => {
    const { decision } = await (await gateApi(`/api/runs/${RUN}/decisions`, {
      method: 'POST', body: JSON.stringify({ kind: 'permission', payload: { tool: 'Bash', input: { command: 'ls' } } }),
    })).json() as { decision: { id: string } }

    const allow = await api(`/api/runs/${RUN}/decisions/${decision.id}`, {
      method: 'POST', body: JSON.stringify({ decision: 'allow' }),
    })
    expect(allow.status).toBe(200)
    expect(await allow.json()).toMatchObject({ decision: { status: 'allowed' } })

    const again = await api(`/api/runs/${RUN}/decisions/${decision.id}`, {
      method: 'POST', body: JSON.stringify({ decision: 'deny' }),
    })
    expect(again.status).toBe(409)
  })

  it('权限的拍板必须明确 allow/deny，提问的必须带非空回答', async () => {
    const { decision: permission } = await (await gateApi(`/api/runs/${RUN}/decisions`, {
      method: 'POST', body: JSON.stringify({ kind: 'permission', payload: { tool: 'T', input: {} } }),
    })).json() as { decision: { id: string } }
    const { decision: question } = await (await gateApi(`/api/runs/${RUN}/decisions`, {
      method: 'POST', body: JSON.stringify({ kind: 'question', payload: { question: 'q' } }),
    })).json() as { decision: { id: string } }

    const empty = await api(`/api/runs/${RUN}/decisions/${permission.id}`, {
      method: 'POST', body: JSON.stringify({}),
    })
    expect(empty.status).toBe(422)
    const blank = await api(`/api/runs/${RUN}/decisions/${question.id}`, {
      method: 'POST', body: JSON.stringify({ answer: '  ' }),
    })
    expect(blank.status).toBe(422)
  })

  it('看板状态捎上每张卡还在等的决策', async () => {
    await gateApi(`/api/runs/${RUN}/decisions`, {
      method: 'POST', body: JSON.stringify({ kind: 'question', payload: { question: 'q' } }),
    })
    const state = await (await api('/api/state')).json() as
      { pending: Record<string, { kind: string }[]> }
    expect(state.pending['t1']).toHaveLength(1)
    expect(state.pending['t1']?.[0]?.kind).toBe('question')
  })

  it('拍板之后回答回到 shim 的轮询里 —— 决策卡片从 pending 变终态', async () => {
    const { decision } = await (await gateApi(`/api/runs/${RUN}/decisions`, {
      method: 'POST', body: JSON.stringify({ kind: 'question', payload: { question: 'q' } }),
    })).json() as { decision: { id: string } }
    await api(`/api/runs/${RUN}/decisions/${decision.id}`, {
      method: 'POST', body: JSON.stringify({ answer: '按方案 A' }),
    })
    const polled = await gateApi(`/api/runs/${RUN}/decisions/${decision.id}`)
    const { decision: settled } = await polled.json() as
      { decision: { status: string; answer: { text: string } } }
    expect(settled.status).toBe('answered')
    expect(settled.answer.text).toBe('按方案 A')
  })
})
