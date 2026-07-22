/**
 * OpenAI Responses 兼容清洗。
 *
 * 部分 OpenAI-compatible 代理会返回近似 /responses 的 JSON，但漏掉 AI SDK 7 schema
 * 要求的空字段（例如 output_text.annotations），导致 200 响应被判为 Invalid JSON response。
 * 这里只修补这些无语义损失的空字段，不改正常官方响应。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stableId(prefix: string, index: number): string {
  return `${prefix}_${index + 1}`
}

function normalizeJsonString(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function normalizeMessageContent(part: Record<string, unknown>): boolean {
  let changed = false
  const type = part.type
  if (type === 'text' || (!type && typeof part.text === 'string')) {
    part.type = 'output_text'
    changed = true
  }
  if (part.type !== 'output_text') return changed

  if (typeof part.text !== 'string') {
    part.text = normalizeJsonString(part.text)
    changed = true
  }
  if (!Array.isArray(part.annotations)) {
    part.annotations = []
    changed = true
  }
  return changed
}

function coerceNumberField(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  if (typeof value === 'number') return false
  if (typeof value !== 'string' || !value.trim()) return false
  const n = Number(value)
  if (!Number.isFinite(n)) return false
  record[key] = n
  return true
}

function normalizeOutputItem(item: Record<string, unknown>, index: number): boolean {
  let changed = false
  if (item.type === 'message') {
    if (typeof item.id !== 'string' || !item.id) {
      item.id = stableId('msg', index)
      changed = true
    }
    if (item.role !== 'assistant') {
      item.role = 'assistant'
      changed = true
    }
    if (!Array.isArray(item.content)) {
      item.content = []
      changed = true
    }
    const content = (item.content as unknown[]).filter(isRecord)
    item.content = content
    for (let i = 0; i < content.length; i += 1) {
      changed = normalizeMessageContent(content[i]) || changed
    }
    return changed
  }

  if (item.type === 'reasoning') {
    if (typeof item.id !== 'string' || !item.id) {
      item.id = stableId('reasoning', index)
      changed = true
    }
    if (!Array.isArray(item.summary)) {
      item.summary = []
      changed = true
    } else {
      item.summary = item.summary.map((summary) => {
        if (typeof summary === 'string') {
          changed = true
          return { type: 'summary_text', text: summary }
        }
        return summary
      })
    }
    return changed
  }

  if (item.type === 'function_call') {
    if (typeof item.id !== 'string' || !item.id) {
      item.id = stableId('fc', index)
      changed = true
    }
    if (typeof item.call_id !== 'string' || !item.call_id) {
      item.call_id = String(item.id)
      changed = true
    }
    if (typeof item.arguments !== 'string') {
      item.arguments = normalizeJsonString(item.arguments)
      changed = true
    }
    return changed
  }

  if (item.type === 'custom_tool_call') {
    if (typeof item.id !== 'string' || !item.id) {
      item.id = stableId('ctc', index)
      changed = true
    }
    if (typeof item.call_id !== 'string' || !item.call_id) {
      item.call_id = String(item.id)
      changed = true
    }
    if (typeof item.input !== 'string') {
      item.input = normalizeJsonString(item.input)
      changed = true
    }
  }
  return changed
}

function normalizeUsage(payload: Record<string, unknown>): boolean {
  const usage = payload.usage
  if (usage == null) return false
  if (!isRecord(usage)) {
    delete payload.usage
    return true
  }

  let changed = false
  changed = coerceNumberField(usage, 'input_tokens') || changed
  changed = coerceNumberField(usage, 'output_tokens') || changed
  if (typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') {
    delete payload.usage
    return true
  }
  return changed
}

export function sanitizeOpenAIResponsesJson(bodyText: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return bodyText
  }
  if (!isRecord(parsed) || parsed.object !== 'response' || !Array.isArray(parsed.output)) {
    return bodyText
  }

  let changed = false
  changed = normalizeUsage(parsed) || changed
  for (let i = 0; i < parsed.output.length; i += 1) {
    const item = parsed.output[i]
    if (!isRecord(item)) continue
    changed = normalizeOutputItem(item, i) || changed
  }

  if (!changed) return bodyText
  return JSON.stringify(parsed)
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url || ''
}

export function withOpenAIResponsesSanitizer(baseFetch: typeof globalThis.fetch | undefined): typeof globalThis.fetch {
  const f = baseFetch ?? (globalThis.fetch as typeof globalThis.fetch)
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await f(input, init)
    const url = requestUrl(input)
    const contentType = res.headers.get('content-type') || ''
    if (!res.ok || !/\/responses(?:\?|$)/.test(url) || !contentType.includes('application/json')) {
      return res
    }

    const text = await res.text()
    const fixed = sanitizeOpenAIResponsesJson(text)
    const headers = new Headers(res.headers)
    if (fixed !== text) {
      headers.delete('content-length')
      headers.delete('content-encoding')
    }
    return new Response(fixed, { status: res.status, statusText: res.statusText, headers })
  }) as typeof globalThis.fetch
}
