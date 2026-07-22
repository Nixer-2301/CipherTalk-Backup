import type { ChatSession, Message } from '../../types/models'
import type { PersonaRecordInfo } from '../../types/electron'
import { isGroupChat } from './utils/messageGuards'

/** 回复建议：类型、会话级配置读写、上下文构建。UI 在 ChatHeader(设置下拉) 和 ReplySuggestBar(悬浮卡片)。 */

export type ReplySuggestStyle = 'natural' | 'short' | 'formal' | 'humorous' | 'warm' | 'likeme'

export type ReplySuggestSettings = {
  enabled: boolean
  style: ReplySuggestStyle
  count: number
  /** 深度模式：更长历史上下文 + 子进程内带会话检索工具的小步 Agent 循环 */
  deep: boolean
  /** 磁贴窗口：把建议贴到微信主窗口旁的独立窗口显示 */
  tile: boolean
}

export const REPLY_SUGGEST_CONFIG_KEY = 'replySuggestSessions'

export const REPLY_SUGGEST_STYLES: Array<{ id: ReplySuggestStyle; label: string }> = [
  { id: 'natural', label: '自然' },
  { id: 'short', label: '简短' },
  { id: 'formal', label: '正式' },
  { id: 'humorous', label: '幽默' },
  { id: 'warm', label: '热情' },
  { id: 'likeme', label: '像我' },
]

export const REPLY_SUGGEST_COUNTS = [1, 2, 3, 4, 5]

export const DEFAULT_REPLY_SUGGEST_SETTINGS: ReplySuggestSettings = {
  enabled: false,
  style: 'natural',
  count: 3,
  deep: false,
  tile: false,
}

type SettingsMap = Record<string, Partial<ReplySuggestSettings> | undefined>

const STYLE_IDS = new Set<string>(REPLY_SUGGEST_STYLES.map((s) => s.id))

export function normalizeReplySuggestSettings(raw: Partial<ReplySuggestSettings> | undefined): ReplySuggestSettings {
  return {
    enabled: raw?.enabled === true,
    style: raw?.style && STYLE_IDS.has(raw.style) ? raw.style : DEFAULT_REPLY_SUGGEST_SETTINGS.style,
    count: REPLY_SUGGEST_COUNTS.includes(Number(raw?.count)) ? Number(raw?.count) : DEFAULT_REPLY_SUGGEST_SETTINGS.count,
    deep: raw?.deep === true,
    tile: raw?.tile === true,
  }
}

export async function getReplySuggestSettings(username: string): Promise<ReplySuggestSettings> {
  const map = (await window.electronAPI.config.get(REPLY_SUGGEST_CONFIG_KEY)) as SettingsMap | null | undefined
  return normalizeReplySuggestSettings(map?.[username])
}

export async function updateReplySuggestSettings(
  username: string,
  patch: Partial<ReplySuggestSettings>,
): Promise<ReplySuggestSettings> {
  const map = ((await window.electronAPI.config.get(REPLY_SUGGEST_CONFIG_KEY)) as SettingsMap | null | undefined) ?? {}
  const next = { ...normalizeReplySuggestSettings(map[username]), ...patch }
  await window.electronAPI.config.set(REPLY_SUGGEST_CONFIG_KEY, { ...map, [username]: next })
  return next
}

/** 与 ChatHeader 的私聊判定保持一致：排除群聊/公众号/聚合会话 */
export function isReplySuggestSession(session: ChatSession): boolean {
  return !isGroupChat(session.username)
    && !session.username.startsWith('gh_')
    && !session.isOfficialAccount
    && !session.isOfficialFolder
}

/**
 * 取最近消息作为对话上下文（从旧到新）。深度模式取更长历史。
 * 语音消息（localType 34）查 STT 转写缓存，命中就把 "[语音]" 占位换成转写文字；
 * 没转写过的保持占位、不现场转写（会拖慢生成，批量转写按钮点一次就全有了）。
 */
export async function buildSuggestContext(
  sessionId: string,
  messages: Message[],
  deep: boolean,
): Promise<Array<{ fromMe: boolean; text: string }>> {
  const take = deep ? 120 : 30
  const slice = messages.filter((m) => m.parsedContent?.trim()).slice(-take)
  return Promise.all(slice.map(async (m) => {
    let text = m.parsedContent.trim()
    if (m.localType === 34) {
      try {
        const cached = await window.electronAPI.stt.getCachedTranscript(sessionId, m.createTime, m.localId)
        if (cached.success && cached.transcript) text = `[语音] ${cached.transcript}`
      } catch {
        // 查缓存失败保持占位
      }
    }
    return { fromMe: m.isSend === 1, text }
  }))
}

/** 单张图片 base64 上限（约 4.5MB 原始字节），超过不附，防 IPC 报文过大 */
const SUGGEST_IMAGE_MAX_BASE64 = 6 * 1024 * 1024
/** 最多附带的图片张数，与引擎侧上限一致 */
const SUGGEST_IMAGE_MAX = 3

/**
 * 收集"对方自我上次回复之后连发的图片"（正在等我回的那批），解密成 base64、时间正序。
 * 引擎侧会按模型是否支持图像输入决定用不用；单张失败静默丢弃。
 */
export async function collectPendingImages(sessionId: string, messages: Message[]): Promise<Array<{ base64: string }>> {
  const refs: Message[] = []
  for (let i = messages.length - 1; i >= 0 && refs.length < SUGGEST_IMAGE_MAX; i -= 1) {
    const m = messages[i]
    if (m.isSend === 1) break
    if (m.localType === 3) refs.push(m)
  }
  if (refs.length === 0) return []
  const out: Array<{ base64: string }> = []
  for (const m of refs.reverse()) {
    try {
      const res = await window.electronAPI.chat.getImageData(sessionId, String(m.localId), m.createTime)
      if (res.success && res.data && res.data.length <= SUGGEST_IMAGE_MAX_BASE64) out.push({ base64: res.data })
    } catch {
      // 单张解密失败跳过
    }
  }
  return out
}

/** "像我"风格的 few-shot：取"我"最近的文本发言，跳过 [图片] 这类占位。 */
export function buildMyRecentTexts(messages: Message[]): string[] {
  return messages
    .filter((m) => m.isSend === 1)
    .map((m) => m.parsedContent?.trim() ?? '')
    .filter((t) => t && !/^\[.+\]$/.test(t))
    .slice(-20)
}

/**
 * 自画像存储键：克隆我自己按联系人会话隔离（我对每个人说话方式不同，不共享）。
 * 主进程 buildPersonaFromSession(role='self') 用相同前缀落库。
 */
export function myPersonaStorageKey(contactSessionId: string): string {
  return `self:${contactSessionId}`
}

/** 加载"我"对某联系人的自画像；不存在返回 null。失败静默（likeme 退回 myRecentTexts 兜底）。 */
export async function loadMyPersona(contactSessionId: string): Promise<PersonaRecordInfo | null> {
  try {
    const res = await window.electronAPI.persona.get(myPersonaStorageKey(contactSessionId))
    return res.success && res.persona ? res.persona : null
  } catch {
    return null
  }
}

/** 加载对方的画像（克隆好友产物，按 sessionId 直接存）；不存在返回 null，失败静默。 */
export async function loadFriendPersona(sessionId: string): Promise<PersonaRecordInfo | null> {
  try {
    const res = await window.electronAPI.persona.get(sessionId)
    return res.success && res.persona ? res.persona : null
  } catch {
    return null
  }
}

/** 把对方画像渲染成给 LLM 的提示文本（深度模式用）：TA 是什么样的人、你们的关系、雷区、典型反应。 */
export function buildFriendPersonaContext(persona: PersonaRecordInfo): string {
  const lines: string[] = []
  const { card, profile } = persona
  if (card.tone) lines.push(`- TA 的语气风格：${card.tone}`)
  if (card.personalityTraits?.length) lines.push(`- TA 的性格：${card.personalityTraits.join('、')}`)
  if (card.topics?.length) lines.push(`- 你们常聊：${card.topics.join('、')}`)
  if (profile?.relationship) lines.push(`- 你们的关系：${profile.relationship}`)
  if (profile?.boundaries?.length) lines.push(`- TA 的雷区/别碰的话题：${profile.boundaries.join('、')}`)
  if (profile?.reactionPatterns?.length) {
    lines.push('- TA 在不同情境下的典型反应：')
    for (const r of profile.reactionPatterns.slice(0, 4)) lines.push(`  · ${r}`)
  }
  return lines.join('\n')
}

/** 连发建议的分隔符：与画像语料里的连发分隔约定一致，模型按此拆条。 */
export const SUGGEST_BURST_JOINER = '／'

/** 把一条建议按连发分隔符拆成若干短句（无分隔符时返回单元素数组）。 */
export function splitSuggestionBursts(text: string): string[] {
  const segs = text.split(SUGGEST_BURST_JOINER).map((t) => t.trim()).filter(Boolean)
  return segs.length > 0 ? segs : [text.trim()]
}

const SENTENCE_SEGMENT_LABELS = ['第一句', '第二句', '第三句', '第四句', '第五句', '第六句', '第七句', '第八句', '第九句', '第十句']

export function sentenceSegmentLabel(index: number): string {
  return SENTENCE_SEGMENT_LABELS[index] || `第${index + 1}句`
}

/**
 * 把自画像画像卡 + few-shot 渲染成给 LLM 的提示文本，供"像我"回复建议使用。
 * 自画像是按"我对该联系人"的说话风格提炼的，比 myRecentTexts 的纯 few-shot 更系统。
 */
export function buildMyPersonaContext(persona: PersonaRecordInfo): string {
  const lines: string[] = []
  const { card, fewShots } = persona
  if (card.tone) lines.push(`- 语气风格：${card.tone}`)
  if (card.personalityTraits?.length) lines.push(`- 性格特征：${card.personalityTraits.join('、')}`)
  if (card.catchphrases?.length) lines.push(`- 口头禅/高频用语：${card.catchphrases.join('、')}`)
  if (card.punctuationStyle) lines.push(`- 标点排版习惯：${card.punctuationStyle}`)
  if (card.addressing) lines.push(`- 称呼习惯：${card.addressing}`)
  if (card.topics?.length) lines.push(`- 常聊话题：${card.topics.join('、')}`)
  if (fewShots?.length) {
    lines.push('- 真实问答示例（模仿"我"的回复）：')
    for (const shot of fewShots.slice(0, 6)) {
      lines.push(`  · 对方：${shot.user}`)
      lines.push(`    我：${shot.replies.join('／')}`)
    }
  }
  return lines.join('\n')
}
