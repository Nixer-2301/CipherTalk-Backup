/**
 * 上下文自动压缩（AI 参与）——当「将要发给模型的上下文」估算超过模型窗口的 90% 时，
 * 把早期历史交给 LLM 摘要成要点，折叠进一条 system 消息，保留近端原样，从而把占用压回安全线。
 *
 * 设计要点：
 * - 只压「发给模型的上下文」，不动会话存储里的原始消息（前端仍能看到完整历史）。
 * - 每次折叠会通过 onChunk 发一个 data-compaction 标记，落进当前助手消息的 parts，
 *   随会话持久化、重载后仍在——这是用户要的「历史性压缩记录」。
 * - 摘要失败/取消时安全回退到确定性裁剪（compaction.ts），行为不劣于改动前。
 * - foldedThrough 是「原始 messages 数组」的下标；该数组只在尾部增长，前缀稳定，故下标跨步有效。
 */
import { generateText, type ModelMessage, type UIMessageChunk } from 'ai'
import { createLanguageModel } from './provider'
import { compactMessages } from './compaction'
import type { AgentProviderConfig } from './types'

const DEFAULT_CONTEXT_WINDOW = 128_000
const COMPACT_TRIGGER_RATIO = 0.9
/** 折叠后让保留的尾部约占窗口这个比例，避免压完立刻又触发。 */
const TAIL_BUDGET_RATIO = 0.4
/** 粗略 token 估算：中英混排约每 2.8 字符 1 token。 */
const CHARS_PER_TOKEN = 2.8
const MIN_TAIL_MESSAGES = 4
const SUMMARY_TRANSCRIPT_CHAR_CAP = 24_000
const PER_MESSAGE_CHAR_CAP = 2_000

export interface CompactionState {
  summary: string | null
  /** 已折叠到的原始消息下标：messages[0..foldedThrough) 用 summary 代替。 */
  foldedThrough: number
  markerSeq: number
}

export function createCompactionState(): CompactionState {
  return { summary: null, foldedThrough: 0, markerSeq: 0 }
}

function getPartType(part: unknown): string | undefined {
  return part && typeof part === 'object' && typeof (part as { type?: unknown }).type === 'string'
    ? (part as { type: string }).type
    : undefined
}

function estimateContentChars(content: unknown): number {
  if (content == null) return 0
  if (typeof content === 'string') return content.length
  try {
    return JSON.stringify(content).length
  } catch {
    return 0
  }
}

export function estimateMessageTokens(messages: ModelMessage[]): number {
  let chars = 0
  for (const message of messages) chars += estimateContentChars((message as { content?: unknown }).content)
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/** 用既有摘要折叠前缀：把 messages[0..foldedThrough) 换成一条 system 摘要消息，尾部原样。 */
function applyFold(state: CompactionState, messages: ModelMessage[]): ModelMessage[] {
  if (!state.summary || state.foldedThrough <= 0) return messages
  const summaryMessage: ModelMessage = {
    role: 'system',
    content: `【以下是更早对话的压缩摘要（自动生成，原文仍在历史里）】\n${state.summary}`,
  }
  return [summaryMessage, ...messages.slice(state.foldedThrough)]
}

/** 选定新的尾部起点：从末尾累计约 TAIL_BUDGET_RATIO×窗口 的 token 作尾部，并对齐到一个 user 轮边界。 */
function computeTailStart(messages: ModelMessage[], foldedThrough: number, contextWindow: number): number {
  const tailBudgetChars = contextWindow * TAIL_BUDGET_RATIO * CHARS_PER_TOKEN
  let chars = 0
  let start = messages.length
  for (let i = messages.length - 1; i > foldedThrough; i -= 1) {
    chars += estimateContentChars((messages[i] as { content?: unknown }).content)
    start = i
    if (chars >= tailBudgetChars && messages.length - i >= MIN_TAIL_MESSAGES) break
  }
  // 对齐到 user 边界，避免把某个工具调用与其结果拆到摘要与尾部两侧
  for (let i = start; i > foldedThrough; i -= 1) {
    if ((messages[i] as { role?: string }).role === 'user') return i
  }
  return start
}

function roleLabel(role: string): string {
  if (role === 'user') return '用户'
  if (role === 'assistant') return 'AI'
  if (role === 'tool') return '工具'
  return role
}

function renderMessageForSummary(message: ModelMessage): string {
  const content = (message as { content?: unknown }).content
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    text = content
      .map((part) => {
        const type = getPartType(part)
        if (type === 'text') return String((part as { text?: unknown }).text || '')
        if (type === 'tool-call') return `[调用工具 ${(part as { toolName?: unknown }).toolName || ''}]`
        if (type === 'tool-result') return '[工具返回结果（已省略明细）]'
        if (type === 'image' || type === 'file') return '[媒体]'
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  text = text.slice(0, PER_MESSAGE_CHAR_CAP).trim()
  return text ? `${roleLabel((message as { role: string }).role)}：${text}` : ''
}

async function summarizeHistory(
  existingSummary: string | null,
  messagesToFold: ModelMessage[],
  providerConfig: AgentProviderConfig,
  signal?: AbortSignal,
): Promise<string> {
  const transcript = messagesToFold
    .map(renderMessageForSummary)
    .filter(Boolean)
    .join('\n')
    .slice(0, SUMMARY_TRANSCRIPT_CHAR_CAP)
  if (!transcript) return existingSummary || ''

  const result = await generateText({
    model: createLanguageModel(providerConfig),
    instructions: [
      '你在压缩一段长对话的早期历史，供后续轮次作为背景继续使用。目标是「不丢关键信息」地缩短它。',
      '必须保留：用户的身份/偏好/长期目标、已确认的事实与数据结论（连同来源/时间/数字）、达成的决定与承诺、未解决的问题与待办、出现过的关键人物/会话/实体。',
      '可以丢弃：寒暄、重复、过程性试错、冗长的工具原始输出。',
      '输出简洁的中文要点（可分小标题/列表），只基于给定内容，不要编造，不要复述本提示。',
    ].join('\n'),
    prompt: [
      existingSummary ? `已有的前情摘要：\n${existingSummary}\n` : '',
      '需要并入摘要的更早对话：',
      transcript,
      '\n请输出合并后的、更新过的完整摘要。',
    ].filter(Boolean).join('\n'),
    abortSignal: signal,
  })
  return result.text.trim() || existingSummary || ''
}

function buildCompactionMarker(params: {
  seq: number
  summary: string
  foldedMessages: number
  approxTokensBefore: number
  approxTokensAfter: number
  contextWindow: number
}): UIMessageChunk {
  return {
    type: 'data-compaction',
    id: `compaction-${params.seq}`,
    data: {
      summary: params.summary,
      foldedMessages: params.foldedMessages,
      approxTokensBefore: params.approxTokensBefore,
      approxTokensAfter: params.approxTokensAfter,
      contextWindow: params.contextWindow,
    },
  } as UIMessageChunk
}

/**
 * 每步压缩入口（在引擎 prepareStep 调用）：先套用既有折叠，估算占用；
 * 超过 90% 就把更早历史交给 LLM 摘要、推进 foldedThrough、发持久标记；最后叠加确定性裁剪。
 */
export async function aiCompactStep(params: {
  messages: ModelMessage[]
  state: CompactionState
  providerConfig: AgentProviderConfig
  emit: (chunk: UIMessageChunk) => void
  signal?: AbortSignal
}): Promise<ModelMessage[]> {
  const contextWindow = params.providerConfig.contextWindow || DEFAULT_CONTEXT_WINDOW
  const threshold = contextWindow * COMPACT_TRIGGER_RATIO

  let folded = applyFold(params.state, params.messages)
  const approxBefore = estimateMessageTokens(folded)
  if (approxBefore <= threshold) {
    return compactMessages(folded)
  }

  const tailStart = computeTailStart(params.messages, params.state.foldedThrough, contextWindow)
  if (tailStart <= params.state.foldedThrough) {
    // 没有可再折叠的早期消息（尾部本身已超）→ 退回确定性裁剪兜底
    return compactMessages(folded)
  }

  try {
    const toFold = params.messages.slice(params.state.foldedThrough, tailStart)
    const summary = await summarizeHistory(params.state.summary, toFold, params.providerConfig, params.signal)
    if (params.signal?.aborted) return compactMessages(folded)
    if (summary) {
      params.state.summary = summary
      params.state.foldedThrough = tailStart
      folded = applyFold(params.state, params.messages)
      params.emit(buildCompactionMarker({
        seq: (params.state.markerSeq += 1),
        summary,
        foldedMessages: tailStart,
        approxTokensBefore: approxBefore,
        approxTokensAfter: estimateMessageTokens(folded),
        contextWindow,
      }))
    }
  } catch {
    // 摘要失败/取消：退回确定性裁剪，不插标记，行为不劣于改动前
  }

  return compactMessages(folded)
}
