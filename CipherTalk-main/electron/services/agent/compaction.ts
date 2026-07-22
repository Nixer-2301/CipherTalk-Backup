/**
 * 上下文压缩 —— 确定性裁剪（不额外花 LLM）。
 *
 * 本 agent 最大的上下文来源是工具结果（semantic_search / get_context 返回大数组），
 * 24 步 ReAct 循环里累积起来才是「爆上下文」的真凶。故在 engine 的 prepareStep 里，对
 * 「每步将发给模型的 messages」做裁剪：保留最近若干步的工具调用/结果原样，裁掉更早的
 * （它们已被模型消化进自己的文本回答），并去掉旧推理痕迹与空消息。prepareStep 在 step 0
 * 也会跑，所以一处即覆盖「历史轮次」与「循环内累积」两种情况。
 *
 * 对短对话优先走 AI SDK pruneMessages；对超大上下文走本地轻量裁剪，避免在 prepareStep 的
 * 同步压缩阶段被巨大的工具输出/媒体 part 拖死。
 * 早期轮次「摘要化」（需额外 LLM 调用）作为后续可选项，暂不做。
 */
import { pruneMessages, type ModelMessage } from 'ai'

/** 保留最近这么多条消息的工具调用/结果原样，更早的裁掉（约 4 个工具往返）。 */
const KEEP_RECENT_TOOL_MESSAGES = 8
const FAST_KEEP_RECENT_MESSAGES = 16
const SAFE_PRUNE_MAX_MESSAGES = 80
const SAFE_PRUNE_MAX_PARTS = 800
const SAFE_PRUNE_MAX_ESTIMATED_CHARS = 180_000
const OLD_TEXT_CHAR_LIMIT = 6_000
const ESTIMATE_MAX_ARRAY_ITEMS = 20
const ESTIMATE_MAX_OBJECT_KEYS = 40
const WARN_INTERVAL_MS = 15_000

type MessageStats = {
  messageCount: number
  partCount: number
  estimatedChars: number
}

let lastFallbackWarnAt = 0

export function compactMessages(messages: ModelMessage[]): ModelMessage[] {
  const stats = estimateMessages(messages)
  const oversizedReason = getOversizedReason(stats)
  if (oversizedReason) {
    warnFallback(oversizedReason, stats)
    return sanitizeModelMessageToolPairs(fastCompactMessages(messages))
  }

  try {
    return sanitizeModelMessageToolPairs(pruneMessages({
      messages,
      reasoning: 'before-last-message',
      toolCalls: `before-last-${KEEP_RECENT_TOOL_MESSAGES}-messages`,
      emptyMessages: 'remove',
    }))
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    warnFallback(`AI SDK pruneMessages 失败：${detail}`, stats)
    return sanitizeModelMessageToolPairs(fastCompactMessages(messages))
  }
}

export function sanitizeModelMessageToolPairs(messages: ModelMessage[]): ModelMessage[] {
  const calls = new Set<string>()
  const results = new Set<string>()

  for (const message of messages) {
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      const type = getPartType(part)
      const id = getStringField(part, 'toolCallId')
      if (!id) continue
      if (type === 'tool-call') calls.add(id)
      if (type === 'tool-result') results.add(id)
    }
  }

  const sanitized = messages
    .map((message) => sanitizeMessageToolPairs(message, calls, results))
    .filter((message): message is ModelMessage => Boolean(message) && !isEmptyMessage(message))

  if (sanitized.length !== messages.length || hasToolPairPartDelta(messages, sanitized)) {
    warnToolPairSanitized(messages, sanitized)
  }

  return sanitized
}

function getOversizedReason(stats: MessageStats): string | null {
  if (stats.messageCount > SAFE_PRUNE_MAX_MESSAGES) return `消息数过大 ${stats.messageCount}/${SAFE_PRUNE_MAX_MESSAGES}`
  if (stats.partCount > SAFE_PRUNE_MAX_PARTS) return `消息 part 过多 ${stats.partCount}/${SAFE_PRUNE_MAX_PARTS}`
  if (stats.estimatedChars > SAFE_PRUNE_MAX_ESTIMATED_CHARS) {
    return `估算上下文过大 ${stats.estimatedChars}/${SAFE_PRUNE_MAX_ESTIMATED_CHARS}`
  }
  return null
}

function warnFallback(reason: string, stats: MessageStats): void {
  const now = Date.now()
  if (now - lastFallbackWarnAt < WARN_INTERVAL_MS) return
  lastFallbackWarnAt = now
  console.warn(
    `[agent:compaction] 使用快速上下文裁剪：${reason}，messages=${stats.messageCount}, parts=${stats.partCount}, estimatedChars=${stats.estimatedChars}`,
  )
}

function estimateMessages(messages: ModelMessage[]): MessageStats {
  const seen = new WeakSet<object>()
  let partCount = 0
  let estimatedChars = 0

  for (const message of messages) {
    const content = (message as { content?: unknown }).content
    if (Array.isArray(content)) partCount += content.length
    estimatedChars += estimateValueSize(content, seen)
  }

  return {
    messageCount: messages.length,
    partCount,
    estimatedChars,
  }
}

function estimateValueSize(value: unknown, seen: WeakSet<object>, depth = 0): number {
  if (value == null) return 0
  if (typeof value === 'string') return Math.min(value.length, SAFE_PRUNE_MAX_ESTIMATED_CHARS + 1)
  if (typeof value === 'number' || typeof value === 'boolean') return 8
  if (typeof value !== 'object') return 0
  if (seen.has(value)) return 0
  seen.add(value)
  if (depth >= 4) return 64

  if (Array.isArray(value)) {
    let total = Math.min(value.length * 8, SAFE_PRUNE_MAX_ESTIMATED_CHARS + 1)
    const limit = Math.min(value.length, ESTIMATE_MAX_ARRAY_ITEMS)
    for (let i = 0; i < limit; i += 1) {
      total += estimateValueSize(value[i], seen, depth + 1)
      if (total > SAFE_PRUNE_MAX_ESTIMATED_CHARS) return total
    }
    return total
  }

  let total = 0
  let inspected = 0
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    total += key.length + estimateValueSize(child, seen, depth + 1)
    inspected += 1
    if (total > SAFE_PRUNE_MAX_ESTIMATED_CHARS || inspected >= ESTIMATE_MAX_OBJECT_KEYS) break
  }
  return total
}

function fastCompactMessages(messages: ModelMessage[]): ModelMessage[] {
  const tailStart = Math.max(0, messages.length - FAST_KEEP_RECENT_MESSAGES)
  const keepIds = collectKeptIds(messages.slice(tailStart))
  const out: ModelMessage[] = []

  for (let i = 0; i < messages.length; i += 1) {
    const message = i >= tailStart
      ? messages[i]
      : compactOldMessage(messages[i], keepIds)
    if (!isEmptyMessage(message)) out.push(message)
  }

  return out
}

function collectKeptIds(messages: ModelMessage[]): { toolCallIds: Set<string>; approvalIds: Set<string> } {
  const toolCallIds = new Set<string>()
  const approvalIds = new Set<string>()

  for (const message of messages) {
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      const type = getPartType(part)
      if (type === 'tool-call' || type === 'tool-result') {
        const id = getStringField(part, 'toolCallId')
        if (id) toolCallIds.add(id)
      } else if (type === 'tool-approval-request' || type === 'tool-approval-response') {
        const id = getStringField(part, 'approvalId')
        if (id) approvalIds.add(id)
      }
    }
  }

  return { toolCallIds, approvalIds }
}

function compactOldMessage(
  message: ModelMessage,
  keepIds: { toolCallIds: Set<string>; approvalIds: Set<string> },
): ModelMessage {
  const content = (message as { content?: unknown }).content

  if (typeof content === 'string') {
    return { ...message, content: truncateOldText(content) } as ModelMessage
  }

  if (!Array.isArray(content)) return message

  const compacted = content
    .map((part) => compactOldPart(part, keepIds))
    .filter((part): part is Record<string, unknown> => Boolean(part))

  return { ...message, content: compacted } as ModelMessage
}

function compactOldPart(
  part: unknown,
  keepIds: { toolCallIds: Set<string>; approvalIds: Set<string> },
): Record<string, unknown> | null {
  if (!part || typeof part !== 'object') return null
  const record = part as Record<string, unknown>
  const type = getPartType(record)

  if (type === 'reasoning') return null

  if (type === 'tool-call' || type === 'tool-result') {
    const id = getStringField(record, 'toolCallId')
    return id && keepIds.toolCallIds.has(id) ? record : null
  }

  if (type === 'tool-approval-request' || type === 'tool-approval-response') {
    const id = getStringField(record, 'approvalId')
    return id && keepIds.approvalIds.has(id) ? record : null
  }

  if (type === 'image' || type === 'file') return null

  if (type === 'text' && typeof record.text === 'string') {
    return { ...record, text: truncateOldText(record.text) }
  }

  return record
}

function sanitizeMessageToolPairs(
  message: ModelMessage,
  calls: Set<string>,
  results: Set<string>,
): ModelMessage | null {
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return message

  const compacted = content.filter((part) => {
    const type = getPartType(part)
    if (type !== 'tool-call' && type !== 'tool-result') return true
    const id = getStringField(part, 'toolCallId')
    if (!id) return false
    return calls.has(id) && results.has(id)
  })

  if (compacted.length === 0) return null
  return compacted.length === content.length ? message : { ...message, content: compacted } as ModelMessage
}

function countToolPairParts(messages: ModelMessage[]): number {
  let count = 0
  for (const message of messages) {
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      const type = getPartType(part)
      if (type === 'tool-call' || type === 'tool-result') count += 1
    }
  }
  return count
}

function hasToolPairPartDelta(before: ModelMessage[], after: ModelMessage[]): boolean {
  return countToolPairParts(before) !== countToolPairParts(after)
}

function warnToolPairSanitized(before: ModelMessage[], after: ModelMessage[]): void {
  console.warn(
    `[agent:compaction] 已移除不完整工具调用：messages ${before.length}->${after.length}, toolParts ${countToolPairParts(before)}->${countToolPairParts(after)}`,
  )
}

function getPartType(part: unknown): string | undefined {
  return part && typeof part === 'object' && typeof (part as { type?: unknown }).type === 'string'
    ? (part as { type: string }).type
    : undefined
}

function getStringField(part: unknown, field: string): string | undefined {
  return part && typeof part === 'object' && typeof (part as Record<string, unknown>)[field] === 'string'
    ? (part as Record<string, string>)[field]
    : undefined
}

function truncateOldText(text: string): string {
  if (text.length <= OLD_TEXT_CHAR_LIMIT) return text
  return `${text.slice(0, OLD_TEXT_CHAR_LIMIT)}\n[旧消息过长，已截断]`
}

function isEmptyMessage(message: ModelMessage): boolean {
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content.length === 0
  if (Array.isArray(content)) return content.length === 0
  return false
}
