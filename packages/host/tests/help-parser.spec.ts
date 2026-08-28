import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { choicesOf, hasFlag, parseHelp } from '../src/agents/help-parser.ts'

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')

describe('parseHelp', () => {
  it('从 claude 的 help 里解析出关键参数与候选值', () => {
    const surface = parseHelp(fixture('claude-help.txt'))

    for (const flag of ['print', 'output-format', 'verbose', 'resume', 'session-id', 'permission-mode', 'add-dir', 'model']) {
      expect(hasFlag(surface, flag), `缺少 --${flag}`).toBe(true)
    }
    expect(choicesOf(surface, 'output-format')).toEqual(['text', 'json', 'stream-json'])
    expect(choicesOf(surface, 'permission-mode')).toEqual(
      ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'],
    )
  })

  it('从 codex exec 的 help 里解析出 clap 风格的候选值', () => {
    const surface = parseHelp(fixture('codex-exec-help.txt'))

    for (const flag of ['json', 'cd', 'sandbox', 'output-last-message', 'output-schema', 'ephemeral', 'skip-git-repo-check']) {
      expect(hasFlag(surface, flag), `缺少 --${flag}`).toBe(true)
    }
    // 短参数与长参数在同一块里声明，候选值要挂到长参数上。
    expect(choicesOf(surface, 'sandbox')).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
  })

  it('从 opencode run 的 help 里解析出 yargs 风格的候选值', () => {
    const surface = parseHelp(fixture('opencode-run-help.txt'))

    for (const flag of ['format', 'auto', 'dir', 'session', 'model', 'continue', 'agent', 'variant']) {
      expect(hasFlag(surface, flag), `缺少 --${flag}`).toBe(true)
    }
    // 候选值写在描述的下一行，块要跨行收集才拿得到。
    expect(choicesOf(surface, 'format')).toEqual(['default', 'json'])
    expect(choicesOf(surface, 'log-level')).toEqual(['DEBUG', 'INFO', 'WARN', 'ERROR'])
  })

  it('yargs 的 [choices:] 不会被 clap 的 [possible values:] 抢走', () => {
    // 两者都是方括号，先试 clap 再试 yargs，互不干扰。
    const clap = parseHelp('  -s, --sandbox <M>  x [possible values: read-only, workspace-write]\n')
    const yargs = parseHelp('  --format  x  [string] [choices: "default", "json"] [default: "default"]\n')
    expect(choicesOf(clap, 'sandbox')).toEqual(['read-only', 'workspace-write'])
    expect(choicesOf(yargs, 'format')).toEqual(['default', 'json'])
  })

  it('识别 codex exec resume 的 --last', () => {
    expect(hasFlag(parseHelp(fixture('codex-exec-resume-help.txt')), 'last')).toBe(true)
  })

  it('对没见过的参数如实返回 false / 空', () => {
    const surface = parseHelp(fixture('claude-help.txt'))
    expect(hasFlag(surface, 'definitely-not-a-flag')).toBe(false)
    expect(choicesOf(surface, 'verbose')).toEqual([])
  })

  it('空输入不炸', () => {
    const surface = parseHelp('')
    expect(surface.flags.size).toBe(0)
    expect(surface.choices.size).toBe(0)
  })
})
