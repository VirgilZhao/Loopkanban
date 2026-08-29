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
    // 等人拍板的决策：创建与收场各一行。细节在决策卡上，这里一行带过即可。
    case 'decision': {
      const payload = p['payload'] as Record<string, unknown> | undefined
      return p['kind'] === 'question'
        ? `提问：${String(payload?.['question'] ?? '')}`
        : `请求权限：${String(payload?.['tool'] ?? '?')}`
    }
    case 'decision_resolved': {
      const status = String(p['status'] ?? '')
      if (p['kind'] === 'question') return status === 'answered' ? '提问已回答' : `提问已收场（${status}）`
      return status === 'allowed'
        ? `已放行${p['answer'] instanceof Object && (p['answer'] as Record<string, unknown>)['auto'] === true ? '（按你的记忆）' : ''}`
        : '已拒绝'
    }
    default: {
      const text = String(p['line'] ?? JSON.stringify(p))
      return text.length > RAW_MAX ? `${text.slice(0, RAW_MAX)}…` : text
    }
  }
}
