import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CACHE_TTL_MS, loadModelCatalog, mergeModels, parseCatalog } from '../src/agents/models-dev.ts'

const T0 = 1_800_000_000_000

/** 一份缩到最小的 models.dev 响应。 */
const PAYLOAD = {
  anthropic: {
    models: {
      'claude-sonnet-5': {
        modalities: { output: ['text'] }, tool_call: true, release_date: '2026-01-10',
      },
      'claude-opus-5': {
        modalities: { output: ['text'] }, tool_call: true, release_date: '2026-03-01',
      },
    },
  },
  openai: {
    models: {
      'gpt-5': { modalities: { output: ['text'] }, tool_call: true, release_date: '2025-08-01' },
      'gpt-image-2': { modalities: { output: ['image'] }, tool_call: true, release_date: '2026-01-01' },
      'text-embedding-3-small': { modalities: { output: ['text'] }, release_date: '2024-01-01' },
    },
  },
  // 我们不关心的 provider 一概不看。
  'some-other': { models: { foo: { modalities: { output: ['text'] }, tool_call: true } } },
}

let dir: string
let cachePath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'loopkanban-models-'))
  cachePath = join(dir, 'models-dev.json')
})

afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

/** 假的 fetch。用 vi.fn 本身计数 —— Object.assign 会把 getter 求值成快照。 */
function fakeFetch(body: unknown, ok = true) {
  return vi.fn(() => Promise.resolve({
    ok,
    status: ok ? 200 : 503,
    json: () => Promise.resolve(body),
  } as Response))
}

describe('parseCatalog', () => {
  it('只取 claude 与 codex 要的那两个 provider，按发布日期倒序', () => {
    const catalog = parseCatalog(PAYLOAD)
    expect(Object.keys(catalog).sort()).toEqual(['claude', 'codex'])
    // 新的排前面 —— 人多半想用最新那个。
    expect(catalog['claude']).toEqual(['claude-opus-5', 'claude-sonnet-5'])
  })

  it('干不了活的一律不列：画图的、嵌入的、不支持工具调用的', () => {
    // Agent CLI 没有工具寸步难行，列出来只会让人选中之后一头雾水。
    expect(parseCatalog(PAYLOAD)['codex']).toEqual(['gpt-5'])
  })

  it('第三方的 4MB JSON 里任何一处不合预期，都只跳过那一条', () => {
    expect(parseCatalog(null)).toEqual({})
    expect(parseCatalog({ anthropic: 'nonsense' })).toEqual({})
    expect(parseCatalog({ anthropic: { models: { a: null, b: 42 } } })).toEqual({})
  })
})

describe('loadModelCatalog', () => {
  it('第一次去网上取，并把结果落盘', async () => {
    const get = fakeFetch(PAYLOAD)
    const catalog = await loadModelCatalog({ cachePath, now: () => T0, fetchImpl: get as unknown as typeof fetch })
    expect(catalog['codex']).toEqual(['gpt-5'])
    expect(JSON.parse(await readFile(cachePath, 'utf8'))).toMatchObject({ at: T0 })
  })

  it('缓存没过期就不再联网 —— 说好了一天最多一次', async () => {
    const get = fakeFetch(PAYLOAD)
    await loadModelCatalog({ cachePath, now: () => T0, fetchImpl: get as unknown as typeof fetch })
    await loadModelCatalog({ cachePath, now: () => T0 + CACHE_TTL_MS - 1, fetchImpl: get as unknown as typeof fetch })
    expect(get.mock.calls).toHaveLength(1)
  })

  it('过期了会重取', async () => {
    const get = fakeFetch(PAYLOAD)
    await loadModelCatalog({ cachePath, now: () => T0, fetchImpl: get as unknown as typeof fetch })
    await loadModelCatalog({ cachePath, now: () => T0 + CACHE_TTL_MS + 1, fetchImpl: get as unknown as typeof fetch })
    expect(get.mock.calls).toHaveLength(2)
  })

  it('取不到就用手上的过期缓存 —— 模型名不会一夜之间全变', async () => {
    await writeFile(cachePath, JSON.stringify({ at: T0, catalog: { claude: ['旧的'] } }), 'utf8')
    const catalog = await loadModelCatalog({
      cachePath,
      now: () => T0 + CACHE_TTL_MS + 1,
      fetchImpl: (() => Promise.reject(new Error('离线'))) as unknown as typeof fetch,
    })
    expect(catalog['claude']).toEqual(['旧的'])
  })

  it('既取不到也没缓存就给空 —— 建议缺席比建议错误好', async () => {
    expect(await loadModelCatalog({
      cachePath,
      now: () => T0,
      fetchImpl: fakeFetch({}, false) as unknown as typeof fetch,
    })).toEqual({})
  })
})

describe('mergeModels', () => {
  it('CLI 自己报的排前面，目录补的排后面，去重', () => {
    expect(mergeModels(['opus', 'sonnet'], ['claude-opus-5', 'opus']))
      .toEqual(['opus', 'sonnet', 'claude-opus-5'])
  })
})
