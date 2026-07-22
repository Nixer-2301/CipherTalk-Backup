/**
 * 表情包工具 —— search_stickers 按"使用情境"检索聊天里出现过的表情包，send_sticker 把选中的作为当前会话回复附件。
 *
 * 词典从 chat_search_index 的 message_index 聚合（localType=47），不直接碰原微信库。
 * 语义难题与 persona 表情词典同解法：表情是图、模型看不到内容，但发表情前最近一句话
 * 就是这张表情的"使用情境"，把情境和使用次数列出来让模型自己挑（md5 只作元数据）。
 */
import { tool } from 'ai'
import { z } from 'zod'
import * as fs from 'fs'
import * as path from 'path'
import { parseEmojiInfo } from '../../chat/contentParsers'
import { getRecentChatSessions, toLocalTime } from './shared'

const DICT_TTL_MS = 10 * 60 * 1000
const SCAN_ROW_CAP = 20000        // 词典最多扫描的表情消息行数（按时间倒序取最近的）
const DICT_ENTRY_CAP = 400        // 词典保留的表情包数量上限（按使用次数）
const MAX_CONTEXTS = 3            // 每张表情保留的使用情境条数
const CONTEXT_CHAR_CAP = 40       // 情境短句字符上限
const BOOTSTRAP_SESSION_CAP = 10  // 索引为空时，现场补建索引的最近会话数
const BOOTSTRAP_MESSAGE_CAP = 800 // 补建索引时每会话最多纳入的消息条数

interface StickerEntry {
  md5: string
  cdnUrl: string
  productId?: string
  encryptUrl?: string
  aesKey?: string
  count: number
  lastCreateTime: number
  contexts: string[]
}

let dictCache: { entries: StickerEntry[]; builtAt: number } | null = null

function extractAttr(content: string, name: string): string | undefined {
  const match = new RegExp(`${name}\\s*=\\s*['"]([^'"]+)['"]`, 'i').exec(content)
  return match ? match[1].replace(/&amp;/g, '&') : undefined
}

/** 索引里一条表情消息都没有时，给最近活跃会话现场补建索引（与 search_messages 的兜底口径一致）。 */
export async function bootstrapIndexRecentSessions(): Promise<void> {
  const { chatSearchIndexService } = await import('../../search/chatSearchIndexService')
  const sessions = await getRecentChatSessions(BOOTSTRAP_SESSION_CAP)
  for (const sid of sessions) {
    try {
      await chatSearchIndexService.listSessionMemoryMessages(sid, undefined, BOOTSTRAP_MESSAGE_CAP)
    } catch {
      /* 单会话索引失败跳过 */
    }
  }
}

async function buildStickerDict(): Promise<StickerEntry[]> {
  if (dictCache && Date.now() - dictCache.builtAt < DICT_TTL_MS) {
    return dictCache.entries
  }
  const { chatSearchIndexService } = await import('../../search/chatSearchIndexService')

  let rows = chatSearchIndexService.listStickerMessageRows(SCAN_ROW_CAP)
  if (rows.length === 0) {
    await bootstrapIndexRecentSessions()
    rows = chatSearchIndexService.listStickerMessageRows(SCAN_ROW_CAP)
  }

  const byKey = new Map<string, StickerEntry & { anchors: Array<{ sessionId: string; sortSeq: number }> }>()
  for (const row of rows) {
    const info = parseEmojiInfo(row.rawContent)
    const key = info.md5 || info.cdnUrl
    if (!key) continue
    let entry = byKey.get(key)
    if (!entry) {
      entry = {
        md5: info.md5 || '',
        cdnUrl: info.cdnUrl || '',
        productId: info.productId,
        encryptUrl: extractAttr(row.rawContent, 'encrypturl'),
        aesKey: extractAttr(row.rawContent, 'aeskey'),
        count: 0,
        lastCreateTime: row.createTime,
        contexts: [],
        anchors: []
      }
      byKey.set(key, entry)
    }
    entry.count += 1
    if (row.createTime > entry.lastCreateTime) entry.lastCreateTime = row.createTime
    if (entry.anchors.length < MAX_CONTEXTS) {
      entry.anchors.push({ sessionId: row.sessionId, sortSeq: row.sortSeq })
    }
  }

  const top = [...byKey.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, DICT_ENTRY_CAP)

  for (const entry of top) {
    for (const anchor of entry.anchors) {
      const text = chatSearchIndexService.getPrecedingText(anchor.sessionId, anchor.sortSeq)
        .replace(/\s+/g, ' ').trim().slice(0, CONTEXT_CHAR_CAP)
      if (text && !entry.contexts.includes(text)) entry.contexts.push(text)
    }
  }

  const entries: StickerEntry[] = top.map(({ anchors: _anchors, ...rest }) => rest)
  dictCache = { entries, builtAt: Date.now() }
  return entries
}

/** AI 媒体输出目录（与 generate_image 共用 ai-images），返回 null 表示拿不到缓存目录。 */
export async function getAiImageOutputDir(): Promise<string | null> {
  try {
    const { ConfigService } = await import('../../config')
    const cs = new ConfigService()
    try {
      const dir = path.join(cs.getCacheBasePath(), 'ai-images')
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      return dir
    } finally {
      cs.close()
    }
  } catch {
    return null
  }
}

/**
 * 把 data URL 写成磁盘文件（前端经 local-image:// 原样读文件，必须是解码后的纯图片）。
 * 已存在同名文件直接复用。
 */
export async function writeDataUrlToFile(dataUrl: string, baseName: string): Promise<string | null> {
  const match = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(dataUrl)
  if (!match) return null
  const extByMime: Record<string, string> = {
    'image/gif': '.gif',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
  }
  const ext = extByMime[match[1].toLowerCase()] || '.gif'
  const dir = await getAiImageOutputDir()
  if (!dir) return null
  const filePath = path.join(dir, `${baseName}${ext}`)
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, Buffer.from(match[2], 'base64'))
    }
    return filePath
  } catch {
    return null
  }
}

/** 词典里按 md5 找一条（send_sticker 用，避免模型回传长 URL）。 */
async function findStickerByMd5(md5: string): Promise<StickerEntry | undefined> {
  const entries = await buildStickerDict()
  const lower = md5.toLowerCase()
  return entries.find((e) => e.md5.toLowerCase() === lower)
}

export const searchStickers = tool({
  description:
    '检索聊天记录里出现过的表情包。表情包是图片、你看不到内容，但每条结果带"使用情境"' +
    '（聊天里发这张表情前别人说的话）和使用次数，凭情境和次数判断哪张合适。' +
    '想给用户发表情包时先用本工具挑，再用 send_sticker 按 md5 发出。' +
    '不带 query 时返回最常用的表情包。',
  inputSchema: z.object({
    query: z.string().optional().describe('情绪/场景关键词（如 笑 无语 晚安），按使用情境匹配；不传则返回最常用'),
    limit: z.number().int().min(1).max(20).default(10).describe('返回条数上限'),
  }),
  execute: async ({ query, limit }) => {
    try {
      const entries = await buildStickerDict()
      if (entries.length === 0) {
        return { error: '没有找到任何表情包记录（消息索引可能还没建立）' }
      }
      const keywords = String(query || '').split(/\s+/).map((s) => s.trim()).filter(Boolean)
      let picked = entries
      let matched = false
      if (keywords.length > 0) {
        const scored = entries
          .map((e) => {
            const ctx = e.contexts.join(' ')
            const score = keywords.reduce((acc, kw) => acc + (ctx.includes(kw) ? 1 : 0), 0)
            return { e, score }
          })
          .filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score || b.e.count - a.e.count)
        if (scored.length > 0) {
          matched = true
          picked = scored.map((s) => s.e)
        }
      }
      const hits = picked.slice(0, limit).map((e) => ({
        md5: e.md5,
        count: e.count,
        lastUsed: toLocalTime(e.lastCreateTime),
        contexts: e.contexts,
      }))
      return {
        matched: keywords.length === 0 ? undefined : matched,
        note: keywords.length > 0 && !matched ? '没有情境匹配的表情包，已返回最常用的，自行判断是否合适' : undefined,
        hits,
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
})

export const sendSticker = tool({
  description:
    '把一张表情包作为当前会话回复附件。md5 来自 search_stickers 的结果，先检索再发。' +
    '表情包是点缀：只在情绪到位或用户要求时发，一轮最多 1 张。' +
    '不得指定联系人、群或 toUserId；发出后回答里不要再输出 md5、路径或链接。',
  inputSchema: z.object({
    md5: z.string().min(8).describe('表情包 md5（来自 search_stickers 结果）'),
  }),
  execute: async ({ md5 }) => {
    try {
      const entry = await findStickerByMd5(md5)
      const { chatService } = await import('../../chatService')
      const res = await chatService.downloadEmoji(
        entry?.cdnUrl || '',
        md5,
        entry?.productId,
        entry?.lastCreateTime,
        entry?.encryptUrl,
        entry?.aesKey
      )
      if (!res.success || !res.localPath) {
        return { error: res.error || '表情包获取失败' }
      }
      // localPath 是已解码的 data URL；cachePath 可能是微信加密缓存原文件，不能直接给前端
      const filePath = await writeDataUrlToFile(res.localPath, `sticker-${md5.toLowerCase()}`)
      if (!filePath) {
        return { error: '表情包落盘失败' }
      }
      return {
        success: true,
        filePath,
        note: '表情包已准备作为当前会话回复附件，回答里不要再输出路径或链接',
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
})
