import { createHash } from 'crypto'
import type { ProviderOptions, SystemModelMessage } from '@ai-sdk/provider-utils'
import type { ToolSet } from 'ai'
import { isArkBaseURL } from './arkContextFetch'
import type { AgentReasoningEffort, AgentRunInput } from './types'

export interface AgentPromptParts {
  cacheableSystem: string
  dynamicSystem: string
  /** 每轮必变（当前时间、按问题挑选的技能等）；不进 instructions，由 engine 注入消息尾部以保住前缀缓存。 */
  turnSystem: string
}

export type AnthropicCacheTtl = '5m' | '1h'
const MAX_ANTHROPIC_CACHE_BREAKPOINTS = 4

const CACHEABLE_BUILTIN_TOOL_NAMES = new Set([
  'list_contacts',
  'search_messages',
  'semantic_search',
  'get_context',
  'get_timeline',
  'chat_stats',
  'list_groups',
  'group_members',
  'group_member_ranking',
  'search_moments',
  'moments_stats',
  'query_sql',
  'update_plan',
  'remember',
  'recall',
  'list_memories',
  'forget',
  'consolidate_memory',
  'delegate_analysis',
  'export_chat',
])

function toCamelCase(value: string): string {
  return value.replace(/[-_\s]+([a-zA-Z0-9])/g, (_match, char: string) => char.toUpperCase())
}

function hostFromUrl(url: string): string | null {
  if (!url) return null
  try {
    return new URL(url).host || null
  } catch {
    return null
  }
}

function isOfficialOpenAIResponsesEndpoint(input: AgentRunInput): boolean {
  return input.providerConfig.providerKind === 'openai-responses' &&
    hostFromUrl(input.providerConfig.baseURL) === 'api.openai.com'
}

function isDeepSeekProvider(input: AgentRunInput): boolean {
  if (input.providerConfig.providerKind !== 'openai-compatible') return false
  const text = [input.providerConfig.name, input.providerConfig.baseURL, input.providerConfig.model]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return text.includes('deepseek')
}

function supportsOpenAI24hPromptCache(model: string): boolean {
  return /\b5\.1\b/.test(model.toLowerCase())
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function stableToolSignature(tools: ToolSet): string {
  const items = Object.entries(tools)
    .filter(([name]) => CACHEABLE_BUILTIN_TOOL_NAMES.has(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, tool]) => ({
      name,
      description: tool.description || '',
      title: tool.title || '',
    }))
  return JSON.stringify(items)
}

export function buildPromptCacheKey(parts: AgentPromptParts, tools: ToolSet): string {
  return `ciphertalk:agent:${shortHash(parts.cacheableSystem)}:${shortHash(stableToolSignature(tools))}`
}

function isReasoningEffortSet(effort?: AgentReasoningEffort): effort is AgentReasoningEffort {
  return Boolean(effort)
}

export function buildReasoningOption(config: { reasoningEffort?: AgentReasoningEffort }): AgentReasoningEffort | undefined {
  return isReasoningEffortSet(config.reasoningEffort) ? config.reasoningEffort : undefined
}

function toAnthropicEffort(effort: AgentReasoningEffort): 'low' | 'medium' | 'high' {
  if (effort === 'none') return 'low'
  if (effort === 'xhigh' || effort === 'max') return 'high'
  return effort
}

function toGoogleThinkingConfig(
  effort: AgentReasoningEffort,
  model: string,
): Record<string, unknown> | undefined {
  const normalizedModel = model.toLowerCase()
  if (normalizedModel.includes('gemini-3')) {
    const thinkingLevel = effort === 'none' || effort === 'low' ? 'low' : 'high'
    return { thinkingLevel, includeThoughts: true }
  }
  if (!normalizedModel.includes('gemini-2.5')) {
    return undefined
  }

  const thinkingBudgetByEffort: Record<AgentReasoningEffort, number> = {
    none: 1024,
    low: 2048,
    medium: 4096,
    high: 8192,
    xhigh: 16384,
    // max 是 GPT-5.6 档位；Gemini 2.5 没有对应枚举，沿用当前最高预算。
    max: 16384,
  }
  return { thinkingBudget: thinkingBudgetByEffort[effort], includeThoughts: true }
}

export function buildProviderOptions(input: AgentRunInput, promptCacheKey: string): ProviderOptions | undefined {
  const effort = input.providerConfig.reasoningEffort
  const options: Record<string, Record<string, unknown>> = {}

  if (input.providerConfig.providerKind === 'openai-responses' || input.providerConfig.providerKind === 'codex-subscription' || input.providerConfig.providerKind === 'openai-compatible') {
    const option: Record<string, unknown> = {}
    if (isReasoningEffortSet(effort)) option.reasoningEffort = effort
    if (input.providerConfig.providerKind === 'openai-responses' || input.providerConfig.providerKind === 'codex-subscription') {
      // 让 OpenAI 返回思考摘要（推理模型才有内容，非推理模型会被忽略）；下游 engine 已透传 reasoning 块
      option.reasoningSummary = 'auto'
      option.store = isOfficialOpenAIResponsesEndpoint(input)
      // prompt_cache_key 与 store 无关：官方直连必发；第三方中转透传到上游即可命中，不透传也无害
      option.promptCacheKey = promptCacheKey
      if (option.store && supportsOpenAI24hPromptCache(input.providerConfig.model)) {
        option.promptCacheRetention = '24h'
      }
    } else {
      // @ai-sdk/openai-compatible 只校验 camelCase 标准项；厂商扩展字段要用请求体原名透传。
      // 这里恢复 AI SDK 6 时代 OpenAI-compatible 服务常用的 prompt_cache_key 行为。
      option.prompt_cache_key = promptCacheKey
    }
    if (Object.keys(option).length > 0) {
      const keys = new Set(['openai'])
      if (input.providerConfig.providerKind === 'openai-compatible') {
        keys.add(input.providerConfig.name)
        keys.add(toCamelCase(input.providerConfig.name))
      }
      for (const key of keys) options[key] = option
    }
  }

  if (input.providerConfig.providerKind === 'anthropic' && isReasoningEffortSet(effort)) {
    options.anthropic = {
      effort: toAnthropicEffort(effort),
    }
  }

  if (input.providerConfig.providerKind === 'google' && isReasoningEffortSet(effort)) {
    const thinkingConfig = toGoogleThinkingConfig(effort, input.providerConfig.model)
    if (thinkingConfig) {
      options.google = { thinkingConfig }
    }
  }

  return Object.keys(options).length > 0 ? options as ProviderOptions : undefined
}

export type AgentProviderCacheStatus = {
  providerKind: AgentRunInput['providerConfig']['providerKind']
  providerName: string
  model: string
  promptCacheKey: string
  promptCacheRetention?: '24h'
  promptCacheEnabled: boolean
  promptCacheProvider: 'openai-responses' | 'anthropic' | 'google' | 'openai-compatible' | 'none'
  requestBodyPromptCacheField?: 'prompt_cache_key' | 'promptCacheKey'
  reason?: string
}

export function buildProviderCacheStatus(input: AgentRunInput, promptCacheKey: string): AgentProviderCacheStatus {
  const base = {
    providerKind: input.providerConfig.providerKind,
    providerName: input.providerConfig.name,
    model: input.providerConfig.model,
    promptCacheKey,
  }
  if (isOfficialOpenAIResponsesEndpoint(input)) {
    return {
      ...base,
      ...(supportsOpenAI24hPromptCache(input.providerConfig.model) ? { promptCacheRetention: '24h' as const } : {}),
      promptCacheEnabled: true,
      promptCacheProvider: 'openai-responses',
      requestBodyPromptCacheField: 'promptCacheKey',
    }
  }
  if (input.providerConfig.providerKind === 'openai-responses' || input.providerConfig.providerKind === 'codex-subscription') {
    return {
      ...base,
      promptCacheEnabled: true,
      promptCacheProvider: 'openai-responses',
      requestBodyPromptCacheField: 'promptCacheKey',
      reason: '第三方 responses 端点：已注入 promptCacheKey，是否命中取决于中转是否透传到上游并回传 cached_tokens。',
    }
  }
  if (input.providerConfig.providerKind === 'anthropic') {
    return {
      ...base,
      promptCacheEnabled: true,
      promptCacheProvider: 'anthropic',
      reason: `cache_control 断点 TTL ${input.providerConfig.anthropicCacheTtl || '5m'}（config key anthropicCacheTtl 可切 1h，写入计价 2×）。`,
    }
  }
  if (input.providerConfig.providerKind === 'google') {
    return {
      ...base,
      promptCacheEnabled: true,
      promptCacheProvider: 'google',
      reason: '自动创建 cachedContent 缓存稳定前缀（system+tools，TTL 1h，Google 按 token·小时收存储费）；前缀低于模型最小缓存长度或创建失败时回退直连，命中读 cachedContentTokenCount。',
    }
  }
  if (input.providerConfig.providerKind === 'openai-compatible') {
    if (isArkBaseURL(input.providerConfig.baseURL)) {
      return {
        ...base,
        promptCacheEnabled: true,
        promptCacheProvider: 'openai-compatible',
        requestBodyPromptCacheField: 'prompt_cache_key',
        reason: '火山方舟端点：system 前缀自动走 context 缓存（common_prefix，TTL 1h），创建失败回退直连。',
      }
    }
    if (isDeepSeekProvider(input)) {
      return {
        ...base,
        promptCacheEnabled: true,
        promptCacheProvider: 'openai-compatible',
        requestBodyPromptCacheField: 'prompt_cache_key',
        reason: 'DeepSeek 上下文硬盘缓存默认开启；当前通过隐藏 system 历史消息保持多轮前缀可复现，并读取 prompt_cache_hit_tokens / prompt_cache_miss_tokens。',
      }
    }
    return {
      ...base,
      promptCacheEnabled: true,
      promptCacheProvider: 'openai-compatible',
      requestBodyPromptCacheField: 'prompt_cache_key',
      reason: '已通过 AI SDK openai-compatible 的 transformRequestBody 注入 prompt_cache_key；是否命中取决于服务商是否支持并返回 cached_tokens。',
    }
  }
  return {
    ...base,
    promptCacheEnabled: false,
    promptCacheProvider: 'none',
    reason: '当前 provider 不支持可控 prompt cache 参数。',
  }
}

function withAnthropicCacheControl(providerOptions: ProviderOptions | undefined, ttl: AnthropicCacheTtl): ProviderOptions {
  return {
    ...(providerOptions || {}),
    anthropic: {
      ...((providerOptions?.anthropic as Record<string, unknown> | undefined) || {}),
      cacheControl: { type: 'ephemeral', ttl },
    },
  }
}

export function applyAnthropicCacheControl(
  messages: SystemModelMessage[],
  tools: ToolSet,
  ttl: AnthropicCacheTtl = '5m',
): { messages: SystemModelMessage[]; tools: ToolSet } {
  let remainingBreakpoints = MAX_ANTHROPIC_CACHE_BREAKPOINTS
  const takeBreakpoint = () => {
    if (remainingBreakpoints <= 0) return false
    remainingBreakpoints -= 1
    return true
  }
  const nextMessages = messages.map((message, index) => (
    index === 0 && takeBreakpoint()
      ? { ...message, providerOptions: withAnthropicCacheControl(message.providerOptions, ttl) }
      : message
  ))

  const nextTools: ToolSet = {}
  for (const [name, item] of Object.entries(tools)) {
    nextTools[name] = CACHEABLE_BUILTIN_TOOL_NAMES.has(name) && takeBreakpoint()
      ? { ...item, providerOptions: withAnthropicCacheControl(item.providerOptions, ttl) } as typeof item
      : item
  }

  return { messages: nextMessages, tools: nextTools }
}
