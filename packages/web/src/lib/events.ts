import type { StreamEvent } from '@/types.ts'

/** raw 行是没被识别的原始输出，只留个头，别把整坨 JSON 倒进界面。 */
const RAW_MAX = 140

/** 把一条事件压成一行可读文本。 */
export function summarize(event: StreamEvent): string {
  const p = event.payload
  switch (event.kind) {
    case 'session': {
      // 不同 CLI 给的字段不一样（codex 没有 model / apiKeySource），
      // 缺的就不显示，别用 "?" 占位假装它存在。
      const parts = [String(p['sessionId'] ?? '')]
      if (typeof p['model'] === 'string') parts.push(`model=${p['model']}`)
      if (typeof p['apiKeySource'] === 'string') parts.push(`apiKeySource=${p['apiKeySource']}`)
      return parts.join('  ')
    }
    case 'text': return String(p['text'] ?? '')
    case 'tool': return String(p['name'] ?? '')
    case 'notice': return String(p['text'] ?? '')
    case 'usage': return `in=${String(p['inputTokens'] ?? '-')} out=${String(p['outputTokens'] ?? '-')}${p['costUsd'] === undefined ? '' : ` $${String(p['costUsd'])}`}`
    case 'finished': return `${p['ok'] === true ? 'ok' : 'failed'} ${String(p['diagnostic'] ?? p['summary'] ?? '')}`
    default: {
      const text = String(p['line'] ?? JSON.stringify(p))
      return text.length > RAW_MAX ? `${text.slice(0, RAW_MAX)}…` : text
    }
  }
}
