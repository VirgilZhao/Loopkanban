import { asRunId } from '@loopkanban/core'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseHelp } from '../src/agents/help-parser.ts'
import { OPENCODE_PERMISSION_CAVEAT, opencodeCliProvider, parseModelList } from '../src/agents/providers/opencode-cli.ts'
import type { AgentCaps, RunContext } from '../src/agents/types.ts'

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')

const CAPS: AgentCaps = {
  id: 'opencode',
  bin: '/fake/opencode',
  version: '1.18.23',
  streaming: true,
  canPinSessionId: false,
  canResume: true,
  canPickModel: true, models: [],
  permissionTiers: ['standard', 'yolo'],
  canAskUser: false,
  canPromptPermission: false,
  help: parseHelp(fixture('opencode-run-help.txt')),
}

const RUN: RunContext = {
  runId: 'run-1',
  worktreePath: '/tmp/wt',
  artifactsDir: '/tmp/artifacts',
  prompt: '做点事',
  permission: 'standard',
}

const lines = (): string[] =>
  fixture('opencode-run-json-success.jsonl').split('\n').filter((l) => l.trim().length > 0)

const events = () => lines().flatMap((l) => opencodeCliProvider.parseLine(l, CAPS))

describe('opencodeCliProvider.buildStart', () => {
  it('拼出 run + json + auto + dir，提示词用 -- 隔开', () => {
    expect(opencodeCliProvider.buildStart(RUN, CAPS).argv).toEqual([
      '/fake/opencode', 'run',
      '--format', 'json',
      '--auto',
      '--dir', '/tmp/wt',
      '--', '做点事',
    ])
  })

  it('支持得了的档位都带上 --auto —— 少了它 Run 会挂到超时为止', () => {
    for (const tier of ['standard', 'yolo'] as const) {
      expect(opencodeCliProvider.buildStart({ ...RUN, permission: tier }, CAPS).argv).toContain('--auto')
    }
  })

  it('要求 strict 时拒绝执行，绝不悄悄降级成 --auto', () => {
    // 这是最关键的一条：opencode 没有只读模式，少了 --auto 又会永远挂住，
    // 所以「按 --auto 跑」等于把最严的档位跑成最松的 —— 宁可当场失败。
    expect(() => opencodeCliProvider.buildStart({ ...RUN, permission: 'strict' }, CAPS)).toThrow(/strict/)
    expect(() => opencodeCliProvider.buildResume({ ...RUN, permission: 'strict' }, CAPS, 'ses_a')).toThrow(/strict/)
  })

  it('探测不到 --auto 时一个档位都不支持，于是什么都跑不了', () => {
    const noAuto: AgentCaps = { ...CAPS, permissionTiers: [], help: parseHelp('  --format  x\n') }
    for (const tier of ['strict', 'standard', 'yolo'] as const) {
      expect(() => opencodeCliProvider.buildStart({ ...RUN, permission: tier }, noAuto)).toThrow()
    }
  })

  it('拒绝的理由要能落到卡片诊断上，说清楚为什么和该怎么办', () => {
    // Runner 用 error.message 当 diagnostic，所以这句话就是用户看到的全部。
    let message = ''
    try { opencodeCliProvider.buildStart({ ...RUN, permission: 'strict' }, CAPS) } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('opencode')
    expect(message).toContain('strict')
    expect(message).toMatch(/claude|codex/)
  })

  it('提示词永远排在 -- 之后 —— 以 - 开头的一行不能被当成参数吃掉', () => {
    const argv = opencodeCliProvider.buildStart({ ...RUN, prompt: '--help 这不是参数' }, CAPS).argv
    expect(argv.at(-2)).toBe('--')
    expect(argv.at(-1)).toBe('--help 这不是参数')
  })

  it('给了 model 才带 -m', () => {
    expect(opencodeCliProvider.buildStart(RUN, CAPS).argv).not.toContain('-m')
    const argv = opencodeCliProvider.buildStart({ ...RUN, model: 'anthropic/claude-opus-5' }, CAPS).argv
    expect(argv).toContain('-m')
    expect(argv).toContain('anthropic/claude-opus-5')
  })

  it('探测不到的参数不硬塞', () => {
    const bare: AgentCaps = { ...CAPS, streaming: false, help: parseHelp('  --auto  approve\n') }
    const argv = opencodeCliProvider.buildStart(RUN, bare).argv
    expect(argv).not.toContain('--format')
    expect(argv).not.toContain('--dir')
    expect(argv).toContain('--auto')
  })

  it('子进程不许有 stdin —— 逃过 --auto 的询问不能坐在那儿等人', () => {
    expect(opencodeCliProvider.buildStart(RUN, CAPS).stdin).toBe('ignore')
  })

  it('凭证形环境变量被清掉，不靠环境泄漏给子进程', () => {
    const env = opencodeCliProvider.buildStart(RUN, CAPS).env ?? {}
    expect(Object.keys(env)).not.toContain('ANTHROPIC_API_KEY')
  })
})

describe('opencodeCliProvider.buildResume', () => {
  it('续跑是同一条 run 命令，只多一个 -s', () => {
    expect(opencodeCliProvider.buildResume(RUN, CAPS, 'ses_abc')?.argv).toEqual([
      '/fake/opencode', 'run',
      '--format', 'json',
      '--auto',
      '--dir', '/tmp/wt',
      '-s', 'ses_abc',
      '--', '做点事',
    ])
  })

  it('不支持续跑时返回 null', () => {
    expect(opencodeCliProvider.buildResume(RUN, { ...CAPS, canResume: false }, 'ses_abc')).toBeNull()
  })
})

describe('opencodeCliProvider.parseLine（真实 --format json 输出）', () => {
  it('从 step_start 捞出会话 id —— opencode 不允许我们预先指定', () => {
    const sessions = events().filter((e) => e.kind === 'session')
    expect(sessions.length).toBeGreaterThan(0)
    for (const s of sessions) {
      expect(s).toMatchObject({ sessionId: 'ses_fba149baeffennUmYCQDCsez0R' })
    }
    expect(CAPS.canPinSessionId).toBe(false)
  })

  it('text 事件取出正文', () => {
    const texts = events().filter((e) => e.kind === 'text')
    expect(texts).toHaveLength(1)
    expect(texts[0]).toMatchObject({ kind: 'text', text: 'DONE' })
  })

  it('工具只在 completed 时上报一次，并带上入参', () => {
    const tools = events().filter((e) => e.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ kind: 'tool', name: 'write' })
    expect((tools[0] as { input: Record<string, unknown> }).input).toMatchObject({ content: 'banana' })
  })

  it('每个 step_finish 报一次自己那一步的用量', () => {
    const usage = events().filter((e) => e.kind === 'usage')
    expect(usage).toHaveLength(2)
    // Storage 端是把 usage 事件累加起来的，所以这里报的必须是"每步"而非累计值。
    expect(usage[0]).toMatchObject({ inputTokens: 16054, outputTokens: 92 })
    expect(usage[1]).toMatchObject({ inputTokens: 96, outputTokens: 4 })
  })

  it('成功那条路径上没有 finished —— 完成与否交给退出码', () => {
    expect(events().filter((e) => e.kind === 'finished')).toHaveLength(0)
  })

  it('error 事件给出结构化诊断', () => {
    const [event] = opencodeCliProvider.parseLine(
      JSON.stringify({
        type: 'error',
        sessionID: 'ses_x',
        error: { name: 'UnknownError', data: { message: 'Unexpected server error.' } },
      }),
      CAPS,
    )
    expect(event).toMatchObject({ kind: 'finished', ok: false })
    expect((event as { diagnostic: string }).diagnostic).toContain('Unexpected server error.')
    expect((event as { diagnostic: string }).diagnostic).toContain('UnknownError')
  })

  // 1.18.23 实测不会发这种事件（连 12 秒的 bash 也只在 completed 时报一次），
  // 这条是前向兼容：真发了就压成一行提示，而不是当成噪音丢掉。
  it('万一出现进行中的工具事件，压成一行提示而不是丢掉', () => {
    const [event] = opencodeCliProvider.parseLine(
      JSON.stringify({ type: 'tool_use', part: { type: 'tool', tool: 'bash', state: { status: 'running', title: 'pnpm test' } } }),
      CAPS,
    )
    expect(event).toMatchObject({ kind: 'notice', level: 'info' })
    expect((event as { text: string }).text).toContain('pnpm test')
  })

  it('工具失败是解释「为什么没干完」的线索，不能当噪音丢掉', () => {
    const [event] = opencodeCliProvider.parseLine(
      JSON.stringify({ type: 'tool_use', part: { type: 'tool', tool: 'bash', state: { status: 'error', error: 'exit 1' } } }),
      CAPS,
    )
    expect(event).toMatchObject({ kind: 'notice', level: 'warn' })
    expect((event as { text: string }).text).toContain('exit 1')
  })

  it('认不出的行降级为 raw，绝不抛异常', () => {
    for (const line of ['{"type":"未来才有的事件"}', '不是 JSON', '', '{"broken":']) {
      expect(() => opencodeCliProvider.parseLine(line, CAPS)).not.toThrow()
    }
    expect(opencodeCliProvider.parseLine('不是 JSON', CAPS)[0]?.kind).toBe('raw')
  })
})

describe('opencodeCliProvider 的能力矩阵', () => {
  const caps = parseHelp(fixture('opencode-run-help.txt'))

  it('run 的参数面里有我们依赖的那几个', () => {
    for (const flag of ['format', 'auto', 'dir', 'session', 'model', 'continue', 'agent']) {
      expect(caps.flags.has(flag), `缺少 --${flag}`).toBe(true)
    }
  })

  it('strict 不上报 —— opencode 没有只读模式，假装支持等于换了语义', () => {
    expect(CAPS.permissionTiers).not.toContain('strict')
    expect(CAPS.permissionTiers).toEqual(['standard', 'yolo'])
  })

  it('上报权限警示 —— 同一个 standard，它比另外两家松得多', () => {
    // 只说「支持 standard」会让用户按 codex 的经验去理解它（那边是有沙箱的）。
    expect(OPENCODE_PERMISSION_CAVEAT.label).toBe('无沙箱')
    expect(OPENCODE_PERMISSION_CAVEAT.detail).toContain('codex')
    expect(OPENCODE_PERMISSION_CAVEAT.detail).toContain('worktree')
  })
})

describe('模型自动获取', () => {
  it('把 opencode models 的输出解析成清单', () => {
    const models = parseModelList([
      'anthropic/claude-sonnet-4-5',
      'openai/gpt-5',
      'opencode/big-pickle',
    ].join('\n'))
    expect(models).toEqual(['anthropic/claude-sonnet-4-5', 'openai/gpt-5', 'opencode/big-pickle'])
  })

  it('转售商那种多段 id 也要收 —— 只认两段会整片丢掉', () => {
    const models = parseModelList([
      'siliconflow-cn/deepseek-ai/DeepSeek-R1',
      'siliconflow-cn/Pro/deepseek-ai/DeepSeek-V3',
    ].join('\n'))
    expect(models).toHaveLength(2)
  })

  it('认不出的行一概丢掉 —— 宁可少给建议，也不要把噪音塞进下拉框', () => {
    const models = parseModelList([
      '',
      'Available models:',
      'anthropic/claude-sonnet-4-5',
      '  openai/gpt-5  ',
      'anthropic/claude-sonnet-4-5',
      '这是一行提示',
    ].join('\n'))
    // 去重、去空白、只留 provider/model 那种行。
    expect(models).toEqual(['anthropic/claude-sonnet-4-5', 'openai/gpt-5'])
  })
})

const GATE = {
  serverName: 'loopkanban', baseUrl: 'http://127.0.0.1:9', runId: asRunId('run-g'),
  token: 'run-token', shimPath: '/x/gate-shim.mjs',
  mcpConfigPath: '/x/artifacts/gate/mcp.json', envConfigPath: '/x/artifacts/gate/opencode.json',
}

describe('opencodeCliProvider gate', () => {
  it('经 OPENCODE_CONFIG 把 gate 配置指给 CLI —— 合并语义，不顶掉用户配置', () => {
    const spec = opencodeCliProvider.buildStart({ ...RUN, gate: GATE }, CAPS)
    expect(spec.env?.['OPENCODE_CONFIG']).toBe(GATE.envConfigPath)
  })

  it('没接 gate 时不带 OPENCODE_CONFIG', () => {
    const spec = opencodeCliProvider.buildStart(RUN, CAPS)
    expect(spec.env?.['OPENCODE_CONFIG']).toBeUndefined()
  })
})
