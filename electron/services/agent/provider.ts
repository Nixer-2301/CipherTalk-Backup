/**
 * 把 provider 配置变成 AI SDK 的 LanguageModel —— 纯函数，不依赖 Electron app/ConfigService，
 * 可在 AI 子进程内调用。逻辑对齐 ai/providers/base.ts 的 getModelProvider()。
 */
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogle } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel, ToolSet } from 'ai'
import type { FilesV4 } from '@ai-sdk/provider'
import { createProxyFetch } from '../ai/proxyFetch'
import { withOpenAIResponsesSanitizer } from '../ai/openaiResponsesSanitizer'
import { CODEX_SUBSCRIPTION_DUMMY_API_KEY, createCodexSubscriptionFetch, getCodexSubscriptionAuthPath } from '../ai/codexSubscriptionAuth'
import { withOpenAICompatibleStreamSanitizer } from '../ai/openaiCompatibleStreamSanitizer'
import { withGoogleExplicitCache } from './googleCacheFetch'
import { isArkBaseURL, withArkContextCache } from './arkContextFetch'
import type { AgentProviderConfig } from './types'

export type AgentLanguageModelOptions = {
  promptCacheKey?: string
}

export type NativeWebSearchProvider = 'openai' | 'google' | 'anthropic'

/** 当前协议是否能通过对应 AI SDK provider 挂载厂商执行的原生联网搜索。 */
export function getNativeWebSearchProvider(config: Pick<AgentProviderConfig, 'providerKind'>): NativeWebSearchProvider | null {
  if (config.providerKind === 'openai-responses' || config.providerKind === 'codex-subscription') return 'openai'
  if (config.providerKind === 'google') return 'google'
  if (config.providerKind === 'anthropic') return 'anthropic'
  return null
}

/**
 * 构造 provider-executed 搜索工具。工具由厂商执行，不带本地 execute；搜索引用会由
 * AI SDK 转成 source 事件，再由 engine.ts 的 toUIMessageStream(sendSources) 发给渲染端。
 */
export function createNativeWebSearchTools(config: Pick<AgentProviderConfig, 'providerKind'>): ToolSet {
  const provider = getNativeWebSearchProvider(config)
  if (provider === 'openai') {
    return {
      web_search: createOpenAI().tools.webSearch({
        externalWebAccess: true,
        searchContextSize: 'medium',
      }),
    }
  }
  if (provider === 'google') {
    return {
      google_search: createGoogle().tools.googleSearch({
        searchTypes: { webSearch: {} },
      }),
    }
  }
  if (provider === 'anthropic') {
    return {
      web_search: createAnthropic().tools.webSearch_20250305({ maxUses: 5 }),
    }
  }
  return {}
}

/**
 * 部分第三方 Claude 代理（如 right.codes/claude-aws）会强制返回 thinking 块却漏掉 signature 字段，
 * 触发 @ai-sdk/anthropic 的 schema 校验失败（Invalid JSON response）。这里在非流式 JSON 响应里
 * 剔除「缺 signature 的 thinking 块」，让合规的 text/tool_use 块照常解析；合规响应原样返回。
 */
function sanitizeAnthropicThinking(bodyText: string): string {
  let parsed: any
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return bodyText
  }
  if (!parsed || parsed.type !== 'message' || !Array.isArray(parsed.content)) return bodyText
  const cleaned = parsed.content.filter(
    (b: any) => !(b && b.type === 'thinking' && (typeof b.signature !== 'string' || b.signature.length === 0)),
  )
  // 剔光会让 content 变空（不该发生，总有 text 块），保险起见保持原样
  if (cleaned.length === parsed.content.length || cleaned.length === 0) return bodyText
  parsed.content = cleaned
  return JSON.stringify(parsed)
}

/** 给 anthropic 的 fetch 包一层：只清洗非流式 JSON 响应，流式(SSE)与非 2xx 一律透传。 */
function withAnthropicSanitizer(baseFetch: typeof globalThis.fetch | undefined): typeof globalThis.fetch {
  const f = baseFetch ?? (globalThis.fetch as typeof globalThis.fetch)
  return (async (input: any, init?: any) => {
    const res = await f(input, init)
    const contentType = res.headers.get('content-type') || ''
    if (!res.ok || !contentType.includes('application/json')) return res
    const text = await res.text()
    const fixed = sanitizeAnthropicThinking(text)
    if (fixed === text) {
      return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers })
    }
    const headers = new Headers(res.headers)
    headers.delete('content-length') // 重写 body 后旧长度失效
    headers.delete('content-encoding') // undici 已解压，别让下游再按 gzip 解
    return new Response(fixed, { status: res.status, statusText: res.statusText, headers })
  }) as typeof globalThis.fetch
}

function injectOpenAICompatiblePromptCacheKey(args: Record<string, any>, promptCacheKey?: string): Record<string, any> {
  if (!promptCacheKey || args.prompt_cache_key) return args
  return { ...args, prompt_cache_key: promptCacheKey }
}

export function createLanguageModel(config: AgentProviderConfig, options: AgentLanguageModelOptions = {}): LanguageModel {
  const { providerKind, name, apiKey, baseURL, model, headers, proxyUrl } = config
  const fetch = createProxyFetch(proxyUrl)

  if (providerKind === 'codex-subscription') {
    const subscriptionFetch = createCodexSubscriptionFetch({
      authFilePath: config.authFilePath || getCodexSubscriptionAuthPath(),
      baseFetch: fetch,
    })
    return createOpenAI({
      apiKey: CODEX_SUBSCRIPTION_DUMMY_API_KEY,
      baseURL: 'https://api.openai.com/v1',
      name,
      fetch: withOpenAIResponsesSanitizer(subscriptionFetch),
    }).responses(model as any)
  }
  if (providerKind === 'anthropic') {
    return createAnthropic({ apiKey, baseURL, name, headers, fetch: withAnthropicSanitizer(fetch) })(model as any)
  }
  if (providerKind === 'google') {
    // 显式 cachedContent 缓存：fetch 层自动创建/复用，见 googleCacheFetch.ts
    return createGoogle({ apiKey, baseURL, name, headers, fetch: withGoogleExplicitCache(fetch) })(model as any)
  }
  if (providerKind === 'openai-responses') {
    return createOpenAI({ apiKey, baseURL, name, headers, fetch: withOpenAIResponsesSanitizer(fetch) }).responses(model as any)
  }

  const compatibleFetch = isArkBaseURL(baseURL) ? withArkContextCache(fetch) : fetch
  return createOpenAICompatible({
    name,
    apiKey,
    baseURL,
    headers,
    includeUsage: true,
    // 火山方舟端点：system 前缀自动走 context 缓存，见 arkContextFetch.ts
    fetch: withOpenAICompatibleStreamSanitizer(compatibleFetch),
    transformRequestBody: (args) => injectOpenAICompatiblePromptCacheKey(args, options.promptCacheKey),
  }).chatModel(model)
}

export function createProviderFilesApi(config: AgentProviderConfig): FilesV4 | null {
  const { providerKind, name, apiKey, baseURL, headers, proxyUrl } = config
  const fetch = createProxyFetch(proxyUrl)

  if (providerKind === 'codex-subscription') return null
  if (providerKind === 'anthropic') {
    return createAnthropic({ apiKey, baseURL, name, headers, fetch: withAnthropicSanitizer(fetch) }).files()
  }
  if (providerKind === 'google') {
    return createGoogle({ apiKey, baseURL, name, headers, fetch }).files()
  }
  if (providerKind === 'openai-responses') {
    return createOpenAI({ apiKey, baseURL, name, headers, fetch: withOpenAIResponsesSanitizer(fetch) }).files()
  }

  return null
}
