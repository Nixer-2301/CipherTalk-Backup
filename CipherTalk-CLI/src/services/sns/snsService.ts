import { dbError } from '../../errors.js'
import { dbAdapter } from '../db/dbAdapter.js'
import { wcdbService } from '../db/wcdbService.js'
import type { RuntimeConfig } from '../../types.js'

export interface MomentsOptions {
  limit?: number
  user?: string
  from?: string
  to?: string
}

export interface MomentsEntry {
  id: string
  author: { wxid: string; displayName: string }
  createTime: number
  contentText: string
  mediaUrls: string[]
  likes: number
  comments: number
  raw: unknown
}

export interface MomentsResult {
  entries: MomentsEntry[]
  total: number
  limit: number
  meta?: {
    nativeSupported: boolean
    note?: string
  }
}

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 200

// 时间字符串/数字 -> Unix 秒时间戳
function normalizeTimestamp(input?: string | number): number | undefined {
  if (input === undefined || input === null || input === '') return undefined
  if (typeof input === 'number') return Math.floor(input > 1e12 ? input / 1000 : input)
  const trimmed = String(input).trim()
  if (!trimmed) return undefined
  if (/^\d+$/.test(trimmed)) {
    const num = Number(trimmed)
    return Math.floor(num > 1e12 ? num / 1000 : num)
  }
  const parsed = Date.parse(trimmed)
  if (Number.isNaN(parsed)) return undefined
  return Math.floor(parsed / 1000)
}

function clampLimit(raw?: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(n), MAX_LIMIT)
}

function unescapeXml(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function extractContentText(xml: string, fallback: string): string {
  if (!xml) return fallback
  const match = xml.match(/<contentDesc(?:\s+[^>]*)?>([\s\S]*?)<\/contentDesc>/i)
  if (match) return unescapeXml(match[1]).trim()
  return fallback
}

function extractCreateTime(xml: string, fallback: number): number {
  if (fallback > 0) return fallback
  const match = xml.match(/<createTime>(\d+)<\/createTime>/i)
  if (match) return Number(match[1])
  return 0
}

function extractSnsId(xml: string, fallback: string): string {
  const match = xml.match(/<id>(\d+)<\/id>/i)
  if (match) return match[1]
  return fallback
}

function extractMediaUrls(xml: string): string[] {
  if (!xml) return []
  const urls: string[] = []
  // 朋友圈媒体 url 通常在 <url type="2" ...>HTTP...</url>
  const urlRegex = /<url[^>]*>([\s\S]*?)<\/url>/gi
  let match: RegExpExecArray | null
  while ((match = urlRegex.exec(xml)) !== null) {
    const raw = unescapeXml(match[1]).trim()
    if (raw && /^https?:\/\//i.test(raw)) {
      urls.push(raw)
    }
  }
  return urls
}

function countTags(xml: string, tag: string): number {
  if (!xml) return 0
  // 计算 <tag ...> 出现次数（自闭合或开标签）
  const regex = new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi')
  const matches = xml.match(regex)
  return matches ? matches.length : 0
}

function extractLikesCount(xml: string, fallback: number): number {
  if (fallback > 0) return fallback
  // 朋友圈点赞在 <LikeUserList> 节点下，每个 <name>xx</name>
  const block = xml.match(/<LikeUserList>([\s\S]*?)<\/LikeUserList>/i)
  if (block) {
    const m = block[1].match(/<name[^>]*>/gi)
    if (m) return m.length
  }
  return 0
}

function extractCommentsCount(xml: string, fallback: number): number {
  if (fallback > 0) return fallback
  // 朋友圈评论结构通常嵌在 <CommentUserList> 或 <commentUserList>，
  // 每条评论是一个 <CommentItem> 或 <commentItem>
  const block = xml.match(/<CommentUserList>([\s\S]*?)<\/CommentUserList>/i)
    || xml.match(/<commentUserList>([\s\S]*?)<\/commentUserList>/i)
  if (block) {
    return countTags(block[1], 'CommentItem') || countTags(block[1], 'commentItem') || 0
  }
  return 0
}

async function buildDisplayNameMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  try {
    const rows = await dbAdapter.all<{ username: string; nickname?: string; remark?: string }>(
      'session', '',
      'SELECT username, nickname, remark FROM SessionTable'
    )
    for (const row of rows) {
      const username = row.username || ''
      const name = row.remark || row.nickname || username
      if (username) map.set(username, name)
    }
  } catch { /* SessionTable 不可用时静默 */ }
  return map
}

function normalizeRow(row: any, displayNames: Map<string, string>): MomentsEntry {
  const xml = String(row?.rawXml || row?.content || row?.xml || '')
  const username = String(row?.username || row?.user_name || row?.userName || '')
  const fallbackCreateTime = Number(row?.createTime || row?.create_time || 0)
  const createTime = extractCreateTime(xml, fallbackCreateTime)
  const fallbackId = String(row?.id || row?.snsId || row?.sns_id || row?.tid || '')
  const id = extractSnsId(xml, fallbackId)
  const contentText = extractContentText(xml, String(row?.contentDesc || row?.content_desc || ''))
  const nativeMedia = Array.isArray(row?.media) ? row.media : []
  const mediaUrls = nativeMedia.length > 0
    ? nativeMedia.map((m: any) => String(m?.url || m?.thumb || '')).filter(Boolean)
    : extractMediaUrls(xml)
  const likesFallback = Array.isArray(row?.likes) ? row.likes.length : 0
  const commentsFallback = Array.isArray(row?.comments) ? row.comments.length : 0
  const likes = likesFallback || extractLikesCount(xml, 0)
  const comments = commentsFallback || extractCommentsCount(xml, 0)
  return {
    id,
    author: {
      wxid: username,
      displayName: displayNames.get(username) || String(row?.nickname || username || '')
    },
    createTime,
    contentText,
    mediaUrls,
    likes,
    comments,
    raw: row
  }
}

async function connect(config: RuntimeConfig): Promise<void> {
  if (!config.dbPath) throw new Error('使用 --db-path 或 miyu init 设置微信数据目录')
  if (!config.keyHex) throw new Error('使用 --key 或 miyu key set 设置数据库密钥')
  const ok = await wcdbService.open(config.dbPath, config.keyHex, config.wxid || '')
  if (!ok) throw dbError('数据库连接失败，请检查 dbPath / keyHex / wxid')
}

/**
 * 朋友圈时间线查询。
 *
 * 依赖 wcdbCore 暴露的 `wcdb_get_sns_timeline` 原生符号；
 * 如果当前 native 未实现 SNS 支持（success=false 且错误信息含 "not" / "未支持" / "未初始化"），
 * 我们将返回空 timeline + meta.note，调用方不应崩溃。
 */
export async function getMomentsTimeline(
  config: RuntimeConfig,
  options: MomentsOptions = {}
): Promise<MomentsResult> {
  const limit = clampLimit(options.limit)
  const usernames = options.user ? [options.user] : undefined
  const startTime = normalizeTimestamp(options.from)
  const endTime = normalizeTimestamp(options.to)

  await connect(config)

  let nativeResult: { success: boolean; timeline?: any[]; error?: string }
  try {
    nativeResult = await wcdbService.getSnsTimeline(limit, 0, usernames, undefined, startTime, endTime)
  } catch (e: any) {
    return {
      entries: [],
      total: 0,
      limit,
      meta: {
        nativeSupported: false,
        note: `朋友圈原生接口调用失败：${e?.message || String(e)}`
      }
    }
  }

  if (!nativeResult.success) {
    const errorMessage = nativeResult.error || '未知错误'
    const looksUnsupported = /未支持|not\s*support|未初始化|尚未/.test(errorMessage)
    if (looksUnsupported) {
      return {
        entries: [],
        total: 0,
        limit,
        meta: {
          nativeSupported: false,
          note: `当前 native 库不支持朋友圈查询：${errorMessage}`
        }
      }
    }
    throw dbError(`朋友圈查询失败：${errorMessage}`)
  }

  const rawRows = Array.isArray(nativeResult.timeline)
    ? nativeResult.timeline
    : Array.isArray((nativeResult.timeline as any)?.timeline)
      ? (nativeResult.timeline as any).timeline
      : Array.isArray((nativeResult.timeline as any)?.items)
        ? (nativeResult.timeline as any).items
        : []

  const displayNames = await buildDisplayNameMap()
  const entries = rawRows.map((row: any) => normalizeRow(row, displayNames))

  return {
    entries,
    total: entries.length,
    limit,
    meta: { nativeSupported: true }
  }
}
