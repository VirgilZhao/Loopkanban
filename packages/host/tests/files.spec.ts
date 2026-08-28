import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  confine, contains, listFiles, listWorkspaces, readFileText, refusalFor, MAX_FILE_BYTES,
} from '../src/server/files.ts'
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
    expect(await confine([repo], join(repo, 'src'))).not.toBeNull()
    expect(await confine([repo], sandbox)).toBeNull()
  })

  it('`..` 爬不出去', async () => {
    expect(await confine([repo], join(repo, 'src', '..', '..', 'escape'))).toBeNull()
  })

  it('相对路径直接拒绝', async () => {
    expect(await confine([repo], 'src')).toBeNull()
  })

  it('指向围栏外面的符号链接挡得住 —— 字符串前缀比较看不出它', async () => {
    const outside = join(sandbox, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.txt'), 'nope\n', 'utf8')
    await symlink(outside, join(repo, 'link'))
    expect(await confine([repo], join(repo, 'link', 'secret.txt'))).toBeNull()
  })

  it('路径不存在不算越界 —— 那是「打不开」，由 stat 去说', async () => {
    const gone = join(repo, 'src', 'gone.ts')
    expect(await confine([repo], gone)).not.toBeNull()
  })
})

describe('refusalFor', () => {
  it('真的越界就是越界', async () => {
    expect(await refusalFor([repo], join(sandbox, 'elsewhere'))).toBe('outside-project')
    expect(await refusalFor([repo], 'relative')).toBe('outside-project')
  })

  it('仓库自己没了要分得出来 —— 说成「在项目外面」会把人带偏', async () => {
    await rm(repo, { recursive: true, force: true })
    expect(await refusalFor([repo], join(repo, 'src'))).toBe('repo-missing')
    // 仓库没了，但问的本来就是别处的路径 —— 那还是越界。
    expect(await refusalFor([repo], join(sandbox, 'elsewhere'))).toBe('outside-project')
  })
})

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

describe('readFileText', () => {
  it('回正文与相对路径', async () => {
    const file = await readFileText(repo, join(repo, 'src', 'main.ts'))
    expect(file.content).toBe('export const x = 1\n')
    expect(file.relative).toBe(join('src', 'main.ts'))
    expect(file.binary).toBe(false)
    expect(file.truncated).toBe(false)
  })

  it('二进制文件不回正文 —— 按 UTF-8 解出来只会是一屏乱码', async () => {
    await writeFile(join(repo, 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]))
    const file = await readFileText(repo, join(repo, 'blob.bin'))
    expect(file.binary).toBe(true)
    expect(file.content).toBe('')
  })

  it('大文件截断并如实说明', async () => {
    await writeFile(join(repo, 'big.txt'), 'x'.repeat(MAX_FILE_BYTES + 100), 'utf8')
    const file = await readFileText(repo, join(repo, 'big.txt'))
    expect(file.truncated).toBe(true)
    expect(file.content.length).toBe(MAX_FILE_BYTES)
    expect(file.size).toBe(MAX_FILE_BYTES + 100)
  })

  it('目录不是文件', async () => {
    await expect(readFileText(repo, join(repo, 'src'))).rejects.toThrow()
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
