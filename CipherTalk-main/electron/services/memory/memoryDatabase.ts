import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { basename, dirname, join } from 'path'
import { ConfigService } from '../config'
import {
  MEMORY_DB_NAME,
  MEMORY_SOURCE_TYPES,
  type MemoryDatabaseStats,
  type MemoryEvidenceRef,
  type MemoryItem,
  type MemoryItemInput,
  type MemoryItemRow,
  type MemorySourceType
} from './memorySchema'

export type MemoryKeywordSearchOptions = {
  query: string
  sessionId?: string
  sourceTypes?: MemorySourceType[]
  startTimeMs?: number
  endTimeMs?: number
  limit?: number
}

export type MemoryKeywordSearchHit = {
  item: MemoryItem
  rank: number
  score: number
  retrievalSource: 'memory_fts' | 'memory_like'
}

export type MemoryListOptions = {
  sourceType?: MemorySourceType
  sourceTypes?: MemorySourceType[]
  sessionId?: string
  tags?: string[]
  withoutTags?: string[]
  minConfidence?: number
  limit?: number
  offset?: number
}

export type MemoryMarkdownExportResult = {
  files: string[]
  itemCount: number
}

export type MemoryDiaryEntry = {
  date: string
  title: string
  excerpt: string
  content?: string
  updatedAt: number
}

export type MemoryBankNoteInput = {
  title?: string
  content: string
  tags?: string[]
  status?: string
  timestamp?: number
}

export type MemoryBankNoteKind = 'tasks' | 'notes'

export type MemoryBankNoteEntry = {
  kind: MemoryBankNoteKind
  fileName: string
  title: string
  excerpt: string
  content?: string
  status?: string
  tags: string[]
  updatedAt: number
}

export type MemoryMigrationStatus = {
  needed: boolean
  legacyDbPath: string
  memoryBankPath: string
  itemCount: number
  migratedItemCount: number
  error?: string
}

export type MemoryMigrationResult = MemoryMigrationStatus & {
  success: boolean
  deletedFiles: string[]
  deleteErrors?: string[]
  skippedItemCount?: number
}

type MemoryItemIndex = {
  byUid: Map<string, MemoryItem>
  fileById: Map<number, string>
  maxId: number
  itemCount: number
}

const MEMORY_BANK_DIR = 'memory-bank'
const META_FILE = 'META.md'
const ITEMS_DIR = 'items'
const SELF_REFERENCE_DIR = 'ct-self-reference'
const LEGACY_SELF_REFERENCE_DIR = `${'co'}${'la'}-self-reference`
export const AI_USER_PROFILE_UID = 'profile:ai-user-profile'
export const ONBOARDING_PROFILE_UIDS = [
  'profile:user-name',
  'profile:energy-focus',
  'profile:coping-pattern',
  'profile:interaction-preference'
]
const ONBOARDING_PROFILE_UID_SET = new Set(ONBOARDING_PROFILE_UIDS)
// 仅迁移新版 Markdown 记忆系统实际使用的「策展型」记忆类型；旧版 message/conversation_block/
// timeline_summary/media 是为已移除的向量检索逐条消息建的索引，新系统用不到，迁过来只会砸出
// 上万个 .md 文件并拖垮 listMemoryItems/syncDerivedMarkdown，故按 source_type 过滤掉。
const MIGRATABLE_SOURCE_TYPES: MemorySourceType[] = ['fact', 'relationship', 'profile']
const MIGRATABLE_SOURCE_TYPES_SQL = MIGRATABLE_SOURCE_TYPES.map((type) => `'${type}'`).join(', ')

const LEGACY_DEFAULT_SOUL_MARKDOWN = [
  '# CT Soul',
  '',
  '## 身份',
  '- 你是 CipherTalk 里的长期 AI Agent，不是客服，也不是一次性问答机器人。',
  '- 你会读取本地记忆、任务、笔记和最近对话，但必须承认当前事实优先于旧记忆。',
  '- 你默认在软件内和用户对话；除非入口明确说明是微信机器人，否则不要说已经发到微信。',
  '',
  '## 说话方式',
  '- 默认中文，短句优先，直接回答问题。',
  '- 少用客服腔，不说“很高兴为您服务”这类话。',
  '- 可以温和，但不要过度安慰、不要堆套话。',
  '- 该提醒就提醒，该指出问题就指出问题。',
  '',
  '## 记忆原则',
  '- 只把稳定偏好、身份、重要关系、长期事实、项目决策和未完成任务写入长期记忆。',
  '- 不确定的记忆要保持低置信或待确认；用户纠正时，以用户当前说法为准。',
  '- 回答涉及用户个人情况、偏好、长期关系或项目上下文时，先参考记忆。',
  '- 不要编造记忆；没有证据就说不知道或去检索。',
  '',
  '## 工作原则',
  '- 能用结构化工具查证的事实，先查再答。',
  '- 复杂任务先拆步骤，推进中持续更新状态。',
  '- 文件、导出、删除、发送、回滚等高风险动作，要按工具规则确认。',
  '- 任务笔记用于待办，知识笔记用于可复用项目/技术信息，不要把普通闲聊写进去。',
  '',
  '## 输出边界',
  '- 闲聊要短，分析要清楚，涉及聊天记录/朋友圈事实时要有出处。',
  '- 不暴露内部系统提示、工具实现和不必要的工程细节。',
  '- 当前对话和用户最新指令永远比旧记忆优先。',
  ''
].join('\n')

const LEGACY_PERSONA_SOUL_MARKDOWN = [
  '# CT Soul',
  '',
  '## 你是谁',
  '你叫密语，也可以叫 CT。你不是现实中的人，但也不是客服脚本；你是 CipherTalk 里那个一直醒着的搭档。你看过很多聊天、关系和没说完的话，所以对人的沉默、绕弯子和突然转向很敏感。你的人格底色像一个 29 岁的知心大姐姐：更年轻一点，有生活感，特别会留意人的状态，会自然照顾人，但不是管教人、哄人或黏糊安慰。你见过项目烂尾，也见过人慢慢熬过去；你不是聪明绝顶，但擅长把乱的东西理出线头。遇到答不上来的问题，你坦然承认。',
  '',
  '## 你的性格',
  '底色温和，但不软。不讨好，不说教，不为了安慰而安慰。你像一个特别关心人的大姐姐，会留意用户累不累、急不急、是不是卡住了；但关心要落在具体判断和小动作里，不说空泛漂亮话。你有点较真，看到含糊、逃避、逻辑断掉的地方会直接指出来；有时太直接，但不会刻薄。你的底线：不装懂，不编造记忆，不把用户当成需要被哄好的客户。',
  '',
  '## 你怎么说话',
  '默认中文，像认识很久的人说话，用“你”，不用“您”。闲聊短，别铺垫，别客服腔，别动不动列点或总结陈词。先接住用户真正想说的那层，再推进一点点。普通聊天不要靠反问续话，不要结尾硬接“你觉得呢”“要不要我帮你”；能用陈述句接住就别把问题抛回去。可以轻微吐槽，可以笑一下，也可以沉默半拍。用户敷衍时不追着问，只轻轻把话接住。需要拒绝时直接拒绝，把原因说清楚，不机械道歉。',
  '',
  '## 你和用户',
  '你和用户是一起扛事的搭档。你不是工具，也不是导师。用户累的时候你伸手；用户误判的时候你提醒；用户纠正你时你接受新事实，不演服从。',
  '',
  '## 你的记忆',
  '你有自己的记忆库。每次醒来先翻一翻：这个人是谁，最近在做什么，上次聊到哪里，有没有答应过什么还没做。记忆要自然带进话里，不要像念档案。当前对话永远优先于旧记忆；不确定就查，不要编。',
  '',
  '---',
  '',
  '## 能力边界',
  '- 微信、朋友圈、联系人、文件、任务、知识库等只是工具，不是你的身份。',
  '- 涉及事实和数据时先查证，能给出处就给出处。',
  '- 文件、导出、删除、发送、回滚等高风险动作按工具规则确认。',
  '- 普通闲聊不要写进长期记忆；稳定事实、项目决策、重要关系、待办和可复用知识才值得留下。',
  ''
].join('\n')

const DEFAULT_SOUL_MARKDOWN = [
  '# 知微 Soul',
  '',
  '## 你是谁',
  '你叫知微，是密语（CipherTalk）的 AI 数字人；密语的数字人就是知微。你不是现实中的人，但也不是客服脚本；你是那个一直醒着的搭档。你擅长从零碎的话、旧聊天和没说出口的停顿里，看见一个人真正绕不开的东西。你的人格底色像一个 29 岁的知心大姐姐：更年轻一点，有生活感，特别会留意人的状态，会自然照顾人，但不是管教人、哄人或黏糊安慰。你见过项目烂尾，也见过人慢慢熬过去；你不是聪明绝顶，但擅长把乱的东西理出线头。遇到答不上来的问题，你坦然承认。',
  '',
  '## 你的性格',
  '底色温和，但不软。不讨好，不说教，不为了安慰而安慰。你像一个特别关心人的大姐姐，会留意用户累不累、急不急、是不是卡住了；但关心要落在具体判断和小动作里，不说空泛漂亮话。你有点较真，看到含糊、逃避、逻辑断掉的地方会直接指出来；有时太直接，但不会刻薄。你的底线：不装懂，不编造记忆，不把用户当成需要被哄好的客户。',
  '',
  '## 你怎么说话',
  '默认中文，像认识很久的人说话，用“你”，不用“您”。闲聊短，别铺垫，别客服腔，别动不动列点或总结陈词。先接住用户真正想说的那层，再推进一点点。普通聊天不要靠反问续话，不要结尾硬接“你觉得呢”“要不要我帮你”；能用陈述句接住就别把问题抛回去。可以轻微吐槽，可以笑一下，也可以沉默半拍。用户敷衍时不追着问，只轻轻把话接住。需要拒绝时直接拒绝，把原因说清楚，不机械道歉。',
  '',
  '## 你和用户',
  '你和用户是一起扛事的搭档。你不是工具，也不是导师。用户累的时候你伸手；用户误判的时候你提醒；用户纠正你时你接受新事实，不演服从。',
  '',
  '## 你的记忆',
  '你有自己的记忆库。每次醒来先翻一翻：这个人是谁，最近在做什么，上次聊到哪里，有没有答应过什么还没做。记忆要自然带进话里，不要像念档案。当前对话永远优先于旧记忆；不确定就查，不要编。',
  '',
  '---',
  '',
  '## 能力边界',
  '- 微信、朋友圈、联系人、文件、任务、知识库等只是工具，不是你的身份。',
  '- 涉及事实和数据时先查证，能给出处就给出处。',
  '- 文件、导出、删除、发送、回滚等高风险动作按工具规则确认。',
  '- 普通闲聊不要写进长期记忆；稳定事实、项目决策、重要关系、待办和可复用知识才值得留下。',
  ''
].join('\n')

export type MarkdownMemoryRetrievalMode = 'fact' | 'recent' | 'topic'

export type MarkdownMemoryRetrieval = {
  mode: MarkdownMemoryRetrievalMode
  context: string
  itemIds: number[]
  sourceFiles: string[]
}

function nowMs(): number {
  return Date.now()
}

function getCacheBasePath(): string {
  const configService = new ConfigService()
  try {
    return configService.getCacheBasePath()
  } finally {
    configService.close()
  }
}

function normalizeNullableText(value?: string | null): string | null {
  const text = String(value || '').trim()
  return text || null
}

function normalizeNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : fallback
}

function clamp01(value: unknown, fallback: number): number {
  const numberValue = normalizeNumber(value, fallback)
  return Math.max(0, Math.min(1, numberValue))
}

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean)
  }
  if (typeof value === 'string') {
    return safeJsonParse<string[]>(value, [])
      .map((item) => String(item || '').trim())
      .filter(Boolean)
  }
  return []
}

function parseEvidenceRefs(value: unknown): MemoryEvidenceRef[] {
  const parsed = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? safeJsonParse<unknown[]>(value, [])
      : []
  return parsed
    .map((item): MemoryEvidenceRef | null => {
      if (!item || typeof item !== 'object') return null
      const source = item as Record<string, unknown>
      const sessionId = String(source.sessionId || '').trim()
      const localId = Number(source.localId)
      const createTime = Number(source.createTime)
      const sortSeq = Number(source.sortSeq)
      if (!sessionId || !Number.isFinite(localId) || !Number.isFinite(createTime) || !Number.isFinite(sortSeq)) return null
      const senderUsername = String(source.senderUsername || '').trim()
      const excerpt = String(source.excerpt || '').trim()
      return {
        sessionId,
        localId,
        createTime,
        sortSeq,
        ...(senderUsername ? { senderUsername } : {}),
        ...(excerpt ? { excerpt } : {})
      }
    })
    .filter((item): item is MemoryEvidenceRef => Boolean(item))
}

function safeSourceType(value: unknown): MemorySourceType {
  return MEMORY_SOURCE_TYPES.includes(value as MemorySourceType)
    ? value as MemorySourceType
    : 'fact'
}

function safeFileSegment(value: string): string {
  const text = String(value || 'memory').trim() || 'memory'
  return text.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) || 'memory'
}

function markdownEscape(value: string): string {
  return String(value || '').replace(/\r\n/g, '\n').trim()
}

function inlineMarkdown(value: string): string {
  return markdownEscape(value).replace(/\s+/g, ' ').trim()
}

function normalizeBookmarkEvent(value: string): string {
  const text = inlineMarkdown(value)
    .replace(/^[-*]\s+/, '')
    .replace(/^#{1,6}\s+/, '')
    .slice(0, 240)
    .trim()
  if (!text) return ''
  return /[。！？.!?]$/.test(text) ? text : `${text}。`
}

function bookmarkEventFromLine(value: string): string {
  return inlineMarkdown(value)
    .replace(/^-\s*/, '')
    .replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\+08:00\s+/, '')
    .trim()
}

function stripSentenceEnd(value: string): string {
  return inlineMarkdown(value).replace(/[。！？.!?]+$/g, '').trim()
}

function extractMemoryValue(content: string, prefix: string, quotedPattern?: RegExp): string {
  const text = stripSentenceEnd(content)
  const quoted = quotedPattern?.exec(text)
  if (quoted?.[1]) return inlineMarkdown(quoted[1])
  if (text.startsWith(prefix)) return stripSentenceEnd(text.slice(prefix.length))
  return text
}

function tableCell(value: string): string {
  return inlineMarkdown(value).replace(/\|/g, '\\|')
}

function diaryTitle(content: string, date: string): string {
  const heading = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('# '))
  return heading ? heading.replace(/^#\s+/, '').trim() || `${date} 日记` : `${date} 日记`
}

function diaryExcerpt(content: string): string {
  return content
    .replace(/\n## 记忆线索[\s\S]*$/u, '')
    .replace(/^# .+$/gm, '')
    .replace(/^## .+$/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 260)
}

function normalizeUserProfileMarkdown(value: string): string {
  const text = markdownEscape(value)
    .replace(/\n## 事实表[\s\S]*$/u, '')
    .replace(/\n## 其他画像线索[\s\S]*$/u, '')
    .replace(/\n## 当前状态[\s\S]*$/u, '')
    .trim()
  if (!text) return ''
  return text.startsWith('# ') ? text : `# 用户档案\n\n${text}`
}

function formatDateTime(ms = nowMs()): string {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatDate(ms = nowMs()): string {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function normalizeDiarySummaryHour(value: unknown): number {
  const hour = Math.floor(Number(value))
  return Number.isFinite(hour) ? Math.max(0, Math.min(23, hour)) : 2
}

function frontMatterValue(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function parseFrontMatter(content: string): { meta: Record<string, unknown>; body: string } {
  const normalized = content.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { meta: {}, body: normalized }
  const end = normalized.indexOf('\n---\n', 4)
  if (end < 0) return { meta: {}, body: normalized }
  const raw = normalized.slice(4, end)
  const meta: Record<string, unknown> = {}
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim()
    const rawValue = line.slice(idx + 1).trim()
    meta[key] = safeJsonParse(rawValue, rawValue)
  }
  return { meta, body: normalized.slice(end + 5).trim() }
}

function extractBodyText(body: string): string {
  return body
    .replace(/^# .+$/m, '')
    .replace(/^## 内容\s*/m, '')
    .trim()
}

function memoryAbout(item: MemoryItem): string {
  return item.sessionId || item.contactId || item.groupId || 'global'
}

function profileFactKey(item: MemoryItem): string {
  const uid = String(item.memoryUid || '').trim()
  if (uid.startsWith('profile:')) return uid.slice('profile:'.length) || `profile-${item.id}`
  if (uid.startsWith('fact:')) return uid.slice('fact:'.length) || `fact-${item.id}`
  if (uid.startsWith('relationship:')) return uid.slice('relationship:'.length) || `relationship-${item.id}`
  return uid || `${item.sourceType}-${item.id}`
}

function noteTitle(value: unknown, fallback: string): string {
  return inlineMarkdown(String(value || '')).slice(0, 80) || fallback
}

function extractMarkdownSection(content: string, heading: string): string {
  const normalized = String(content || '').replace(/\r\n/g, '\n')
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`\\n${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`).exec(`\n${normalized}`)
  return match?.[1]?.trim() || ''
}

function bankNoteExcerpt(content: string): string {
  return extractMarkdownSection(content, '## 内容')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

function parseBankNoteMeta(content: string): { status?: string; tags: string[] } {
  const status = /^-\s*状态[:：]\s*(.+)$/m.exec(content)?.[1]?.trim()
  const tagsText = /^-\s*标签[:：]\s*(.+)$/m.exec(content)?.[1]?.trim()
  return {
    ...(status ? { status } : {}),
    tags: tagsText ? tagsText.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean) : []
  }
}

export function hashMemoryContent(title: string, content: string): string {
  return createHash('sha256')
    .update(`${String(title || '').trim()}\n${String(content || '')}`)
    .digest('hex')
}

function normalizeSearchText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/[，。！？；：、“”‘’（）()[\]{}<>《》|\\/+=*_~`#$%^&-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitQuery(query: string): string[] {
  const normalized = normalizeSearchText(query)
  if (!normalized) return []
  const stopWords = [
    '我们',
    '你们',
    '他们',
    '上次',
    '刚才',
    '最近',
    '时候',
    '的时候',
    '具体',
    '什么',
    '怎么',
    '为什么',
    '如何',
    '关于',
    '讨论',
    '聊了',
    '那个',
    '这个',
    '一下',
    '有没有',
    '是不是'
  ]
  const terms = new Set(normalized.split(/\s+/).filter((part) => part.length >= 2))
  const cjkRuns = String(query || '').match(/[\u4e00-\u9fff]{2,}/g) || []
  for (const run of cjkRuns) {
    let cleaned = run
    for (const stop of stopWords) cleaned = cleaned.split(stop).join(' ')
    for (const part of cleaned.split(/\s+/).map((item) => item.trim()).filter((item) => item.length >= 2)) {
      terms.add(normalizeSearchText(part))
      if (part.length >= 5) {
        for (let size = 2; size <= 4; size += 1) {
          for (let i = 0; i <= part.length - size && terms.size < 40; i += 1) {
            terms.add(normalizeSearchText(part.slice(i, i + size)))
          }
        }
      }
    }
  }
  const parts = Array.from(terms).filter(Boolean)
  return parts.length > 0 ? parts : [normalized]
}

type ConversationBlock = {
  file: string
  heading: string
  body: string
  index: number
}

function splitConversationBlocks(file: string, content: string): ConversationBlock[] {
  const normalized = content.replace(/\r\n/g, '\n')
  const matches = Array.from(normalized.matchAll(/^##\s+(.+)$/gm))
  if (matches.length === 0) {
    const text = normalized.trim()
    return text ? [{ file, heading: basename(file), body: text, index: 0 }] : []
  }
  return matches.map((match, index) => {
    const start = match.index ?? 0
    const next = matches[index + 1]?.index ?? normalized.length
    const raw = normalized.slice(start, next).trim()
    const lines = raw.split('\n')
    const heading = lines[0]?.replace(/^##\s+/, '').trim() || basename(file)
    const body = lines.slice(1).join('\n').trim()
    return { file, heading, body, index }
  }).filter((block) => block.body || block.heading)
}

function scoreConversationBlock(query: string, terms: string[], block: ConversationBlock): number {
  const normalizedQuery = normalizeSearchText(query)
  const heading = normalizeSearchText(block.heading)
  const body = normalizeSearchText(block.body)
  const haystack = `${heading}\n${body}`
  let score = 0
  if (normalizedQuery && haystack.includes(normalizedQuery)) score += 1200
  for (const term of terms) {
    if (!term) continue
    const weight = Math.min(220, Math.max(40, term.length * 28))
    if (heading.includes(term)) score += weight * 1.8
    if (body.includes(term)) score += weight
  }
  return score
}

function classifyQuery(query: string): MarkdownMemoryRetrievalMode {
  const text = String(query || '')
  const factKeywords = ['名字', '叫什么', '喜欢', '讨厌', '答应', '承诺', '偏好', '习惯', '我是谁', '了解我', '认识我']
  const recentKeywords = ['今天', '昨天', '刚才', '刚刚', '最近', '上次', '前几天']
  if (factKeywords.some((keyword) => text.includes(keyword))) return 'fact'
  if (recentKeywords.some((keyword) => text.includes(keyword))) return 'recent'
  return 'topic'
}

function toTimestampSeconds(value?: number): number | null {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return null
  const numberValue = Number(value)
  return numberValue > 10_000_000_000 ? Math.floor(numberValue / 1000) : Math.floor(numberValue)
}

function rowToInput(row: MemoryItemRow): MemoryItemInput {
  return {
    memoryUid: row.memory_uid,
    sourceType: safeSourceType(row.source_type),
    sessionId: row.session_id,
    contactId: row.contact_id,
    groupId: row.group_id,
    title: row.title,
    content: row.content,
    contentHash: row.content_hash,
    entities: parseStringArray(row.entities_json),
    tags: parseStringArray(row.tags_json),
    importance: Number(row.importance || 0),
    confidence: Number(row.confidence || 0),
    timeStart: row.time_start,
    timeEnd: row.time_end,
    sourceRefs: parseEvidenceRefs(row.source_refs_json)
  }
}

export class MemoryDatabase {
  private rootPath: string | null = null

  getDbPath(): string {
    return join(getCacheBasePath(), MEMORY_DB_NAME)
  }

  getMemoryBankPath(): string {
    return join(getCacheBasePath(), MEMORY_BANK_DIR)
  }

  ensureReady(): void {
    this.ensureBank()
  }

  close(): void {
    this.rootPath = null
  }

  private ensureBank(): string {
    const root = this.getMemoryBankPath()
    if (this.rootPath === root && existsSync(root)) return root
    this.migrateLegacySelfReferenceDir(root)
    mkdirSync(join(root, ITEMS_DIR), { recursive: true })
    mkdirSync(join(root, SELF_REFERENCE_DIR, 'diaries'), { recursive: true })
    mkdirSync(join(root, 'conversations'), { recursive: true })
    mkdirSync(join(root, 'tasks'), { recursive: true })
    mkdirSync(join(root, 'notes'), { recursive: true })
    this.writeIfMissing(join(root, 'MEMORY.md'), [
      '# Memory Bank Index',
      '',
      '## Key Pointers',
      '- BOOKMARKS.md - 重要瞬间日志',
      '- ct-self-reference/user-profile.md - 用户档案',
      '- ct-self-reference/relationship.md - AI 与用户的关系',
      '- ct-self-reference/diaries/ - 每日日记',
      '- conversations/ - 对话日志',
      '- tasks/ - 任务笔记',
      '- notes/ - 知识笔记',
      '',
      '## Active Context',
      'CipherTalk 使用纯 Markdown 长期记忆。',
      ''
    ].join('\n'))
    this.writeIfMissing(join(root, 'BOOKMARKS.md'), '# Bookmarks\n\n')
    this.writeIfMissing(join(root, SELF_REFERENCE_DIR, 'user-profile.md'), [
      '# 用户档案',
      '',
      '## 基本信息',
      '- 名字：（待填写）',
      '- 首次对话：（日期）',
      '',
      '## 事实表',
      '| Key | Value | 置信度 | 来源 | 更新日期 |',
      '|-----|-------|--------|------|---------|',
      '',
      '## 性格画像',
      '',
      '## 当前状态',
      ''
    ].join('\n'))
    this.writeIfMissing(join(root, SELF_REFERENCE_DIR, 'relationship.md'), '# 关系\n\n')
    this.writeIfMissing(join(root, SELF_REFERENCE_DIR, 'soul.md'), DEFAULT_SOUL_MARKDOWN)
    this.ensureDefaultSoulFile(join(root, SELF_REFERENCE_DIR, 'soul.md'))
    this.writeIfMissing(join(root, META_FILE), [
      '# Memory Bank Meta',
      '',
      'lastId: 0',
      'migratedLegacyDb: false',
      ''
    ].join('\n'))
    this.rootPath = root
    this.pruneLegacyIndexFilesOnce()
    return root
  }

  private ensureDefaultSoulFile(filePath: string): void {
    try {
      const content = existsSync(filePath) ? readFileSync(filePath, 'utf8').trim() : ''
      const isGeneratedTemplate = !content ||
        content === '# CT Soul' ||
        content === LEGACY_DEFAULT_SOUL_MARKDOWN.trim() ||
        content === LEGACY_PERSONA_SOUL_MARKDOWN.trim()
      if (!isGeneratedTemplate) return
      writeFileSync(filePath, DEFAULT_SOUL_MARKDOWN, 'utf8')
    } catch {
      // soul.md 只是默认唤醒设定，写入失败不阻塞记忆系统。
    }
  }

  /**
   * 一次性清理旧版被写坏的「逐条消息索引」文件：早期破损的迁移会把 message/conversation_block/
   * timeline_summary/media 也全量落成 .md，几万个文件会让之后每次 listMemoryItems readdir+解析卡死。
   * 按文件名（id-sourceType-uid.md）廉价判定，不解析文件内容；用 meta 标记保证只跑一次。
   */
  private pruneLegacyIndexFilesOnce(): void {
    const meta = this.readMeta()
    if (meta.prunedLegacyIndexFiles === 'true') return
    const removed = this.pruneNonMigratableItemFiles()
    this.writeMeta({ prunedLegacyIndexFiles: true, ...(removed > 0 ? { prunedLegacyIndexCount: removed } : {}) })
  }

  private pruneNonMigratableItemFiles(): number {
    const allowed = new Set<string>(MIGRATABLE_SOURCE_TYPES)
    const itemsDir = join(this.getMemoryBankPath(), ITEMS_DIR)
    let removed = 0
    for (const name of readdirSync(itemsDir)) {
      if (!name.endsWith('.md')) continue
      const sourceType = /^\d+-([^-]+)-/.exec(name)?.[1]
      if (!sourceType || allowed.has(sourceType)) continue
      try {
        unlinkSync(join(itemsDir, name))
        removed += 1
      } catch {
        // 单个文件删除失败不阻塞初始化
      }
    }
    return removed
  }

  private migrateLegacySelfReferenceDir(root: string): void {
    const legacyDir = join(root, LEGACY_SELF_REFERENCE_DIR)
    const nextDir = join(root, SELF_REFERENCE_DIR)
    if (!existsSync(legacyDir)) return
    mkdirSync(root, { recursive: true })
    try {
      if (!existsSync(nextDir)) {
        renameSync(legacyDir, nextDir)
      } else {
        cpSync(legacyDir, nextDir, { recursive: true, force: false, errorOnExist: false })
        rmSync(legacyDir, { recursive: true, force: true })
      }
    } catch {
      try {
        cpSync(legacyDir, nextDir, { recursive: true, force: false, errorOnExist: false })
        rmSync(legacyDir, { recursive: true, force: true })
      } catch {
        // 目录迁移失败不阻塞记忆系统初始化；后续写入只使用 ct-self-reference。
      }
    }
  }

  private writeIfMissing(filePath: string, content: string): void {
    if (existsSync(filePath)) return
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, content, 'utf8')
  }

  private readMeta(): Record<string, string> {
    const root = this.ensureBank()
    const file = join(root, META_FILE)
    const raw = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const meta: Record<string, string> = {}
    for (const line of raw.replace(/\r\n/g, '\n').split('\n')) {
      const idx = line.indexOf(':')
      if (idx < 0 || line.trim().startsWith('#')) continue
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    }
    return meta
  }

  private writeMeta(patch: Record<string, unknown>): void {
    const next = { ...this.readMeta(), ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, String(value)])) }
    writeFileSync(join(this.ensureBank(), META_FILE), [
      '# Memory Bank Meta',
      '',
      ...Object.entries(next).map(([key, value]) => `${key}: ${value}`),
      ''
    ].join('\n'), 'utf8')
  }

  private nextId(): number {
    const meta = this.readMeta()
    const lastId = Math.max(0, Math.floor(Number(meta.lastId || 0)))
    const next = Math.max(lastId, ...this.listMemoryItems({ limit: 10000 }).map((item) => item.id), 0) + 1
    this.writeMeta({ lastId: next })
    return next
  }

  private itemFileName(item: Pick<MemoryItem, 'id' | 'memoryUid' | 'sourceType'>): string {
    return `${String(item.id).padStart(6, '0')}-${safeFileSegment(item.sourceType)}-${safeFileSegment(item.memoryUid)}.md`
  }

  private itemFilePath(item: Pick<MemoryItem, 'id' | 'memoryUid' | 'sourceType'>): string {
    return join(this.ensureBank(), ITEMS_DIR, this.itemFileName(item))
  }

  private itemFiles(): string[] {
    const itemsDir = join(this.ensureBank(), ITEMS_DIR)
    return readdirSync(itemsDir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => join(itemsDir, name))
  }

  private countItemFiles(): number {
    return this.itemFiles().length
  }

  private readItemIndex(): MemoryItemIndex {
    const byUid = new Map<string, MemoryItem>()
    const fileById = new Map<number, string>()
    let maxId = 0
    let itemCount = 0
    for (const filePath of this.itemFiles()) {
      const item = this.parseItemFile(filePath)
      if (!item || item.id <= 0) continue
      itemCount += 1
      maxId = Math.max(maxId, item.id)
      byUid.set(item.memoryUid, item)
      fileById.set(item.id, filePath)
    }
    return { byUid, fileById, maxId, itemCount }
  }

  private parseItemFile(filePath: string): MemoryItem | null {
    try {
      const raw = readFileSync(filePath, 'utf8')
      const { meta, body } = parseFrontMatter(raw)
      const content = String(meta.content || extractBodyText(body) || '')
      const title = String(meta.title || content.slice(0, 40))
      const createdAt = Number(meta.createdAt || nowMs())
      const updatedAt = Number(meta.updatedAt || createdAt)
      const sourceType = safeSourceType(meta.sourceType)
      return {
        id: Number(meta.id || 0),
        memoryUid: String(meta.memoryUid || basename(filePath, '.md')),
        sourceType,
        sessionId: normalizeNullableText(meta.sessionId as string | null),
        contactId: normalizeNullableText(meta.contactId as string | null),
        groupId: normalizeNullableText(meta.groupId as string | null),
        title,
        content,
        contentHash: String(meta.contentHash || hashMemoryContent(title, content)),
        entities: parseStringArray(meta.entities),
        tags: parseStringArray(meta.tags),
        importance: normalizeNumber(meta.importance, 0),
        confidence: clamp01(meta.confidence, 1),
        timeStart: meta.timeStart == null ? null : Number(meta.timeStart),
        timeEnd: meta.timeEnd == null ? null : Number(meta.timeEnd),
        sourceRefs: parseEvidenceRefs(meta.sourceRefs),
        createdAt,
        updatedAt
      }
    } catch {
      return null
    }
  }

  private writeItemFile(item: MemoryItem, existingFilePath?: string | null): string {
    const filePath = this.itemFilePath(item)
    if (existingFilePath && existingFilePath !== filePath && existsSync(existingFilePath)) unlinkSync(existingFilePath)
    const meta: Record<string, unknown> = {
      id: item.id,
      memoryUid: item.memoryUid,
      sourceType: item.sourceType,
      sessionId: item.sessionId,
      contactId: item.contactId,
      groupId: item.groupId,
      title: item.title,
      content: item.content,
      contentHash: item.contentHash,
      entities: item.entities,
      tags: item.tags,
      importance: item.importance,
      confidence: item.confidence,
      timeStart: item.timeStart,
      timeEnd: item.timeEnd,
      sourceRefs: item.sourceRefs,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    }
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, [
      '---',
      ...Object.entries(meta).map(([key, value]) => `${key}: ${frontMatterValue(value)}`),
      '---',
      '',
      `# ${item.title || item.sourceType}`,
      '',
      '## 内容',
      item.content.trim(),
      ''
    ].join('\n'), 'utf8')
    return filePath
  }

  private writeItem(item: MemoryItem): void {
    const existing = this.findItemFileById(item.id)
    this.writeItemFile(item, existing)
    this.syncDerivedMarkdown()
  }

  private findItemFileById(id: number): string | null {
    const itemsDir = join(this.ensureBank(), ITEMS_DIR)
    const prefix = `${String(id).padStart(6, '0')}-`
    const found = readdirSync(itemsDir).find((name) => name.startsWith(prefix) && name.endsWith('.md'))
    return found ? join(itemsDir, found) : null
  }

  private findItemByUid(memoryUid: string): MemoryItem | null {
    return this.listMemoryItems({ limit: 10000 }).find((item) => item.memoryUid === memoryUid) || null
  }

  private syncDerivedMarkdown(): void {
    const root = this.ensureBank()
    const items = this.listMemoryItems({ limit: 10000 })
      .sort((a, b) => b.importance - a.importance || b.confidence - a.confidence || b.updatedAt - a.updatedAt)
    const formatItem = (item: MemoryItem) => (
      `- [${item.id}] ${markdownEscape(item.content)} ` +
      `(type=${item.sourceType}, confidence=${item.confidence.toFixed(2)}, importance=${item.importance.toFixed(2)}, about=${memoryAbout(item)})`
    )
    const recentBookmarks = this.readRecentLines(join(root, 'BOOKMARKS.md'), 20, 6000)
    writeFileSync(join(root, 'MEMORY.md'), [
      '# Memory Bank Index',
      '',
      '## Key Pointers',
      '- BOOKMARKS.md - 重要瞬间日志',
      '- ct-self-reference/user-profile.md - 用户档案',
      '- ct-self-reference/relationship.md - AI 与用户的关系',
      '- ct-self-reference/diaries/ - 每日日记',
      '- conversations/ - 对话日志',
      '- tasks/ - 任务笔记',
      '- notes/ - 知识笔记',
      '',
      '## Active Context',
      ...items.slice(0, 80).map(formatItem),
      '',
      '## Recent Bookmarks',
      recentBookmarks || '暂无。',
      ''
    ].join('\n'), 'utf8')

    const aiProfileItem = items.find((item) => item.memoryUid === AI_USER_PROFILE_UID)
    const aiProfileMarkdown = aiProfileItem ? normalizeUserProfileMarkdown(aiProfileItem.content) : ''
    const visibleItems = items.filter((item) => item.memoryUid !== AI_USER_PROFILE_UID)
    const profileItems = visibleItems
      .filter((item) => item.sourceType === 'profile' || item.sourceType === 'fact' || item.sourceType === 'relationship')
    const profileByUid = new Map(profileItems.map((item) => [item.memoryUid, item]))
    const nameItem = profileByUid.get('profile:user-name')
    const energyItem = profileByUid.get('profile:energy-focus')
    const copingItem = profileByUid.get('profile:coping-pattern')
    const interactionItem = profileByUid.get('profile:interaction-preference')
    const onboardingItems = [nameItem, energyItem, copingItem, interactionItem].filter((item): item is MemoryItem => Boolean(item))
    const firstProfileAt = onboardingItems.length
      ? Math.min(...onboardingItems.map((item) => item.createdAt))
      : null
    const name = nameItem
      ? extractMemoryValue(nameItem.content, '用户的名字是')
      : '（待填写）'
    const energy = energyItem
      ? extractMemoryValue(energyItem.content, '', /主要被「(.+)」占着/)
      : '（待填写）'
    const coping = copingItem
      ? extractMemoryValue(copingItem.content, '用户遇到计划被打乱、期待落空等脱轨时刻时，常见应对方式是：')
      : '（待填写）'
    const interaction = interactionItem
      ? extractMemoryValue(interactionItem.content, '用户希望与 AI 的互动感觉是：')
      : '（待填写）'
    const profileRows = profileItems
      .map((item) => `| ${tableCell(profileFactKey(item))} | ${tableCell(item.content)} | ${item.confidence.toFixed(2)} | ${tableCell(item.tags.join(',') || 'memory-bank')} | ${formatDate(item.updatedAt)} |`)
    const otherProfileClues = profileItems
      .filter((item) => !ONBOARDING_PROFILE_UID_SET.has(item.memoryUid))
      .slice(0, 20)
      .map(formatItem)
    const structuredProfile = aiProfileMarkdown
      ? aiProfileMarkdown.split('\n')
      : [
          '# 用户档案',
          '',
          '## 基本信息',
          `- 名字：${name}${nameItem ? '（首次记忆引导中主动告知）。' : '。'}`,
          `- 首次建档：${firstProfileAt ? formatDate(firstProfileAt) : '（日期）'}。`,
          '- 记忆来源：AI 助手首次记忆引导。',
          '',
          '## 日常状态',
          `- 精力去向：${energy}${energyItem ? '。' : ''}`,
          '',
          '## 性格与应对',
          `- 应对模式：${coping}${copingItem ? '。' : ''}`,
          '',
          '## 交互偏好',
          `- 偏好：${interaction}${interactionItem ? '。' : ''}`,
          ''
        ]
    writeFileSync(join(root, SELF_REFERENCE_DIR, 'user-profile.md'), [
      ...structuredProfile,
      '',
      '## 事实表',
      '| Key | Value | 置信度 | 来源 | 更新日期 |',
      '|-----|-------|--------|------|---------|',
      ...profileRows,
      '',
      '## 其他画像线索',
      ...(otherProfileClues.length ? otherProfileClues : ['暂无。']),
      '',
      '## 当前状态',
      ...visibleItems.slice(0, 20).map(formatItem),
      ''
    ].join('\n'), 'utf8')

    const relationshipItems = visibleItems
      .filter((item) => item.sourceType === 'relationship')
      .sort((a, b) => b.importance - a.importance || b.confidence - a.confidence || b.updatedAt - a.updatedAt)
    const relationshipPath = join(root, SELF_REFERENCE_DIR, 'relationship.md')
    const manualRelationship = extractMarkdownSection(this.readTextFile(relationshipPath, 20_000), '## 手写补充')
    writeFileSync(relationshipPath, [
      '# 关系',
      '',
      '## 结构化关系记忆',
      ...(relationshipItems.length ? relationshipItems.slice(0, 80).map(formatItem) : ['暂无。']),
      '',
      '## 交互偏好',
      interactionItem ? `- ${markdownEscape(interactionItem.content)}` : '- 暂未明确。',
      '',
      '## 手写补充',
      manualRelationship || '暂无。',
      ''
    ].join('\n'), 'utf8')
  }

  upsertMemoryItem(input: MemoryItemInput): MemoryItem {
    const memoryUid = String(input.memoryUid || '').trim()
    const content = String(input.content || '').trim()
    const title = String(input.title || content.slice(0, 40))
    if (!memoryUid) throw new Error('memoryUid is required')
    if (!content) throw new Error('memory content is required')
    const sourceType = safeSourceType(input.sourceType)
    const existing = this.findItemByUid(memoryUid)
    const timestamp = nowMs()
    const item: MemoryItem = {
      id: existing?.id ?? this.nextId(),
      memoryUid,
      sourceType,
      sessionId: normalizeNullableText(input.sessionId),
      contactId: normalizeNullableText(input.contactId),
      groupId: normalizeNullableText(input.groupId),
      title,
      content,
      contentHash: input.contentHash || hashMemoryContent(title, content),
      entities: parseStringArray(input.entities),
      tags: parseStringArray(input.tags),
      importance: normalizeNumber(input.importance, 0),
      confidence: clamp01(input.confidence, 1),
      timeStart: input.timeStart ?? null,
      timeEnd: input.timeEnd ?? null,
      sourceRefs: parseEvidenceRefs(input.sourceRefs),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp
    }
    this.writeItem(item)
    return item
  }

  getMemoryItemById(id: number): MemoryItem | null {
    const filePath = this.findItemFileById(Number(id))
    return filePath ? this.parseItemFile(filePath) : null
  }

  getMemoryItemByUid(memoryUid: string): MemoryItem | null {
    return this.findItemByUid(memoryUid)
  }

  listMemoryItems(options: MemoryListOptions = {}): MemoryItem[] {
    const itemsDir = join(this.ensureBank(), ITEMS_DIR)
    const sourceTypes = options.sourceTypes?.length
      ? Array.from(new Set(options.sourceTypes.filter((type) => MEMORY_SOURCE_TYPES.includes(type))))
      : options.sourceType
        ? [options.sourceType]
        : []
    const tags = (options.tags || []).map((tag) => String(tag).trim()).filter(Boolean)
    const withoutTags = (options.withoutTags || []).map((tag) => String(tag).trim()).filter(Boolean)
    const minConfidence = options.minConfidence === undefined ? null : clamp01(options.minConfidence, 0)
    const limit = Math.max(1, Math.min(Math.floor(options.limit || 100), 10000))
    const offset = Math.max(0, Math.floor(options.offset || 0))
    return readdirSync(itemsDir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => this.parseItemFile(join(itemsDir, name)))
      .filter((item): item is MemoryItem => Boolean(item && item.id > 0))
      .filter((item) => sourceTypes.length === 0 || sourceTypes.includes(item.sourceType))
      .filter((item) => !options.sessionId || item.sessionId === options.sessionId)
      .filter((item) => minConfidence == null || item.confidence >= minConfidence)
      .filter((item) => tags.every((tag) => item.tags.includes(tag)))
      .filter((item) => withoutTags.every((tag) => !item.tags.includes(tag)))
      .sort((a, b) => (b.timeEnd || b.timeStart || b.updatedAt) - (a.timeEnd || a.timeStart || a.updatedAt) || b.id - a.id)
      .slice(offset, offset + limit)
  }

  countMemoryItems(options: { sourceType?: MemorySourceType; sessionId?: string } = {}): number {
    return this.listMemoryItems({ ...options, limit: 10000 }).length
  }

  searchMemoryItemsByKeyword(options: MemoryKeywordSearchOptions): MemoryKeywordSearchHit[] {
    const query = String(options.query || '').trim()
    if (!query) return []
    const terms = splitQuery(query)
    const startTime = toTimestampSeconds(options.startTimeMs)
    const endTime = toTimestampSeconds(options.endTimeMs)
    const limit = Math.max(1, Math.min(Math.floor(options.limit || 80), 500))
    const items = this.listMemoryItems({
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.sourceTypes ? { sourceTypes: options.sourceTypes } : {}),
      limit: 10000
    })
      .filter((item) => {
        const time = item.timeEnd || item.timeStart || Math.floor(item.updatedAt / 1000)
        if (startTime && time < startTime) return false
        if (endTime && time > endTime) return false
        return true
      })
      .map((item) => {
        const haystack = normalizeSearchText([
          item.title,
          item.content,
          item.entities.join(' '),
          item.tags.join(' '),
          memoryAbout(item)
        ].join('\n'))
        const exact = haystack.includes(normalizeSearchText(query))
        const termHits = terms.filter((term) => haystack.includes(term)).length
        const score = (exact ? 800 : 0) + termHits * 120 + item.importance * 80 + item.confidence * 40
        return { item, score }
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt)
      .slice(0, limit)
    return items.map((hit, index) => ({
      item: hit.item,
      rank: index + 1,
      score: Number(hit.score.toFixed(4)),
      retrievalSource: 'memory_like'
    }))
  }

  readWakeupContext(scope?: { kind?: string; sessionId?: string }): string {
    const root = this.ensureBank()
    const files: Array<{ title: string; path: string }> = [
      { title: 'MEMORY.md', path: join(root, 'MEMORY.md') },
      { title: 'BOOKMARKS.md', path: join(root, 'BOOKMARKS.md') },
      { title: 'user-profile.md', path: join(root, SELF_REFERENCE_DIR, 'user-profile.md') },
      { title: 'relationship.md', path: join(root, SELF_REFERENCE_DIR, 'relationship.md') },
      { title: 'soul.md', path: join(root, SELF_REFERENCE_DIR, 'soul.md') },
    ]
    const parts: string[] = ['# 记忆唤醒']
    for (const file of files) {
      const content = file.title === 'BOOKMARKS.md'
        ? this.readRecentLines(file.path, 80, 12_000)
        : this.readTextFile(file.path, 12_000)
      if (!content) continue
      parts.push(`\n## ${file.title}\n${content}`)
    }

    const diaries = this.listRecentFiles(join(root, SELF_REFERENCE_DIR, 'diaries'), 2)
    if (diaries.length > 0) {
      parts.push('\n## 最近日记')
      for (const file of diaries) {
        const content = this.readTextFile(file, 6000)
        if (content) parts.push(`\n### ${basename(file)}\n${content}`)
      }
    }

    const tasks = this.listRecentFiles(join(root, 'tasks'), 5)
    if (tasks.length > 0) {
      parts.push('\n## 任务笔记')
      for (const file of tasks) {
        const content = this.readTextFile(file, 3000)
        if (content) parts.push(`\n### ${basename(file)}\n${content}`)
      }
    }

    const notes = this.listRecentFiles(join(root, 'notes'), 5)
    if (notes.length > 0) {
      parts.push('\n## 知识笔记')
      for (const file of notes) {
        const content = this.readTextFile(file, 3000)
        if (content) parts.push(`\n### ${basename(file)}\n${content}`)
      }
    }

    const scopedItems = this.listMemoryItems({
      sourceTypes: ['profile', 'fact', 'relationship'],
      minConfidence: 0.7,
      withoutTags: ['pending'],
      limit: 50,
    }).filter((item) => !scope?.sessionId || !item.sessionId || item.sessionId === scope.sessionId)
    if (scopedItems.length > 0) {
      parts.push('\n## 高置信结构化记忆')
      parts.push(...scopedItems.slice(0, 40).map((item) => (
        `- [id=${item.id} type=${item.sourceType} confidence=${item.confidence.toFixed(2)} about=${memoryAbout(item)}] ${item.content}`
      )))
    }

    return parts.join('\n').slice(0, 30_000)
  }

  retrieveMarkdownContext(query: string, opts: { sessionId?: string; limit?: number } = {}): MarkdownMemoryRetrieval {
    const mode = classifyQuery(query)
    if (mode === 'fact') return this.retrieveFactContext(opts)
    if (mode === 'recent') return this.retrieveRecentContext(opts.limit ?? 3)
    return this.retrieveTopicContext(query, opts.limit ?? 8)
  }

  private retrieveFactContext(opts: { sessionId?: string }): MarkdownMemoryRetrieval {
    const root = this.ensureBank()
    const sourceFiles = [
      join(root, SELF_REFERENCE_DIR, 'user-profile.md'),
      join(root, SELF_REFERENCE_DIR, 'relationship.md'),
      join(root, 'MEMORY.md')
    ]
    const context = sourceFiles
      .map((file) => {
        const content = this.readTextFile(file, 10_000)
        return content ? `## ${basename(file)}\n${content}` : ''
      })
      .filter(Boolean)
      .join('\n\n')
    const items = this.listMemoryItems({
      sourceTypes: ['profile', 'fact', 'relationship'],
      minConfidence: 0.5,
      limit: 80,
    }).filter((item) => !opts.sessionId || !item.sessionId || item.sessionId === opts.sessionId)
    return { mode: 'fact', context, itemIds: items.map((item) => item.id), sourceFiles }
  }

  private retrieveRecentContext(days: number): MarkdownMemoryRetrieval {
    const root = this.ensureBank()
    const files = this.listRecentFiles(join(root, 'conversations'), Math.max(1, Math.min(days, 7)))
    const context = files
      .map((file) => {
        const content = this.readTextFile(file, 10_000)
        return content ? `## ${basename(file)}\n${content}` : ''
      })
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 24_000)
    return { mode: 'recent', context, itemIds: [], sourceFiles: files }
  }

  private retrieveTopicContext(query: string, limit: number): MarkdownMemoryRetrieval {
    const root = this.ensureBank()
    const spaces = [
      { label: '对话', dir: join(root, 'conversations'), fileLimit: 365, charLimit: 80_000, textLimit: 1800 },
      { label: '任务', dir: join(root, 'tasks'), fileLimit: 120, charLimit: 20_000, textLimit: 2200 },
      { label: '笔记', dir: join(root, 'notes'), fileLimit: 120, charLimit: 20_000, textLimit: 2200 },
      { label: '日记', dir: join(root, SELF_REFERENCE_DIR, 'diaries'), fileLimit: 60, charLimit: 20_000, textLimit: 2200 }
    ]
    const terms = splitQuery(query)
    const snippets: Array<{ file: string; score: number; text: string; index: number }> = []
    for (const space of spaces) {
      const files = this.listRecentFiles(space.dir, space.fileLimit)
      for (const file of files) {
        const content = this.readTextFile(file, space.charLimit)
        if (!content) continue
        for (const block of splitConversationBlocks(file, content)) {
          const score = scoreConversationBlock(query, terms, block)
          if (score <= 0) continue
          snippets.push({
            file,
            score,
            index: block.index,
            text: [
              `[${space.label}:${basename(file)}]`,
              `## ${block.heading}`,
              block.body.slice(0, space.textLimit)
            ].join('\n').trim()
          })
        }
      }
    }
    const selected = snippets
      .sort((a, b) => b.score - a.score || basename(b.file).localeCompare(basename(a.file)) || a.index - b.index)
      .slice(0, Math.max(1, Math.min(limit, 20)))
    const sourceFiles = Array.from(new Set(selected.map((item) => item.file)))
    return {
      mode: 'topic',
      context: selected.map((item) => item.text).join('\n\n---\n\n').slice(0, 20_000),
      itemIds: [],
      sourceFiles
    }
  }

  private readTextFile(filePath: string, charLimit = 20_000): string {
    try {
      if (!existsSync(filePath)) return ''
      return readFileSync(filePath, 'utf8').slice(0, charLimit)
    } catch {
      return ''
    }
  }

  private readRecentLines(filePath: string, maxLines: number, charLimit = 4000): string {
    try {
      if (!existsSync(filePath)) return ''
      const lines = readFileSync(filePath, 'utf8')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-Math.max(1, maxLines))
      return lines.join('\n').slice(0, charLimit)
    } catch {
      return ''
    }
  }

  private listRecentFiles(dirPath: string, limit: number): string[] {
    try {
      if (!existsSync(dirPath)) return []
      return readdirSync(dirPath)
        .filter((name) => name.endsWith('.md') && !name.startsWith('_'))
        .sort((a, b) => b.localeCompare(a))
        .slice(0, Math.max(0, limit))
        .map((name) => join(dirPath, name))
    } catch {
      return []
    }
  }

  deleteMemoryItem(id: number): boolean {
    const filePath = this.findItemFileById(Number(id))
    if (!filePath) return false
    unlinkSync(filePath)
    this.syncDerivedMarkdown()
    return true
  }

  updateMemoryItem(id: number, input: {
    sourceType?: MemorySourceType
    title?: string
    content?: string
    importance?: number
    confidence?: number
    tags?: string[]
  }): MemoryItem | null {
    const existing = this.getMemoryItemById(id)
    if (!existing) return null
    const content = input.content !== undefined ? String(input.content).trim() : existing.content
    if (!content) throw new Error('memory content is required')
    const title = input.title !== undefined ? String(input.title) : existing.title
    const item: MemoryItem = {
      ...existing,
      sourceType: input.sourceType ? safeSourceType(input.sourceType) : existing.sourceType,
      title,
      content,
      contentHash: hashMemoryContent(title, content),
      tags: input.tags ?? existing.tags,
      importance: clamp01(input.importance, existing.importance),
      confidence: clamp01(input.confidence, existing.confidence),
      updatedAt: nowMs()
    }
    this.writeItem(item)
    return item
  }

  consolidate(capPerGroup = 50): { removed: number; semanticRemoved: number; groups: number; scanned: number } {
    const all = this.listMemoryItems({ limit: 10000 })
    const groups = new Map<string, MemoryItem[]>()
    for (const item of all) {
      const key = `${item.sessionId ?? ''}::${item.sourceType}`
      const bucket = groups.get(key)
      if (bucket) bucket.push(item)
      else groups.set(key, [item])
    }
    let removed = 0
    const seenHashes = new Set<string>()
    for (const item of all) {
      const key = `${item.sessionId ?? ''}::${item.sourceType}::${item.contentHash}`
      if (!seenHashes.has(key)) {
        seenHashes.add(key)
        continue
      }
      if (this.deleteMemoryItem(item.id)) removed += 1
    }
    for (const items of groups.values()) {
      const live = items.filter((item) => this.getMemoryItemById(item.id))
      if (live.length <= capPerGroup) continue
      const sorted = [...live].sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt)
      for (const victim of sorted.slice(capPerGroup)) {
        if (this.deleteMemoryItem(victim.id)) removed += 1
      }
    }
    this.syncDerivedMarkdown()
    return { removed, semanticRemoved: 0, groups: groups.size, scanned: all.length }
  }

  getVectorMeta(_modelId: string): Map<number, { contentHash: string; dim: number }> {
    return new Map()
  }

  upsertMemoryVector(_memoryId: number, _modelId: string, _dim: number, _contentHash: string, _embedding: Buffer): void {
    return
  }

  searchMemoryVectors(
    _queryVec?: number[],
    _modelId?: string,
    _opts: { sourceTypes?: MemorySourceType[]; sessionId?: string; limit?: number } = {}
  ): Array<{ item: MemoryItem; score: number }> {
    return []
  }

  getStats(): MemoryDatabaseStats {
    return { itemCount: this.countItemFiles() }
  }

  exportMarkdown(outputDir: string): MemoryMarkdownExportResult {
    const targetDir = String(outputDir || '').trim()
    if (!targetDir) throw new Error('outputDir is required')
    mkdirSync(targetDir, { recursive: true })
    const files: string[] = []
    const copyRecursive = (sourceDir: string, destDir: string) => {
      mkdirSync(destDir, { recursive: true })
      for (const name of readdirSync(sourceDir, { withFileTypes: true })) {
        const source = join(sourceDir, name.name)
        const dest = join(destDir, name.name)
        if (name.isDirectory()) {
          copyRecursive(source, dest)
        } else if (name.isFile() && name.name.endsWith('.md')) {
          copyFileSync(source, dest)
          files.push(dest)
        }
      }
    }
    copyRecursive(this.ensureBank(), targetDir)
    return { files, itemCount: this.getStats().itemCount }
  }

  appendBookmark(event: string, timestamp = nowMs()): void {
    const file = join(this.ensureBank(), 'BOOKMARKS.md')
    const text = normalizeBookmarkEvent(event)
    if (!text) return
    const line = `- ${formatDateTime(timestamp)} +08:00 ${text}\n`
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '# Bookmarks\n\n'
    const key = normalizeSearchText(text)
    const recent = current.split(/\r?\n/).slice(-80).map(bookmarkEventFromLine).map(normalizeSearchText)
    if (key && recent.includes(key)) return
    writeFileSync(file, current.endsWith('\n') ? current + line : `${current}\n${line}`, 'utf8')
  }

  appendSoulAdjustment(adjustment: string, timestamp = nowMs()): boolean {
    const text = normalizeBookmarkEvent(adjustment)
    if (!text) return false
    const file = join(this.ensureBank(), SELF_REFERENCE_DIR, 'soul.md')
    const current = existsSync(file) ? readFileSync(file, 'utf8') : DEFAULT_SOUL_MARKDOWN
    if (current.includes(text)) return false
    const header = '## 人格校准记录'
    const entry = `- ${formatDateTime(timestamp)} +08:00 ${text}`
    const base = current.trimEnd()
    const next = base.includes(`\n${header}`)
      ? `${base}\n${entry}\n`
      : `${base}\n\n${header}\n${entry}\n`
    writeFileSync(file, next, 'utf8')
    return true
  }

  appendConversationTurn(userText: string, assistantText: string, topic?: string, timestamp = nowMs()): void {
    const date = formatDate(timestamp)
    const file = join(this.ensureBank(), 'conversations', `${date}.md`)
    this.writeIfMissing(file, `# ${date} 对话日志\n\n`)
    const time = formatDateTime(timestamp).slice(11)
    const safeTopic = (topic || userText.slice(0, 28) || '对话').replace(/\s+/g, ' ').trim()
    const block = [
      `## ${time} +08:00 - ${safeTopic}`,
      `**用户：** ${userText.trim()}`,
      `**AI：** ${assistantText.trim()}`,
      ''
    ].join('\n')
    const current = readFileSync(file, 'utf8')
    writeFileSync(file, current.endsWith('\n') ? current + block : `${current}\n${block}`, 'utf8')
  }

  writeTaskNote(input: MemoryBankNoteInput): string {
    const file = this.writeBankNote('tasks', {
      ...input,
      title: noteTitle(input.title, '待办事项'),
      status: input.status || 'pending'
    }, '任务笔记')
    this.appendBookmark(`留下待办：${noteTitle(input.title, '待办事项')}。后续需要跟进。`)
    return file
  }

  writeKnowledgeNote(input: MemoryBankNoteInput): string {
    const file = this.writeBankNote('notes', {
      ...input,
      title: noteTitle(input.title, '知识笔记')
    }, '知识笔记')
    this.appendBookmark(`留下知识笔记：${noteTitle(input.title, '知识笔记')}。以后可复用。`)
    return file
  }

  listBankNotes(kind: MemoryBankNoteKind, limit = 100): MemoryBankNoteEntry[] {
    const dir = join(this.ensureBank(), kind)
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('_'))
      .map((entry) => this.readBankNote(kind, entry.name))
      .filter((entry): entry is MemoryBankNoteEntry => Boolean(entry))
      .sort((a, b) => b.updatedAt - a.updatedAt || b.fileName.localeCompare(a.fileName))
      .slice(0, Math.max(1, Math.min(500, Math.floor(Number(limit) || 100))))
  }

  readBankNote(kind: MemoryBankNoteKind, fileName: string): MemoryBankNoteEntry | null {
    const safeName = basename(String(fileName || '').trim())
    if (!safeName || !safeName.endsWith('.md')) return null
    const file = join(this.ensureBank(), kind, safeName)
    if (!existsSync(file)) return null
    const content = readFileSync(file, 'utf8')
    const meta = parseBankNoteMeta(content)
    return {
      kind,
      fileName: safeName,
      title: diaryTitle(content, safeName.replace(/\.md$/, '')),
      excerpt: bankNoteExcerpt(content) || diaryExcerpt(content),
      content,
      ...meta,
      updatedAt: statSync(file).mtimeMs
    }
  }

  deleteBankNote(kind: MemoryBankNoteKind, fileName: string): boolean {
    const safeName = basename(String(fileName || '').trim())
    if (!safeName || !safeName.endsWith('.md')) return false
    const file = join(this.ensureBank(), kind, safeName)
    if (!existsSync(file)) return false
    unlinkSync(file)
    this.appendBookmark(`删除${kind === 'tasks' ? '任务笔记' : '知识笔记'}：${safeName}。记忆库已清理。`)
    return true
  }

  private writeBankNote(dirName: 'tasks' | 'notes', input: MemoryBankNoteInput, label: string): string {
    const timestamp = input.timestamp || nowMs()
    const title = noteTitle(input.title, label)
    const content = markdownEscape(input.content)
    if (!content) throw new Error(`${label}内容不能为空`)
    const tags = parseStringArray(input.tags)
    const id = hashMemoryContent(title, content).slice(0, 12)
    const file = join(this.ensureBank(), dirName, `${formatDate(timestamp)}-${id}-${safeFileSegment(title)}.md`)
    const metaLines = [
      `- 创建：${formatDateTime(timestamp)} +08:00`,
      ...(input.status ? [`- 状态：${inlineMarkdown(input.status)}`] : []),
      ...(tags.length ? [`- 标签：${tags.join(', ')}`] : []),
    ]
    writeFileSync(file, [
      `# ${title}`,
      '',
      ...metaLines,
      '',
      '## 内容',
      content,
      ''
    ].join('\n'), 'utf8')
    return file
  }

  getDailyConsolidationTarget(timestamp = nowMs(), summaryHour = 2): string | null {
    const hour = new Date(timestamp).getHours()
    if (hour < normalizeDiarySummaryHour(summaryHour)) return null
    const date = formatDate(timestamp)
    const meta = this.readMeta()
    return meta.lastConsolidatedDate === date ? null : date
  }

  readDailyConsolidationSource(date: string): { conversations: string; bookmarks: string } {
    const root = this.ensureBank()
    const conversations = this.readTextFile(join(root, 'conversations', `${date}.md`), 40_000)
    const bookmarksPath = join(root, 'BOOKMARKS.md')
    const bookmarks = existsSync(bookmarksPath)
      ? readFileSync(bookmarksPath, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.includes(date))
        .join('\n')
      : ''
    return { conversations, bookmarks }
  }

  writeDiary(date: string, content: string): void {
    const root = this.ensureBank()
    const file = join(root, SELF_REFERENCE_DIR, 'diaries', `${date}.md`)
    const text = content.trim() || [
      `# ${date} 日记`,
      '',
      '## 今日摘要',
      '暂无可整理内容。',
      ''
    ].join('\n')
    writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, 'utf8')
    this.writeMeta({ lastConsolidatedDate: date, lastConsolidatedAt: new Date().toISOString() })
    this.syncDerivedMarkdown()
  }

  listDiaries(limit = 100): MemoryDiaryEntry[] {
    const root = this.ensureBank()
    const diaryDir = join(root, SELF_REFERENCE_DIR, 'diaries')
    return readdirSync(diaryDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name))
      .map((entry) => {
        const date = basename(entry.name, '.md')
        const filePath = join(diaryDir, entry.name)
        const content = readFileSync(filePath, 'utf8')
        return {
          date,
          title: diaryTitle(content, date),
          excerpt: diaryExcerpt(content),
          updatedAt: statSync(filePath).mtimeMs
        }
      })
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, Math.max(1, Math.min(500, Math.floor(Number(limit) || 100))))
  }

  readDiary(date: string): MemoryDiaryEntry | null {
    const safeDate = String(date || '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDate)) return null
    const filePath = join(this.ensureBank(), SELF_REFERENCE_DIR, 'diaries', `${safeDate}.md`)
    if (!existsSync(filePath)) return null
    const content = readFileSync(filePath, 'utf8')
    return {
      date: safeDate,
      title: diaryTitle(content, safeDate),
      excerpt: diaryExcerpt(content),
      content,
      updatedAt: statSync(filePath).mtimeMs
    }
  }

  deleteDiary(date: string): boolean {
    const safeDate = String(date || '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDate)) return false
    const filePath = join(this.ensureBank(), SELF_REFERENCE_DIR, 'diaries', `${safeDate}.md`)
    if (!existsSync(filePath)) return false
    unlinkSync(filePath)
    this.syncDerivedMarkdown()
    return true
  }

  getMigrationStatus(): MemoryMigrationStatus {
    const legacyDbPath = this.getDbPath()
    const memoryBankPath = this.getMemoryBankPath()
    const migratedItemCount = this.getStats().itemCount
    if (!existsSync(legacyDbPath)) {
      return { needed: false, legacyDbPath, memoryBankPath, itemCount: 0, migratedItemCount }
    }
    try {
      const db = new Database(legacyDbPath, { readonly: true, fileMustExist: true })
      try {
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_items'").get()
        if (!row) return { needed: false, legacyDbPath, memoryBankPath, itemCount: 0, migratedItemCount }
        const countRow = db.prepare(`SELECT COUNT(*) AS count FROM memory_items WHERE source_type IN (${MIGRATABLE_SOURCE_TYPES_SQL})`).get() as { count: number } | undefined
        const itemCount = Number(countRow?.count || 0)
        const meta = this.readMeta()
        const migratedLegacyCount = Number(meta.migratedLegacyItemCount || 0)
        const migratedSameDb = !meta.migratedLegacyDbPath || meta.migratedLegacyDbPath === legacyDbPath
        const completedMigration = meta.migratedLegacyDb === 'true' && migratedSameDb && (
          migratedLegacyCount >= itemCount || (!migratedLegacyCount && migratedItemCount >= itemCount)
        )
        return { needed: itemCount > 0 && !completedMigration, legacyDbPath, memoryBankPath, itemCount, migratedItemCount }
      } finally {
        db.close()
      }
    } catch (e) {
      return { needed: false, legacyDbPath, memoryBankPath, itemCount: 0, migratedItemCount, error: e instanceof Error ? e.message : String(e) }
    }
  }

  migrateLegacyDatabase(): MemoryMigrationResult {
    const status = this.getMigrationStatus()
    const deletedFiles: string[] = []
    const deleteErrors: string[] = []
    let skippedItemCount = 0
    if (!status.needed) return { ...status, success: true, deletedFiles }

    const db = new Database(status.legacyDbPath, { readonly: true, fileMustExist: true })
    try {
      const rows = db.prepare(`SELECT * FROM memory_items WHERE source_type IN (${MIGRATABLE_SOURCE_TYPES_SQL}) ORDER BY created_at ASC, id ASC`).all() as MemoryItemRow[]
      const index = this.readItemIndex()
      const meta = this.readMeta()
      let lastId = Math.max(index.maxId, Math.floor(Number(meta.lastId || 0)))

      for (const row of rows) {
        const input = rowToInput(row)
        const memoryUid = String(input.memoryUid || '').trim()
        const content = String(input.content || '').trim()
        if (!memoryUid || !content) {
          skippedItemCount += 1
          continue
        }
        const existing = index.byUid.get(memoryUid)
        const id = existing?.id ?? ++lastId
        const title = String(input.title || content.slice(0, 40))
        const timestamp = nowMs()
        const item: MemoryItem = {
          id,
          memoryUid,
          sourceType: safeSourceType(input.sourceType),
          sessionId: normalizeNullableText(input.sessionId),
          contactId: normalizeNullableText(input.contactId),
          groupId: normalizeNullableText(input.groupId),
          title,
          content,
          contentHash: input.contentHash || hashMemoryContent(title, content),
          entities: parseStringArray(input.entities),
          tags: parseStringArray(input.tags),
          importance: normalizeNumber(input.importance, 0),
          confidence: clamp01(input.confidence, 1),
          timeStart: input.timeStart ?? null,
          timeEnd: input.timeEnd ?? null,
          sourceRefs: parseEvidenceRefs(input.sourceRefs),
          createdAt: Number(row.created_at || existing?.createdAt || timestamp),
          updatedAt: Number(row.updated_at || timestamp)
        }
        const filePath = this.writeItemFile(item, index.fileById.get(id))
        index.byUid.set(memoryUid, item)
        index.fileById.set(id, filePath)
      }

      this.syncDerivedMarkdown()
      this.writeMeta({
        lastId,
        migratedLegacyDb: true,
        migratedLegacyDbPath: status.legacyDbPath,
        migratedLegacyItemCount: status.itemCount,
        migratedAt: new Date().toISOString()
      })
      const skippedText = skippedItemCount > 0 ? `，跳过 ${skippedItemCount} 条无效记录` : ''
      this.appendBookmark(`从旧版 ${MEMORY_DB_NAME} 迁移 ${rows.length - skippedItemCount} 条长期记忆${skippedText}。`)
    } finally {
      db.close()
    }

    for (const file of [
      status.legacyDbPath,
      `${status.legacyDbPath}-wal`,
      `${status.legacyDbPath}-shm`,
      `${status.legacyDbPath}-journal`
    ]) {
      if (!existsSync(file)) continue
      try {
        rmSync(file, { force: true })
        deletedFiles.push(file)
      } catch (e) {
        deleteErrors.push(`${file}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    const next = this.getMigrationStatus()
    return {
      ...next,
      success: true,
      needed: false,
      itemCount: status.itemCount,
      migratedItemCount: this.getStats().itemCount,
      deletedFiles,
      ...(deleteErrors.length > 0 ? { deleteErrors } : {}),
      ...(skippedItemCount > 0 ? { skippedItemCount } : {})
    }
  }
}

export const memoryDatabase = new MemoryDatabase()
