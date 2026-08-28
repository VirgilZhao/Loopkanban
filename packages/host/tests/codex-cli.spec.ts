import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseHelp } from '../src/agents/help-parser.ts'
import { codexCliProvider } from '../src/agents/providers/codex-cli.ts'
import type { AgentCaps, RunContext } from '../src/agents/types.ts'

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')

const CAPS: AgentCaps = {
  id: 'codex',
  bin: '/fake/codex',
  version: 'codex-cli 0.149.1',
  streaming: true,
  canPinSessionId: false,
  canResume: true,
  canPickModel: true, models: [],
  permissionTiers: ['strict', 'standard', 'yolo'],
  help: parseHelp(fixture('codex-exec-help.txt')),
  resumeHelp: parseHelp(fixture('codex-exec-resume-help.txt')),
}

const RUN: RunContext = {
  runId: 'run-1',
  worktreePath: '/tmp/wt',
  artifactsDir: '/tmp/artifacts',
  prompt: '做点事',
  permission: 'standard',
}

const lines = (): string[] =>
  fixture('codex-exec-json-success.jsonl').split('\n').filter((l) => l.trim().length > 0)

const events = () => lines().flatMap((l) => codexCliProvider.parseLine(l, CAPS))

describe('codexCliProvider.buildStart', () => {
  it('拼出 exec + json + cd + 沙箱 + 最终回答落盘', () => {
    expect(codexCliProvider.buildStart(RUN, CAPS).argv).toEqual([
      '/fake/codex', 'exec',
      '--json',
      '-C', '/tmp/wt',
      '--approve-for-me',
      '-o', '/tmp/artifacts/run-1-last-message.txt',
      '做点事',
    ])
  })

  it('三档权限各自映射到 codex 自己的说法', () => {
    const argv = (tier: RunContext["permission"]): readonly string[] =>
      codexCliProvider.buildStart({ ...RUN, permission: tier }, CAPS).argv

    expect(argv('strict')).toContain('read-only')
    expect(argv('strict')).not.toContain('--approve-for-me')
    // --approve-for-me 隐含 workspace-write，与 -s 互斥，同时传会被 clap 拒绝。
    expect(argv('standard')).toContain('--approve-for-me')
    expect(argv('standard')).not.toContain('-s')
    expect(argv('yolo')).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(argv('yolo')).not.toContain('-s')
  })

  it('--approve-for-me 与 -s 互斥，绝不同时出现', () => {
    for (const tier of ['strict', 'standard', 'yolo'] as const) {
      const argv = codexCliProvider.buildStart({ ...RUN, permission: tier }, CAPS).argv
      expect(argv.includes('--approve-for-me') && argv.includes('-s'), `${tier} 档同时传了两者`).toBe(false)
    }
  })

  it('没有 --approve-for-me 的版本回落到 -s workspace-write', () => {
    const help = parseHelp('  --json  x\n  -s, --sandbox <M>  y\n          [possible values: read-only, workspace-write]\n')
    const argv = codexCliProvider.buildStart(RUN, { ...CAPS, help }).argv
    expect(argv).toContain('-s')
    expect(argv).toContain('workspace-write')
  })

  it('绝不加 --ephemeral —— 会话要落盘才能续跑', () => {
    expect(codexCliProvider.buildStart(RUN, CAPS).argv).not.toContain('--ephemeral')
  })

  it('探测不到某档位时不硬塞参数', () => {
    const noSandbox: AgentCaps = { ...CAPS, help: parseHelp('  --json  Print events\n') }
    const argv = codexCliProvider.buildStart(RUN, noSandbox).argv
    expect(argv).not.toContain('-s')
    expect(argv).not.toContain('-o')
  })
})

describe('codexCliProvider.buildResume', () => {
  it('用 resume 子命令而不是参数', () => {
    const argv = codexCliProvider.buildResume(RUN, CAPS, 'thread-9')?.argv ?? []
    expect(argv.slice(0, 4)).toEqual(['/fake/codex', 'exec', 'resume', 'thread-9'])
    expect(argv.at(-1)).toBe('做点事')
  })

  it('只用 resume 自己声明过的参数 —— 它的参数面和主命令不一样', () => {
    const argv = codexCliProvider.buildResume(RUN, CAPS, 'thread-9')?.argv ?? []
    // 实测: codex exec resume 没有这几个，硬塞进去会被 clap 直接拒绝(exit 2)。
    for (const absent of ['-C', '--cd', '-s', '--sandbox', '--approve-for-me', '--add-dir']) {
      expect(argv, `resume 不该出现 ${absent}`).not.toContain(absent)
    }
    // 它自己有的仍然要用上。
    expect(argv).toContain('--json')
    expect(argv).toContain('-o')
  })

  it('主命令那条路径照旧带上 -C 与权限参数', () => {
    const argv = codexCliProvider.buildStart(RUN, CAPS).argv
    expect(argv).toContain('-C')
    expect(argv).toContain('--approve-for-me')
  })

  it('没探测到 resume 参数面时退回主命令的，但也只用两边都有的', () => {
    const { resumeHelp: _drop, ...noResumeSurface } = CAPS
    const argv = codexCliProvider.buildResume(RUN, noResumeSurface, 'thread-9')?.argv ?? []
    expect(argv).toContain('--json')
  })

  it('不支持续跑时返回 null', () => {
    expect(codexCliProvider.buildResume(RUN, { ...CAPS, canResume: false }, 't')).toBeNull()
  })
})

describe('codexCliProvider.parseLine（真实 --json 输出）', () => {
  it('从 thread.started 捞出会话 id —— codex 不允许我们预先指定', () => {
    const sessions = events().filter((e) => e.kind === 'session')
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ sessionId: '01a0439e-45c9-7001-a754-f19c2f17b153' })
    expect(CAPS.canPinSessionId).toBe(false)
  })

  it('agent_message 变成文本事件', () => {
    const texts = events().filter((e) => e.kind === 'text')
    expect(texts).toHaveLength(2)
    expect((texts.at(-1) as { text: string }).text).toContain('greet.js')
  })

  it('file_change 只在 completed 时上报一次，不重复计数', () => {
    const tools = events().filter((e) => e.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ name: 'file_change' })
  })

  it('从 turn.completed 取出用量', () => {
    const usage = events().find((e) => e.kind === 'usage')
    expect(usage).toMatchObject({ kind: 'usage', inputTokens: 31415, outputTokens: 145 })
  })

  it('turn.completed 同时是用量与收尾信号 —— 报了用量不该就报不成结束', () => {
    const all = events()
    expect(all.filter((e) => e.kind === 'finished')).toEqual([{ kind: 'finished', ok: true }])
    // 用量排在结束之前：消费方看到 finished 往往就开始收尾了。
    expect(all.findIndex((e) => e.kind === 'usage')).toBeLessThan(all.findIndex((e) => e.kind === 'finished'))
  })

  it('turn.failed 给出结构化诊断', () => {
    const [event] = codexCliProvider.parseLine(
      JSON.stringify({ type: 'turn.failed', error: { message: 'context window exceeded' } }),
      CAPS,
    )
    expect(event).toMatchObject({ kind: 'finished', ok: false })
    expect((event as { diagnostic: string }).diagnostic).toContain('context window exceeded')
  })

  it('认不出的行降级为 raw，绝不抛异常', () => {
    for (const line of ['{"type":"未来才有的事件"}', '不是 JSON', '', '{"broken":']) {
      expect(() => codexCliProvider.parseLine(line, CAPS)).not.toThrow()
    }
    expect(codexCliProvider.parseLine('不是 JSON', CAPS)[0]?.kind).toBe('raw')
  })
})
