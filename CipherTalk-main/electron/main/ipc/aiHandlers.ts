import { ipcMain } from 'electron'
import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { UIMessage } from 'ai'
import type { ConfigService } from '../../services/config'
import type { MainProcessContext } from '../context'
import type { AgentPromptOptimizeContextMessage, AgentProviderConfig, AgentProviderConfigOverride, AgentReasoningEffort, AgentScope, AgentSkillContextItem, AgentToolProfile, AgentUploadedMediaContext } from '../../services/agent/types'
import type { CodeWorkspaceRef } from '../../services/agent/codeWorkspaceTypes'
import type { PersonaCard, PersonaNotes, PersonaRecord, PersonaTtsVoiceBinding } from '../../services/agent/persona/personaTypes'
import { formatAgentError } from '../../services/agent/errorFormat'

/** 进行中的 agent 运行：runId → AbortController，用于取消。 */
const agentAborters = new Map<string, AbortController>()
const ttsStreamAborters = new Map<string, AbortController>()
const AGENT_RUN_PROXY_CACHE_TTL_MS = 5 * 60 * 1000
const AGENT_PREP_PROGRESS_TITLE = '大模型准备中'
const TOOL_APPROVAL_SIGNATURE_TTL_MS = 2 * 60 * 60 * 1000
const TOOL_APPROVAL_SIGNATURE_CACHE_MAX = 500
const INTERNAL_TURN_CONTEXT_KIND = 'agent-turn-context'

type ToolApprovalSignatureCacheItem = {
  toolCallId: string
  signature: string
  at: number
}

const toolApprovalSignatureCache = new Map<string, ToolApprovalSignatureCacheItem>()
// App 完整重启后 toolApprovalSignatureCache 会清空，靠这份落盘副本重建，见 registerAiHandlers 里的加载和 persistToolApprovalSignatureCache
let toolApprovalCacheConfigService: ConfigService | null = null

let agentRunProxyRefreshedAt = 0
let agentRunProxyRefreshPromise: Promise<string | null> | null = null

async function refreshAgentRunProxyCached(refreshResolvedProxyUrl: () => Promise<string | null>): Promise<string | null> {
  const now = Date.now()
  if (agentRunProxyRefreshPromise) return agentRunProxyRefreshPromise
  if (now - agentRunProxyRefreshedAt < AGENT_RUN_PROXY_CACHE_TTL_MS) return null

  agentRunProxyRefreshPromise = refreshResolvedProxyUrl()
    .finally(() => {
      agentRunProxyRefreshedAt = Date.now()
      agentRunProxyRefreshPromise = null
    })

  return agentRunProxyRefreshPromise
}

function textFromUiMessage(message: UIMessage): string {
  const anyMessage = message as any
  if (typeof anyMessage.content === 'string') return anyMessage.content
  if (!Array.isArray(anyMessage.parts)) return ''
  return anyMessage.parts
    .map((part: any) => {
      if (!part || typeof part !== 'object') return ''
      if (part.type === 'text') return String(part.text || '')
      if (typeof part.text === 'string') return part.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function lastUserTextFromUiMessages(messages: UIMessage[] = []): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return textFromUiMessage(messages[i])
  }
  return ''
}

function stableUiMessageKey(message: UIMessage, fallbackIndex: number): string {
  const anyMessage = message as any
  const id = typeof anyMessage?.id === 'string' ? anyMessage.id.trim() : ''
  if (id) return `id:${id}`
  try {
    return `body:${String(anyMessage?.role || '')}:${JSON.stringify(anyMessage?.parts ?? anyMessage?.content ?? null)}`
  } catch {
    return `idx:${fallbackIndex}:${String(anyMessage?.role || '')}`
  }
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function uiMessageId(message: UIMessage | undefined): string {
  const id = (message as any)?.id
  return typeof id === 'string' ? id : ''
}

function internalTurnContextMeta(message: UIMessage | undefined): { targetUserMessageId?: string } | null {
  const meta = (message as any)?.metadata?.ciphertalk?.internal
  if (!meta || typeof meta !== 'object') return null
  if ((meta as any).kind !== INTERNAL_TURN_CONTEXT_KIND) return null
  return {
    targetUserMessageId: typeof (meta as any).targetUserMessageId === 'string'
      ? (meta as any).targetUserMessageId
      : undefined,
  }
}

function isInternalTurnContextMessage(message: UIMessage | undefined): boolean {
  return Boolean(internalTurnContextMeta(message))
}

function stripInternalTurnContextMessages(messages: UIMessage[] = []): UIMessage[] {
  return messages.filter((message) => !isInternalTurnContextMessage(message))
}

function stripInternalTurnContextFromConversation<T extends { messages?: UIMessage[] }>(conversation: T): T {
  if (!Array.isArray(conversation.messages)) return conversation
  return { ...conversation, messages: stripInternalTurnContextMessages(conversation.messages) }
}

function stripHistoricalToolPartsForModel(messages: UIMessage[] = []): UIMessage[] {
  const lastUserIndex = findLastUserMessageIndex(messages)
  if (lastUserIndex < 0 || lastUserIndex !== messages.length - 1) return messages
  let changed = false
  const next = messages.map((message, index) => {
    if (index >= lastUserIndex || message.role !== 'assistant' || !Array.isArray((message as any).parts)) return message
    const parts = ((message as any).parts as any[]).filter((part) => {
      const keep = !(part && typeof part.type === 'string' && part.type.startsWith('tool-'))
      if (!keep) changed = true
      return keep
    })
    return parts.length === (message as any).parts.length ? message : { ...message, parts } as UIMessage
  })
  return changed ? next : messages
}

function countToolParts(messages: UIMessage[] = []): number {
  let count = 0
  for (const message of messages) {
    const parts = Array.isArray((message as any)?.parts) ? (message as any).parts as any[] : []
    for (const part of parts) {
      if (part && typeof part.type === 'string' && part.type.startsWith('tool-')) count += 1
    }
  }
  return count
}

function preserveInternalTurnContextMessages(dbMessages: UIMessage[] = [], incomingMessages: UIMessage[] = []): UIMessage[] {
  const next = incomingMessages.filter((message) => !isInternalTurnContextMessage(message))
  const existingIds = new Set(next.map((message) => uiMessageId(message)).filter(Boolean))
  const internals = dbMessages.filter(isInternalTurnContextMessage)
  for (const internal of internals) {
    const id = uiMessageId(internal)
    if (id && existingIds.has(id)) continue
    const targetUserMessageId = internalTurnContextMeta(internal)?.targetUserMessageId
    const targetIndex = targetUserMessageId
      ? next.findIndex((message) => uiMessageId(message) === targetUserMessageId)
      : -1
    if (targetIndex >= 0) next.splice(targetIndex, 0, internal)
  }
  return next
}

function isDeepSeekProvider(config: AgentProviderConfig): boolean {
  if (config.providerKind !== 'openai-compatible') return false
  const text = [config.name, config.baseURL, config.model].filter(Boolean).join(' ').toLowerCase()
  return text.includes('deepseek')
}

function findLastUserMessageIndex(messages: UIMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return i
  }
  return -1
}

async function buildDeepSeekHistoryTurnContext(opts: {
  scope: AgentScope
  skills: AgentSkillContextItem[]
  queryText: string
  planMode: boolean
  codeWorkspace: CodeWorkspaceRef | null
  toolsDisabled?: boolean
  includeWechatOutbound?: boolean
  includeWechatReplyMedia?: boolean
}): Promise<string> {
  const [
    prompts,
    memory,
    runtimeCache,
    imageGen,
  ] = await Promise.all([
    import('../../services/agent/prompts'),
    import('../../services/agent/tools/memory'),
    import('../../services/agent/runtimeCache'),
    import('../../services/ai/imageGenService'),
  ])
  const promptParts = prompts.buildAgentPromptParts(opts.scope, opts.skills, {
    includeWechatOutbound: opts.includeWechatOutbound === true,
    includeWechatReplyMedia: opts.includeWechatReplyMedia === true,
  })
  const toolsDisabled = opts.toolsDisabled === true
  const cachedMemoryContext = runtimeCache.getCachedStartupMemory(opts.scope)
  const memoryContext = cachedMemoryContext ?? ''
  if (cachedMemoryContext === null) {
    runtimeCache.warmStartupMemory(opts.scope, () => memory.buildMemoryContext(opts.scope))
  }
  const relevantMemoryContext = await memory.preloadRelevantMemories(opts.queryText, opts.scope)
  return [
    '# 本轮内部上下文',
    '以下内容只适用于紧随其后的用户消息；后续回合若出现新的同类 system 消息，以新的为准。',
    promptParts.dynamicSystem,
    opts.planMode ? prompts.PLAN_MODE_PROMPT : '',
    opts.codeWorkspace ? prompts.CODE_WORKSPACE_PROMPT : '',
    !toolsDisabled && imageGen.isImageGenAvailable() ? prompts.IMAGE_GEN_PROMPT : '',
    memoryContext,
    promptParts.turnSystem,
    relevantMemoryContext,
  ].filter(Boolean).join('\n')
}

async function upsertDeepSeekHistoryTurnContextMessage(opts: {
  messages: UIMessage[]
  providerConfig: AgentProviderConfig
  scope: AgentScope
  skills: AgentSkillContextItem[]
  queryText: string
  planMode: boolean
  codeWorkspace: CodeWorkspaceRef | null
}): Promise<{ messages: UIMessage[]; changed: boolean; mode: 'history' | 'tail' }> {
  if (!isDeepSeekProvider(opts.providerConfig)) {
    return { messages: opts.messages, changed: false, mode: 'tail' }
  }
  const lastUserIndex = findLastUserMessageIndex(opts.messages)
  if (lastUserIndex < 0) return { messages: opts.messages, changed: false, mode: 'tail' }
  const userMessage = opts.messages[lastUserIndex]
  const userId = uiMessageId(userMessage) || `user-${shortHash(JSON.stringify((userMessage as any)?.parts ?? userMessage))}`
  const previous = opts.messages[lastUserIndex - 1]
  if (internalTurnContextMeta(previous)?.targetUserMessageId === userId) {
    return { messages: opts.messages, changed: false, mode: 'history' }
  }

  const content = await buildDeepSeekHistoryTurnContext({
    scope: opts.scope,
    skills: opts.skills,
    queryText: opts.queryText,
    planMode: opts.planMode,
    codeWorkspace: opts.codeWorkspace,
  })
  if (!content.trim()) return { messages: opts.messages, changed: false, mode: 'tail' }

  const message: UIMessage = {
    id: `ct-turn-context-${userId}-${shortHash(content)}`,
    role: 'system',
    metadata: {
      ciphertalk: {
        internal: {
          kind: INTERNAL_TURN_CONTEXT_KIND,
          targetUserMessageId: userId,
          provider: 'deepseek',
        },
      },
    },
    parts: [{ type: 'text', text: content }],
  } as UIMessage

  const next = opts.messages.filter((item) => {
    const meta = internalTurnContextMeta(item)
    return !meta || meta.targetUserMessageId !== userId
  })
  const targetIndex = findLastUserMessageIndex(next)
  if (targetIndex < 0) return { messages: opts.messages, changed: false, mode: 'tail' }
  next.splice(targetIndex, 0, message)
  return { messages: next, changed: true, mode: 'history' }
}

function uiMessageTextLength(message: UIMessage): number {
  const parts = Array.isArray((message as any)?.parts) ? (message as any).parts as any[] : []
  return parts.reduce((sum, part) => (
    sum + (part?.type === 'text' && typeof part.text === 'string' ? part.text.length : 0)
  ), 0)
}

function uiMessageCompletenessScore(message: UIMessage): number {
  const anyMessage = message as any
  const parts = Array.isArray(anyMessage?.parts) ? anyMessage.parts as any[] : []
  const metadata = anyMessage?.metadata && typeof anyMessage.metadata === 'object' ? anyMessage.metadata as any : null
  let score = 0
  score += parts.length * 10
  score += uiMessageTextLength(message)
  if (metadata?.usage) score += 100_000
  if (metadata?.finishReason || metadata?.rawFinishReason) score += 50_000
  if (metadata?.ciphertalk?.trace?.finishedAt) score += 25_000
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'text' && part.state === 'done') score += 1_000
    if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
      if (part.state === 'output-available' || part.state === 'output-error' || part.state === 'output-denied') score += 2_000
      else if (part.state) score += 500
    }
  }
  return score
}

function pickMoreCompleteUiMessage(current: UIMessage, incoming: UIMessage): UIMessage {
  const currentScore = uiMessageCompletenessScore(current)
  const incomingScore = uiMessageCompletenessScore(incoming)
  if (incomingScore !== currentScore) return incomingScore > currentScore ? incoming : current
  return uiMessageTextLength(incoming) >= uiMessageTextLength(current) ? incoming : current
}

function mergeUiMessagesById(dbMessages: UIMessage[] = [], incomingMessages: UIMessage[] = []): UIMessage[] {
  const indexByKey = new Map<string, number>()
  const merged: UIMessage[] = []
  const push = (message: UIMessage, index: number) => {
    if (!message || typeof message !== 'object') return
    const key = stableUiMessageKey(message, index)
    const existingIndex = indexByKey.get(key)
    if (existingIndex !== undefined) {
      merged[existingIndex] = pickMoreCompleteUiMessage(merged[existingIndex], message)
      return
    }
    indexByKey.set(key, merged.length)
    merged.push(message)
  }
  dbMessages.forEach(push)
  incomingMessages.forEach(push)
  return merged
}

function localDateKey(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function extractUploadedMediaContext(messages: UIMessage[] = []): AgentUploadedMediaContext | undefined {
  let userMessage: UIMessage | undefined
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      userMessage = messages[i]
      break
    }
  }
  const parts = Array.isArray((userMessage as any)?.parts) ? (userMessage as any).parts as any[] : []
  const images = parts
    .filter((part) => part && part.type === 'file' && typeof part.url === 'string' && String(part.mediaType || '').startsWith('image/'))
    .map((part, index) => ({
      id: `upload-${index + 1}`,
      mediaType: String(part.mediaType || 'image/png'),
      filename: typeof part.filename === 'string' ? part.filename : undefined,
      dataUrl: String(part.url || ''),
      sizeBytes: Number.isFinite(Number(part.sizeBytes)) ? Number(part.sizeBytes) : undefined,
    }))
    .filter((item) => item.dataUrl.startsWith('data:image/'))
    .slice(0, 6)
  return images.length > 0 ? { images } : undefined
}

function sanitizePersonaVoiceForRenderer(ttsVoice: PersonaTtsVoiceBinding | null | undefined): PersonaTtsVoiceBinding | null {
  if (!ttsVoice) return null
  const { samplePath: _samplePath, ...safeVoice } = ttsVoice
  return safeVoice as PersonaTtsVoiceBinding
}

function sanitizePersonaForRenderer(persona: PersonaRecord | null | undefined): PersonaRecord | null {
  if (!persona) return null
  return {
    ...persona,
    ttsVoice: sanitizePersonaVoiceForRenderer(persona.ttsVoice),
  }
}

function sanitizePersonaStyleText(value: unknown, maxLength: number): string {
  return String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, maxLength)
}

function sanitizePersonaStyleList(value: unknown, maxItems = 20, maxItemLength = 80): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const items: string[] = []
  for (const item of value) {
    const text = sanitizePersonaStyleText(item, maxItemLength)
    if (!text || seen.has(text)) continue
    seen.add(text)
    items.push(text)
    if (items.length >= maxItems) break
  }
  return items
}

function sanitizePersonaSpeakingStylePatch(card: Partial<PersonaCard> | undefined, current: PersonaCard): PersonaCard {
  const patch = card || {}
  return {
    tone: 'tone' in patch ? sanitizePersonaStyleText(patch.tone, 1200) : current.tone,
    personalityTraits: 'personalityTraits' in patch
      ? sanitizePersonaStyleList(patch.personalityTraits)
      : current.personalityTraits,
    catchphrases: 'catchphrases' in patch
      ? sanitizePersonaStyleList(patch.catchphrases)
      : current.catchphrases,
    punctuationStyle: 'punctuationStyle' in patch ? sanitizePersonaStyleText(patch.punctuationStyle, 600) : current.punctuationStyle,
    addressing: 'addressing' in patch ? sanitizePersonaStyleText(patch.addressing, 200) : current.addressing,
    topics: 'topics' in patch ? sanitizePersonaStyleList(patch.topics) : current.topics,
    ttsInstructions: 'ttsInstructions' in patch ? sanitizePersonaStyleText(patch.ttsInstructions, 1000) : current.ttsInstructions,
  }
}

function scopeToLogData(scope?: AgentScope): Record<string, unknown> {
  if (!scope || scope.kind === 'global') return { scopeKind: 'global' }
  return {
    scopeKind: 'session',
    sessionId: scope.sessionId,
    hasDisplayName: Boolean(scope.displayName),
  }
}

function hostFromUrl(url: string): string | null {
  if (!url) return null
  try {
    return new URL(url).host || null
  } catch {
    return null
  }
}

function shouldStripProviderMetadata(providerConfig: AgentProviderConfig): boolean {
  if (providerConfig.providerKind !== 'openai-responses') return false
  const host = hostFromUrl(providerConfig.baseURL)
  return providerConfig.name === 'custom' || (host !== null && host !== 'api.openai.com')
}

function stripRemoteResponseRefs(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripRemoteResponseRefs(item))
  }
  if (!value || typeof value !== 'object') return value

  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      key === 'providerMetadata' ||
      key === 'callProviderMetadata' ||
      key === 'resultProviderMetadata' ||
      key === 'providerOptions' ||
      key === 'itemId' ||
      key === 'item_id' ||
      key === 'responseId' ||
      key === 'response_id' ||
      key === 'previousResponseId' ||
      key === 'previous_response_id'
    ) {
      continue
    }
    if (typeof child === 'string' && /^(msg|rs|resp)_[A-Za-z0-9_-]+$/.test(child)) {
      continue
    }
    out[key] = stripRemoteResponseRefs(child)
  }
  return out
}

function stripUiMessageProviderMetadata(messages: UIMessage[] = []): UIMessage[] {
  return stripRemoteResponseRefs(messages) as UIMessage[]
}

function providerToLogData(providerConfig: AgentProviderConfig): Record<string, unknown> {
  return {
    provider: providerConfig.name,
    protocol: providerConfig.providerKind,
    model: providerConfig.model,
    baseURLHost: hostFromUrl(providerConfig.baseURL),
    hasBaseURL: Boolean(providerConfig.baseURL),
    hasApiKey: Boolean(providerConfig.apiKey),
    hasProxy: Boolean(providerConfig.proxyUrl),
    reasoningEffort: providerConfig.reasoningEffort || null,
  }
}

function errorToLogData(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack }
  }
  return { message: String(error) }
}

function persistToolApprovalSignatureCache(): void {
  if (!toolApprovalCacheConfigService) return
  const entries = Array.from(toolApprovalSignatureCache.entries())
    .map(([approvalId, item]) => ({ approvalId, ...item }))
  toolApprovalCacheConfigService.set('agentToolApprovalSignatures', entries)
}

function pruneToolApprovalSignatureCache(now = Date.now()): void {
  for (const [approvalId, item] of toolApprovalSignatureCache.entries()) {
    if (now - item.at > TOOL_APPROVAL_SIGNATURE_TTL_MS) toolApprovalSignatureCache.delete(approvalId)
  }
  while (toolApprovalSignatureCache.size > TOOL_APPROVAL_SIGNATURE_CACHE_MAX) {
    const oldest = toolApprovalSignatureCache.keys().next().value
    if (!oldest) break
    toolApprovalSignatureCache.delete(oldest)
  }
  persistToolApprovalSignatureCache()
}

function rememberToolApprovalSignature(chunk: unknown): void {
  if (!chunk || typeof chunk !== 'object') return
  const item = chunk as { type?: unknown; approvalId?: unknown; toolCallId?: unknown; signature?: unknown }
  if (item.type !== 'tool-approval-request') return
  if (typeof item.approvalId !== 'string' || typeof item.toolCallId !== 'string' || typeof item.signature !== 'string') return
  toolApprovalSignatureCache.set(item.approvalId, {
    toolCallId: item.toolCallId,
    signature: item.signature,
    at: Date.now(),
  })
  pruneToolApprovalSignatureCache()
}

function rememberUiMessageToolApprovalSignatures(messages: UIMessage[] = []): void {
  for (const message of messages) {
    const parts = Array.isArray((message as any)?.parts) ? (message as any).parts as any[] : []
    for (const part of parts) {
      const approval = part && typeof part === 'object' ? (part as any).approval : null
      if (!approval || typeof approval.id !== 'string' || typeof approval.signature !== 'string') continue
      if (typeof (part as any).toolCallId !== 'string') continue
      toolApprovalSignatureCache.set(approval.id, {
        toolCallId: (part as any).toolCallId,
        signature: approval.signature,
        at: Date.now(),
      })
    }
  }
  pruneToolApprovalSignatureCache()
}

function restoreUiMessageToolApprovalSignatures(messages: UIMessage[] = []): UIMessage[] {
  let changed = false
  const nextMessages = messages.map((message) => {
    const parts = Array.isArray((message as any)?.parts) ? (message as any).parts as any[] : null
    if (!parts) return message

    let partsChanged = false
    const nextParts = parts.map((part) => {
      if (!part || typeof part !== 'object') return part
      const approval = (part as any).approval
      const approvalId = typeof approval?.id === 'string' ? approval.id : ''
      const toolCallId = typeof (part as any).toolCallId === 'string' ? (part as any).toolCallId : ''
      if (!approvalId || !toolCallId || typeof approval?.signature === 'string') return part

      const cached = toolApprovalSignatureCache.get(approvalId)
      if (!cached || cached.toolCallId !== toolCallId) return part

      partsChanged = true
      return {
        ...(part as Record<string, unknown>),
        approval: {
          ...approval,
          signature: cached.signature,
        },
      }
    })
    if (!partsChanged) return message
    changed = true
    return { ...message, parts: nextParts } as UIMessage
  })
  return changed ? nextMessages : messages
}

function stripToolApprovalSignatureFromChunk(chunk: unknown): unknown {
  if (!chunk || typeof chunk !== 'object') return chunk
  const item = chunk as { type?: unknown; signature?: unknown }
  if (item.type !== 'tool-approval-request' || typeof item.signature !== 'string') return chunk
  const { signature: _signature, ...safeChunk } = item as Record<string, unknown>
  return safeChunk
}

function formatIpcError(error: unknown, fallback: string): string {
  const message = formatAgentError(error).trim()
  return message && message !== 'Error' && message !== '[object Object]' ? message : fallback
}

const PERSONA_VOICE_MARKER_RE = /^[\[【]\s*(?:语音|voice)\s*[\]】]\s*/i

function createPersonaVoiceCachePrewarmer(input: {
  runId: string
  sessionId: string
  ttsVoice: PersonaTtsVoiceBinding | null
  instructions?: string
  signal?: AbortSignal
  logger?: { warn?(category: string, message: string, data?: any): void }
}): (chunk: unknown) => void {
  const textById = new Map<string, string>()
  const queued = new Set<string>()

  const prewarm = (rawText: string) => {
    const match = rawText.match(PERSONA_VOICE_MARKER_RE)
    if (!match || input.signal?.aborted) return

    const text = rawText.slice(match[0].length).trim()
    if (!text) return

    const key = `${input.ttsVoice?.provider || 'default'}:${input.ttsVoice?.model || ''}:${input.ttsVoice?.voice || ''}:${input.instructions || ''}:${text}`
    if (queued.has(key)) return
    queued.add(key)

    void (async () => {
      try {
        const { resolvePersonaVoiceTtsConfig, synthesizeSpeech } = await import('../../services/ai/ttsService')
        const configPatch = input.instructions ? { instructions: input.instructions } : undefined
        const config = input.ttsVoice
          ? resolvePersonaVoiceTtsConfig(input.ttsVoice, configPatch as any)
          : configPatch
        const result = await synthesizeSpeech(text, config ? { config: config as any, useCache: true, signal: input.signal } : { useCache: true, signal: input.signal })
        if (!result.success) {
          input.logger?.warn?.('Persona', '分身语音预合成失败', {
            runId: input.runId,
            sessionId: input.sessionId,
            error: result.error,
            errorCode: result.errorCode,
          })
        }
      } catch (error) {
        input.logger?.warn?.('Persona', '分身语音预合成异常', {
          runId: input.runId,
          sessionId: input.sessionId,
          ...errorToLogData(error),
        })
      }
    })()
  }

  return (chunk: unknown) => {
    if (!chunk || typeof chunk !== 'object') return
    const item = chunk as { type?: unknown; id?: unknown; delta?: unknown }
    const type = String(item.type || '')
    const id = typeof item.id === 'string' ? item.id : ''
    if (!id) return

    if (type === 'text-start') {
      textById.set(id, '')
    } else if (type === 'text-delta') {
      textById.set(id, `${textById.get(id) || ''}${String(item.delta || '')}`)
    } else if (type === 'text-end') {
      const text = textById.get(id) || ''
      textById.delete(id)
      prewarm(text)
    }
  }
}

export function registerAiHandlers(ctx: MainProcessContext): void {
  toolApprovalCacheConfigService = ctx.getConfigService()
  for (const item of toolApprovalCacheConfigService?.get('agentToolApprovalSignatures') ?? []) {
    toolApprovalSignatureCache.set(item.approvalId, { toolCallId: item.toolCallId, signature: item.signature, at: item.at })
  }
  pruneToolApprovalSignatureCache()

  void import('../../services/agent/conversationStore')
    .then(({ setAgentConversationChangeBroadcaster }) => {
      setAgentConversationChangeBroadcaster((event) => ctx.broadcastToWindows('agent:conversationUpdated', event))
    })
    .catch(() => undefined)

  void import('../../services/agent/agentCapabilityService')
    .then(({ agentCapabilityService }) => agentCapabilityService.setContext(ctx))
    .catch(() => undefined)

  // ========= AI Agent（跑在独立 utilityProcess 子进程，主进程仅做 broker）=========
  ipcMain.handle('agent:run', async (event, payload: {
    runId: string
    messages: UIMessage[]
    scope?: AgentScope
    modelConfig?: AgentProviderConfigOverride | null
    conversationId?: number | null
    planMode?: boolean
    toolProfile?: AgentToolProfile
    codeWorkspace?: CodeWorkspaceRef | null
    canvasContext?: { activeCanvasId?: string; activeRevision?: number } | null
  }) => {
    const sender = event.sender
    const { runId } = payload
    const send = (chunk: unknown) => { if (!sender.isDestroyed()) sender.send('agent:chunk', { runId, chunk }) }
    const sendProgress = (progress: unknown) => { if (!sender.isDestroyed()) sender.send('agent:progress', { runId, progress }) }
    const aborter = new AbortController()
    const logger = ctx.getLogService()
    const startedAt = Date.now()
    const scope = payload.scope ?? { kind: 'global' as const }
    const toolProfile: AgentToolProfile = payload.toolProfile === 'code' || payload.toolProfile === 'hybrid' || payload.toolProfile === 'chat'
      ? payload.toolProfile
      : payload.codeWorkspace ? 'hybrid' : 'chat'
    const codeWorkspace = payload.codeWorkspace && typeof payload.codeWorkspace.root === 'string'
      ? payload.codeWorkspace
      : null
    const initialLastUserText = lastUserTextFromUiMessages(payload.messages || [])
    const baseRunData = {
      runId,
      conversationId: payload.conversationId ?? null,
      messageCount: payload.messages?.length ?? 0,
      lastUserTextLength: initialLastUserText.length,
      toolProfile,
      hasCodeWorkspace: Boolean(codeWorkspace),
      ...scopeToLogData(scope),
    }
    let stage = 'start'
    let chunkCount = 0
    let progressCount = 0
    let lastActivityAt = startedAt
    let lastActivityKind = 'start'
    let idleWarningCount = 0
    let watchdog: NodeJS.Timeout | null = null
    // 发送后各阶段耗时打点：每步一行 [agent:perf] 打到控制台，完整时间线随完成日志落盘
    let perfLastAt = startedAt
    const perfTimeline: string[] = []
    const markPerf = (label: string, detail?: string) => {
      const now = Date.now()
      const entry = `${label} +${now - perfLastAt}ms${detail ? `（${detail}）` : ''}`
      perfTimeline.push(entry)
      console.info(`[agent:perf] ${runId} ${entry}，累计 ${now - startedAt}ms`)
      perfLastAt = now
    }
    // 并行任务用绝对耗时记录（互相重叠，增量没意义）
    const timedTask = async <T,>(label: string, task: Promise<T>): Promise<T> => {
      const t0 = Date.now()
      try {
        return await task
      } finally {
        const entry = `${label} 耗时 ${Date.now() - t0}ms`
        perfTimeline.push(entry)
        console.info(`[agent:perf] ${runId} ${entry}`)
      }
    }
    agentAborters.set(runId, aborter)
    let prepProgressSent = false
    // 准备阶段对用户合并成单一步骤；细分阶段只保留在 stage/perf 日志里。
    const sendPrepProgress = (visible = true) => {
      lastActivityAt = Date.now()
      lastActivityKind = 'progress'
      idleWarningCount = 0
      if (!visible || prepProgressSent) return
      prepProgressSent = true
      progressCount += 1
      sendProgress({
        stage: 'run_started',
        title: AGENT_PREP_PROGRESS_TITLE,
        category: 'prep',
        elapsedMs: Date.now() - startedAt,
        at: Date.now(),
      })
    }
    logger?.warn('AIAgent', 'AI Agent 请求开始', baseRunData)
    try {
      stage = 'import_services'
      sendPrepProgress()
      const { agentProcessService } = await import('../../services/agent/agentProcessService')
      agentProcessService.setLogger(logger)
      const { agentProfileService } = await import('../../services/agent/agentProfileService')
      const { sanitizeModelMessageToolPairs } = await import('../../services/agent/compaction')
      const { convertToModelMessages } = await import('ai')
      markPerf('加载主进程服务模块')
      stage = 'resolve_agent_profile'
      sendPrepProgress()
      const profile = await timedTask('解析 Agent Profile', agentProfileService.resolve({
        mode: 'app',
        scope,
        modelConfig: payload.modelConfig,
        toolProfile,
        codeWorkspace,
        includeMcpSkills: true,
        queryText: initialLastUserText,
      }))
      const providerConfig = profile.providerConfig
      markPerf('解析 Agent Profile', `MCP ${profile.mcpTools.length} 个 / 技能 ${profile.skills.length} 个`)
      stage = 'convert_messages'
      sendPrepProgress()
      const { agentConversationStore } = await import('../../services/agent/conversationStore')
      const storedConversation = payload.conversationId ? agentConversationStore.load(Number(payload.conversationId)) : null
      // Canvas 上下文：conversationId 有效才注入；activeCanvasId 必须归属该会话，否则丢弃（防跨会话访问）
      let canvasContext: import('../../services/agent/canvasTypes').AgentCanvasRunContext | undefined
      if (storedConversation) {
        canvasContext = { conversationId: storedConversation.id }
        const activeCanvasId = typeof payload.canvasContext?.activeCanvasId === 'string' ? payload.canvasContext.activeCanvasId.trim() : ''
        if (activeCanvasId) {
          const { agentCanvasStore } = await import('../../services/agent/agentCanvasStore')
          const activeCanvas = agentCanvasStore.get(activeCanvasId)
          if (activeCanvas && activeCanvas.conversationId === storedConversation.id) {
            canvasContext.activeCanvasId = activeCanvas.id
            canvasContext.activeRevision = activeCanvas.revision
          }
        }
      }
      const payloadMessages = Array.isArray(payload.messages) ? payload.messages : []
      const historyMergedMessages = storedConversation?.messages
        ? mergeUiMessagesById(storedConversation.messages, payloadMessages)
        : payloadMessages
      const historyTurnContext = await timedTask('DeepSeek 历史上下文', upsertDeepSeekHistoryTurnContextMessage({
        messages: historyMergedMessages,
        providerConfig,
        scope: profile.scope,
        skills: profile.skills,
        queryText: initialLastUserText,
        planMode: payload.planMode === true,
        codeWorkspace: profile.codeWorkspace,
      }))
      if (historyTurnContext.changed && payload.conversationId) {
        // 内部上下文注入：只落库、不广播。否则 originClientId 为空会让前端在 busy 时挂起
        // pending reload，流结束后从库重载，和最终落盘抢跑，偶发把刚生成的正文盖成空白。
        agentConversationStore.replaceMessages(Number(payload.conversationId), historyTurnContext.messages, { emit: false })
      }
      rememberUiMessageToolApprovalSignatures(historyTurnContext.messages)
      const messagesWithApprovalSignatures = restoreUiMessageToolApprovalSignatures(historyTurnContext.messages)
      const uiMessages = shouldStripProviderMetadata(providerConfig)
        ? stripUiMessageProviderMetadata(messagesWithApprovalSignatures)
        : messagesWithApprovalSignatures
      const { prepareProviderFileUploads } = await import('../../services/agent/providerFileUpload')
      const modelUiMessages = stripHistoricalToolPartsForModel(uiMessages)
      const strippedToolPartCount = countToolParts(uiMessages) - countToolParts(modelUiMessages)
      const providerFileUpload = await timedTask('provider file upload', prepareProviderFileUploads(modelUiMessages, providerConfig, logger))
      const uploadedMediaContext = extractUploadedMediaContext(providerFileUpload.messages)
      const messages = sanitizeModelMessageToolPairs(await convertToModelMessages(providerFileUpload.messages))
      markPerf('整理消息', `${messages.length} 条 / strip tools ${strippedToolPartCount} 个 / file upload ${providerFileUpload.stats.uploaded} 上传 ${providerFileUpload.stats.reused} 复用 ${providerFileUpload.stats.failed} 失败`)
      stage = 'inject_tools_and_skills'
      sendPrepProgress()
      const mcpTools = profile.mcpTools
      const skills = profile.skills
      sendPrepProgress()
      if (mcpTools.length > 0 || skills.length > 0) {
        console.info('[agent:run] injected context', {
          mcpTools: mcpTools.map((tool) => `${tool.serverName}/${tool.toolName}`),
          skills: skills.map((skill) => skill.name),
        })
      }
      logger?.warn('AIAgent', 'AI Agent 配置与上下文准备完成', {
        ...baseRunData,
        elapsedMs: Date.now() - startedAt,
        provider: providerToLogData(providerConfig),
        modelMessageCount: messages.length,
        turnContextMode: historyTurnContext.mode,
        readOnlyMcpToolCount: profile.logMeta.readOnlyMcpToolCount,
        mcpCandidateCount: profile.logMeta.readOnlyMcpToolCount,
        selectedMcpToolCount: mcpTools.length,
        selectedMcpTools: mcpTools.map((tool) => `${tool.serverName}/${tool.toolName}`),
        mcpSelectionMode: profile.logMeta.mcpSelectionMode,
        mcpRerankApplied: false,
        mcpRerankError: null,
        selectedSkillCount: skills.length,
        selectedSkills: skills.map((skill) => skill.name),
        skillSelectionMode: profile.logMeta.skillSelectionMode,
      })
      stage = 'run_agent_process'
      sendPrepProgress()
      watchdog = setInterval(() => {
        const idleMs = Date.now() - lastActivityAt
        if (idleMs < 10000) return
        if (idleWarningCount >= 6) return
        idleWarningCount += 1
        logger?.warn('AIAgent', 'AI Agent 运行中暂无新输出', {
          ...baseRunData,
          stage,
          elapsedMs: Date.now() - startedAt,
          idleMs,
          chunkCount,
          progressCount,
          lastActivityKind,
        })
      }, 15000)
      markPerf('交给 Agent 子进程')
      logger?.warn('AIAgent', 'AI Agent 已交给 utility process 运行', {
        ...baseRunData,
        elapsedMs: Date.now() - startedAt,
        prepTimeline: perfTimeline.slice(),
      })
      let firstChunkSeen = false
      let firstModelOutputSeen = false
      await agentProcessService.run(
        {
          messages,
          providerConfig,
          scope: profile.scope,
          uploadedMediaContext,
          mcpTools,
          skills,
          planMode: payload.planMode === true,
          toolProfile: profile.toolProfile,
          codeWorkspace: profile.codeWorkspace,
          turnContextMode: historyTurnContext.mode,
          allowWechatReplyMedia: false,
          canvasContext,
        },
        (chunk) => {
          chunkCount += 1
          lastActivityAt = Date.now()
          lastActivityKind = 'chunk'
          idleWarningCount = 0
          const chunkType = (chunk as { type?: string })?.type || ''
          if (!firstChunkSeen) {
            firstChunkSeen = true
            markPerf('子进程回传首个 chunk', chunkType)
          }
          if (!firstModelOutputSeen && (chunkType === 'text-delta' || chunkType === 'reasoning-delta' || chunkType === 'tool-input-start')) {
            firstModelOutputSeen = true
            markPerf('模型首个增量输出', chunkType)
          }
          rememberToolApprovalSignature(chunk)
          send(stripToolApprovalSignatureFromChunk(chunk))
        },
        (progress) => {
          progressCount += 1
          lastActivityAt = Date.now()
          lastActivityKind = 'progress'
          idleWarningCount = 0
          sendProgress(progress)
        },
        aborter.signal,
      )
      stage = 'done'
      send('[DONE]')
      markPerf('本次运行结束')
      logger?.warn('AIAgent', 'AI Agent 请求完成', {
        ...baseRunData,
        elapsedMs: Date.now() - startedAt,
        chunkCount,
        progressCount,
        perfTimeline,
      })
      return { success: true }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger?.error('AIAgent', 'AI Agent 请求失败', {
        ...baseRunData,
        stage,
        elapsedMs: Date.now() - startedAt,
        chunkCount,
        progressCount,
        perfTimeline,
        ...errorToLogData(e),
      })
      sendProgress({ stage: 'error', title: 'AI 助手运行失败', detail: message, at: Date.now() })
      send({ type: 'error', errorText: message })
      send('[DONE]')
      return { success: false, error: message }
    } finally {
      if (watchdog) clearInterval(watchdog)
      agentAborters.delete(runId)
    }
  })

  ipcMain.handle('agent:listConversations', async (_event, scope?: AgentScope) => {
    try {
      const { agentConversationStore } = await import('../../services/agent/conversationStore')
      return { success: true, conversations: agentConversationStore.list({ scope }) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('agent:loadConversation', async (_event, id: number) => {
    try {
      const { agentConversationStore } = await import('../../services/agent/conversationStore')
      const conversation = agentConversationStore.load(Number(id))
      return conversation
        ? { success: true, conversation: stripInternalTurnContextFromConversation(conversation) }
        : { success: false, error: 'AI 对话不存在' }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('agent:createConversation', async (_event, payload: {
    scope?: AgentScope
    title?: string
    modelProvider?: string
    modelId?: string
    originClientId?: string | null
  }) => {
    try {
      const { agentConversationStore } = await import('../../services/agent/conversationStore')
      return { success: true, conversation: agentConversationStore.create(payload || {}) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('agent:deleteConversation', async (_event, idOrPayload: number | { id?: number; originClientId?: string | null }) => {
    try {
      const { agentConversationStore } = await import('../../services/agent/conversationStore')
      const id = typeof idOrPayload === 'object' && idOrPayload ? Number(idOrPayload.id) : Number(idOrPayload)
      const originClientId = typeof idOrPayload === 'object' && idOrPayload ? idOrPayload.originClientId : null
      agentConversationStore.remove(id, { originClientId })
      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('agent:deleteConversationsByScope', async (_event, scope: AgentScope) => {
    try {
      const { agentConversationStore } = await import('../../services/agent/conversationStore')
      return agentConversationStore.removeByScope(scope)
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('agent:renameConversation', async (_event, id: number, title: string, originClientId?: string | null) => {
    try {
      const { agentConversationStore } = await import('../../services/agent/conversationStore')
      // 带上来源 clientId：否则自动起标题的广播会被发起窗口误判为外部修改，流结束后触发重载盖掉刚生成的正文
      return { success: true, conversation: agentConversationStore.rename(Number(id), title, { originClientId: originClientId ?? null }) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('agent:saveConversationMessages', async (_event, payload: {
    id: number
    messages: UIMessage[]
    scope?: AgentScope
    modelProvider?: string
    modelId?: string
    baseUpdatedAt?: number
    mergeIfStale?: boolean
    originClientId?: string | null
  }) => {
    try {
      const { agentConversationStore } = await import('../../services/agent/conversationStore')
      const id = Number(payload.id)
      const loadedBeforeSave = agentConversationStore.load(id)
      if (!loadedBeforeSave) return { success: false, error: 'AI 对话不存在' }

      const baseUpdatedAt = Number(payload.baseUpdatedAt)
      const hasVersion = Number.isFinite(baseUpdatedAt) && baseUpdatedAt > 0
      const isStale = hasVersion && Number(loadedBeforeSave.updatedAt || 0) > baseUpdatedAt
      const shouldMergeIfStale = payload.mergeIfStale !== false
      const incomingMessages = isStale && shouldMergeIfStale
        ? mergeUiMessagesById(loadedBeforeSave.messages, payload.messages || [])
        : (payload.messages || [])
      const nextMessages = preserveInternalTurnContextMessages(loadedBeforeSave.messages, incomingMessages)
      const originClientId = payload.originClientId ?? null

      if (payload.scope || payload.modelProvider !== undefined || payload.modelId !== undefined) {
        agentConversationStore.updateMeta(id, {
          scope: payload.scope,
          modelProvider: payload.modelProvider,
          modelId: payload.modelId,
        }, { originClientId })
      }
      const conversation = agentConversationStore.replaceMessages(id, nextMessages, { originClientId })
      return { success: true, conversation, staleMerged: isStale && shouldMergeIfStale }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('agent:sendConversationReplyToWechat', async (_event, payload: {
    conversationId?: number
    messageId?: string
    bubbles?: string[]
  }) => {
    try {
      const { weixinBotService } = await import('../../services/deviceConnect/weixinBotService')
      return await weixinBotService.sendConversationReplyToWechat({
        conversationId: Number(payload?.conversationId || 0),
        messageId: String(payload?.messageId || ''),
        bubbles: Array.isArray(payload?.bubbles) ? payload.bubbles.map((item) => String(item || '')) : [],
      })
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('agent:getLastConversation', async (_event, scope?: AgentScope) => {
    try {
      const { agentConversationStore } = await import('../../services/agent/conversationStore')
      return { success: true, conversation: agentConversationStore.getLast(scope) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('agent:abort', (_e, runId: string) => {
    ctx.getLogService()?.warn('AIAgent', '收到 AI Agent 取消请求', { runId })
    agentAborters.get(runId)?.abort()
    return { success: true }
  })

  // ========= 嵌入模型（语义/向量检索）=========
  ipcMain.handle('embedding:getConfig', async () => {
    try {
      const { getEmbeddingConfig } = await import('../../services/ai/embeddingService')
      return { success: true, config: getEmbeddingConfig() }
    } catch (e) {
      return { success: false, error: formatIpcError(e, '读取嵌入配置失败') }
    }
  })

  ipcMain.handle('embedding:setConfig', async (_e, patch: Record<string, unknown>) => {
    try {
      const { saveEmbeddingConfig } = await import('../../services/ai/embeddingService')
      return { success: true, config: saveEmbeddingConfig(patch as any) }
    } catch (e) {
      return { success: false, error: formatIpcError(e, '保存嵌入配置失败') }
    }
  })

  ipcMain.handle('embedding:test', async (_e, cfg: any) => {
    try {
      const { testEmbeddingConfig } = await import('../../services/ai/embeddingService')
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      await refreshResolvedProxyUrl() // 测试也走代理，保证"测试通过=实际可用"
      return await testEmbeddingConfig(cfg)
    } catch (e) {
      return { success: false, error: formatIpcError(e, '嵌入模型测试失败') }
    }
  })

  // ========== 文字转语音（TTS） ==========

  ipcMain.handle('tts:getConfig', async () => {
    try {
      const { getTtsConfig, isTtsAvailable } = await import('../../services/ai/ttsService')
      const config = getTtsConfig()
      return { success: true, config, available: isTtsAvailable(config) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('tts:setConfig', async (_e, patch: Record<string, unknown>) => {
    try {
      const { saveTtsConfig } = await import('../../services/ai/ttsService')
      return { success: true, config: saveTtsConfig(patch as any) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('tts:test', async (_e, cfg: any) => {
    try {
      const { testTtsConfig } = await import('../../services/ai/ttsService')
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      await refreshResolvedProxyUrl() // 测试也走代理，保证"测试通过=实际可用"
      return await testTtsConfig(cfg)
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e), errorCode: 'SYNTHESIS_FAILED' }
    }
  })

  ipcMain.handle('tts:speak', async (_e, text: string, options?: { config?: Record<string, unknown>; personaVoice?: unknown }) => {
    try {
      const { resolvePersonaVoiceTtsConfig, synthesizeSpeech } = await import('../../services/ai/ttsService')
      const configPatch = options?.config && typeof options.config === 'object' ? options.config : undefined
      const config = options?.personaVoice && typeof options.personaVoice === 'object'
        ? resolvePersonaVoiceTtsConfig(options.personaVoice as any, configPatch as any)
        : configPatch
      return await synthesizeSpeech(String(text || ''), config ? { config: config as any, useCache: true } : undefined)
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e), errorCode: 'SYNTHESIS_FAILED' }
    }
  })

  ipcMain.handle('tts:streamCancel', async (_e, streamId: string) => {
    const id = String(streamId || '')
    const controller = ttsStreamAborters.get(id)
    if (controller) {
      controller.abort()
      ttsStreamAborters.delete(id)
    }
    return { success: true }
  })

  ipcMain.handle('tts:stream', async (event, streamId: string, text: string, options?: { config?: Record<string, unknown>; personaVoice?: unknown }) => {
    const id = String(streamId || '')
    const controller = new AbortController()
    if (id) ttsStreamAborters.set(id, controller)

    const sendEvent = (payload: Record<string, unknown>) => {
      if (!id || event.sender.isDestroyed()) return
      event.sender.send('tts:streamEvent', { streamId: id, ...payload })
    }

    try {
      const { resolvePersonaVoiceTtsConfig, synthesizeSpeechStream } = await import('../../services/ai/ttsService')
      const configPatch = options?.config && typeof options.config === 'object' ? options.config : undefined
      const config = options?.personaVoice && typeof options.personaVoice === 'object'
        ? resolvePersonaVoiceTtsConfig(options.personaVoice as any, configPatch as any)
        : configPatch

      sendEvent({ type: 'start' })
      const result = await synthesizeSpeechStream(String(text || ''), {
        config: config as any,
        useCache: true,
        signal: controller.signal,
        onAudioChunk: (chunk) => {
          sendEvent({
            type: 'chunk',
            audioBase64: Buffer.from(chunk.data).toString('base64'),
            format: chunk.format,
            sampleRate: chunk.sampleRate,
            channels: chunk.channels,
          })
        },
      })

      if (result.success && !result.streamed && result.audioBase64) {
        sendEvent({
          type: 'complete',
          audioBase64: result.audioBase64,
          mimeType: result.mimeType,
          cached: result.cached,
        })
      }
      sendEvent({
        type: result.success ? 'end' : 'error',
        success: result.success,
        error: result.error,
        errorCode: result.errorCode,
        streamed: result.streamed,
        cached: result.cached,
        mimeType: result.mimeType,
      })

      return result.streamed ? { ...result, audioBase64: undefined } : result
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      sendEvent({ type: 'error', success: false, error, errorCode: 'SYNTHESIS_FAILED' })
      return { success: false, error, errorCode: 'SYNTHESIS_FAILED' }
    } finally {
      if (id && ttsStreamAborters.get(id) === controller) {
        ttsStreamAborters.delete(id)
      }
    }
  })

  // ========== AI 作图 ==========

  ipcMain.handle('imageGen:getConfig', async () => {
    try {
      const { getImageGenConfig, isImageGenAvailable } = await import('../../services/ai/imageGenService')
      const config = getImageGenConfig()
      return { success: true, config, available: isImageGenAvailable(config) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('imageGen:setConfig', async (_e, patch: Record<string, unknown>) => {
    try {
      const { saveImageGenConfig } = await import('../../services/ai/imageGenService')
      return { success: true, config: saveImageGenConfig(patch as any) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('imageGen:test', async (_e, cfg: any) => {
    try {
      const { testImageGenConfig } = await import('../../services/ai/imageGenService')
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      await refreshResolvedProxyUrl() // 测试也走代理，保证"测试通过=实际可用"
      return await testImageGenConfig(cfg)
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 某会话的向量化状态：是否启用嵌入 + 已建片段数
  ipcMain.handle('embedding:sessionStatus', async (_e, sessionId: string) => {
    try {
      const { getEmbeddingConfig } = await import('../../services/ai/embeddingService')
      const { messageVectorService } = await import('../../services/search/messageVectorService')
      const cfg = getEmbeddingConfig()
      const store = messageVectorService.getSessionVectorStoreInfo(sessionId)
      return { success: true, enabled: messageVectorService.isReady(cfg), mediaEnabled: messageVectorService.isMediaReady(cfg), count: store.count, mediaCount: store.mediaCount || 0, store }
    } catch (e) {
      return { success: false, error: formatIpcError(e, '读取向量化状态失败') }
    }
  })

  // 主动为某会话构建向量（懒构建的手动触发；增量，已建则只补新增）
  ipcMain.handle('embedding:buildSession', async (event, sessionId: string, options?: { target?: 'all' | 'text' | 'image' }) => {
    try {
      const { getEmbeddingConfig } = await import('../../services/ai/embeddingService')
      const { messageVectorService } = await import('../../services/search/messageVectorService')
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      const sender = event.sender
      const cfg = getEmbeddingConfig()
      const target = options?.target === 'text' || options?.target === 'image' ? options.target : 'all'
      if (!messageVectorService.isReady(cfg)) {
        return { success: false, error: '未启用或未配置嵌入模型（请先在设置 → 嵌入中配置并启用）' }
      }
      if (target === 'image' && !messageVectorService.isMediaReady(cfg)) {
        return { success: false, error: '图片向量化未开启（请先在设置 → 嵌入中开启图片向量化）' }
      }
      await refreshResolvedProxyUrl()
      const currentStore = messageVectorService.getSessionVectorStoreInfo(sessionId)
      let indexed = currentStore.count
      let mediaIndexed = currentStore.mediaCount || 0
      if (target === 'all' || target === 'text') {
        indexed = await messageVectorService.ensureSessionVectors(sessionId, cfg, undefined, (progress) => {
          if (!sender.isDestroyed()) sender.send('embedding:buildProgress', progress)
        })
      }
      if ((target === 'all' && messageVectorService.isMediaReady(cfg)) || target === 'image') {
        mediaIndexed = await messageVectorService.ensureSessionMediaVectors(sessionId, cfg, undefined, (progress) => {
          if (!sender.isDestroyed()) sender.send('embedding:buildProgress', progress)
        })
      }
      const store = messageVectorService.getSessionVectorStoreInfo(sessionId)
      return { success: true, indexed: store.count || indexed, mediaIndexed: store.mediaCount || mediaIndexed }
    } catch (e) {
      return { success: false, error: formatIpcError(e, '向量化失败') }
    }
  })

  // ========= 重排模型（RAG/Skills/MCP 候选重排）=========
  ipcMain.handle('rerank:getConfig', async () => {
    try {
      const { getRerankConfig } = await import('../../services/ai/rerankService')
      return { success: true, config: getRerankConfig() }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('rerank:setConfig', async (_e, patch: Record<string, unknown>) => {
    try {
      const { saveRerankConfig } = await import('../../services/ai/rerankService')
      return { success: true, config: saveRerankConfig(patch as any) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('rerank:test', async (_e, cfg: any) => {
    try {
      const { testRerankConfig } = await import('../../services/ai/rerankService')
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      await refreshResolvedProxyUrl()
      return await testRerankConfig(cfg)
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ========= AI 长期记忆管理（cachePath/memory-bank；纯 Markdown）=========
  ipcMain.handle('memory:migrationStatus', async () => {
    try {
      const { memoryDatabase } = await import('../../services/memory/memoryDatabase')
      return { success: true, status: memoryDatabase.getMigrationStatus() }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('memory:migrateLegacy', async () => {
    try {
      const { memoryDatabase } = await import('../../services/memory/memoryDatabase')
      return { success: true, result: memoryDatabase.migrateLegacyDatabase() }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('memory:list', async (_event, opts?: {
    sourceType?: string
    sourceTypes?: string[]
    sessionId?: string
    tags?: string[]
    withoutTags?: string[]
    minConfidence?: number
    limit?: number
  }) => {
    try {
      const { memoryDatabase } = await import('../../services/memory/memoryDatabase')
      const sourceType = String(opts?.sourceType || '').trim()
      const sourceTypes = Array.isArray(opts?.sourceTypes)
        ? opts.sourceTypes.map((type) => String(type || '').trim()).filter(Boolean)
        : undefined
      const items = memoryDatabase.listMemoryItems({
        ...(sourceType ? { sourceType: sourceType as any } : {}),
        ...(sourceTypes ? { sourceTypes: sourceTypes as any } : {}),
        ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(Array.isArray(opts?.tags) ? { tags: opts.tags } : {}),
        ...(Array.isArray(opts?.withoutTags) ? { withoutTags: opts.withoutTags } : {}),
        ...(opts?.minConfidence !== undefined ? { minConfidence: opts.minConfidence } : {}),
        limit: opts?.limit ?? 300,
      })
      return { success: true, items, stats: memoryDatabase.getStats() }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('memory:listDiaries', async (_event, limit?: number) => {
    try {
      const { memoryDatabase } = await import('../../services/memory/memoryDatabase')
      return { success: true, diaries: memoryDatabase.listDiaries(limit) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('memory:listBankNotes', async (_event, kind: string, limit?: number) => {
    try {
      const safeKind = kind === 'tasks' ? 'tasks' : kind === 'notes' ? 'notes' : null
      if (!safeKind) return { success: false, error: '无效的笔记类型' }
      const { memoryDatabase } = await import('../../services/memory/memoryDatabase')
      return { success: true, notes: memoryDatabase.listBankNotes(safeKind, limit) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('memory:readBankNote', async (_event, kind: string, fileName: string) => {
    try {
      const safeKind = kind === 'tasks' ? 'tasks' : kind === 'notes' ? 'notes' : null
      if (!safeKind) return { success: false, error: '无效的笔记类型' }
      const { memoryDatabase } = await import('../../services/memory/memoryDatabase')
      const note = memoryDatabase.readBankNote(safeKind, String(fileName || ''))
      return note ? { success: true, note } : { success: false, error: '未找到该笔记' }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('memory:deleteBankNote', async (_event, kind: string, fileName: string) => {
    try {
      const safeKind = kind === 'tasks' ? 'tasks' : kind === 'notes' ? 'notes' : null
      if (!safeKind) return { success: false, error: '无效的笔记类型' }
      const { memoryDatabase } = await import('../../services/memory/memoryDatabase')
      const deleted = memoryDatabase.deleteBankNote(safeKind, String(fileName || ''))
      return deleted ? { success: true } : { success: false, error: '未找到该笔记' }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('memory:readDiary', async (_event, date: string) => {
    try {
      const { memoryDatabase } = await import('../../services/memory/memoryDatabase')
      const diary = memoryDatabase.readDiary(String(date || ''))
      return diary ? { success: true, diary } : { success: false, error: '未找到该日记' }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('memory:deleteDiary', async (_event, date: string) => {
    try {
      const { memoryDatabase } = await import('../../services/memory/memoryDatabase')
      const deleted = memoryDatabase.deleteDiary(String(date || ''))
      return deleted ? { success: true } : { success: false, error: '未找到该日记' }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('memory:summarizeTodayDiary', async () => {
    try {
      const date = localDateKey()
      const { memoryDatabase } = await import('../../services/memory/memoryDatabase')
      const existing = memoryDatabase.readDiary(date)
      if (existing) return { success: true, alreadyExists: true, diary: existing }

      const [
        { resolveProviderConfig },
        { runDailyDiaryConsolidation },
        { readUnreadDiarySource, readTodayChatDiarySource }
      ] = await Promise.all([
        import('../../services/agent/resolveProviderConfig'),
        import('../../services/agent/tools/memory'),
        import('../../services/memory/nightlyMemoryService')
      ])
      const customPrompt = String(ctx.getConfigService()?.get('diaryCustomPrompt' as any) || '').trim()
      const [unreadMessages, dayMessages] = await Promise.all([
        readUnreadDiarySource().catch(() => ''),
        readTodayChatDiarySource(date).catch(() => '')
      ])
      await runDailyDiaryConsolidation(date, resolveProviderConfig(), undefined, { unreadMessages, dayMessages, customPrompt })
      const diary = memoryDatabase.readDiary(date)
      return diary ? { success: true, alreadyExists: false, diary } : { success: false, error: '日记生成后未找到文件' }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('memory:create', async (_event, payload: {
    memoryUid?: string
    sourceType?: string
    content?: string
    title?: string
    importance?: number
    confidence?: number
    tags?: string[]
  }) => {
    try {
      const { memoryDatabase } = await import('../../services/memory/memoryDatabase')
      const content = String(payload?.content || '').trim()
      if (!content) return { success: false, error: '记忆内容不能为空' }
      const sourceType = String(payload?.sourceType || 'profile').trim()
      const memoryUid = String(payload?.memoryUid || `${sourceType}:${Date.now()}`).trim()
      const item = memoryDatabase.upsertMemoryItem({
        memoryUid,
        sourceType: sourceType as any,
        title: String(payload?.title || content.slice(0, 40)),
        content,
        ...(payload?.importance !== undefined ? { importance: payload.importance } : {}),
        ...(payload?.confidence !== undefined ? { confidence: payload.confidence } : {}),
        ...(Array.isArray(payload?.tags) ? { tags: payload.tags } : {}),
      })
      return { success: true, item }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('memory:delete', async (_event, id: number) => {
    try {
      const { memoryDatabase } = await import('../../services/memory/memoryDatabase')
      return { success: memoryDatabase.deleteMemoryItem(Number(id)) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('memory:update', async (_event, payload: {
    id: number
    sourceType?: string
    content?: string
    importance?: number
    confidence?: number
    tags?: string[]
  }) => {
    try {
      const { memoryDatabase } = await import('../../services/memory/memoryDatabase')
      const id = Number(payload?.id)
      if (!Number.isFinite(id)) return { success: false, error: '无效的记忆 id' }
      const content = String(payload?.content || '').trim()
      if (!content) return { success: false, error: '记忆内容不能为空' }
      const sourceType = String(payload?.sourceType || '').trim()
      const item = memoryDatabase.updateMemoryItem(id, {
        ...(sourceType ? { sourceType: sourceType as any } : {}),
        title: content.slice(0, 40),
        content,
        ...(payload.importance !== undefined ? { importance: payload.importance } : {}),
        ...(payload.confidence !== undefined ? { confidence: payload.confidence } : {}),
        ...(Array.isArray(payload.tags) ? { tags: payload.tags } : {}),
      })
      return item ? { success: true, item } : { success: false, error: '未找到该记忆' }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('memory:consolidate', async () => {
    try {
      const { ONBOARDING_PROFILE_UIDS, memoryDatabase } = await import('../../services/memory/memoryDatabase')
      let profileBuilt = false
      let profileBuildError = ''
      const hasOnboardingProfile = ONBOARDING_PROFILE_UIDS.some((uid) => memoryDatabase.getMemoryItemByUid(uid))
      if (hasOnboardingProfile) {
        try {
          const { resolveProviderConfig } = await import('../../services/agent/resolveProviderConfig')
          const { buildOnboardingUserProfileMemory } = await import('../../services/agent/tools/memory')
          const buildResult = await buildOnboardingUserProfileMemory(resolveProviderConfig())
          profileBuilt = buildResult.built
          profileBuildError = buildResult.reason || ''
        } catch (error) {
          profileBuildError = error instanceof Error ? error.message : String(error)
        }
      }
      return { success: true, result: { ...memoryDatabase.consolidate(50), profileBuilt, ...(profileBuildError ? { profileBuildError } : {}) } }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('memory:exportMarkdown', async (_event, outputDir: string) => {
    try {
      const { memoryDatabase } = await import('../../services/memory/memoryDatabase')
      return { success: true, result: memoryDatabase.exportMarkdown(outputDir) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ========= 克隆好友（数字分身画像，agent_personas.db）=========
  // 克隆聊天：加载画像 → 子进程预检索 + 单次 generateText；完整结果按气泡经 persona:chunk 推回
  ipcMain.handle('persona:chat', async (event, payload: {
    runId: string
    sessionId: string
    messages: UIMessage[]
    reasoningEffort?: AgentReasoningEffort
  }) => {
    const sender = event.sender
    const { runId } = payload
    const sessionId = String(payload?.sessionId || '').trim()
    const send = (chunk: unknown) => { if (!sender.isDestroyed()) sender.send('persona:chunk', { runId, chunk }) }
    const sendProgress = (progress: unknown) => { if (!sender.isDestroyed()) sender.send('persona:progress', { runId, progress }) }
    const aborter = new AbortController()
    const logger = ctx.getLogService()
    agentAborters.set(runId, aborter)
    try {
      if (!sessionId) return { success: false, error: '缺少 sessionId' }
      const { personaStore } = await import('../../services/agent/persona/personaStore')
      const persona = personaStore.get(sessionId)
      if (!persona) return { success: false, error: '尚未克隆该好友，请先生成画像' }

      const { resolveProviderConfig } = await import('../../services/agent/resolveProviderConfig')
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      const { sanitizeModelMessageToolPairs } = await import('../../services/agent/compaction')
      const { prepareProviderFileUploads } = await import('../../services/agent/providerFileUpload')
      const { convertToModelMessages } = await import('ai')
      const providerConfig = resolveProviderConfig({ reasoningEffort: payload.reasoningEffort })
      await refreshAgentRunProxyCached(refreshResolvedProxyUrl)
      const providerFileUpload = await prepareProviderFileUploads(payload.messages || [], providerConfig, logger)
      const messages = sanitizeModelMessageToolPairs(await convertToModelMessages(providerFileUpload.messages))

      // 导演笔记（纠正规则 + 分身对话记忆）：读取失败不阻塞聊天
      let notes: PersonaNotes | undefined
      try {
        const { personaNotesStore } = await import('../../services/agent/persona/personaNotesStore')
        notes = personaNotesStore.getNotes(sessionId)
      } catch { /* 无笔记照常聊 */ }

      const { agentProcessService } = await import('../../services/agent/agentProcessService')
      agentProcessService.setLogger(logger)
      const prewarmPersonaVoice = createPersonaVoiceCachePrewarmer({
        runId,
        sessionId,
        ttsVoice: persona.ttsVoice,
        instructions: persona.card.ttsInstructions,
        signal: aborter.signal,
        logger: logger ?? undefined,
      })
      const sendPersonaChunk = (chunk: unknown) => {
        send(chunk)
        prewarmPersonaVoice(chunk)
      }
      await agentProcessService.personaChat(
        {
          providerConfig,
          persona: {
            sessionId: persona.sessionId,
            displayName: persona.displayName,
            card: persona.card,
            fewShots: persona.fewShots,
            stats: persona.stats,
            profile: persona.profile,
            notes,
            stickers: persona.stickers,
            ttsVoice: persona.ttsVoice,
          },
          messages,
        },
        sendPersonaChunk,
        sendProgress,
        aborter.signal,
      )
      send('[DONE]')
      return { success: true }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger?.error('Persona', '克隆聊天失败', { runId, sessionId, ...errorToLogData(e) })
      send({ type: 'error', errorText: message })
      send('[DONE]')
      return { success: false, error: message }
    } finally {
      agentAborters.delete(runId)
    }
  })

  ipcMain.handle('persona:abort', (_e, runId: string) => {
    agentAborters.get(runId)?.abort()
    return { success: true }
  })

  ipcMain.handle('persona:get', async (_event, sessionId: string) => {
    try {
      const { personaStore } = await import('../../services/agent/persona/personaStore')
      return { success: true, persona: sanitizePersonaForRenderer(personaStore.get(String(sessionId || '').trim())) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('persona:list', async () => {
    try {
      const { personaStore } = await import('../../services/agent/persona/personaStore')
      // self: 前缀是"克隆我自己"的自画像（只供回复建议用），不算克隆的好友，不进列表
      const personas = personaStore.list().filter((persona) => !persona.sessionId.startsWith('self:'))
      return { success: true, personas: personas.map((persona) => sanitizePersonaForRenderer(persona)) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('persona:updateSpeakingStyle', async (_event, payload: { sessionId: string; card?: Partial<PersonaCard> }) => {
    try {
      const sessionId = String(payload?.sessionId || '').trim()
      if (!sessionId) return { success: false, error: '缺少 sessionId' }

      const { personaStore } = await import('../../services/agent/persona/personaStore')
      const current = personaStore.get(sessionId)
      if (!current) return { success: false, error: '尚未克隆该好友' }

      const updated = personaStore.patch(sessionId, {
        card: sanitizePersonaSpeakingStylePatch(payload?.card, current.card),
      })
      if (!updated) return { success: false, error: '保存说话方式失败' }
      return { success: true, persona: sanitizePersonaForRenderer(updated) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('persona:cloneVoice', async (_event, payload: { sessionId: string; displayName?: string }) => {
    try {
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      const { clonePersonaVoiceFromSession } = await import('../../services/agent/persona/personaVoiceCloneService')
      await refreshResolvedProxyUrl()
      const result = await clonePersonaVoiceFromSession({
        sessionId: String(payload?.sessionId || '').trim(),
        displayName: String(payload?.displayName || '').trim(),
        logger: ctx.getLogService() ?? undefined,
      })
      if (!result.success) return result
      return {
        ...result,
        persona: sanitizePersonaForRenderer(result.persona),
        voice: sanitizePersonaVoiceForRenderer(result.voice),
      }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('persona:exportVoiceSample', async (_event, payload: { sessionId: string; displayName?: string; outputPath: string }) => {
    try {
      const { exportPersonaVoiceSampleFromSession } = await import('../../services/agent/persona/personaVoiceCloneService')
      return await exportPersonaVoiceSampleFromSession({
        sessionId: String(payload?.sessionId || '').trim(),
        displayName: String(payload?.displayName || '').trim(),
        outputPath: String(payload?.outputPath || '').trim(),
        minSeconds: 10,
        logger: ctx.getLogService() ?? undefined,
      })
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('persona:delete', async (_event, sessionId: string) => {
    try {
      const id = String(sessionId || '').trim()
      const { personaStore } = await import('../../services/agent/persona/personaStore')
      const removed = personaStore.remove(id)
      // 问答对索引与导演笔记一并清掉（失败不影响画像删除结果）
      try {
        const { personaPairStore } = await import('../../services/agent/persona/personaPairStore')
        personaPairStore.remove(id)
        const { personaNotesStore } = await import('../../services/agent/persona/personaNotesStore')
        personaNotesStore.remove(id)
      } catch { /* ignore */ }
      return { success: removed }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ========= 自动进化 =========
  // 防止同一分身的增量刷新/反思并发重入
  const personaEvolveInFlight = new Set<string>()
  /** 增量进化触发门槛：水位之后对方新消息达到此数才重蒸馏 */
  const PERSONA_REFRESH_MIN_FRIEND_MESSAGES = 50
  /** 对话反思触发门槛：未反思消息达到此数才跑一次 */
  const PERSONA_REFLECT_MIN_MESSAGES = 10

  // 真实数据回路：微信里和 TA 还在继续聊 → 新增消息够多时后台增量重蒸馏（打开分身时由页面触发）
  ipcMain.handle('persona:refreshIfStale', async (_event, payload: { sessionId: string }) => {
    const sessionId = String(payload?.sessionId || '').trim()
    const flightKey = `refresh:${sessionId}`
    const logger = ctx.getLogService()
    if (!sessionId) return { success: false, error: '缺少 sessionId' }
    if (personaEvolveInFlight.has(flightKey)) return { success: true, refreshed: false }
    personaEvolveInFlight.add(flightKey)
    try {
      const { personaStore } = await import('../../services/agent/persona/personaStore')
      const persona = personaStore.get(sessionId)
      if (!persona) return { success: false, error: '尚未克隆该好友' }

      const { chatSearchIndexService } = await import('../../services/search/chatSearchIndexService')
      const messages = await chatSearchIndexService.listSessionMemoryMessages(sessionId, undefined, 2000)
      // 旧画像没有水位列：按画像更新时间当水位
      const watermark = persona.corpusUntil || Math.floor(persona.updatedAt / 1000)
      const fresh = messages.filter((m) => m.createTime > watermark)
      if (fresh.length === 0) return { success: true, refreshed: false }

      const { buildPersonaCorpus, mergeTurns, extractPersonaPairs } = await import('../../services/agent/persona/personaCorpus')
      const freshCorpus = buildPersonaCorpus(fresh, persona.displayName)
      if (freshCorpus.stats.friendMessageCount < PERSONA_REFRESH_MIN_FRIEND_MESSAGES) {
        return { success: true, refreshed: false }
      }

      const { resolveProviderConfig } = await import('../../services/agent/resolveProviderConfig')
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      const providerConfig = resolveProviderConfig()
      await refreshAgentRunProxyCached(refreshResolvedProxyUrl)

      const { agentProcessService } = await import('../../services/agent/agentProcessService')
      agentProcessService.setLogger(logger)
      const revised = await agentProcessService.revisePersona({
        providerConfig,
        friendName: persona.displayName,
        card: persona.card,
        profile: persona.profile,
        newCorpusText: freshCorpus.corpusText,
      })

      const corpusUntil = fresh.reduce((max, m) => Math.max(max, m.createTime), watermark)
      const updated = personaStore.patch(sessionId, {
        card: revised.card,
        profile: revised.profile,
        // 新黄金样本追加在后、总量封顶（最新的优先保留）
        fewShots: [...persona.fewShots, ...revised.newFewShots].slice(-10),
        // 群聊来源标记保留：画像卡里群聊提炼的内容不会因增量修订消失
        stats: {
          ...buildPersonaCorpus(messages, persona.displayName).stats,
          ...(persona.stats.groupMessageCount
            ? { groupMessageCount: persona.stats.groupMessageCount, groupSessionCount: persona.stats.groupSessionCount }
            : {}),
        },
        corpusUntil,
      })

      // 新问答对入索引 + 补嵌入（失败不影响画像修订结果）
      try {
        const { personaPairStore } = await import('../../services/agent/persona/personaPairStore')
        personaPairStore.append(sessionId, extractPersonaPairs(mergeTurns(fresh)))
        await personaPairStore.embedPending(sessionId)
      } catch (e) {
        logger?.warn('Persona', '增量问答对索引失败', { sessionId, ...errorToLogData(e) })
      }

      logger?.warn('Persona', '画像增量进化完成', {
        sessionId,
        freshFriendMessages: freshCorpus.stats.friendMessageCount,
        newFewShots: revised.newFewShots.length,
      })
      return { success: true, refreshed: true, persona: sanitizePersonaForRenderer(updated) }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger?.error('Persona', '画像增量进化失败', { sessionId, ...errorToLogData(e) })
      return { success: false, error: message }
    } finally {
      personaEvolveInFlight.delete(flightKey)
    }
  })

  // 克隆对话回路：每轮保存后由页面触发；未反思消息够多时提炼导演笔记 + 对话摘要
  ipcMain.handle('persona:reflect', async (_event, payload: { sessionId: string; conversationId: number }) => {
    const sessionId = String(payload?.sessionId || '').trim()
    const conversationId = Number(payload?.conversationId || 0)
    const flightKey = `reflect:${sessionId}:${conversationId}`
    const logger = ctx.getLogService()
    if (!sessionId || !Number.isFinite(conversationId) || conversationId <= 0) {
      return { success: false, error: '缺少 sessionId 或 conversationId' }
    }
    if (personaEvolveInFlight.has(flightKey)) return { success: true, reflected: false }
    personaEvolveInFlight.add(flightKey)
    try {
      const { personaStore } = await import('../../services/agent/persona/personaStore')
      const persona = personaStore.get(sessionId)
      if (!persona) return { success: false, error: '尚未克隆该好友' }

      const { agentConversationStore } = await import('../../services/agent/conversationStore')
      const conversation = agentConversationStore.load(conversationId)
      if (!conversation || conversation.scope.kind !== 'persona' || conversation.scope.sessionId !== sessionId) {
        return { success: false, error: '对话不存在或不属于该分身' }
      }

      const { personaNotesStore } = await import('../../services/agent/persona/personaNotesStore')
      const reflectedCount = personaNotesStore.getReflectedCount(sessionId, conversationId)
      const unreflected = conversation.messages.slice(reflectedCount)
      if (unreflected.length < PERSONA_REFLECT_MIN_MESSAGES) return { success: true, reflected: false }

      const transcript = unreflected
        .map((m) => {
          // 表情包气泡的 JSON 载荷对反思没用，压成可读标记
          const text = textFromUiMessage(m)
            .replace(/\[表情包\]\{[^}]*\}/g, '[发了个表情包]')
            .replace(/\n+/g, '／')
            .trim()
          return text ? `${m.role === 'user' ? '我' : `${persona.displayName}（分身）`}: ${text}` : ''
        })
        .filter(Boolean)
        .join('\n')
        .slice(-8000)
      if (!transcript) {
        personaNotesStore.setReflectedCount(sessionId, conversationId, conversation.messages.length)
        return { success: true, reflected: false }
      }

      const { resolveProviderConfig } = await import('../../services/agent/resolveProviderConfig')
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      const providerConfig = resolveProviderConfig()
      await refreshAgentRunProxyCached(refreshResolvedProxyUrl)

      const { agentProcessService } = await import('../../services/agent/agentProcessService')
      agentProcessService.setLogger(logger)
      const result = await agentProcessService.reflectPersona({
        providerConfig,
        friendName: persona.displayName,
        transcript,
      })

      if (result.corrections.length > 0) personaNotesStore.add(sessionId, 'correction', result.corrections)
      if (result.summary) {
        const date = new Date().toISOString().slice(0, 10)
        personaNotesStore.add(sessionId, 'episode', [`${date}：${result.summary}`])
      }
      personaNotesStore.setReflectedCount(sessionId, conversationId, conversation.messages.length)

      logger?.warn('Persona', '克隆对话反思完成', {
        sessionId,
        conversationId,
        corrections: result.corrections.length,
        hasSummary: !!result.summary,
      })
      return { success: true, reflected: true }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger?.error('Persona', '克隆对话反思失败', { sessionId, conversationId, ...errorToLogData(e) })
      return { success: false, error: message }
    } finally {
      personaEvolveInFlight.delete(flightKey)
    }
  })

  // 触发画像 ETL：读消息（懒索引）→ 轮次合并/统计 → 子进程 LLM 提取 → 入库；进度经 persona:buildProgress 推送
  ipcMain.handle('persona:build', async (event, payload: { sessionId: string; displayName?: string }) => {
    const sender = event.sender
    const sessionId = String(payload?.sessionId || '').trim()
    const displayName = String(payload?.displayName || '').trim() || sessionId
    const logger = ctx.getLogService()
    const { buildPersonaFromSession } = await import('../../services/agent/persona/personaBuildService')
    const result = await buildPersonaFromSession({
      sessionId,
      displayName,
      logger,
      onProgress: (progress) => {
        if (!sender.isDestroyed()) sender.send('persona:buildProgress', progress)
      },
    })
    if (result.success && result.persona) {
      return { ...result, persona: sanitizePersonaForRenderer(result.persona) }
    }
    return result
  })

  ipcMain.handle('agent:generateTitle', async (_event, payload: {
    firstMessage: string
    modelConfig?: AgentProviderConfigOverride | null
  }) => {
    try {
      const { agentProcessService } = await import('../../services/agent/agentProcessService')
      const { resolveProviderConfig } = await import('../../services/agent/resolveProviderConfig')
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      await refreshResolvedProxyUrl()
      const providerConfig = resolveProviderConfig(payload.modelConfig)
      const title = await agentProcessService.generateTitle({
        firstMessage: payload.firstMessage,
        providerConfig,
      })
      return { success: true, title }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('agent:optimizePrompt', async (_event, payload: {
    prompt: string
    modelConfig?: AgentProviderConfigOverride | null
    context?: AgentPromptOptimizeContextMessage[]
  }) => {
    try {
      const { agentProcessService } = await import('../../services/agent/agentProcessService')
      const { resolveProviderConfig } = await import('../../services/agent/resolveProviderConfig')
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      await refreshResolvedProxyUrl()
      const providerConfig = resolveProviderConfig(payload.modelConfig)
      const text = await agentProcessService.optimizePrompt({
        prompt: payload.prompt,
        context: payload.context,
        providerConfig,
      })
      return { success: true, text }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('agent:replySuggest', async (_event, payload: {
    input: Omit<import('../../services/agent/engine').ReplySuggestInput, 'providerConfig'>
    modelConfig?: AgentProviderConfigOverride | null
  }) => {
    try {
      const { agentProcessService } = await import('../../services/agent/agentProcessService')
      const { resolveProviderConfig } = await import('../../services/agent/resolveProviderConfig')
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      await refreshResolvedProxyUrl()
      const input = payload.input
      if (input.deep === true) {
        const { agentProfileService } = await import('../../services/agent/agentProfileService')
        const sessionId = String(input.sessionId || '').trim()
        const contactName = String(input.contactName || '').trim()
        const queryText = input.context.map((m) => m.text).join('\n').slice(-2000)
        const profile = await agentProfileService.resolve({
          mode: 'app',
          scope: sessionId ? { kind: 'session', sessionId, displayName: contactName || undefined } : { kind: 'global' },
          modelConfig: payload.modelConfig,
          toolProfile: 'hybrid',
          includeMcpSkills: true,
          queryText,
        })
        const result = await agentProcessService.replySuggest({
          ...input,
          providerConfig: profile.providerConfig,
          mcpTools: profile.mcpTools,
          skills: profile.skills,
          toolProfile: profile.toolProfile,
          codeWorkspace: profile.codeWorkspace,
        })
        return { success: true, ...result }
      }
      const providerConfig = resolveProviderConfig(payload.modelConfig)
      const result = await agentProcessService.replySuggest({
        ...input,
        providerConfig,
      })
      return { success: true, ...result }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 克隆我自己：用与克隆好友一致的 AI 管线提炼"我"对此联系人的说话风格自画像，
  // 按 self: 前缀存储；供"像我"回复建议使用。进度经 persona:buildProgress 推回（sessionId='self:'+原sessionId）
  ipcMain.handle('persona:buildSelf', async (event, payload: { sessionId: string; displayName?: string }) => {
    const sender = event.sender
    const sessionId = String(payload?.sessionId || '').trim()
    const displayName = String(payload?.displayName || '').trim() || sessionId
    const logger = ctx.getLogService()
    const { buildPersonaFromSession } = await import('../../services/agent/persona/personaBuildService')
    const result = await buildPersonaFromSession({
      sessionId,
      displayName,
      role: 'self',
      logger,
      onProgress: (progress) => {
        if (!sender.isDestroyed()) sender.send('persona:buildProgress', progress)
      },
    })
    if (result.success && result.persona) {
      return { ...result, persona: sanitizePersonaForRenderer(result.persona) }
    }
    return result
  })


  ipcMain.handle('ai:getProviders', async () => {
    try {
      const { aiService } = await import('../../services/ai/aiService')
      return aiService.getAllProviders()
    } catch (e) {
      console.error('[AI] 获取提供商列表失败:', e)
      return []
    }
  })

  ipcMain.handle('ai:getProxyStatus', async () => {
    try {
      const { proxyService } = await import('../../services/ai/proxyService')
      const proxyUrl = await proxyService.getSystemProxy()
      return {
        success: true,
        hasProxy: !!proxyUrl,
        proxyUrl: proxyUrl || null
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:refreshProxy', async () => {
    try {
      const { proxyService } = await import('../../services/ai/proxyService')
      proxyService.clearCache()
      const proxyUrl = await proxyService.getSystemProxy()
      return {
        success: true,
        hasProxy: !!proxyUrl,
        proxyUrl: proxyUrl || null,
        message: proxyUrl ? `已刷新代理: ${proxyUrl}` : '未检测到代理，使用直连'
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:testProxy', async (_, proxyUrl: string, testUrl?: string) => {
    try {
      const { proxyService } = await import('../../services/ai/proxyService')
      const success = await proxyService.testProxy(proxyUrl, testUrl)
      return {
        success,
        message: success ? '代理连接正常' : '代理连接失败'
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:testConnection', async (_, provider: string, apiKey: string, baseURL?: string, protocol?: 'openai-responses' | 'openai-compatible' | 'anthropic' | 'google' | 'codex-subscription', model?: string) => {
    try {
      if (provider === 'openai-codex') {
        const { codexSubscriptionService } = await import('../../services/ai/codexSubscriptionService')
        const status = await codexSubscriptionService.getStatus(true)
        return status.authenticated ? { success: true } : { success: false, error: status.error || '请先登录 ChatGPT 账号' }
      }
      const { aiService } = await import('../../services/ai/aiService')
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      await refreshResolvedProxyUrl() // 测试连接也走代理，保证"测试通过=实际可用"
      return await aiService.testConnection(provider, apiKey, baseURL, protocol, model)
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:listModels', async (_, options: { provider: string; apiKey?: string; baseURL?: string; protocol?: 'openai-responses' | 'openai-compatible' | 'anthropic' | 'google' | 'codex-subscription' }) => {
    try {
      if (options.provider === 'openai-codex') {
        const { codexSubscriptionService } = await import('../../services/ai/codexSubscriptionService')
        const { getProviderDefinition } = await import('../../services/ai/providers/catalog')
        const items = await codexSubscriptionService.listModels()
        const details = getProviderDefinition('openai-codex')?.modelDetails || []
        return {
          success: true,
          models: items.map((item) => item.id),
          modelDetails: details,
        }
      }
      const { aiService } = await import('../../services/ai/aiService')
      return await aiService.listProviderModels(options)
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:estimateCost', async (_, messageCount: number, provider: string) => {
    try {
      const { aiService } = await import('../../services/ai/aiService')
      const estimatedTokens = messageCount * 33
      const cost = aiService.estimateCost(estimatedTokens, provider)
      return { success: true, tokens: estimatedTokens, cost }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:readGuide', async (_, guideName: string) => {
    try {
      const guidePath = join(__dirname, '../electron/services/ai', guideName)
      if (!existsSync(guidePath)) {
        return { success: false, error: '指南文件不存在' }
      }
      const content = readFileSync(guidePath, 'utf-8')
      return { success: true, content }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })
}
