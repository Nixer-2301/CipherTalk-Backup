/**
 * Google 显式 prompt cache（cachedContent）—— fetch 中间层。
 * @ai-sdk/google 原生支持 providerOptions.google.cachedContent，但 Google API 要求带
 * cachedContent 的请求不得再携带 systemInstruction/tools/toolConfig（二选一，见官方文档），
 * 而 AI SDK 不会自动剥字段。为不侵入 engine 的消息组装，这里在 fetch 层拦截 generateContent：
 * 以（model + systemInstruction + tools + toolConfig）为键自动创建/复用 cachedContent，
 * 命中时改写请求体（剥掉三字段、引用缓存名）；创建失败（前缀低于模型最小缓存长度
 * Flash≈1024/Pro≈4096 token、模型不支持等）记为不支持并原样直连，任何异常都不阻断请求。
 */
import { createHash } from 'crypto'

type FetchLike = typeof globalThis.fetch

// ponytail: TTL 固定 1h；Google 显式缓存按 token·小时收存储费，改档位动这里
const GOOGLE_CACHE_TTL_SECONDS = 3600
/** 到期前提前放弃复用，避免请求路上缓存刚好过期 */
const EXPIRY_SAFETY_MS = 60_000
/** 创建失败后的重试间隔（网络抖动/暂时性错误也会被记为不支持，靠它恢复） */
const UNSUPPORTED_RETRY_MS = 600_000

type CacheEntry =
  | { kind: 'ready'; name: string; expiresAt: number }
  | { kind: 'unsupported'; retryAt: number }

// 进程内注册表：AI 子进程长驻，丢了也只是多一次 create 调用
const cacheRegistry = new Map<string, CacheEntry>()

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

async function resolveCacheEntry(
  f: FetchLike,
  apiBase: string,
  key: string,
  prefix: Record<string, unknown>,
  apiKeyHeader: string | undefined,
): Promise<CacheEntry> {
  const existing = cacheRegistry.get(key)
  if (existing?.kind === 'ready' && existing.expiresAt > Date.now()) return existing
  if (existing?.kind === 'unsupported' && existing.retryAt > Date.now()) return existing

  let entry: CacheEntry = { kind: 'unsupported', retryAt: Date.now() + UNSUPPORTED_RETRY_MS }
  try {
    const response = await f(`${apiBase}/cachedContents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKeyHeader ? { 'x-goog-api-key': apiKeyHeader } : {}),
      },
      body: JSON.stringify({ ...prefix, ttl: `${GOOGLE_CACHE_TTL_SECONDS}s`, displayName: 'ciphertalk-agent-prefix' }),
    })
    if (response.ok) {
      const payload = (await response.json().catch(() => null)) as { name?: unknown } | null
      if (payload?.name) {
        entry = {
          kind: 'ready',
          name: String(payload.name),
          expiresAt: Date.now() + GOOGLE_CACHE_TTL_SECONDS * 1000 - EXPIRY_SAFETY_MS,
        }
      }
    } else {
      await response.text().catch(() => '')
    }
  } catch {
    // 网络失败等按不支持处理，到 retryAt 后重试
  }
  cacheRegistry.set(key, entry)
  return entry
}

/** 包一层 google provider 的 fetch：自动管理 cachedContent。imageGen 等其他 google 调用不要用。 */
export function withGoogleExplicitCache(baseFetch?: FetchLike): FetchLike {
  const f = baseFetch ?? (globalThis.fetch as FetchLike)
  return (async (input: Parameters<FetchLike>[0], init?: RequestInit) => {
    try {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request)?.url || '')
      const method = String(init?.method || 'GET').toUpperCase()
      const match = url.match(/^(.+)\/models\/([^/:?]+):(?:stream)?[gG]enerateContent/)
      if (method !== 'POST' || !match || typeof init?.body !== 'string') return f(input, init)

      const body = JSON.parse(init.body) as Record<string, unknown>
      // 已显式引用缓存、或没有可缓存前缀（无 system 也无 tools）时直连
      if (!body || body.cachedContent || (!body.systemInstruction && !body.tools)) return f(input, init)

      const apiBase = match[1]
      const prefix = {
        model: `models/${match[2]}`,
        ...(body.systemInstruction !== undefined ? { systemInstruction: body.systemInstruction } : {}),
        ...(body.tools !== undefined ? { tools: body.tools } : {}),
        ...(body.toolConfig !== undefined ? { toolConfig: body.toolConfig } : {}),
      }
      const key = hashKey(prefix)
      const entry = await resolveCacheEntry(f, apiBase, key, prefix, headerValue(init, 'x-goog-api-key'))
      if (entry.kind !== 'ready') return f(input, init)

      const { systemInstruction: _system, tools: _tools, toolConfig: _toolConfig, ...rest } = body
      return f(input, { ...init, body: JSON.stringify({ ...rest, cachedContent: entry.name }) })
    } catch {
      return f(input, init) // 中间层任何异常都回退直连
    }
  }) as FetchLike
}
