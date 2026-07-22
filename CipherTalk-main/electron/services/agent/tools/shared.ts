/**
 * Agent 工具共用的小工具：时间单位归一、消息精简、发送者名解析。
 *
 * 单位约定：原微信库 create_time 是「秒」，memory 派生库用「毫秒」。工具对外统一用毫秒，
 * 喂底层时按需换算；锚点 ref 的 createTime 原样透传（chatService 期望秒）。
 */
import type { Message } from '../../chatService'
import type { ChatSearchIndexHit } from '../../search/chatSearchIndexService'
import { truncateText } from '../errorFormat'
import { reportAgentProgress } from '../progress'

/** 归一到毫秒：秒级(<=1e12)自动 ×1000。无效返回 null。 */
export function toMs(value?: number | null): number | null {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return n > 1e12 ? n : n * 1000
}

/** 毫秒 → 秒（喂 chatService 时间范围接口）。容错：误传秒级也按秒。 */
export function msToSeconds(value?: number | null): number | undefined {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.floor(n > 1e12 ? n / 1000 : n)
}

/** 本地时区可读时间 `YYYY-MM-DD HH:mm`（用于标注出处）。 */
export function toLocalTime(value?: number | null): string | null {
  const ms = toMs(value)
  if (ms == null) return null
  const d = new Date(ms)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 批量把 username 解析成显示名（备注/昵称）。失败不致命，返回空映射。 */
export async function resolveSenders(usernames: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const unique = Array.from(new Set(usernames.filter(Boolean)))
  if (unique.length === 0) return out
  try {
    const { resolveContactNames } = await import('../../contactNameResolver')
    const resolved = await resolveContactNames(unique)
    for (const [username, info] of resolved) out.set(username, info.displayName)
  } catch {
    /* 名称解析失败，回退用 username */
  }
  return out
}

export interface CompactMessage {
  time: string | null
  sender: string
  fromMe: boolean
  text: string
  localId: number
  sortSeq: number
  createTime: number
}

/** 把一条消息压成精简、可控大小、带出处字段的结构。 */
export function compactMessage(msg: Message, senderName?: string): CompactMessage {
  const fromMe = msg.isSend === 1
  const sender = fromMe ? '我' : senderName || msg.senderUsername || '未知'
  const text = String(msg.parsedContent || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  return {
    time: toLocalTime(msg.createTime),
    sender,
    fromMe,
    text,
    localId: msg.localId,
    sortSeq: msg.sortSeq,
    createTime: msg.createTime,
  }
}

export interface ChatSearchHit {
  sessionId: string
  time: string | null
  sender: string
  excerpt: string
  anchor: { sessionId: string; localId: number; sortSeq: number; createTime: number }
}

export interface AgentEvidenceItem {
  id: string
  sessionId: string
  localId?: number
  time?: string | null
  sender?: string
  text: string
}

/** 最近活跃的会话 username（只取真人/群，跳过公众号 gh_、聚合/虚拟会话）。检索与向量索引共用。 */
export async function getRecentChatSessions(cap: number): Promise<string[]> {
  const { chatService } = await import('../../chatService')
  const res = await chatService.getSessions(0, cap)
  return (res.success ? res.sessions || [] : [])
    .map((s) => s.username)
    .filter((u) => !!u && !u.startsWith('@') && !u.startsWith('gh_') && u !== 'brandsessionholder')
}

/**
 * 关键词检索原微信聊天原文（基于 chatSearchIndexService 的本地 FTS 索引，按需构建）。
 * 给 sessionId 则只搜该会话；否则遍历最近活跃的若干会话再合并（首次会建索引，稍慢）。
 * memory_items 派生层已被移除，故检索一律走原文索引。
 */
export async function searchChat(opts: {
  query: string
  sessionId?: string
  startTimeMs?: number
  endTimeMs?: number
  limit: number
}): Promise<{ hits: ChatSearchHit[]; sessionsScanned: number; coverage: string }> {
  const RECENT_SESSION_CAP = 20
  const GLOBAL_INDEX_MESSAGE_CAP = 800
  const SESSION_INDEX_MESSAGE_CAP = 5000
  // 单会话命中不足时逐步向更早历史加深（每轮目标×4：5000→2万→8万→32万），扫完或够用即停
  const SESSION_DEEPEN_MAX_ROUNDS = 3
  const { chatSearchIndexService } = await import('../../search/chatSearchIndexService')

  const perSession = Math.max(opts.limit, 10)
  const raw: ChatSearchIndexHit[] = []
  let sessionsScanned = 0

  const indexProgress = (progress: { stage: string; message: string; sessionId?: string; messagesScanned?: number; indexedCount?: number }) => {
    reportAgentProgress({
      stage: progress.stage === 'searching_index' ? 'searching' : 'indexing',
      title: progress.message,
      sessionId: progress.sessionId,
      messagesScanned: progress.messagesScanned,
      indexedCount: progress.indexedCount,
      sessionsScanned,
    })
  }
  const runSearch = (sid: string, maxIndexMessages?: number) =>
    chatSearchIndexService.searchSession({
      sessionId: sid,
      query: opts.query,
      limit: perSession,
      startTimeMs: opts.startTimeMs,
      endTimeMs: opts.endTimeMs,
      maxIndexMessages,
      reusePartialIndex: true,
      onProgress: indexProgress,
    })

  let coverage: string
  if (opts.sessionId) {
    reportAgentProgress({
      stage: 'searching',
      title: '搜索当前会话',
      detail: opts.query,
      sessionsScanned,
      coverage: 'session_partial',
    })
    let r = await runSearch(opts.sessionId, SESSION_INDEX_MESSAGE_CAP)
    sessionsScanned = 1
    for (let round = 0; r.hits.length < opts.limit && !r.indexComplete && round < SESSION_DEEPEN_MAX_ROUNDS; round += 1) {
      reportAgentProgress({
        stage: 'indexing',
        title: `近 ${r.indexedCount} 条内命中不足，向更早的记录扩大搜索`,
        detail: opts.query,
        sessionsScanned,
      })
      try {
        await chatSearchIndexService.deepenSessionIndex(
          opts.sessionId,
          Math.max(r.indexedCount * 4, 20000),
          indexProgress,
        )
      } catch {
        break // 加深失败不影响已有结果
      }
      r = await runSearch(opts.sessionId) // 不带上限：复用刚加深的部分索引
    }
    raw.push(...r.hits)
    coverage = r.indexComplete ? 'session_full' : `session_recent_${r.indexedCount}`
  } else {
    const targetSessions = await getRecentChatSessions(RECENT_SESSION_CAP)
    reportAgentProgress({
      stage: 'searching',
      title: '搜索最近活跃会话',
      detail: opts.query,
      sessionsScanned,
      coverage: `recent_${RECENT_SESSION_CAP}_partial`,
    })
    for (const sid of targetSessions) {
      try {
        const r = await runSearch(sid, GLOBAL_INDEX_MESSAGE_CAP)
        sessionsScanned += 1
        raw.push(...r.hits)
      } catch {
        /* 单会话索引/检索失败则跳过 */
      }
    }
    coverage = `recent_${RECENT_SESSION_CAP}_messages_${GLOBAL_INDEX_MESSAGE_CAP}`
  }

  raw.sort((a, b) => b.score - a.score)
  const top = raw.slice(0, opts.limit)
  const senderMap = await resolveSenders(top.map((h) => h.message.senderUsername || ''))
  const hits: ChatSearchHit[] = top.map((h) => {
    const m = h.message
    const sender = m.isSend === 1 ? '我' : senderMap.get(m.senderUsername || '') || m.senderUsername || '未知'
    return {
      sessionId: h.sessionId,
      time: toLocalTime(m.createTime),
      sender,
      excerpt: String(h.excerpt || m.parsedContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      anchor: { sessionId: h.sessionId, localId: m.localId, sortSeq: m.sortSeq, createTime: m.createTime },
    }
  })
  return { hits, sessionsScanned, coverage }
}

export function evidenceFromHit(hit: ChatSearchHit): AgentEvidenceItem {
  return {
    id: `${hit.sessionId}:${hit.anchor.localId}`,
    sessionId: hit.sessionId,
    localId: hit.anchor.localId,
    time: hit.time,
    sender: hit.sender,
    text: hit.excerpt,
  }
}

export function evidenceFromMessage(sessionId: string, message: CompactMessage): AgentEvidenceItem {
  return {
    id: `${sessionId}:${message.localId}`,
    sessionId,
    localId: message.localId,
    time: message.time,
    sender: message.sender,
    text: message.text,
  }
}

function readableErrorMessage(error: unknown): string {
  if (!error) return ''
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (typeof error === 'string' && error.trim()) return error.trim()
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : null
  const direct = record?.message
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const nested = record?.error
  if (typeof nested === 'string' && nested.trim()) return nested.trim()
  if (nested && typeof nested === 'object') {
    const nestedMessage = (nested as Record<string, unknown>).message
    if (typeof nestedMessage === 'string' && nestedMessage.trim()) return nestedMessage.trim()
  }
  const text = String(error).trim()
  return text && text !== '[object Object]' && text !== 'Error' ? text : ''
}

export function describeToolError(error: unknown, fallback = '工具执行失败'): string {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : null
  const details = [readableErrorMessage(error) || fallback]

  const status = record?.statusCode ?? record?.status
  if (typeof status === 'number') details.push(`status=${status}`)
  if (typeof record?.url === 'string' && record.url) details.push(`url=${record.url}`)
  if (typeof record?.responseBody === 'string' && record.responseBody) {
    details.push(`responseBody=${truncateText(record.responseBody, 600)}`)
  }

  const cause = record?.cause
  const causeMessage = readableErrorMessage(cause)
  if (causeMessage && causeMessage !== details[0]) details.push(`cause=${truncateText(causeMessage, 400)}`)

  return details.filter(Boolean).join(' | ')
}
