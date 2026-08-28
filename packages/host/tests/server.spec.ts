import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { chmod, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { connect, type AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { asProjectId, asRunId, asTaskId, type Task } from '@loopkanban/core'
import { AgentPool } from '../src/agents/index.ts'
import { AttachmentStore } from '../src/attachments/index.ts'
import { Storage } from '../src/storage/index.ts'
import { startServer, type RunningServer } from '../src/server/index.ts'

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
    blockedBy: [], createdAt: T0, updatedAt: T0, ...rest,
  }
}

/** 带 cookie 的 fetch，模拟浏览器拿到 token 之后的后续请求。 */
const api = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`http://127.0.0.1:${String(server.port)}${path}`, {
    ...init,
    headers: { cookie: `loopkanban_token=${TOKEN}`, ...init.headers },
  })

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

  it('跑命令，回退出码与输出', async () => {
    const res = await api('/api/exec', {
      method: 'POST',
      body: JSON.stringify({ root: repo, cwd: join(repo, 'src'), command: 'cat main.ts' }),
    })
    expect(res.status).toBe(200)
    const result = await res.json() as { stdout: string; code: number; cwd: string }
    expect(result.stdout).toBe('export const x = 1\n')
    expect(result.code).toBe(0)
  })

  it('命令失败照样 200 —— 那是它的输出，不是我们的故障', async () => {
    const res = await api('/api/exec', {
      method: 'POST', body: JSON.stringify({ root: repo, command: 'exit 7' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json() as { code: number }).code).toBe(7)
  })

  /*
   * 目录在你浏览的这会儿被删掉，是这几个接口最常见的失败 —— 废弃一张卡就会
   * 连它的 worktree 一起删。三条路都得说人话，不能一句 500 了事。
   */
  it('cwd 没了是 404，不是 500 —— spawn 的报错会把锅甩给 shell', async () => {
    const res = await api('/api/exec', {
      method: 'POST',
      body: JSON.stringify({ root: repo, cwd: join(repo, '走了'), command: 'pwd' }),
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
    const ran = await api('/api/exec', {
      method: 'POST', body: JSON.stringify({ root: repo, command: 'pwd' }),
    })
    expect(ran.status).toBe(410)
    expect((await ran.json() as { error: string }).error).toBe('repo-missing')
  })

  it('空命令 422，围栏外的 cwd 422', async () => {
    expect((await api('/api/exec', {
      method: 'POST', body: JSON.stringify({ root: repo, command: '   ' }),
    })).status).toBe(422)
    expect((await api('/api/exec', {
      method: 'POST', body: JSON.stringify({ root: '/etc', command: 'ls' }),
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

  it('卡不存在 404', async () => {
    expect((await say('nope', { body: 'x' })).status).toBe(404)
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

  it('二进制 415，不给一屏乱码', async () => {
    await writeFile(join(worktree, 'shot.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]))
    const res = await ask('t1', 'shot.png')
    expect(res.status).toBe(415)
    expect(await res.json()).toMatchObject({ error: 'not-text' })
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
