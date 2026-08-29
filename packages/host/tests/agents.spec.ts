/**
 * 抽象层本身的约束。
 *
 * 这些用例守的不是某个 CLI 的行为，而是"再接一个 CLI 时，除了写它自己的
 * provider 文件，别处不用改"这件事 —— 一旦有人把新 CLI 的名字写进宿主，
 * 或者漏填了 provider 该声明的事实，这里先失败。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { AgentPool, ALL_PROVIDERS, detectAgents, knownCommands, type DetectedAgent } from '../src/agents/index.ts'
import { parseHelp } from '../src/agents/help-parser.ts'
import { catalogSources, parseCatalog } from '../src/agents/models-dev.ts'
import type { AgentProvider } from '../src/agents/types.ts'

const SRC = join(import.meta.dirname, '../src')

describe('provider 注册表', () => {
  it('每个 provider 都声明了 id 与可执行文件名', () => {
    for (const provider of ALL_PROVIDERS) {
      expect(provider.id.length).toBeGreaterThan(0)
      expect(provider.command.length).toBeGreaterThan(0)
    }
  })

  it('id 不重复 —— 重名会让任务派给谁变成运气', () => {
    const ids = ALL_PROVIDERS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('"我找过谁"这句话从注册表里长出来，不是手抄的', () => {
    expect(knownCommands()).toEqual(ALL_PROVIDERS.map((p) => p.command))
  })

  it('探测不到的 provider 不进清单，坏掉的也不拖垮其余', async () => {
    const missing: AgentProvider = {
      ...ALL_PROVIDERS[0] as AgentProvider,
      id: '装了个寂寞', command: 'nope', probe: () => Promise.resolve(null),
    }
    const broken: AgentProvider = {
      ...ALL_PROVIDERS[0] as AgentProvider,
      id: '坏的', command: 'boom', probe: () => Promise.reject(new Error('探测炸了')),
    }
    const ok: AgentProvider = {
      ...ALL_PROVIDERS[0] as AgentProvider,
      id: '好的', command: 'fine',
      probe: () => Promise.resolve({
        id: '好的', bin: '/fake', version: '1.0', streaming: true,
        canPinSessionId: false, canResume: false, canPickModel: false,
        models: [], permissionTiers: ['standard'], canAskUser: false, canPromptPermission: false,
        help: parseHelp(''),
      }),
    }
    const found = await detectAgents({}, [missing, broken, ok])
    expect(found.map((f) => f.provider.id)).toEqual(['好的'])
  })
})

describe('AgentPool —— 可刷新的活视图', () => {
  const fake = (id: string): DetectedAgent => ({
    provider: { ...ALL_PROVIDERS[0] as AgentProvider, id, command: id },
    caps: {
      id, bin: `/fake/${id}`, version: '1.0', streaming: true,
      canPinSessionId: false, canResume: false, canPickModel: false,
      models: [], permissionTiers: ['standard'], canAskUser: false, canPromptPermission: false, help: parseHelp(''),
    },
  })

  it('刷完之后 list() 给的是新的 —— 拿着旧快照就等于要重启', async () => {
    let found = [fake('甲')]
    const pool = new AgentPool(() => Promise.resolve(found))
    expect(pool.list()).toEqual([])

    await pool.refresh()
    expect(pool.list().map((a) => a.provider.id)).toEqual(['甲'])

    // 装上了一个新的 CLI。
    found = [fake('甲'), fake('乙')]
    await pool.refresh()
    expect(pool.list().map((a) => a.provider.id)).toEqual(['甲', '乙'])
  })

  it('卸载干净就如实变空 —— 这不是失败，是事实', async () => {
    let found = [fake('甲')]
    const pool = new AgentPool(() => Promise.resolve(found))
    await pool.refresh()
    found = []
    expect(await pool.refresh()).toEqual([])
    expect(pool.list()).toEqual([])
  })

  it('探测整个炸了就留着原来那份 —— 一次抖动不该让所有卡无处可派', async () => {
    let boom = false
    const pool = new AgentPool(() => boom
      ? Promise.reject(new Error('探测炸了'))
      : Promise.resolve([fake('甲')]))
    await pool.refresh()

    boom = true
    await expect(pool.refresh()).rejects.toThrow('探测炸了')
    expect(pool.list().map((a) => a.provider.id)).toEqual(['甲'])
  })

  it('连点几下只探测一次 —— 每次探测都要为每个 CLI 起子进程', async () => {
    let calls = 0
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const pool = new AgentPool(async () => {
      calls += 1
      await gate
      return [fake('甲')]
    })

    const all = Promise.all([pool.refresh(), pool.refresh(), pool.refresh()])
    release()
    await all
    expect(calls).toBe(1)

    // 但那一次结束之后，下一次点击要能真的再探一遍。
    await pool.refresh()
    expect(calls).toBe(2)
  })
})

describe('模型目录的来源由 provider 自己声明', () => {
  it('只收集填了 catalogSource 的那些', () => {
    const sources = catalogSources()
    for (const [id, key] of Object.entries(sources)) {
      expect(ALL_PROVIDERS.find((p) => p.id === id)?.catalogSource).toBe(key)
    }
    // 自己能列模型的 CLI 不该出现在这里 —— 它自报的比外部目录准。
    for (const provider of ALL_PROVIDERS) {
      if (provider.catalogSource === undefined) expect(sources[provider.id]).toBeUndefined()
    }
  })

  it('换一份 sources 就换一批 provider，解析器本身不认识任何 CLI', () => {
    const payload = {
      某家: { models: { 'm-1': { modalities: { output: ['text'] }, tool_call: true, release_date: '2026-01-01' } } },
    }
    expect(parseCatalog(payload, { 新接的: '某家' })).toEqual({ 新接的: ['m-1'] })
    expect(parseCatalog(payload, {})).toEqual({})
  })
})

describe('宿主不认识具体的 CLI', () => {
  /** 注册表是唯一有权认识具体 provider 的地方，检查时排除它自己。 */
  const REGISTRY = join(SRC, 'agents', 'index.ts')

  /** 递归收集 src 下除 providers 目录与注册表之外的所有源码。 */
  function hostSources(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'providers') out.push(...hostSources(path))
      } else if (entry.name.endsWith('.ts') && path !== REGISTRY) {
        out.push(path)
      }
    }
    return out
  }

  /**
   * 去掉注释，只留下真正会执行的代码。
   *
   * 注释里提到某个 CLI 是**解释**（"claude 支持预先指定会话 id"），是好东西；
   * 代码里提到才是分支。只看后者。
   */
  function stripComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  }

  it('宿主代码里根本不出现 provider id 的字面量 —— 要分支就说明抽象少了个字段', () => {
    /*
     * 直接找 id 字面量，而不是找 `provider.id === 'x'` 这一种写法。
     *
     * 只匹配那一种的话，`switch (provider.id) { case 'gemini': }`、
     * `const { id } = agent.provider; if (id === 'gemini')`、
     * `['claude','codex'].includes(provider.id)` 全都能大摇大摆地过 ——
     * 而这三种恰恰就是这条规矩要挡的东西。字面量出现即失败，不给它们绕路。
     */
    const ids = ALL_PROVIDERS.map((provider) => provider.id)
    const offenders: string[] = []
    for (const path of hostSources(SRC)) {
      const code = stripComments(readFileSync(path, 'utf8'))
      for (const id of ids) {
        for (const match of code.matchAll(new RegExp(`['"\`]${id}['"\`]`, 'g'))) {
          offenders.push(`${path}:${String(code.slice(0, match.index).split('\n').length)} 提到了 ${id}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('注册表之外的宿主代码不 import 任何具体 provider', () => {
    const offenders = hostSources(SRC)
      .filter((path) => /from '.*providers\/[\w-]+\.ts'/.test(readFileSync(path, 'utf8')))
    expect(offenders).toEqual([])
  })
})
