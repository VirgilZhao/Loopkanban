import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_TEXT_BYTES } from '../src/fs/index.ts'
import { listFiles, listWorkspaces, readFileText } from '../src/server/files.ts'
import { ensureWorktree } from '../src/worktree/index.ts'

/** 跑一条 git 命令，测试里只关心它跑完了。 */
function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], { stdio: 'ignore' })
    child.on('exit', () => { resolve() })
    child.on('error', reject)
  })
}

let sandbox: string
let repo: string

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'loopkanban-files-'))
  repo = join(sandbox, 'repo')
  await mkdir(join(repo, 'src'), { recursive: true })
  await writeFile(join(repo, 'README.md'), '# hi\n', 'utf8')
  await writeFile(join(repo, '.gitignore'), 'node_modules\n', 'utf8')
  await writeFile(join(repo, 'src', 'main.ts'), 'export const x = 1\n', 'utf8')
  await new Promise((resolve, reject) => {
    const child = spawn('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' })
    child.on('exit', resolve)
    child.on('error', reject)
  })
  await git(repo, ['config', 'user.email', 'test@example.com'])
  await git(repo, ['config', 'user.name', 'test'])
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-q', '-m', 'init'])
})

afterEach(async () => { await rm(sandbox, { recursive: true, force: true }) })

describe('listFiles', () => {
  it('目录在前、文件在后，隐藏文件照列，.git 不列', async () => {
    const listing = await listFiles(repo, repo)
    expect(listing.entries.map((e) => e.name)).toEqual(['src', '.gitignore', 'README.md'])
    expect(listing.entries.find((e) => e.name === 'src')?.kind).toBe('dir')
    expect(listing.entries.find((e) => e.name === 'README.md')?.size).toBe(5)
  })

  it('根上没有上一级 —— 围栏在界面上要看得见', async () => {
    expect((await listFiles(repo, repo)).parent).toBeNull()
    expect((await listFiles(repo, join(repo, 'src'))).parent).toBe(repo)
  })

  it('相对路径给面包屑用', async () => {
    expect((await listFiles(repo, repo)).relative).toBe('')
    expect((await listFiles(repo, join(repo, 'src'))).relative).toBe('src')
  })
})

/*
 * 读取本身（上限、二进制、截断收尾）在 text.spec.ts 里验；这里只验浏览页
 * 在它之上加的那点东西 —— 相对工作区根的路径，以及失败怎么回。
 */
describe('readFileText', () => {
  it('回正文与相对根的路径', async () => {
    const read = await readFileText(repo, join(repo, 'src', 'main.ts'))
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.file.content).toBe('export const x = 1\n')
    expect(read.file.relative).toBe(join('src', 'main.ts'))
    expect(read.file.binary).toBe(false)
    expect(read.file.truncated).toBe(false)
  })

  it('二进制照样回，只是不带正文 —— 文件管理器该让人看见它在那儿', async () => {
    await writeFile(join(repo, 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]))
    const read = await readFileText(repo, join(repo, 'blob.bin'))
    expect(read).toMatchObject({ ok: true, file: { binary: true, content: '' } })
  })

  it('大文件截断并如实说明', async () => {
    await writeFile(join(repo, 'big.txt'), 'x'.repeat(MAX_TEXT_BYTES + 100), 'utf8')
    const read = await readFileText(repo, join(repo, 'big.txt'))
    expect(read).toMatchObject({ ok: true, file: { truncated: true, size: MAX_TEXT_BYTES + 100 } })
  })

  it('目录不是文件 —— 回失败而不是抛，调用方要据此挑状态码', async () => {
    expect(await readFileText(repo, join(repo, 'src'))).toMatchObject({
      ok: false, reason: 'no-such-file',
    })
  })
})

describe('listWorkspaces', () => {
  it('只有主仓库时就回它一个', async () => {
    const spaces = await listWorkspaces(repo)
    expect(spaces).toHaveLength(1)
    expect(spaces[0]?.kind).toBe('repo')
    expect(spaces[0]?.branch).toBe('main')
  })

  it('卡片留下的 worktree 也列出来 —— Agent 干活的地方正是那里', async () => {
    await ensureWorktree(repo, 't1', 'task/t1', 'main')
    const spaces = await listWorkspaces(repo)
    expect(spaces.map((s) => s.kind)).toEqual(['repo', 'worktree'])
    expect(spaces[1]?.taskId).toBe('t1')
    expect(spaces[1]?.branch).toBe('task/t1')
  })
})
