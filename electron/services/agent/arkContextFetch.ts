/**
 * 火山方舟（Ark）context 前缀缓存 —— fetch 中间层，豆包等 Ark 端点专用。
 * Ark 的 POST /context/create 以 common_prefix 模式把前缀消息缓存到服务端
 * （这里取请求开头的连续 system 消息），之后改走 /context/chat/completions
 * 携带 context_id + 剩余消息，前缀部分按缓存价计费。
 * 端点已实测存在（未授权探测返回 AuthenticationError 而非 404）。
 * 创建失败（中转站没有 context API、模型不支持等）记为不支持并直连；
 * 改写后的请求 4xx 时丢弃缓存条目并原样重发一次，任何异常都不阻断请求。
 */
import { createHash } from 'crypto'

type FetchLike = typeof globalThis.fetch

// ponytail: TTL 固定 1h；Ark context 按存储计费，改档位动这里
const ARK_CONTEXT_TTL_SECONDS = 3600
const EXPIRY_SAFETY_MS = 60_000
const UNSUPPORTED_RETRY_MS = 600_000

type CacheEntry =
  | { kind: 'ready'; contextId: string; expiresAt: number }
  | { kind: 'unsupported'; retryAt: number }

const contextRegistry = new Map<string, CacheEntry>()

/** 是否火山方舟端点（豆包官方 baseURL 形如 https://ark.cn-beijing.volces.com/api/v3）。 */
export function isArkBaseURL(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'volces.com' || host.endsWith('.volces.com')
  } catch {
    return false
  }
}

function hashKey(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers
  if (!headers) return undefined
  if (headers instanceof Headers) return headers.get(name) || undefined
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name)
    return found?.[1]
  }
  const record = headers as Record<string, string>
  const key = Object.keys(record).find((item) => item.toLowerCase() === name)
  return key ? record[key] : undefined
}

async function resolveContext(
  f: FetchLike,
  createUrl: string,
  key: string,
  model: string,
  prefixMessages: unknown[],
  authorization: string | undefined,
): Promise<CacheEntry> {
  const existing = contextRegistry.get(key)
  if (existing?.kind === 'ready' && existing.expiresAt > Date.now()) return existing
  if (existing?.kind === 'unsupported' && existing.retryAt > Date.now()) return existing

  let entry: CacheEntry = { kind: 'unsupported', retryAt: Date.now() + UNSUPPORTED_RETRY_MS }
  try {
    const response = await f(createUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify({ model, mode: 'common_prefix', messages: prefixMessages, ttl: ARK_CONTEXT_TTL_SECONDS }),
    })
    if (response.ok) {
      const payload = (await response.json().catch(() => null)) as { id?: unknown } | null
      if (payload?.id) {
        entry = {
          kind: 'ready',
          contextId: String(payload.id),
          expiresAt: Date.now() + ARK_CONTEXT_TTL_SECONDS * 1000 - EXPIRY_SAFETY_MS,
        }
      }
    } else {
      await response.text().catch(() => '')
    }
  } catch {
    // 网络失败等按不支持处理，到 retryAt 后重试
  }
  contextRegistry.set(key, entry)
  return entry
}

/** 包一层 openai-compatible 的 fetch：Ark 端点自动走 context 前缀缓存。 */
export function withArkContextCache(baseFetch?: FetchLike): FetchLike {
  const f = baseFetch ?? (globalThis.fetch as FetchLike)
  return (async (input: Parameters<FetchLike>[0], init?: RequestInit) => {
    try {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request)?.url || '')
      const method = String(init?.method || 'GET').toUpperCase()
      if (method !== 'POST' || !/\/chat\/completions(\?|$)/.test(url) || url.includes('/context/chat/completions') || typeof init?.body !== 'string') {
        return f(input, init)
      }

      const body = JSON.parse(init.body) as { model?: unknown; messages?: unknown[] } & Record<string, unknown>
      const messages = Array.isArray(body?.messages) ? body.messages : []
      let prefixLength = 0
      while (prefixLength < messages.length && (messages[prefixLength] as { role?: unknown })?.role === 'system') prefixLength += 1
      if (!body?.model || prefixLength === 0) return f(input, init)

      const prefixMessages = messages.slice(0, prefixLength)
      const key = hashKey({ model: body.model, prefixMessages })
      const createUrl = url.replace(/\/chat\/completions(\?.*)?$/, '/context/create')
      const entry = await resolveContext(f, createUrl, key, String(body.model), prefixMessages, headerValue(init, 'authorization'))
      if (entry.kind !== 'ready') return f(input, init)

      const contextUrl = url.replace('/chat/completions', '/context/chat/completions')
      const response = await f(contextUrl, {
        ...init,
        body: JSON.stringify({ ...body, context_id: entry.contextId, messages: messages.slice(prefixLength) }),
      })
      if (response.ok || response.status >= 500 || response.status === 429) return response
      // 4xx：context 过期/参数不兼容，丢条目并原样直连一次
      contextRegistry.delete(key)
      await response.text().catch(() => '')
      return f(input, init)
    } catch {
      return f(input, init) // 中间层任何异常都回退直连
    }
  }) as FetchLike
}
