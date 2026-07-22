/**
 * 会话持久化相关的纯函数：标题兜底、会话记录归一化、模型配置匹配、
 * 把子助手进度/工具耗时写进消息 metadata 以便重开会话后仍能展示。
 * 从 AgentPage.tsx 拆出。
 */
import { isToolUIPart, type UIMessage } from 'ai'
import type { AgentModelConfig, AgentProgressEvent, AgentScope } from '@/features/aiagent/transport/ipcChatTransport'
import type * as configService from '@/services/config'
import { toolPartProgressKey } from './agentMessageHelpers'

export function buildFallbackConversationTitle(text: string): string {
  const normalized = text
    .replace(/@\S+\[[^\]]+\]/g, '')
    .replace(/[？?。！!，,、：:\s]+/g, ' ')
    .trim()
  return (normalized || '新对话').slice(0, 18)
}

export type AgentConversationRecord = {
  id: number
  accountId?: string
  title: string
  scope?: AgentScope
  modelProvider?: string
  modelId?: string
  source?: string
  externalId?: string | null
  createdAt?: number
  updatedAt: number
}

export type AgentConversationLoaded = AgentConversationRecord & {
  messages: UIMessage[]
}

export const ACTIVE_AGENT_CONVERSATION_KEY = 'ciphertalk.agent.activeConversationId'
export const NEW_AGENT_CONVERSATION_MARKER = 'new'
export const STREAMING_AGENT_SAVE_INTERVAL_MS = 2000

export function readStoredActiveAgentConversation(): number | 'new' | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(ACTIVE_AGENT_CONVERSATION_KEY)
    if (raw === NEW_AGENT_CONVERSATION_MARKER) return 'new'
    const id = Number(raw)
    return Number.isFinite(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

export function storeActiveAgentConversation(id: number | null): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(
      ACTIVE_AGENT_CONVERSATION_KEY,
      id && id > 0 ? String(id) : NEW_AGENT_CONVERSATION_MARKER,
    )
  } catch {
    // 某些受限渲染上下文可能禁用 sessionStorage。
  }
}

export function normalizeConversationRecord(value: any): AgentConversationRecord | null {
  const id = Number(value?.id)
  if (!Number.isFinite(id) || id <= 0) return null
  return {
    id,
    accountId: value?.accountId ? String(value.accountId) : undefined,
    title: String(value?.title || '新对话'),
    scope: value?.scope,
    modelProvider: value?.modelProvider,
    modelId: value?.modelId,
    source: typeof value?.source === 'string' ? value.source : undefined,
    externalId: value?.externalId == null ? null : String(value.externalId),
    createdAt: Number(value?.createdAt || 0) || undefined,
    updatedAt: Number(value?.updatedAt || Date.now()),
  }
}


export function normalizeLoadedConversation(value: any): AgentConversationLoaded | null {
  const record = normalizeConversationRecord(value)
  if (!record) return null
  return {
    ...record,
    messages: Array.isArray(value?.messages) ? value.messages as UIMessage[] : [],
  }
}

export function modelConfigProvider(config: AgentModelConfig | null): string {
  return String(config?.provider || 'current')
}

export function modelConfigId(config: AgentModelConfig | null): string {
  return String(config?.model || '')
}

function normalizeConfigText(value?: string) {
  return String(value || '').trim()
}

function normalizeConfigBaseURL(value?: string) {
  return normalizeConfigText(value).replace(/\/+$/, '')
}

export function presetMatchesCurrentConfig(
  preset: configService.AiConfigPreset,
  provider: string,
  currentConfig: configService.AiProviderConfig | null,
) {
  if (!currentConfig) return false
  return preset.provider === provider
    && normalizeConfigText(preset.apiKey) === normalizeConfigText(currentConfig.apiKey)
    && normalizeConfigText(preset.model) === normalizeConfigText(currentConfig.model)
    && normalizeConfigBaseURL(preset.baseURL) === normalizeConfigBaseURL(currentConfig.baseURL)
    && normalizeConfigText(preset.protocol) === normalizeConfigText(currentConfig.protocol)
}

export function resolveDefaultPresetId(
  presets: configService.AiConfigPreset[],
  provider: string,
  currentConfig: configService.AiProviderConfig | null,
  activePresetId: string,
) {
  const activePreset = presets.find((preset) => preset.id === activePresetId)
  if (activePreset && presetMatchesCurrentConfig(activePreset, provider, currentConfig)) return activePreset.id
  return presets.find((preset) => presetMatchesCurrentConfig(preset, provider, currentConfig))?.id || 'current'
}

export type AgentUsage = {
  inputTokens?: number
  cacheHitRate?: number
  inputTokenDetails?: {
    noCacheTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  outputTokens?: number
  outputTokenDetails?: {
    textTokens?: number
    reasoningTokens?: number
  }
  totalTokens?: number
  raw?: unknown
}

export type AgentTraceStep = {
  stepNumber: number
  callId?: string
  provider?: string
  modelId?: string
  finishReason?: string
  usage?: AgentUsage
  elapsedMs?: number
  responseMs?: number
  timeToFirstOutputMs?: number
  outputTokensPerSecond?: number
  effectiveOutputTokensPerSecond?: number
}

export type AgentTraceTool = {
  toolCallId: string
  toolName: string
  elapsedMs: number
  error?: string
}

export type AgentTraceMetadata = {
  startedAt: number
  finishedAt?: number
  totalElapsedMs?: number
  firstStreamEventMs?: number
  firstOutputMs?: number
  stepCount: number
  toolCount: number
  steps: AgentTraceStep[]
  tools: AgentTraceTool[]
}

export type AgentProviderCacheStatus = {
  providerKind?: string
  providerName?: string
  model?: string
  promptCacheKey?: string
  promptCacheRetention?: '24h' | string
  promptCacheEnabled?: boolean
  promptCacheProvider?: 'openai-responses' | 'anthropic' | 'google' | 'openai-compatible' | 'none' | string
  requestBodyPromptCacheField?: 'prompt_cache_key' | 'promptCacheKey' | string
  reason?: string
}

export type AgentMessageMetadata = {
  usage?: AgentUsage
  finishReason?: string
  rawFinishReason?: string
  modelProvider?: string
  modelId?: string
  /** 计划模式生成的消息：正文是"执行计划"，前端用可折叠卡片展示（默认收起）。 */
  planMode?: boolean
  ciphertalk?: {
    subAgentProgress?: AgentProgressEvent[]
    toolElapsed?: Record<string, number>
    providerCache?: AgentProviderCacheStatus
    trace?: AgentTraceMetadata
  }
}

function isAgentProgressEvent(value: unknown): value is AgentProgressEvent {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<AgentProgressEvent>
  return typeof item.stage === 'string'
    && typeof item.title === 'string'
    && typeof item.at === 'number'
}

export function readSubAgentProgressFromMessage(message: UIMessage): AgentProgressEvent[] {
  const metadata = (message as { metadata?: AgentMessageMetadata }).metadata
  const value = metadata?.ciphertalk?.subAgentProgress
  return Array.isArray(value) ? value.filter(isAgentProgressEvent) : []
}

function progressSignature(events: AgentProgressEvent[]): string {
  return JSON.stringify(events.map((event) => ({
    stage: event.stage,
    title: event.title,
    detail: event.detail,
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    parentToolCallId: event.parentToolCallId,
    subTaskId: event.subTaskId,
    subTaskTitle: event.subTaskTitle,
    depth: event.depth,
    at: event.at,
  })))
}

function attachSubAgentProgressToLastAssistant(messages: UIMessage[], progress: AgentProgressEvent[]): UIMessage[] {
  if (progress.length === 0) return messages
  const targetIndex = [...messages].reverse().findIndex((message) => message.role === 'assistant')
  if (targetIndex < 0) return messages
  const index = messages.length - 1 - targetIndex
  const current = readSubAgentProgressFromMessage(messages[index])
  if (progressSignature(current) === progressSignature(progress)) return messages

  return messages.map((message, i) => {
    if (i !== index) return message
    const metadata = ((message as { metadata?: AgentMessageMetadata }).metadata || {}) as AgentMessageMetadata
    return {
      ...message,
      metadata: {
        ...metadata,
        ciphertalk: {
          ...(metadata.ciphertalk || {}),
          subAgentProgress: progress,
        },
      },
    } as UIMessage
  })
}

export function readToolElapsedFromMessage(message: UIMessage): Record<string, number> {
  const value = (message as { metadata?: AgentMessageMetadata }).metadata?.ciphertalk?.toolElapsed
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [key, ms] of Object.entries(value)) {
    if (typeof ms === 'number' && Number.isFinite(ms)) out[key] = ms
  }
  return out
}

function sameToolElapsed(a: Record<string, number>, b: Record<string, number>): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  return aKeys.every((key) => a[key] === b[key])
}

/** 把工具步骤耗时写进各助手消息 metadata，重开会话后思考链里的工具步骤仍显示 "· X.Xs"。 */
function attachToolElapsedToMessages(messages: UIMessage[], toolElapsedByKey: Record<string, number>): UIMessage[] {
  let changed = false
  const next = messages.map((message) => {
    if (message.role !== 'assistant') return message
    const elapsed: Record<string, number> = {}
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue
      const toolName = part.type.replace(/^tool-/, '')
      const ms = toolElapsedByKey[toolPartProgressKey(part, toolName)]
      if (typeof ms === 'number' && Number.isFinite(ms)) elapsed[toolPartProgressKey(part, toolName)] = ms
    }
    if (Object.keys(elapsed).length === 0) return message
    if (sameToolElapsed(readToolElapsedFromMessage(message), elapsed)) return message
    changed = true
    const metadata = ((message as { metadata?: AgentMessageMetadata }).metadata || {}) as AgentMessageMetadata
    return {
      ...message,
      metadata: {
        ...metadata,
        ciphertalk: {
          ...(metadata.ciphertalk || {}),
          toolElapsed: elapsed,
        },
      },
    } as UIMessage
  })
  return changed ? next : messages
}

export function prepareAgentMessagesForPersist(
  messages: UIMessage[],
  subAgentProgress: AgentProgressEvent[],
  toolElapsedByKey: Record<string, number>,
): UIMessage[] {
  return attachToolElapsedToMessages(
    attachSubAgentProgressToLastAssistant(messages, subAgentProgress),
    toolElapsedByKey,
  )
}

export function signatureAgentMessages(messages: UIMessage[]): string {
  try {
    return JSON.stringify(messages)
  } catch {
    return `${messages.length}:${Date.now()}`
  }
}

export function finiteNumber(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

export function parseAgentMessageMetadata(metadata: unknown): AgentMessageMetadata | null {
  if (!metadata || typeof metadata !== 'object') return null
  const value = metadata as AgentMessageMetadata
  return value.usage && typeof value.usage === 'object' ? value : null
}
