import { describe, expect, it } from 'vitest'
import { scrubEnv } from '../src/agents/env.ts'

describe('scrubEnv', () => {
  it('清掉凭证形变量 —— 这是「零 API Key」的执行点', () => {
    const { env, removed } = scrubEnv({
      ANTHROPIC_API_KEY: 'sk-x',
      OPENAI_API_KEY: 'sk-y',
      ANTHROPIC_AUTH_TOKEN: 't',
      GH_ACCESS_TOKEN: 't',
      MY_SECRET: 's',
      DB_PASSWORD: 'p',
      PATH: '/usr/bin',
    })
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined()
    expect(env['OPENAI_API_KEY']).toBeUndefined()
    expect(env['DB_PASSWORD']).toBeUndefined()
    expect(env['PATH']).toBe('/usr/bin')
    expect(removed).toContain('ANTHROPIC_API_KEY')
    expect(removed).toContain('MY_SECRET')
  })

  it('切断父 Agent 会话的身份，避免子进程以为鉴权由宿主代管', () => {
    const { env, removed } = scrubEnv({
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH: '1',
      CLAUDE_CODE_MESSAGING_TOKEN: 'tok',
      CLAUDE_AGENT_SDK_VERSION: '0.3',
      CLAUDE_PID: '123',
      HOME: '/Users/x',
    })
    for (const name of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH', 'CLAUDE_PID']) {
      expect(env[name], `${name} 应被清除`).toBeUndefined()
      expect(removed).toContain(name)
    }
    expect(env['HOME']).toBe('/Users/x')
  })

  it('保留普通环境变量，不能把 CLI 跑所需的东西也洗掉', () => {
    const { env } = scrubEnv({ PATH: '/bin', HOME: '/h', SHELL: '/bin/zsh', LANG: 'zh_CN.UTF-8', TMPDIR: '/tmp', TERM: 'xterm' })
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'PATH', 'SHELL', 'TERM', 'TMPDIR'])
  })

  it('端点类变量保留但如实上报', () => {
    const { env, endpoints } = scrubEnv({ ANTHROPIC_BASE_URL: 'https://gw', HTTPS_PROXY: 'http://p' })
    expect(env['ANTHROPIC_BASE_URL']).toBe('https://gw')
    expect(endpoints).toEqual(['ANTHROPIC_BASE_URL', 'HTTPS_PROXY'])
  })

  it('显式配置在清洗之后叠加，因此可以覆盖', () => {
    const { env } = scrubEnv({ ANTHROPIC_API_KEY: 'from-ambient' }, { ANTHROPIC_API_KEY: 'from-config' })
    // 环境里泄漏进来的会被洗掉；确实要传的必须走显式配置这条唯一通道。
    expect(env['ANTHROPIC_API_KEY']).toBe('from-config')
  })

  it('只上报被清除变量的名字，绝不上报值', () => {
    const { removed } = scrubEnv({ ANTHROPIC_API_KEY: 'sk-super-secret' })
    expect(removed.join(' ')).not.toContain('sk-super-secret')
  })
})

describe('凭证识别的覆盖面（回归）', () => {
  it('裸的 *_TOKEN 也算凭证 —— 此前只认 AUTH_TOKEN / ACCESS_TOKEN 这类复合词', () => {
    const { env, removed } = scrubEnv({
      GITHUB_TOKEN: 'x', GH_TOKEN: 'x', NPM_TOKEN: 'x',
      AWS_SESSION_TOKEN: 'x', HF_TOKEN: 'x', VAULT_TOKEN: 'x',
    })
    expect(Object.keys(env)).toEqual([])
    expect(removed).toHaveLength(6)
  })

  it('按下划线分段匹配，不误伤名字里恰好含 token 的普通变量', () => {
    const { env } = scrubEnv({
      TOKENIZERS_PARALLELISM: 'false',
      TOKEN_BUCKET_SIZE: 'x',
      MY_KEYBOARD_LAYOUT: 'us',
    })
    // TOKENIZERS / KEYBOARD 都不是完整的一段，留下。
    expect(env['TOKENIZERS_PARALLELISM']).toBe('false')
    expect(env['MY_KEYBOARD_LAYOUT']).toBe('us')
    // TOKEN 是完整一段，清掉。
    expect(env['TOKEN_BUCKET_SIZE']).toBeUndefined()
  })
})
