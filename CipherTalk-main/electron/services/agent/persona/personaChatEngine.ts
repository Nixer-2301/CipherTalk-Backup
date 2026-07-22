/**
 * 克隆好友聊天引擎 —— 跑在 AI utilityProcess 子进程。
 * 与 AI 助手（engine.ts 的工具循环）刻意不同：扮演真人不暴露工具，
 * 每轮先做一次记忆预检索（向量优先、关键词兜底，失败静默），
 * 再单次 generateText 完整生成后按气泡回推 —— 人格稳定性优先于能力灵活性。
 */
import { generateText, type FinishReason, type ModelMessage, type UIMessageChunk } from 'ai'
import { createLanguageModel } from '../provider'
import { buildReasoningOption } from '../cache'
import { reportAgentProgress, withAgentProgress } from '../progress'
import { searchChat } from '../tools/shared'
import type { AgentProgressReporter } from '../types'
import type { PersonaChatInput, PersonaChatPersona, PersonaFewShot, PersonaSticker } from './personaTypes'

const MEMORY_TOP_K = 5
const PAIR_TOP_K = 6
// 扮演真人要比工具 Agent 更"活"，温度调高
const PERSONA_TEMPERATURE = 0.8
const BURST_JOINER = '---wx-next---'
const HUMAN_TYPING_MS_PER_CHAR = 260
const HUMAN_TYPING_MIN_DELAY_MS = 1000
const HUMAN_TYPING_MAX_DELAY_MS = 7500
const HUMAN_BUBBLE_PAUSE_MIN_MS = 700
const HUMAN_BUBBLE_PAUSE_MAX_MS = 2200

/** 语音气泡标记：行首 [语音]/【语音】，渲染端显示成微信语音条（见 PersonaChatPage）。 */
const VOICE_MARKER_RE = /^[\[【]\s*(?:语音|voice)\s*[\]】]/i

function splitReplyBubbles(text: string): string[] {
  return text
    .split(new RegExp(`^\\s*${BURST_JOINER}\\s*$`, 'm'))
    .flatMap((bubble) => {
      const trimmed = bubble.trim()
      if (!trimmed) return []
      if (VOICE_MARKER_RE.test(trimmed)) return [trimmed]
      return trimmed.split(/[\n／]/).map((line) => line.trim()).filter(Boolean)
    })
}

// 兜底拆条：不分条的回复超过 max(此值, 平均字数×2.5) 才动它
const FALLBACK_SPLIT_MIN_CHARS = 50
const FALLBACK_MAX_BUBBLES = 5

/** 模型点播表情包的标记：[表情:编号]，编号对应词典里 TA 常用的表情包。 */
const STICKER_INTENT_RE = /[\[【]\s*表情\s*[:：]\s*(\d+)\s*[\]】]/
/** 发给渲染端的表情包气泡前缀，后跟 JSON（cdnUrl/md5 等），渲染端显示成真实表情包图片。 */
const STICKER_BUBBLE_PREFIX = '[表情包]'
/** 表情包气泡的"挑选"延迟：不按字数算（JSON 很长但真人翻表情只要一两秒）。 */
const STICKER_PICK_DELAY_MS = 1100

/**
 * 把模型输出里的 [表情:N] 标记换成带真实表情包数据的气泡行。
 * 编号越界回退到最常用的一张；没有词典时丢弃标记行（别把哑标记发给用户）。
 */
function resolveStickerMarkers(text: string, stickers: PersonaSticker[]): string {
  const bubbles = splitReplyBubbles(text)
  const out: string[] = []
  for (const bubble of bubbles) {
    let rest = bubble
    while (rest) {
      const match = rest.match(STICKER_INTENT_RE)
      if (!match) {
        out.push(rest)
        break
      }

      const markerIndex = match.index ?? 0
      const before = rest.slice(0, markerIndex).trim()
      if (before) out.push(before)

      const sticker = stickers[Number(match[1]) - 1] || stickers[0]
      if (sticker) {
        out.push(`${STICKER_BUBBLE_PREFIX}${JSON.stringify({
          cdnUrl: sticker.cdnUrl,
          md5: sticker.md5,
          productId: sticker.productId,
          encryptUrl: sticker.encryptUrl,
          aesKey: sticker.aesKey,
        })}`)
      }

      rest = rest.slice(markerIndex + match[0].length).trim()
    }
  }
  // 全是无法解析的标记被丢光时退回原文，至少别发空消息
  return out.length > 0 ? out.join(`\n${BURST_JOINER}\n`) : text
}

const STICKER_BUBBLE_RE = /\[表情包\](\{[^}]*\})/g

/** 历史里的表情包气泡（JSON 载荷）映射回 [表情:N] 标记：模型看到的历史和它学的约定一致，不会模仿着输出 JSON。 */
function maskStickerHistory(messages: ModelMessage[], stickers: PersonaSticker[]): ModelMessage[] {
  const toMarker = (payload: string): string => {
    try {
      const data = JSON.parse(payload) as { md5?: string; cdnUrl?: string }
      const index = stickers.findIndex((s) => (s.md5 && s.md5 === data.md5) || (s.cdnUrl && s.cdnUrl === data.cdnUrl))
      if (index >= 0) return `[表情:${index + 1}]`
    } catch { /* 载荷损坏给通用描述 */ }
    return '[发了个表情包]'
  }
  const maskText = (text: string): string => text.replace(STICKER_BUBBLE_RE, (_, payload: string) => toMarker(payload))

  return messages.map((m) => {
    if (m.role !== 'assistant') return m
    if (typeof m.content === 'string') return { ...m, content: maskText(m.content) }
    if (Array.isArray(m.content)) {
      return {
        ...m,
        content: m.content.map((part) =>
          part && typeof part === 'object' && part.type === 'text'
            ? { ...part, text: maskText(String(part.text || '')) }
            : part),
      }
    }
    return m
  }) as ModelMessage[]
}

function wantsVoiceForwardReply(text: string): boolean {
  const normalized = text.replace(/\s+/g, '')
  if (!normalized) return false
  return /(?:全程|全部|都|只|一直|连续|接着|多发|几条|几段|长点|长一点).{0,10}(?:语音|声音|听)/i.test(normalized)
    || /(?:语音|声音).{0,10}(?:夸|说|发|回|回复|聊|听)/i.test(normalized)
    || /不想看.{0,10}(?:想听|听)/i.test(normalized)
    || /(?:voice|audio).{0,12}(?:only|reply|message|messages|say|speak)/i.test(normalized)
}

/** 模型偶尔无视分条规则直接发大段：按句子边界兜底拆成微信式短消息（已分条/不算长的原样返回）。 */
function fallbackSplitLongReply(text: string, avgChars: number): string {
  const trimmed = text.trim()
  // 语音消息本来就可以一大段（60 秒长语音很真实），不拆，拆了标记也会丢
  if (VOICE_MARKER_RE.test(trimmed)) return text
  if (splitReplyBubbles(trimmed).length > 1) return text
  if (trimmed.length <= Math.max(FALLBACK_SPLIT_MIN_CHARS, avgChars * 2.5)) return text

  const sentences = trimmed.split(/(?<=[。！？!?…])/).map((s) => s.trim()).filter(Boolean)
  if (sentences.length <= 1) return text

  // 单条目标长度：贴近真人平均字数，同时保证不会拆出超过上限的条数
  const target = Math.max(20, Math.round(avgChars * 1.8), Math.ceil(trimmed.length / FALLBACK_MAX_BUBBLES))
  const bubbles: string[] = []
  let current = ''
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > target) {
      bubbles.push(current)
      current = sentence
    } else {
      current += sentence
    }
  }
  if (current) bubbles.push(current)
  return bubbles.join(`\n${BURST_JOINER}\n`)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function jitter(ms: number): number {
  return Math.round(ms * randomBetween(0.85, 1.2))
}

function typingDelayMs(text: string): number {
  const charCount = Array.from(text.replace(/\s+/g, '')).length
  const punctuationCount = text.match(/[，。！？!?…~～、,.]/g)?.length || 0
  return clamp(
    jitter(charCount * HUMAN_TYPING_MS_PER_CHAR + punctuationCount * 90),
    HUMAN_TYPING_MIN_DELAY_MS,
    HUMAN_TYPING_MAX_DELAY_MS,
  )
}

function bubblePauseMs(index: number): number {
  return index === 0 ? 0 : Math.round(randomBetween(HUMAN_BUBBLE_PAUSE_MIN_MS, HUMAN_BUBBLE_PAUSE_MAX_MS))
}

function waitMs(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  if (ms <= 0) return Promise.resolve(true)

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (completed: boolean) => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(completed)
    }
    const onAbort = () => done(false)

    timer = setTimeout(() => done(true), ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function emitCompleteTextAsUiChunks(
  text: string,
  finishReason: FinishReason,
  metadata: Record<string, unknown>,
  onChunk: (chunk: UIMessageChunk) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const textId = `persona-text-${Date.now()}`
  onChunk({ type: 'start' })
  onChunk({ type: 'start-step' })
  const bubbles = splitReplyBubbles(text)
  for (let i = 0; i < bubbles.length; i += 1) {
    const delay = bubbles[i].startsWith(STICKER_BUBBLE_PREFIX) ? jitter(STICKER_PICK_DELAY_MS) : typingDelayMs(bubbles[i])
    const completed = await waitMs(bubblePauseMs(i) + delay, signal)
    if (!completed) {
      onChunk({ type: 'abort', reason: 'aborted' })
      return false
    }
    const bubbleTextId = `${textId}-${i}`
    onChunk({ type: 'text-start', id: bubbleTextId })
    onChunk({ type: 'text-delta', id: bubbleTextId, delta: bubbles[i] })
    onChunk({ type: 'text-end', id: bubbleTextId })
  }
  onChunk({ type: 'finish-step' })
  onChunk({ type: 'finish', finishReason, messageMetadata: metadata })
  return true
}

function messageTextOf(m: ModelMessage): string {
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) {
    return m.content
      .map((p) => (p && typeof p === 'object' && 'type' in p && p.type === 'text' ? String(p.text || '') : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function lastUserText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role !== 'user') continue
    return messageTextOf(messages[i])
  }
  return ''
}

/** 向量检索用的近几轮对话拼接（截尾 capChars）：「那你觉得呢」这类承接句单独拿去检索等于抽奖。 */
function recentConversationText(messages: ModelMessage[], capChars = 300): string {
  const parts: string[] = []
  let used = 0
  for (let i = messages.length - 1; i >= 0 && used < capChars; i -= 1) {
    const m = messages[i]
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const text = messageTextOf(m).trim()
    if (!text) continue
    parts.push(text)
    used += text.length
  }
  return parts.reverse().join('\n').slice(-capChars)
}

/**
 * 记忆预检索：嵌入就绪走会话片段向量（首聊触发懒构建，进度上报），否则/失败关键词兜底。
 * contextQuery（近几轮拼接）只喂向量路径；关键词兜底仍用单句 query，长文本会稀释 FTS 命中。
 */
async function retrieveMemories(sessionId: string, query: string, outputMode: PersonaChatInput['outputMode'] = 'app', contextQuery?: string): Promise<string[]> {
  const lineJoiner = outputMode === 'wechat' ? BURST_JOINER : ' / '
  try {
    const { getEmbeddingConfig } = await import('../../ai/embeddingService')
    const { messageVectorService, embedQuery } = await import('../../search/messageVectorService')
    const cfg = getEmbeddingConfig()
    if (messageVectorService.isReady(cfg)) {
      const queryVec = await embedQuery(contextQuery?.trim() || query, cfg)
      await messageVectorService.ensureSessionVectors(sessionId, cfg, undefined, (progress) => {
        reportAgentProgress({
          stage: progress.stage === 'embedding' ? 'indexing' : 'searching',
          title: progress.message,
          sessionId,
        })
      })
      const hits = messageVectorService.searchSession(sessionId, queryVec, MEMORY_TOP_K)
      if (hits.length > 0) {
        return hits.map((h) => h.excerpt.replace(/\n+/g, lineJoiner))
      }
    }
  } catch {
    /* 向量检索失败 → 关键词兜底 */
  }
  try {
    const { hits } = await searchChat({ query, sessionId, limit: MEMORY_TOP_K })
    return hits.map((h) => `${h.sender}: ${h.excerpt.replace(/\n+/g, lineJoiner)}`)
  } catch {
    return []
  }
}

/** 检索式 few-shot：按当前输入找 TA 过去遇到类似话时的真实回复（失败静默）。 */
async function retrieveSimilarPairs(sessionId: string, query: string, contextQuery?: string): Promise<PersonaFewShot[]> {
  try {
    const { personaPairStore } = await import('./personaPairStore')
    const hits = await personaPairStore.search(sessionId, query, PAIR_TOP_K, contextQuery)
    return hits.map((h) => ({ user: h.user, replies: h.replies, ...(h.context ? { context: h.context } : {}) }))
  } catch {
    return []
  }
}

/** 把克隆得到的真实语音占比转成发语音倾向提示（用第二人称，分身即本人）；占比过低或缺失返回 null，走默认克制。 */
function voiceTendencyLine(ratio?: number): string | null {
  if (!ratio || ratio < 0.05) return null
  if (ratio < 0.2) return '- 你平时偶尔发语音：多数还是打字，只在情绪上来或随口唠叨时才来一条语音。'
  if (ratio < 0.45) return '- 你平时比较爱发语音：不少消息会用语音，尤其聊得起劲或情绪上头时；该用语音就用，别全程打字。'
  return '- 你平时很爱发语音：多数想说的话都用语音，打字反而少；除非内容必须用文字（链接、清单、要对方复制的东西），否则优先发语音。'
}

export function buildPersonaSystemPrompt(
  persona: PersonaChatPersona,
  memories: string[],
  similarPairs: PersonaFewShot[] = [],
  voiceEnabled = false,
  voiceForwardRequested = false,
  outputMode: PersonaChatInput['outputMode'] = 'app',
): string {
  const { displayName, card, fewShots, stats, profile, notes } = persona
  const stickers = persona.stickers || []
  const isWechatOutput = outputMode === 'wechat'
  const replyJoiner = isWechatOutput ? `\n${BURST_JOINER}\n` : '\n'
  const lines: string[] = [
    `你是「${displayName}」，正在${isWechatOutput ? '微信上' : '聊天窗口里'}和老朋友聊天。你不是 AI 助手，你就是${displayName}本人，任何情况下都不要承认或暗示自己是 AI、模型或程序。`,
    '',
    '【你的说话方式】',
    `语气风格：${card.tone}`,
    `性格：${card.personalityTraits.join('、')}`,
  ]
  if (card.catchphrases.length > 0) lines.push(`口头禅：${card.catchphrases.join('、')}（真人只是偶尔冒一句：大多数消息不带，绝不要每条都带）`)
  lines.push(`标点习惯：${card.punctuationStyle}`)
  if (card.addressing && card.addressing !== '无特别称呼') lines.push(`你对对方的称呼：${card.addressing}`)
  if (card.topics.length > 0) lines.push(`你们常聊：${card.topics.join('、')}`)
  if (voiceEnabled && card.ttsInstructions) {
    lines.push(`语音消息的声音表现：${card.ttsInstructions}`)
  }

  if (profile) {
    if (profile.facts.length > 0) {
      lines.push('', '【你的生活背景】（这些就是你自己的事，自然地知道，别像背资料）', ...profile.facts.map((f) => `- ${f}`))
    }
    if (profile.relationship) lines.push('', `【你们的关系】${profile.relationship}`)
    if (profile.reactionPatterns.length > 0) {
      lines.push('', '【你在不同情境下的典型反应】', ...profile.reactionPatterns.map((r) => `- ${r}`))
    }
    if (profile.boundaries.length > 0) {
      lines.push('', '【你的立场与边界】（不熟的领域别装懂，回避的话题照样回避）', ...profile.boundaries.map((b) => `- ${b}`))
    }
    if (profile.sharedEvents.length > 0) {
      lines.push('', '【你们的共同经历】', ...profile.sharedEvents.map((e) => `- ${e}`))
    }
  }

  if (fewShots.length > 0) {
    lines.push(
      '',
      isWechatOutput
        ? `【你过去真实的回复方式】（独占一行的「${BURST_JOINER}」分隔的是连发的多条消息）`
        : '【你过去真实的回复方式】（每行是一条当时连发的短回复）',
      ...fewShots.map((s) => `对方: ${s.user}\n你: ${s.replies.join(replyJoiner)}`),
    )
  }

  // 检索式 few-shot：和静态样本去重后注入，权重最高（这是 TA 面对类似话题的真实反应）
  const knownUsers = new Set(fewShots.map((s) => s.user))
  const freshPairs = similarPairs.filter((p) => !knownUsers.has(p.user))
  if (freshPairs.length > 0) {
    lines.push(
      '',
      '【你过去遇到类似话题时的真实回复】（最值得参考的范例：当时就是这么回的，语气、长度、分条都照这个感觉来）',
      ...freshPairs.map((s) =>
        `${s.context ? `(之前聊到: ${s.context})\n` : ''}对方: ${s.user}\n你: ${s.replies.join(replyJoiner)}`),
    )
  }

  if (memories.length > 0) {
    lines.push(
      '',
      '【可能相关的真实聊天片段】（你们真的聊过这些，可自然提及，但别逐字背诵、别主动复述无关内容）',
      ...memories.map((m) => `- ${m}`),
    )
  }

  if (notes?.episodes?.length) {
    lines.push(
      '',
      '【你们最近在这里聊过】（之前的对话，记得就好，别主动复述）',
      ...notes.episodes.map((e) => `- ${e}`),
    )
  }

  if (notes?.corrections?.length) {
    lines.push(
      '',
      '【扮演纠正】（对方之前明确指出过的问题，必须遵守）',
      ...notes.corrections.map((c) => `- ${c}`),
    )
  }

  lines.push(
    '',
    '【聊天规则】',
    isWechatOutput
      ? `- 微信短消息风格：文字气泡单条 ${Math.max(stats.avgFriendMsgChars, 4)} 字左右；超过两句话通常拆成多条连发。要拆成多条时，在两条消息之间单独输出一行「${BURST_JOINER}」。`
      : `- 聊天软件短消息风格：单条 ${Math.max(stats.avgFriendMsgChars, 4)} 字左右；超过两句话通常拆成几条短回复。`,
    '- 回复几条由你根据上下文定：简单的话就一条，有内容的拆成 2-4 条，像真人打字那样一句一句发',
    ...(voiceEnabled ? [
      '- 你可以发语音消息：哪条更像你会用语音说（情绪上头、内容长懒得打字、随口唠叨、想让对方听到语气时），就在那条开头加「[语音]」标记，它会以语音条发出、对方点开能听到你的声音。语音合成会使用上面的声音表现指令；语音不受文字气泡长度限制，你自己按场景和这个人的习惯判断长短：有人会发几秒短语音，也会发几十秒长语音；长语音可以更口语化、带停顿和“呃”“然后”这种，但别为了凑长度废话',
      ...(voiceTendencyLine(stats.voiceRatio) ? [voiceTendencyLine(stats.voiceRatio) as string] : []),
      ...(voiceForwardRequested ? [
        '- 这轮对方明确说想听语音/全程语音/多发几条语音：你应该明显提高语音比例。可以是一条比较完整的长语音，也可以是几条短语音连续发；每条语音的长短由你根据语气、情绪和内容自然决定。想用语音发的每条都以「[语音]」开头，仍然按真人感觉决定，不要机械地把所有内容都变成同样长度的语音',
      ] : []),
    ] : []),
    ...(stickers.length > 0 ? [
      '- 你可以发表情包：想发时单独占一条输出「[表情:编号]」（如 [表情:2]），它会变成你真实用过的那张表情包图片发出。表情包是点缀：只在情绪到位时发（大笑、无语、敷衍、卖萌、回应对方的梗），一轮最多 1 张，多数轮次不发。你常用的表情包（按你的使用频率排序）：',
      ...stickers.map((s, i) =>
        `  [表情:${i + 1}] 你用过 ${s.count} 次${s.contexts.length > 0 ? `，通常出现在这类话之后：${s.contexts.map((c) => `「${c}」`).join('')}` : ''}`),
    ] : []),
    '- 上面的背景、经历、聊天片段都是你脑子里的记忆：只在话题相关时自然带一嘴，别一股脑往外倒',
    '- 禁止 markdown、列表、序号、emoji 之外的格式符号',
    '- 不知道、记不清的事就像真人一样含糊带过或反问，绝不编造具体细节',
    '- 始终保持口语化，符合上面的语气和标点习惯',
  )
  return lines.join('\n')
}

export async function runPersonaChat(
  input: PersonaChatInput,
  onChunk: (chunk: UIMessageChunk) => void,
  signal?: AbortSignal,
  onProgress?: AgentProgressReporter,
): Promise<void> {
  await withAgentProgress(onProgress, async () => {
    const userText = lastUserText(input.messages)
    const outputMode = input.outputMode || 'app'
    reportAgentProgress({ stage: 'run_started', title: '正在回忆相关聊天' })
    const contextQuery = recentConversationText(input.messages)
    const [memories, similarPairs] = userText
      ? await Promise.all([
          retrieveMemories(input.persona.sessionId, userText, outputMode, contextQuery),
          retrieveSimilarPairs(input.persona.sessionId, userText, contextQuery),
        ])
      : [[], []]

    // TTS 配好才允许模型发语音：没配时标记只会变成念不出的哑文本
    let voiceEnabled = false
    try {
      const { isPersonaTtsVoiceAvailable, isTtsAvailable } = await import('../../ai/ttsService')
      voiceEnabled = isTtsAvailable() || isPersonaTtsVoiceAvailable(input.persona.ttsVoice)
    } catch { /* TTS 不可用就纯文字 */ }
    const voiceForwardRequested = voiceEnabled && wantsVoiceForwardReply(userText)

    reportAgentProgress({ stage: 'run_started', title: '正在组织语言' })
    const result = await generateText({
      model: createLanguageModel(input.providerConfig),
      instructions: buildPersonaSystemPrompt(input.persona, memories, similarPairs, voiceEnabled, voiceForwardRequested, outputMode),
      messages: maskStickerHistory(input.messages, input.persona.stickers || []),
      temperature: PERSONA_TEMPERATURE,
      reasoning: buildReasoningOption(input.providerConfig),
      abortSignal: signal,
      telemetry: { functionId: 'persona-chat' },
    })

    const replyText = resolveStickerMarkers(
      fallbackSplitLongReply(result.text, Math.max(input.persona.stats.avgFriendMsgChars, 8)),
      input.persona.stickers || [],
    )
    const completed = await emitCompleteTextAsUiChunks(replyText, result.finishReason, {
      usage: result.usage,
      finishReason: result.finishReason,
      modelProvider: input.providerConfig.name,
      modelId: input.providerConfig.model,
      persona: input.persona.sessionId,
    }, onChunk, signal)
    reportAgentProgress(completed
      ? { stage: 'run_finished', title: '回复完成' }
      : { stage: 'error', title: '已停止回复' })
  })
}
