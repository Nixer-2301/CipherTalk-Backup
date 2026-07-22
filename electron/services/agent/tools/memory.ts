/**
 * 长期记忆工具 —— remember / recall（纯 Markdown memory-bank，Letta/LangMem 式「agent 自编辑」范式）。
 *
 * agent 在 ReAct 循环里自己决定记什么、查什么，写进 cachePath/memory-bank 的 Markdown 文件。
 * 只存稳定的「用户画像 profile」与「长期事实 fact」，带 importance；高重要度的会在下次开场注入系统提示。
 * 故意只挂在主 Agent（buildTools），子 Agent（delegate）不带，避免子任务乱写记忆。
 */
import { tool, generateObject, generateText } from 'ai'
import { z } from 'zod'
import type { AgentScope, AgentProviderConfig } from '../types'
import type { MemoryItem, MemorySourceType } from '../../memory/memorySchema'
import { AI_USER_PROFILE_UID, ONBOARDING_PROFILE_UIDS, memoryDatabase, hashMemoryContent } from '../../memory/memoryDatabase'
import { createLanguageModel } from '../provider'
import { invalidateMemoryCache } from '../runtimeCache'
import { rerankCandidates, type RerankMeta } from '../../ai/rerankService'
import { ConfigService } from '../../config'

/** 开场注入的画像/会话事实条数上限；先取 SCAN_LIMIT 再按 importance 排序截断。 */
const STARTUP_MEMORY_ITEM_LIMIT = 40
const STARTUP_MEMORY_CHAR_LIMIT = 20_000
const STARTUP_MEMORY_MIN_CONFIDENCE = 0.7
const PRELOAD_MEMORY_LIMIT = 8
const SCAN_LIMIT = 50
const CONTEXT_SOURCE_TYPES: MemorySourceType[] = ['profile', 'fact', 'relationship']

async function generateMemoryText(opts: {
  providerConfig: AgentProviderConfig
  instructions: string
  prompt: string
  signal?: AbortSignal
}): Promise<string> {
  const result = await generateText({
    model: createLanguageModel(opts.providerConfig),
    abortSignal: opts.signal,
    temperature: 0.2,
    system: opts.instructions,
    prompt: opts.prompt,
  })
  return result.text.trim()
}

async function generateMemoryObject<T>(opts: {
  providerConfig: AgentProviderConfig
  schema: z.ZodType<T>
  instructions: string
  prompt: string
  signal?: AbortSignal
}): Promise<T> {
  const { object } = await generateObject({
    model: createLanguageModel(opts.providerConfig),
    abortSignal: opts.signal,
    schema: opts.schema,
    system: opts.instructions,
    prompt: opts.prompt,
  })
  return object
}

function memoryUid(title: string, content: string): string {
  return `mem-${hashMemoryContent(title, content).slice(0, 16)}`
}

/** about 缺省回退：当前已 @ 某会话则归到该会话，否则不限定（关于用户本人）。 */
function resolveAbout(about: string | undefined, scope: AgentScope): string | null {
  const explicit = String(about || '').trim()
  if (explicit) return explicit
  if (scope.kind === 'session') return scope.sessionId
  return null
}

const MEMORY_KINDS: Array<'profile' | 'fact' | 'relationship'> = ['profile', 'fact', 'relationship']
type RecallMode = 'markdown'
type RecallMatchedBy = 'keyword'

function formatRecall(
  items: MemoryItem[],
  mode: RecallMode,
  opts: {
    fallbackReason?: string
    keywordIds?: Set<number>
    keywordCount?: number
    rerank?: RerankMeta
    markdownContext?: ReturnType<typeof memoryDatabase.retrieveMarkdownContext>
  },
) {
  const keywordIds = opts.keywordIds || new Set<number>()
  return {
    mode,
    retrieval: {
      mode,
      embeddingReady: false,
      fallbackReason: opts.fallbackReason,
      keywordCount: opts.keywordCount ?? keywordIds.size,
      vectorCount: 0,
      rerank: opts.rerank,
      markdownMode: opts.markdownContext?.mode,
      sourceFiles: opts.markdownContext?.sourceFiles,
    },
    context: opts.markdownContext?.context || '',
    count: items.length,
    memories: items.map((m) => ({
      id: m.id,
      kind: m.sourceType,
      content: m.content,
      about: m.sessionId,
      importance: m.importance,
      tags: m.tags,
      matchedBy: 'keyword' as RecallMatchedBy,
    })),
  }
}

function memoryAbout(m: MemoryItem): string {
  return m.sessionId || m.contactId || m.groupId || 'global'
}

function formatMemoryLine(m: MemoryItem): string {
  const tags = m.tags.length > 0 ? ` tags=${m.tags.join(',')}` : ''
  return `- [id=${m.id} type=${m.sourceType} confidence=${m.confidence.toFixed(2)} about=${memoryAbout(m)}${tags}] ${m.content.slice(0, 180)}`
}

function rankContextMemories(items: MemoryItem[]): MemoryItem[] {
  return [...items].sort((a, b) =>
    b.importance - a.importance ||
    b.confidence - a.confidence ||
    b.updatedAt - a.updatedAt
  )
}

function limitMemoryLines(items: MemoryItem[], itemLimit = STARTUP_MEMORY_ITEM_LIMIT, charLimit = STARTUP_MEMORY_CHAR_LIMIT): string[] {
  const lines: string[] = []
  let total = 0
  for (const item of items) {
    if (lines.length >= itemLimit) break
    const line = formatMemoryLine(item)
    if (total + line.length > charLimit) break
    lines.push(line)
    total += line.length + 1
  }
  return lines
}

export function createRemember(scope: AgentScope) {
  return tool({
    description:
      '记住一条关于用户的长期记忆，跨对话保留（下次开场会注入高重要度记忆）。' +
      '只在用户透露稳定的偏好/身份/重要关系或事实时用（如"我是产品经理""我女朋友叫小美""老王是我室友"）；' +
      '一次性、琐碎、或能直接从聊天记录查到的别记。记之前可先用 recall 查是否已记过，避免重复。',
    inputSchema: z.object({
      content: z.string().min(1).describe('要记住的事实，一句话写清'),
      kind: z.enum(['profile', 'fact', 'relationship']).default('fact')
        .describe('profile=关于用户本人的画像/偏好；fact=其它长期事实；relationship=长期关系/称谓/角色'),
      about: z.string().optional().describe('这条记忆关于谁（联系人/会话 username）；profile 默认全局，其它类型不填且当前已 @ 某会话则默认归到该会话'),
      importance: z.number().min(0).max(1).default(0.5).describe('重要度 0~1，越高越会在开场被注入系统提示'),
      tags: z.array(z.string()).optional().describe('可选标签，便于检索'),
    }),
    execute: async ({ content, kind, about, importance, tags }) => {
      try {
        const text = content.trim()
        const title = text.slice(0, 40)
        const sessionId = kind === 'profile' ? null : resolveAbout(about, scope)
        const nextTags = Array.from(new Set(tags || []))
        const item = memoryDatabase.upsertMemoryItem({
          memoryUid: memoryUid(title, text),
          sourceType: kind,
          sessionId,
          contactId: sessionId,
          title,
          content: text,
          importance,
          tags: nextTags,
        })
        memoryDatabase.appendBookmark(`记住新事实：${text.slice(0, 120)}。用户或 Agent 主动保存。`)
        invalidateMemoryCache(sessionId ? { kind: 'session', sessionId } : { kind: 'global' })
        return { remembered: true, id: item.id, kind: item.sourceType, importance: item.importance, about: sessionId || 'global' }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    },
  })
}

export function createRecall(scope: AgentScope) {
  return tool({
    description:
      '检索你记过的长期记忆（用户画像/偏好/长期事实）。回答涉及用户个人情况、偏好、长期关系时先查一下。',
    inputSchema: z.object({
      query: z.string().min(1).describe('检索意图/关键词'),
      about: z.string().optional().describe('限定关于某联系人/会话 username；不填且已 @ 某会话则默认该会话'),
      limit: z.number().int().min(1).max(30).default(10).describe('返回条数上限'),
    }),
    execute: async ({ query, about, limit }) => {
      try {
        const sessionId = resolveAbout(about, scope)
        const markdownContext = memoryDatabase.retrieveMarkdownContext(query, { ...(sessionId ? { sessionId } : {}), limit })
        const candidateLimit = Math.min(50, Math.max(limit, limit * 3))
        const filter = { ...(sessionId ? { sessionId } : {}), sourceTypes: MEMORY_KINDS }
        const keywordHits = memoryDatabase.searchMemoryItemsByKeyword({ query, ...filter, limit: candidateLimit })
        const keywordIds = new Set(keywordHits.map((h) => h.item.id))
        const keywordItems = keywordHits.slice(0, candidateLimit).map((h) => h.item)
        const { items, meta: rerankMeta } = await rerankCandidates(
          query,
          keywordItems.map((item) => ({
            item,
            text: [item.title, item.content, item.tags?.join(' ')].filter(Boolean).join('\n'),
          })),
          { topN: limit },
        )
        return formatRecall(items, 'markdown', {
          fallbackReason: keywordHits.length === 0 ? 'no_keyword_hits' : undefined,
          keywordIds,
          keywordCount: keywordHits.length,
          rerank: rerankMeta,
          markdownContext,
        })
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    },
  })
}

export function createListMemories(scope: AgentScope) {
  return tool({
    description:
      '列出已记的长期记忆（按范围/类型浏览，不带检索词）。用于盘点、整理前查看；要按内容找用 recall。',
    inputSchema: z.object({
      about: z.string().optional().describe('限定关于某联系人/会话 username；不填且已 @ 某会话则默认该会话'),
      kind: z.enum(['profile', 'fact', 'relationship']).optional().describe('只看某类；不填则列画像/事实/关系'),
      limit: z.number().int().min(1).max(100).default(30).describe('返回条数上限'),
    }),
    execute: async ({ about, kind, limit }) => {
      try {
        const sessionId = resolveAbout(about, scope)
        const items = memoryDatabase.listMemoryItems({
          ...(kind ? { sourceType: kind } : {}),
          ...(sessionId ? { sessionId } : {}),
          limit,
        })
        return {
          count: items.length,
          memories: items.map((m) => ({
            id: m.id,
            kind: m.sourceType,
            content: m.content,
            about: m.sessionId,
            importance: m.importance,
            tags: m.tags,
          })),
        }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    },
  })
}

export function createForget() {
  return tool({
    description:
      '删除一条过时或记错的长期记忆（id 来自 recall / list_memories）。' +
      '用户纠正"我已经不是…了 / 那条记错了"时，先 forget 旧的再 remember 新的。',
    inputSchema: z.object({
      id: z.number().int().describe('要删除的记忆 id（来自 recall / list_memories）'),
    }),
    execute: async ({ id }) => {
      try {
        const ok = memoryDatabase.deleteMemoryItem(id)
        if (ok) invalidateMemoryCache()
        return ok ? { forgotten: true, id } : { forgotten: false, id, reason: '未找到该记忆' }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    },
  })
}

export function createConsolidate() {
  return tool({
    description:
      '整理 Markdown 记忆：按"关于谁 × 类型"分组，每组只保留最重要的若干条，删掉低价值冗余，防止记忆库越积越乱。' +
      '记了很多条、或用户让你"整理一下记忆"时调用。',
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const result = memoryDatabase.consolidate(50)
        invalidateMemoryCache()
        return result
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    },
  })
}

/** 读高重要度长期记忆拼成启动摘要；无记忆返回空串，读失败不影响 agent。 */
export async function buildMemoryContext(scope: AgentScope): Promise<string> {
  try {
    const wakeup = memoryDatabase.readWakeupContext(scope)
    const globalProfiles = memoryDatabase.listMemoryItems({
      sourceTypes: ['profile'],
      minConfidence: STARTUP_MEMORY_MIN_CONFIDENCE,
      withoutTags: ['pending'],
      limit: SCAN_LIMIT,
    }).filter((m) => !m.sessionId || (scope.kind === 'session' && m.sessionId === scope.sessionId))

    const scoped = scope.kind === 'session'
      ? memoryDatabase.listMemoryItems({
          sourceTypes: ['fact', 'relationship'],
          sessionId: scope.sessionId,
          minConfidence: STARTUP_MEMORY_MIN_CONFIDENCE,
          withoutTags: ['pending'],
          limit: SCAN_LIMIT,
        })
      : memoryDatabase.listMemoryItems({
          sourceTypes: ['relationship'],
          minConfidence: STARTUP_MEMORY_MIN_CONFIDENCE,
          withoutTags: ['pending'],
          limit: SCAN_LIMIT,
        }).filter((m) => !m.sessionId)

    const lines = limitMemoryLines(rankContextMemories([...globalProfiles, ...scoped]))
    if (lines.length === 0) return wakeup

    return `${wakeup}\n\n# 启动记忆摘要\n这些是经过筛选的高置信长期记忆，只作为上下文参考；若与当前对话冲突，以当前对话为准。每条保留 id/type/confidence/about，细节不足时用 recall 检索。\n${lines.join('\n')}`
  } catch {
    return ''
  }
}

/** 按本轮问题预召回相关记忆，降低模型忘记主动 recall 的概率。 */
export async function preloadRelevantMemories(query: string, scope: AgentScope): Promise<string> {
  const text = query.trim()
  if (text.length < 2) return ''
  try {
    const markdown = memoryDatabase.retrieveMarkdownContext(text, {
      ...(scope.kind === 'session' ? { sessionId: scope.sessionId } : {}),
      limit: PRELOAD_MEMORY_LIMIT,
    })
    const hits = memoryDatabase.searchMemoryItemsByKeyword({
      query: text,
      sourceTypes: CONTEXT_SOURCE_TYPES,
      limit: PRELOAD_MEMORY_LIMIT * 3,
    })
    const scoped = hits
      .map((hit) => hit.item)
      .filter((m) => !m.tags.includes('pending'))
      .filter((m) => m.confidence >= 0.5)
      .filter((m) => scope.kind !== 'session' || !m.sessionId || m.sessionId === scope.sessionId)
    const seen = new Set<number>()
    const items = scoped.filter((m) => {
      if (seen.has(m.id)) return false
      seen.add(m.id)
      return true
    }).slice(0, PRELOAD_MEMORY_LIMIT)
    const itemContext = items.length > 0
      ? `\n\n# 本轮相关记忆\n以下记忆与用户当前问题可能相关；仍需以当前对话与工具查询结果为准。\n${items.map(formatMemoryLine).join('\n')}`
      : ''
    const fileContext = markdown.context
      ? `\n\n# 本轮文件记忆（${markdown.mode}）\n${markdown.context.slice(0, 12_000)}`
      : ''
    return `${itemContext}${fileContext}`
  } catch {
    return ''
  }
}

export async function afterTurnMemory(opts: {
  scope: AgentScope
  providerConfig: AgentProviderConfig
  userText: string
  assistantText: string
  signal?: AbortSignal
}): Promise<AutoMemoryResult[]> {
  const { scope, providerConfig, userText, assistantText, signal } = opts
  memoryDatabase.appendConversationTurn(userText, assistantText)
  const auto = await extractMemories({ scope, providerConfig, userText, assistantText, signal })
  await maybeRunDailyConsolidation(providerConfig, signal)
  return auto
}

export type OnboardingProfileBuildResult = {
  built: boolean
  itemId?: number
  reason?: string
}

export async function buildOnboardingUserProfileMemory(providerConfig: AgentProviderConfig, signal?: AbortSignal): Promise<OnboardingProfileBuildResult> {
  const onboardingItems = ONBOARDING_PROFILE_UIDS
    .map((uid) => memoryDatabase.getMemoryItemByUid(uid))
    .filter((item): item is MemoryItem => Boolean(item))
  if (onboardingItems.length === 0) return { built: false, reason: 'no_onboarding_memory' }

  const source = onboardingItems
    .map((item) => `- ${item.title || item.memoryUid}：${item.content}`)
    .join('\n')
  const previous = memoryDatabase.getMemoryItemByUid(AI_USER_PROFILE_UID)
  const previousProfile = previous?.content.trim()
    ? `\n\n已有画像草稿（如有冲突，以最新回答为准）：\n${previous.content.slice(0, 8000)}`
    : ''

  const content = await generateMemoryText({
    providerConfig,
    signal,
    instructions:
      '你是 CipherTalk 的用户长期记忆画像整理器。只根据给定资料更新用户档案，不编造、不扩写没有证据的内容。' +
      '输出中文 Markdown，第一行必须是「# 用户档案」。只输出档案正文，不要解释。',
    prompt: [
      '根据下面的首次记忆引导回答，整理成长期可用的用户画像。',
      '',
      '格式要求：',
      '- 必须包含这些二级标题：## 基本信息、## 日常状态、## 性格与应对、## 交互偏好。',
      '- 每个标题下用 1-3 条项目符号。',
      '- 写法参考“名字：……（首次对话中主动告知）。”这种清晰句式。',
      '- 不要输出事实表、当前状态、其他画像线索，这些会由系统自动追加。',
      '- 缺失的信息不要猜，可以写“暂未明确”。',
      '',
      `首次记忆引导回答：\n${source}${previousProfile}`
    ].join('\n')
  })

  if (!content || !content.includes('## 基本信息')) return { built: false, reason: 'invalid_ai_profile' }
  const item = memoryDatabase.upsertMemoryItem({
    memoryUid: AI_USER_PROFILE_UID,
    sourceType: 'profile',
    title: 'AI 用户画像',
    content,
    importance: 0.95,
    confidence: 0.9,
    tags: ['onboarding', 'ai-profile', 'profile']
  })
  memoryDatabase.appendBookmark('首次用户画像已生成。下次开场能读到基本用户档案。')
  invalidateMemoryCache({ kind: 'global' })
  return { built: true, itemId: item.id }
}

type DailyDiaryGenerationOptions = {
  unreadMessages?: string
  /** 目标日的真实聊天摘要（主素材）：私聊和筛过的群聊，读没读都算 */
  dayMessages?: string
  summaryHour?: number
  customPrompt?: string
}

function normalizeDiaryCustomPrompt(value: unknown): string {
  return String(value || '').trim().slice(0, 4000)
}

function getDiaryGenerationOptions(extraSource: DailyDiaryGenerationOptions): DailyDiaryGenerationOptions {
  const hasSummaryHour = Number.isFinite(Number(extraSource.summaryHour))
  const hasCustomPrompt = Object.prototype.hasOwnProperty.call(extraSource, 'customPrompt')
  if (hasSummaryHour && hasCustomPrompt) return extraSource

  const config = new ConfigService()
  try {
    return {
      ...extraSource,
      summaryHour: hasSummaryHour ? extraSource.summaryHour : Number(config.get('diarySummaryHour') ?? 2),
      customPrompt: hasCustomPrompt ? extraSource.customPrompt : String(config.get('diaryCustomPrompt') || '').trim(),
    }
  } finally {
    config.close()
  }
}

type BookmarkConsolidationResult = {
  profileFacts: number
  activeContexts: number
  soulAdjustments: number
}

function emptyBookmarkConsolidation(): BookmarkConsolidationResult {
  return { profileFacts: 0, activeContexts: 0, soulAdjustments: 0 }
}

async function consolidateDailyBookmarks(opts: {
  date: string
  bookmarks: string
  providerConfig: AgentProviderConfig
  signal?: AbortSignal
}): Promise<BookmarkConsolidationResult> {
  const lines = opts.bookmarks
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .slice(-80)
  if (lines.length === 0) return emptyBookmarkConsolidation()

  try {
    const existing = memoryDatabase.listMemoryItems({ limit: 80 })
      .map((item) => `- ${item.content}`)
      .join('\n')
      .slice(0, 9000)

    const schema = z.object({
      profileFacts: z.array(z.object({
        content: z.string().describe('应写进用户档案或长期事实的一句话'),
        kind: z.enum(['profile', 'fact', 'relationship']).default('fact'),
        importance: z.number().min(0).max(1).default(0.75),
        confidence: z.number().min(0).max(1).default(0.75),
      })).max(8).default([]),
      activeContexts: z.array(z.object({
        content: z.string().describe('应出现在 MEMORY.md Active Context 的当前项目状态、决策或近期方向'),
        importance: z.number().min(0).max(1).default(0.75),
        confidence: z.number().min(0).max(1).default(0.75),
      })).max(6).default([]),
      soulAdjustments: z.array(z.object({
        content: z.string().describe('明确关于 AI 人格、语气、关系、记忆方式的校准建议，一句话'),
        importance: z.number().min(0).max(1).default(0.7),
      })).max(3).default([]),
    })
    const object = await generateMemoryObject({
      providerConfig: opts.providerConfig,
      signal: opts.signal,
      schema,
      instructions:
        '你是 CipherTalk 的 BOOKMARKS 每夜整理器。BOOKMARKS 每行都是“时间戳 + 发生了什么 + 为什么值得记”的一句话便签。' +
        '你的任务是克制地分流：稳定用户事实进 profileFacts，当前项目决策/近期状态进 activeContexts，只有明确提到 AI 说话方式、人格边界、记忆习惯需要改变时才进 soulAdjustments。' +
        '多数便签只用于日记，不需要输出任何结构化结果。不要重复已有记忆，不要把普通闲聊、临时情绪、一次性话题写进长期档案。',
      prompt: [
        `日期：${opts.date}`,
        '',
        '当天 BOOKMARKS：',
        lines.join('\n'),
        '',
        existing ? `已有长期记忆（避免重复）：\n${existing}` : '已有长期记忆：暂无。',
        '',
        '输出要求：',
        '- profileFacts：只放稳定身份、长期偏好、重要关系、长期事实。',
        '- activeContexts：只放需要下次醒来马上知道的项目状态、产品决策、近期方向。',
        '- soulAdjustments：只放明确的人格/语气/记忆校准，例如“用户嫌 CT 太客气，以后更直接”。',
        '- 每条 content 都是一句话，不要带字段名，不要解释。'
      ].join('\n')
    })

    let profileFacts = 0
    let activeContexts = 0
    let soulAdjustments = 0
    for (const fact of object.profileFacts || []) {
      const content = fact.content.trim()
      if (!content) continue
      const confidence = Math.max(0, Math.min(1, Number(fact.confidence || 0.75)))
      const title = content.slice(0, 40)
      memoryDatabase.upsertMemoryItem({
        memoryUid: memoryUid(title, content),
        sourceType: fact.kind,
        title,
        content,
        importance: Math.max(0.5, Math.min(1, Number(fact.importance || 0.75))),
        confidence,
        tags: confidence >= 0.8 ? ['bookmark', 'nightly', opts.date] : ['bookmark', 'nightly', 'pending', opts.date],
      })
      profileFacts += 1
    }
    for (const context of object.activeContexts || []) {
      const content = context.content.trim()
      if (!content) continue
      const title = content.slice(0, 40)
      memoryDatabase.upsertMemoryItem({
        memoryUid: memoryUid(title, content),
        sourceType: 'fact',
        title,
        content,
        importance: Math.max(0.7, Math.min(1, Number(context.importance || 0.75))),
        confidence: Math.max(0, Math.min(1, Number(context.confidence || 0.75))),
        tags: ['bookmark', 'nightly', 'active-context', opts.date],
      })
      activeContexts += 1
    }
    for (const adjustment of object.soulAdjustments || []) {
      const content = adjustment.content.trim()
      if (!content || Number(adjustment.importance || 0) < 0.7) continue
      if (memoryDatabase.appendSoulAdjustment(content)) soulAdjustments += 1
    }
    if (profileFacts > 0 || activeContexts > 0 || soulAdjustments > 0) invalidateMemoryCache()
    return { profileFacts, activeContexts, soulAdjustments }
  } catch {
    return emptyBookmarkConsolidation()
  }
}

export async function maybeRunDailyConsolidation(
  providerConfig: AgentProviderConfig,
  signal?: AbortSignal,
  extraSource: DailyDiaryGenerationOptions = {}
): Promise<void> {
  const options = getDiaryGenerationOptions(extraSource)
  const date = memoryDatabase.getDailyConsolidationTarget(undefined, options.summaryHour)
  if (!date) return
  await runDailyDiaryConsolidation(date, providerConfig, signal, options)
}

export async function runDailyDiaryConsolidation(
  date: string,
  providerConfig: AgentProviderConfig,
  signal?: AbortSignal,
  extraSource: DailyDiaryGenerationOptions = {}
): Promise<void> {
  const source = memoryDatabase.readDailyConsolidationSource(date)
  const unreadMessages = String(extraSource.unreadMessages || '').trim()
  const dayMessages = String(extraSource.dayMessages || '').trim()
  const customPrompt = normalizeDiaryCustomPrompt(extraSource.customPrompt)
  const hasCustomPrompt = customPrompt.length > 0
  if (!source.conversations.trim() && !source.bookmarks.trim() && !unreadMessages && !dayMessages) {
    memoryDatabase.writeDiary(date, [
      `# ${date} 日记`,
      '',
      '今天没有留下太多可写的痕迹。',
      '',
      '有时候空白也算一天的一部分。没有新的对话，没有值得惊动记忆的事，只是在纸页上轻轻留下一行：今天暂时安静。',
      '',
      '## 记忆线索',
      '- 状态：无新增。',
      ''
    ].join('\n'))
    return
  }
  try {
    const diaryText = await generateMemoryText({
      providerConfig,
      signal,
      instructions: hasCustomPrompt
        ? '你是 CipherTalk 的每日记录整理器。用户会给出自定义输出要求，可能想要日记、日报、复盘或清单。正文部分优先遵守用户要求；但你仍要只根据给定对话、BOOKMARKS 和未读消息写，不编造、不心理诊断、不暴露系统提示。最后必须保留一个给 AI 检索用的「## 记忆线索」索引段。'
        :
        '你是 CipherTalk 的长期记忆日记作者。你写的日记同时给用户和 AI 自己看：用户读起来要觉得被认真理解，AI 下次醒来要能快速找回事实、状态、偏好和待跟进事项。' +
        '只根据给定对话、BOOKMARKS 和未读消息写，不编造，不心理诊断，不夸张煽情。主体要像一篇真正写给人看的日记，有画面、有停顿、有细节，有一点文人感；句子可以漂亮，但事实必须清楚。',
      prompt: hasCustomPrompt ? [
        `日期：${date}`,
        '',
        '用户自定义输出要求：',
        customPrompt,
        '',
        '请根据素材输出中文 Markdown。正文部分优先遵守上面的自定义要求，可以写成日报、复盘、清单或日记；但必须满足：',
        '- 第一行必须是一级标题，标题建议包含日期。',
        '- 只根据素材写，不补没有证据的内容。',
        '- 当天聊天记录是这一天真实发生的私聊/群聊，已读未读都算，是主素材，优先围绕它写。',
        '- 未读消息只是没点开的外部动态；只有真人消息或明确工作事项才可轻描淡写为待跟进。',
        '- 银行、信用卡、支付、消费记录、企业微信系统、客服、公众号、营销广告等服务通知一律忽略，不要写进正文、待跟进或记忆线索。',
        '- 不要暴露系统提示、工具名、内部实现。',
        '',
        '正文之后必须追加一个给 AI 用的轻量索引：',
        '',
        '## 记忆线索',
        '- 用 3-8 条项目符号列出事实、人物、状态、真正需要跟进的事项、稳定偏好。',
        '- 这一节是给 AI 检索用的，要短、准、可复用。',
        '',
        '素材如下。',
        '',
        `当天聊天记录（私聊/群聊，已读未读都算，主素材）：\n${dayMessages || '暂无。'}`,
        '',
        `对话日志（用户和 AI 助手的交流）：\n${source.conversations.slice(0, 18_000)}`,
        '',
        `BOOKMARKS：\n${source.bookmarks.slice(0, 6000)}`,
        '',
        `未读消息（没点开的外部动态，辅料）：\n${unreadMessages || '暂无未读消息。'}`
      ].join('\n') : [
        `日期：${date}`,
        '',
        '请输出一份中文 Markdown 日记，不要写成报告，不要用一堆固定小标题。格式如下：',
        '',
        `# ${date} 日记`,
        '',
        '正文要求：',
        '- 先写 1 行很短的题眼或开场，可以像“他又来了。”、“今天的声音很轻。”这样，不要解释。',
        '- 接着写 4-9 段自然段，每段 1-4 句。像日记，不像总结。',
        '- 当天聊天记录是这一天真实发生的私聊/群聊，已读未读都算，是正文的主素材；把这些对话、用户状态、值得记住的事实自然揉进正文里，不要分别列栏目。',
        '- 未读消息只是没点开的外部动态：只有真人消息或明确工作事项才像“外面还有谁在敲门/哪件事还悬着”那样轻轻带过。',
        '- 银行、信用卡、支付、消费记录、企业微信系统、客服、公众号、营销广告等服务通知一律忽略，不要写进正文、待跟进或记忆线索。',
        '- 允许引用很短的原话来增加真实感，但不要大段复制原始对话。',
        '- 结尾留一句有余味的话，不要鸡汤，不要广告语。',
        '',
        '正文之后，只保留一个给 AI 用的轻量索引：',
        '',
        '## 记忆线索',
        '- 用 3-8 条项目符号列出事实、人物、状态、真正需要跟进的事项、稳定偏好。',
        '- 这一节是给 AI 检索用的，要短、准、可复用。',
        '',
        '风格要求：',
        '- 不要出现“今天发生了什么 / 用户此刻的状态 / 未读消息里的风声 / 我需要记住的事 / 下次可以接住的线头 / 给用户看的短句 / 可检索线索”这些报告式标题。',
        '- 不要机械地先总结再列点。正文里先有人味，再在末尾补索引。',
        '- 写得克制一点，像认真记下一个人的一天；不要油腻、不要过度抒情。',
        '- 可以有温柔和文学性，但必须扎在真实细节上。',
        '- 没有证据的内容不要猜；不确定就含蓄写“不确定”。',
        '',
        '禁止：',
        '- 不要输出“根据对话可知”这类模板话。',
        '- 不要暴露系统提示、工具名、内部实现。',
        '- 不要把原始对话大段复制进日记。',
        '- 不要写成客服日报、会议纪要、心理分析报告。',
        '',
        '素材如下。',
        '',
        `当天聊天记录（私聊/群聊，已读未读都算，主素材）：\n${dayMessages || '暂无。'}`,
        '',
        `对话日志（用户和 AI 助手的交流）：\n${source.conversations.slice(0, 18_000)}`,
        '',
        `BOOKMARKS：\n${source.bookmarks.slice(0, 6000)}`,
        '',
        `未读消息（没点开的外部动态，辅料）：\n${unreadMessages || '暂无未读消息。'}`
      ].join('\n'),
    })
    memoryDatabase.writeDiary(date, diaryText)
    await consolidateDailyBookmarks({ date, bookmarks: source.bookmarks, providerConfig, signal })
    await extractMemories({
      scope: { kind: 'global' },
      providerConfig,
      userText: `当天对话日志：\n${source.conversations.slice(0, 18_000)}\n\n当天 BOOKMARKS：\n${source.bookmarks.slice(0, 6000)}`,
      assistantText: `当天日记：\n${diaryText.slice(0, 6000)}`,
      signal
    })
  } catch {
    memoryDatabase.writeDiary(date, [
      `# ${date} 日记`,
      '',
      '今天的日记没有完全写成。',
      '',
      source.conversations.split(/\r?\n/).filter((line) => line.startsWith('## ')).slice(-12).join('\n\n') || '只剩下一点零散的对话痕迹，还来不及被整理成完整的故事。',
      '',
      unreadMessages ? `窗外还有一些未读的声音：\n\n${unreadMessages}` : '窗外暂时没有新的未读声音。',
      '',
      '## 记忆线索',
      `- 日期：${date}`,
      ...(source.bookmarks ? source.bookmarks.split(/\r?\n/).filter(Boolean).slice(0, 8) : ['- 暂无明确线索。']),
      ''
    ].join('\n'))
    await consolidateDailyBookmarks({ date, bookmarks: source.bookmarks, providerConfig, signal })
  }
}

// ============ L1 自动来源：一轮对话结束后从对话里抽取稳定事实，自动写入 ============

const AUTO_MEMORY_MAX = 5
/** 自动抽取的记忆 confidence 低于主动 remember（默认 1），标记其来源不如用户明说可靠。 */
const AUTO_MEMORY_CONFIDENCE = 0.6
const AUTO_MEMORY_CONFIRMED_CONFIDENCE = 0.8
const AUTO_MEMORY_MIN_USER_CHARS = 6

export interface AutoMemoryResult {
  id: number
  content: string
  kind: 'profile' | 'fact' | 'relationship'
  importance: number
}

/**
 * L1：用一次 LLM 调用从本轮对话抽取「关于用户的稳定事实/偏好」并识别重要事件。
 * 稳定事实写入 items/*.md；重要事件写入 BOOKMARKS.md。失败返回 []（不影响主回答）。
 */
export async function extractMemories(opts: {
  scope: AgentScope
  providerConfig: AgentProviderConfig
  userText: string
  assistantText: string
  signal?: AbortSignal
}): Promise<AutoMemoryResult[]> {
  const { scope, providerConfig, userText, assistantText, signal } = opts
  if (userText.trim().length < AUTO_MEMORY_MIN_USER_CHARS) return []

  try {
    const sessionId = scope.kind === 'session' ? scope.sessionId : null
    const existing = memoryDatabase
      .listMemoryItems({ ...(sessionId ? { sessionId } : {}), limit: 30 })
      .map((m) => m.content)
    const known = existing.length
      ? `\n\n已记过的（不要重复抽取）：\n${existing.map((c) => `- ${c}`).join('\n')}`
      : ''

    const schema = z.object({
      memories: z
        .array(
          z.object({
            content: z.string().describe('一句话写清的稳定长期事实/偏好'),
            kind: z.enum(['profile', 'fact', 'relationship']),
            importance: z.number().min(0).max(1),
            confidence: z.number().min(0).max(1).default(AUTO_MEMORY_CONFIDENCE),
          }),
        )
        .max(AUTO_MEMORY_MAX),
      bookmarks: z.array(z.object({
        event: z.string().describe('值得写入 BOOKMARKS 的一句话便签，格式是“发生了什么。为什么值得记。”'),
        importance: z.number().min(0).max(1).default(0.6),
      })).max(3).default([]),
      taskNote: z.object({
        title: z.string().describe('待办标题，短句'),
        content: z.string().describe('明确未完成的任务、承诺或后续要做的事'),
        importance: z.number().min(0).max(1).default(0.6),
      }).nullable().optional(),
      knowledgeNote: z.object({
        title: z.string().describe('知识笔记标题，短句'),
        content: z.string().describe('可复用的项目/技术/产品信息，不要写用户隐私流水账'),
        importance: z.number().min(0).max(1).default(0.6),
      }).nullable().optional(),
    })
    const object = await generateMemoryObject({
      providerConfig,
      schema,
      signal,
      instructions:
        '你从对话中抽取值得长期记住的稳定信息：用户身份/职业/长期偏好、重要关系、长期事实。' +
        'relationship 用于人与人的长期关系、称谓或角色。只抽用户明确陈述过的，不要推断、不要抽一次性或琐碎信息。' +
        '为每条给 confidence：用户明确说出且长期稳定为 0.8~1，间接或不够确定为 0.5~0.7。没有可抽的就返回空数组。' +
        'BOOKMARKS 是一句话便签，不是结构化字段；如果这一轮出现了值得下次醒来立刻知道的新事实、事件、决策、纠正、承诺或项目节点，给 bookmarks，写成“发生了什么。为什么值得记。”；普通闲聊不要给。' +
        '如果用户明确留下未完成任务、后续承诺、需要继续做的事项，给 taskNote。' +
        '如果出现可复用的项目设计、技术约定、产品决策或实现细节，给 knowledgeNote。两者都要克制，闲聊不要写。',
      prompt: `对话：\n用户：${userText}\n助手：${assistantText}${known}`,
    })

    const out: AutoMemoryResult[] = []
    for (const m of object.memories) {
      const content = m.content.trim()
      if (!content) continue
      const title = content.slice(0, 40)
      const confidence = Math.max(0, Math.min(1, Number(m.confidence || AUTO_MEMORY_CONFIDENCE)))
      const tags = confidence >= AUTO_MEMORY_CONFIRMED_CONFIDENCE ? ['auto'] : ['auto', 'pending']
      const item = memoryDatabase.upsertMemoryItem({
        memoryUid: memoryUid(title, content),
        sourceType: m.kind,
        sessionId: m.kind === 'profile' ? null : sessionId,
        contactId: m.kind === 'profile' ? null : sessionId,
        title,
        content,
        importance: m.importance,
        confidence,
        tags,
      })
      if (!object.bookmarks?.length) memoryDatabase.appendBookmark(`记住新事实：${content.slice(0, 120)}。用于更新用户档案。`)
      invalidateMemoryCache(m.kind === 'profile' ? { kind: 'global' } : scope)
      out.push({ id: item.id, content, kind: m.kind, importance: item.importance })
    }
    let wroteBookmark = false
    for (const bookmark of object.bookmarks || []) {
      if (bookmark?.event && Number(bookmark.importance || 0) >= 0.6) {
        memoryDatabase.appendBookmark(bookmark.event.trim().slice(0, 220))
        wroteBookmark = true
      }
    }
    if (wroteBookmark) invalidateMemoryCache()
    const taskNote = object.taskNote
    if (taskNote?.content && Number(taskNote.importance || 0) >= 0.65) {
      memoryDatabase.writeTaskNote({
        title: taskNote.title,
        content: taskNote.content.slice(0, 3000),
        tags: ['auto', 'agent'],
      })
      invalidateMemoryCache()
    }
    const knowledgeNote = object.knowledgeNote
    if (knowledgeNote?.content && Number(knowledgeNote.importance || 0) >= 0.7) {
      memoryDatabase.writeKnowledgeNote({
        title: knowledgeNote.title,
        content: knowledgeNote.content.slice(0, 4000),
        tags: ['auto', 'agent'],
      })
      invalidateMemoryCache()
    }
    return out
  } catch {
    return []
  }
}
