import { asRunId } from '@loopkanban/core'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseHelp } from '../src/agents/help-parser.ts'
import { claudeCliProvider, modelsFromHelp } from '../src/agents/providers/claude-cli.ts'
import type { AgentCaps, RunContext } from '../src/agents/types.ts'

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')

const CAPS: AgentCaps = {
  id: 'claude',
  bin: '/fake/claude',
  version: '2.1.241 (Claude Code)',
  streaming: true,
  canPinSessionId: true,
  canResume: true,
  canPickModel: true, models: [],
  permissionTiers: ['strict', 'standard', 'yolo'],
  // claude 的 provider 常量：help 不列 --permission-prompt-tool，但能力恒在。
  canAskUser: true,
  canPromptPermission: true,
  help: parseHelp(fixture('claude-help.txt')),
}

const RUN: RunContext = {
  runId: 'run-1',
  worktreePath: '/tmp/wt',
  artifactsDir: '/tmp/artifacts',
  prompt: '做点事',
  permission: 'standard',
  sessionId: '83b274e6-48b9-4d77-ab6f-d53cc3d19d0e',
}

const streamLines = (): string[] =>
  fixture('claude-stream-json-auth-failure.jsonl').split('\n').filter((l) => l.trim().length > 0)

describe('claudeCliProvider.buildStart', () => {
  it('拼出 print + stream-json + verbose + 权限档位 + 会话 id', () => {
    const spec = claudeCliProvider.buildStart(RUN, CAPS)
    expect(spec.argv).toEqual([
      '/fake/claude', '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'auto',
      '--session-id', RUN.sessionId,
      '做点事',
    ])
    expect(spec.cwd).toBe('/tmp/wt')
  })

  it('三档权限各自映射到 claude 自己的说法', () => {
    const mode = (tier: RunContext['permission']): string | undefined => {
      const argv = claudeCliProvider.buildStart({ ...RUN, permission: tier }, CAPS).argv
      const at = argv.indexOf('--permission-mode')
      return at < 0 ? undefined : argv[at + 1]
    }
    expect(mode('strict')).toBe('dontAsk')
    // 实测：acceptEdits 只放行文件编辑，Bash 一律拒绝，Agent 跑不了测试。
    expect(mode('standard')).toBe('auto')
    expect(mode('yolo')).toBe('bypassPermissions')
  })

  it('该版本没有 auto 时，standard 回落到 acceptEdits', () => {
    const help = parseHelp('  --print  x\n  --permission-mode <m>  y (choices: "acceptEdits", "dontAsk")\n')
    const argv = claudeCliProvider.buildStart(RUN, { ...CAPS, help }).argv
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
  })

  it('该版本一个档位都不支持时不硬塞参数', () => {
    const argv = claudeCliProvider.buildStart(RUN, { ...CAPS, help: parseHelp('  --print  x\n') }).argv
    expect(argv).not.toContain('--permission-mode')
  })

  it('不支持指定会话 id 时不会硬塞 --session-id', () => {
    const argv = claudeCliProvider.buildStart(RUN, { ...CAPS, canPinSessionId: false }).argv
    expect(argv).not.toContain('--session-id')
  })

  it('绝不加 --no-session-persistence —— 会话要落盘才能续跑', () => {
    expect(claudeCliProvider.buildStart(RUN, CAPS).argv).not.toContain('--no-session-persistence')
  })
})

describe('claudeCliProvider.buildResume', () => {
  it('支持续跑时带上 --resume', () => {
    const spec = claudeCliProvider.buildResume(RUN, CAPS, 'sess-9')
    expect(spec?.argv).toContain('--resume')
    expect(spec?.argv.at(-2)).toBe('sess-9')
  })

  it('不支持续跑时返回 null，让调用方降级而不是瞎拼参数', () => {
    expect(claudeCliProvider.buildResume(RUN, { ...CAPS, canResume: false }, 'sess-9')).toBeNull()
  })
})

describe('claudeCliProvider.parseLine（真实 stream-json 输出）', () => {
  it('只把 system/init 当作会话建立，不重复上报', () => {
    const sessions = streamLines()
      .flatMap((l) => claudeCliProvider.parseLine(l, CAPS))
      .filter((e) => e.kind === 'session')
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      sessionId: '83b274e6-48b9-4d77-ab6f-d53cc3d19d0e',
      permissionMode: 'acceptEdits',
      // 零 API Key 的硬证据：CLI 用的是自己的登录态。
      apiKeySource: 'none',
    })
  })

  it('把 API 重试上报为 notice', () => {
    const notices = streamLines()
      .flatMap((l) => claudeCliProvider.parseLine(l, CAPS))
      .filter((e) => e.kind === 'notice')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ level: 'warn' })
    expect((notices[0] as { text: string }).text).toContain('401')
  })

  it('subtype 仍是 success 但 is_error 为真时，判为失败并给出结构化诊断', () => {
    const finished = streamLines()
      .flatMap((l) => claudeCliProvider.parseLine(l, CAPS))
      .find((e) => e.kind === 'finished')
    expect(finished).toBeDefined()
    expect(finished).toMatchObject({ ok: false })
    const diagnostic = (finished as { diagnostic?: string }).diagnostic ?? ''
    expect(diagnostic).toContain('terminal=api_error')
    expect(diagnostic).toContain('api_status=401')
    expect(diagnostic.length).toBeLessThanOrEqual(512)
  })

  it('把权限拒绝上报为 notice —— 这是「Agent 为什么没干完」的关键线索', () => {
    const [event] = claudeCliProvider.parseLine(JSON.stringify({
      type: 'system', subtype: 'permission_denied',
      tool_name: 'Bash', decision_reason_type: 'other',
    }), CAPS)
    expect(event).toMatchObject({ kind: 'notice', level: 'warn' })
    expect((event as { text: string }).text).toContain('Bash')
  })

  it('额度事件上报为 notice，allowed 不当成警告', () => {
    const [event] = claudeCliProvider.parseLine(JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1787849400 },
    }), CAPS)
    expect(event).toMatchObject({ kind: 'notice', level: 'info' })
    expect((event as { text: string }).text).toContain('five_hour')
  })

  it('认不出的行降级为 raw，绝不抛异常', () => {
    for (const line of ['{"type":"未知"}', '不是 JSON', '', '{"broken":']) {
      expect(() => claudeCliProvider.parseLine(line, CAPS)).not.toThrow()
    }
    expect(claudeCliProvider.parseLine('不是 JSON', CAPS)[0]?.kind).toBe('raw')
  })

  it('result 那一行同时给出用量与结束 —— 成本不该在 finished 手里输掉', () => {
    const events = streamLines().flatMap((l) => claudeCliProvider.parseLine(l, CAPS))
    const usage = events.find((e) => e.kind === 'usage')
    expect(usage).toMatchObject({ kind: 'usage', inputTokens: 0, outputTokens: 0, costUsd: 0 })
    // 用量排在结束之前：消费方看到 finished 往往就开始收尾了。
    expect(events.findIndex((e) => e.kind === 'usage'))
      .toBeLessThan(events.findIndex((e) => e.kind === 'finished'))
  })
})

describe('模型自动获取', () => {
  it('从 --model 的描述里捞出 CLI 自己给的别名', () => {
    const help = parseHelp([
      '  --model <model>       Model for the current session. Provide an alias',
      "                        for the latest model (e.g. 'fable', 'opus', or",
      "                        'sonnet') or a model's full name (e.g.",
      "                        'claude-fable-5').",
    ].join('\n'))
    expect(modelsFromHelp(help)).toEqual(['fable', 'opus', 'sonnet', 'claude-fable-5'])
  })

  it('措辞变了就捞不到 —— 退回自由输入，而不是给出过期的错答案', () => {
    expect(modelsFromHelp(parseHelp('  --model <model>   Model to use'))).toEqual([])
    expect(modelsFromHelp(parseHelp('  --verbose  x'))).toEqual([])
  })
})

const GATE = {
  serverName: 'loopkanban', baseUrl: 'http://127.0.0.1:9', runId: asRunId('run-g'),
  token: 'run-token', shimPath: '/x/gate-shim.mjs',
  mcpConfigPath: '/x/artifacts/gate/mcp.json', envConfigPath: '/x/artifacts/gate/opencode.json',
}

describe('claudeCliProvider gate（向人提问 / 权限审批）', () => {
  it('接上 gate 时挂 --mcp-config 并预放行 ask_user —— 否则调用工具本身又要权限', () => {
    const argv = claudeCliProvider.buildStart({ ...RUN, gate: GATE }, { ...CAPS, canAskUser: true }).argv
    expect(argv).toContain('--mcp-config')
    expect(argv[argv.indexOf('--mcp-config') + 1]).toBe(GATE.mcpConfigPath)
    expect(argv).toContain('--allowedTools')
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('mcp__loopkanban__ask_user')
  })

  it('supervised 档：不设 permission-mode，把审批路由给 gate 的 request_permission', () => {
    const argv = claudeCliProvider.buildStart(
      { ...RUN, permission: 'supervised', gate: GATE }, { ...CAPS, canAskUser: true },
    ).argv
    expect(argv).not.toContain('--permission-mode')
    expect(argv).toContain('--permission-prompt-tool')
    expect(argv[argv.indexOf('--permission-prompt-tool') + 1]).toBe('mcp__loopkanban__request_permission')
  })

  it('非 supervised 档不挂审批路由；没 gate 时两个旗标都不出现', () => {
    const standard = claudeCliProvider.buildStart({ ...RUN, permission: 'standard', gate: GATE }, CAPS).argv
    expect(standard).not.toContain('--permission-prompt-tool')
    const ungated = claudeCliProvider.buildStart({ ...RUN, permission: 'supervised' }, CAPS).argv
    expect(ungated).not.toContain('--permission-prompt-tool')
    expect(ungated).not.toContain('--mcp-config')
  })

  it('supervised 档也要走续跑路径', () => {
    const argv = claudeCliProvider.buildResume(
      { ...RUN, permission: 'supervised', gate: GATE }, { ...CAPS, canAskUser: true }, 'sess-9',
    )?.argv ?? []
    expect(argv).toContain('--permission-prompt-tool')
    expect(argv).toContain('--mcp-config')
  })
})
