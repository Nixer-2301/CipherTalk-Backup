/**
 * 历史媒体工具 —— 检索聊天/朋友圈里的图片与表情，按需解密落盘，并可交给当前模型做视觉理解。
 */
import { generateText, tool, type ModelMessage } from 'ai'
import { z } from 'zod'
import * as fs from 'fs'
import * as path from 'path'
import { detectImageExtension } from '../../chat/emoji'
import { parseEmojiInfo, parseImageInfo } from '../../chat/contentParsers'
import type { ChatSearchMediaKind, ChatSearchMediaMessageRow } from '../../search/chatSearchIndexService'
import type { SnsCommentEmoji, SnsCommentImage, SnsMedia, SnsPost } from '../../snsService'
import { getProviderDefinition } from '../../ai/providers/catalog'
import { createLanguageModel } from '../provider'
import type { AgentProviderConfig, AgentUploadedMediaContext } from '../types'
import { msToSeconds, resolveSenders, toLocalTime } from './shared'
import { reportAgentProgress } from '../progress'
import { bootstrapIndexRecentSessions, getAiImageOutputDir, writeDataUrlToFile } from './stickers'
import {
  detectImageMime as detectSharedImageMime,
  resolveMediaIdToFile as resolveSharedMediaIdToFile,
  stripFileProtocol as stripSharedFileProtocol,
} from '../../media/mediaResolver'

type ChatMediaIdPayload = {
  source: 'chat'
  kind: ChatSearchMediaKind
  sessionId: string
  localId: number
  createTime: number
}

type MomentMediaTarget = 'post' | 'comment_image' | 'comment_emoji'

type MomentMediaIdPayload = {
  source: 'moment'
  kind: ChatSearchMediaKind
  target: MomentMediaTarget
  postId: string
  username: string
  nickname?: string
  createTime: number
  content?: string
  mediaIndex: number
  commentId?: string
  commentNickname?: string
  url?: string
  thumb?: string
  key?: string | number
  thumbKey?: string | number
  md5?: string
  encryptUrl?: string
  aesKey?: string
}

type MediaIdPayload = ChatMediaIdPayload | MomentMediaIdPayload

type ResolvedMediaFile = {
  success: true
  filePath: string
  kind: 'image'
  mediaKind: ChatSearchMediaKind
  source: 'chat' | 'moment'
  from: string
  sender?: string
  time?: string | null
  postId?: string
  content?: string
}

type ResolveMediaResult = ResolvedMediaFile | {
  success: false
  error: string
  filePath?: string
  source?: 'chat' | 'moment'
  mediaKind?: ChatSearchMediaKind
  from?: string
  sender?: string
  time?: string | null
}

const MAX_VISION_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_MOMENT_FETCH_LIMIT = 200

function safeFileSegment(value: string): string {
  return String(value || 'media').replace(/[^a-zA-Z0-9_@.-]/g, '_').slice(0, 80) || 'media'
}

function optionalString(value: unknown): string | undefined {
  const text = String(value || '').trim()
  return text || undefined
}

function optionalKey(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const text = optionalString(value)
  return text
}

function encodeMediaId(payload: MediaIdPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function decodeMediaId(value: string): MediaIdPayload | null {
  try {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Partial<MediaIdPayload>
    const kind = parsed.kind === 'emoji' ? 'emoji' : parsed.kind === 'image' ? 'image' : null
    if (!kind) return null

    if (parsed.source === 'moment') {
      const target = parsed.target === 'post' || parsed.target === 'comment_image' || parsed.target === 'comment_emoji'
        ? parsed.target
        : null
      const postId = optionalString(parsed.postId)
      const username = optionalString(parsed.username)
      const createTime = Number(parsed.createTime || 0)
      const mediaIndex = Number(parsed.mediaIndex || 0)
      const url = optionalString(parsed.url)
      const thumb = optionalString(parsed.thumb)
      const encryptUrl = optionalString(parsed.encryptUrl)
      if (!target || !postId || !username || !Number.isFinite(mediaIndex)) return null
      if (target === 'comment_emoji' && !url && !encryptUrl) return null
      if (target !== 'comment_emoji' && !url && !thumb) return null
      return {
        source: 'moment',
        kind,
        target,
        postId,
        username,
        nickname: optionalString(parsed.nickname),
        createTime,
        content: optionalString(parsed.content),
        mediaIndex,
        commentId: optionalString(parsed.commentId),
        commentNickname: optionalString(parsed.commentNickname),
        url,
        thumb,
        key: optionalKey(parsed.key),
        thumbKey: optionalKey(parsed.thumbKey),
        md5: optionalString(parsed.md5),
        encryptUrl,
        aesKey: optionalString(parsed.aesKey),
      }
    }

    // 兼容旧版没有 source 字段的聊天 mediaId。
    const sessionId = optionalString(parsed.sessionId)
    const localId = Number(parsed.localId)
    const createTime = Number(parsed.createTime || 0)
    if (!sessionId || !Number.isFinite(localId) || localId <= 0) return null
    return { source: 'chat', kind, sessionId, localId, createTime }
  } catch {
    return null
  }
}

function extractAttr(content: string, name: string): string | undefined {
  const match = new RegExp(`${name}\\s*=\\s*['"]([^'"]+)['"]`, 'i').exec(content)
  return match ? match[1].replace(/&amp;/g, '&') : undefined
}

function mediaKindFromRow(row: ChatSearchMediaMessageRow): ChatSearchMediaKind {
  return Number(row.localType) === 47 ? 'emoji' : 'image'
}

function mediaLabel(kind: ChatSearchMediaKind): string {
  return kind === 'emoji' ? '表情包' : '图片'
}

function normalizeQuery(value: string): string[] {
  return String(value || '')
    .toLowerCase()
    .replace(/[，。！？；：、“”‘’（）()[\]{}<>《》|\\/+=*_~`#$%^&-]+/g, ' ')
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 8)
}

function compactMomentText(value: string | undefined, limit = 160): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

function stripFileProtocol(value: string): string {
  const text = String(value || '').trim()
  if (!text.startsWith('file:')) return text
  try {
    const parsed = new URL(text)
    const pathname = decodeURIComponent(parsed.pathname)
    return process.platform === 'win32' && pathname.startsWith('/') ? pathname.slice(1) : pathname
  } catch {
    return text.replace(/^file:\/+/, '')
  }
}

function detectImageMime(buffer: Buffer): string | null {
  const ext = detectImageExtension(buffer)
  if (ext === '.jpg') return 'image/jpeg'
  if (ext === '.png') return 'image/png'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  return null
}

function imageDataUrlToBuffer(dataUrl: string): { buffer: Buffer; mediaType: string } | null {
  const match = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(String(dataUrl || ''))
  if (!match) return null
  try {
    return { mediaType: match[1].toLowerCase(), buffer: Buffer.from(match[2], 'base64') }
  } catch {
    return null
  }
}

function formatMediaVectorHit(hit: import('../../search/messageVectorService').MediaVectorHit, matchedBy: 'vector' | 'both' = 'vector') {
  return {
    mediaId: hit.mediaId,
    source: hit.source,
    kind: hit.mediaKind,
    mediaKind: hit.mediaKind,
    label: mediaLabel(hit.mediaKind),
    time: hit.timeText || toLocalTime(hit.time),
    from: hit.from,
    sender: hit.sender,
    context: hit.context,
    score: Number(hit.score.toFixed(4)),
    matchedBy,
    localPath: hit.filePath,
    postId: hit.postId,
  }
}

async function resolveImageToFile(sessionId: string, localId: number, createTime: number): Promise<string | null> {
  const { chatService } = await import('../../chatService')
  const res = await chatService.getImageData(sessionId, String(localId), createTime)
  if (!res.success || !res.data) return null
  const buffer = Buffer.from(res.data, 'base64')
  const ext = detectImageExtension(buffer) || '.jpg'
  const dir = await getAiImageOutputDir()
  if (!dir) return null
  const filePath = path.join(dir, `history-${safeFileSegment(sessionId)}-${localId}${ext}`)
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, buffer)
  }
  return filePath
}

async function resolveEmojiToFile(rawContent: string, localId: number, createTime: number): Promise<string | null> {
  const info = parseEmojiInfo(rawContent)
  const md5 = info.md5 || ''
  const { chatService } = await import('../../chatService')
  const res = await chatService.downloadEmoji(
    info.cdnUrl || '',
    md5,
    info.productId,
    createTime,
    extractAttr(rawContent, 'encrypturl'),
    extractAttr(rawContent, 'aeskey')
  )
  if (!res.success || !res.localPath) return null
  return writeDataUrlToFile(res.localPath, `history-emoji-${safeFileSegment(md5 || String(localId))}`)
}

async function resolveRowToFile(row: ChatSearchMediaMessageRow): Promise<string | null> {
  const kind = mediaKindFromRow(row)
  return kind === 'emoji'
    ? resolveEmojiToFile(row.rawContent, row.localId, row.createTime)
    : resolveImageToFile(row.sessionId, row.localId, row.createTime)
}

async function resolveChatPayloadToFile(payload: ChatMediaIdPayload): Promise<ResolveMediaResult> {
  const { chatService } = await import('../../chatService')
  const msgResult = await chatService.getMessageByLocalId(payload.sessionId, payload.localId)
  if (!msgResult.success || !msgResult.message) return { success: false, error: '未找到这条媒体消息' }

  const message = msgResult.message
  const createTime = payload.createTime || Number(message.createTime || 0)
  const filePath = payload.kind === 'emoji'
    ? await resolveEmojiToFile(String(message.rawContent || ''), payload.localId, createTime)
    : await resolveImageToFile(payload.sessionId, payload.localId, createTime)
  if (!filePath) return { success: false, error: `${mediaLabel(payload.kind)}解密或落盘失败` }

  const names = await resolveSenders([payload.sessionId, message.senderUsername || ''])
  return {
    success: true,
    filePath,
    kind: 'image',
    mediaKind: payload.kind,
    source: 'chat',
    from: names.get(payload.sessionId) || payload.sessionId,
    sender: message.isSend === 1
      ? '我'
      : names.get(message.senderUsername || '') || message.senderUsername || undefined,
    time: toLocalTime(createTime),
  }
}

async function resolveProxyResultToFile(
  result: { success: boolean; localPath?: string; dataUrl?: string; videoPath?: string; error?: string },
  baseName: string,
): Promise<string | null> {
  if (!result.success || result.videoPath) return null
  if (result.localPath) return stripFileProtocol(result.localPath)
  if (result.dataUrl) return writeDataUrlToFile(result.dataUrl, baseName)
  return null
}

async function resolveMomentImageToFile(payload: MomentMediaIdPayload): Promise<string | null> {
  const { snsService } = await import('../../snsService')
  const attempts = [
    { url: payload.url, key: payload.key, suffix: 'full' },
    { url: payload.thumb, key: payload.thumbKey || payload.key, suffix: 'thumb' },
  ].filter((item, index, arr) => item.url && arr.findIndex((candidate) => candidate.url === item.url) === index)

  for (const item of attempts) {
    const result = await snsService.proxyImage(item.url || '', item.key, payload.md5)
    const filePath = await resolveProxyResultToFile(
      result,
      `moment-${safeFileSegment(payload.postId)}-${payload.target}-${payload.mediaIndex}-${item.suffix}`,
    )
    if (filePath) return filePath
  }
  return null
}

async function resolveMomentEmojiToFile(payload: MomentMediaIdPayload): Promise<string | null> {
  const { snsService } = await import('../../snsService')
  const res = await snsService.downloadSnsEmoji(payload.url || '', payload.encryptUrl, payload.aesKey)
  return res.success && res.localPath ? stripFileProtocol(res.localPath) : null
}

async function resolveMomentPayloadToFile(payload: MomentMediaIdPayload): Promise<ResolveMediaResult> {
  const filePath = payload.kind === 'emoji'
    ? await resolveMomentEmojiToFile(payload)
    : await resolveMomentImageToFile(payload)
  if (!filePath) {
    return {
      success: false,
      error: payload.kind === 'emoji' ? '朋友圈评论表情包下载或解密失败' : '朋友圈图片下载或解密失败',
      source: 'moment',
      mediaKind: payload.kind,
      from: payload.nickname || payload.username,
      sender: payload.commentNickname,
      time: toLocalTime(payload.createTime),
    }
  }
  return {
    success: true,
    filePath,
    kind: 'image',
    mediaKind: payload.kind,
    source: 'moment',
    from: payload.nickname || payload.username,
    sender: payload.commentNickname,
    time: toLocalTime(payload.createTime),
    postId: payload.postId,
    content: payload.content,
  }
}

async function resolveMediaIdToFile(mediaId: string): Promise<ResolveMediaResult> {
  const payload = decodeMediaId(mediaId)
  if (!payload) return { success: false, error: 'mediaId 无效' }
  return payload.source === 'moment'
    ? resolveMomentPayloadToFile(payload)
    : resolveChatPayloadToFile(payload)
}

async function listRowsWithBootstrap(options: {
  sessionId?: string
  kinds?: ChatSearchMediaKind[]
  startTimeMs?: number
  endTimeMs?: number
  direction?: 'in' | 'out'
  limit: number
}): Promise<ChatSearchMediaMessageRow[]> {
  const { chatSearchIndexService } = await import('../../search/chatSearchIndexService')
  let rows = chatSearchIndexService.listMediaMessageRows(options)
  if (rows.length > 0) return rows

  if (options.sessionId) {
    await chatSearchIndexService.listSessionMemoryMessages(options.sessionId, undefined, 5000)
  } else {
    await bootstrapIndexRecentSessions()
  }
  rows = chatSearchIndexService.listMediaMessageRows(options)
  return rows
}

function buildMomentPayloadBase(post: SnsPost): Pick<MomentMediaIdPayload, 'source' | 'postId' | 'username' | 'nickname' | 'createTime' | 'content'> {
  return {
    source: 'moment',
    postId: post.id,
    username: post.username,
    nickname: post.nickname || post.username,
    createTime: post.createTime,
    content: compactMomentText(post.contentDesc),
  }
}

function momentImagePayload(post: SnsPost, media: SnsMedia, mediaIndex: number): MomentMediaIdPayload {
  return {
    ...buildMomentPayloadBase(post),
    kind: 'image',
    target: 'post',
    mediaIndex,
    url: media.url || undefined,
    thumb: media.thumb || undefined,
    key: media.key,
    thumbKey: media.thumbKey,
    md5: media.md5,
  }
}

function commentImagePayload(post: SnsPost, image: SnsCommentImage, commentId: string, commentNickname: string, mediaIndex: number): MomentMediaIdPayload {
  return {
    ...buildMomentPayloadBase(post),
    kind: 'image',
    target: 'comment_image',
    mediaIndex,
    commentId,
    commentNickname,
    url: image.url || undefined,
    thumb: image.thumbUrl || undefined,
    key: image.key,
    thumbKey: image.thumbKey,
    md5: image.md5 || image.mediaId,
  }
}

function commentEmojiPayload(post: SnsPost, emoji: SnsCommentEmoji, commentId: string, commentNickname: string, mediaIndex: number): MomentMediaIdPayload {
  return {
    ...buildMomentPayloadBase(post),
    kind: 'emoji',
    target: 'comment_emoji',
    mediaIndex,
    commentId,
    commentNickname,
    url: emoji.url || undefined,
    md5: emoji.md5,
    encryptUrl: emoji.encryptUrl,
    aesKey: emoji.aesKey,
  }
}

function momentHitFromPayload(payload: MomentMediaIdPayload, extra: { commentContent?: string } = {}) {
  return {
    mediaId: encodeMediaId(payload),
    source: 'moment',
    kind: payload.kind,
    mediaKind: payload.kind,
    target: payload.target,
    author: payload.nickname || payload.username,
    from: payload.nickname || payload.username,
    sender: payload.commentNickname,
    time: toLocalTime(payload.createTime),
    content: extra.commentContent
      ? compactMomentText(extra.commentContent)
      : payload.content || undefined,
    postId: payload.postId,
    mediaIndex: payload.mediaIndex,
    commentId: payload.commentId,
  }
}

function momentHitScore(hit: ReturnType<typeof momentHitFromPayload>, terms: string[]): number {
  if (terms.length === 0) return 1
  const haystack = [
    hit.kind,
    hit.target,
    hit.author,
    hit.sender,
    hit.content,
    hit.postId,
    hit.commentId,
  ].join(' ').toLowerCase()
  return terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0)
}

export const searchMedia = tool({
  description:
    '检索本地聊天记录里已索引的图片/表情包，按会话、时间、方向、类型和前文语境筛选。' +
    'query 存在且图片向量化已开启时，只搜索已经建立好的历史图片向量，不会现场向量化历史图片。' +
    '结果里的 mediaId 可传给 inspect_media_image 做视觉理解，或传给 send_media_from_history 展示/回复。',
  inputSchema: z.object({
    query: z.string().optional().describe('按前文语境/文本线索筛选，如 晚安、笑、截图、照片；不填则按时间返回最近媒体'),
    kind: z.enum(['all', 'image', 'emoji']).default('all').describe('媒体类型'),
    sessionId: z.string().optional().describe('限定某会话/群 username；不填则从已索引最近会话里找'),
    startTimeMs: z.number().optional().describe('起始时间，毫秒时间戳'),
    endTimeMs: z.number().optional().describe('结束时间，毫秒时间戳'),
    direction: z.enum(['in', 'out']).optional().describe('in=别人发的，out=我发的'),
    limit: z.number().int().min(1).max(20).default(8).describe('返回条数上限'),
    includeLocalPaths: z.boolean().default(false).describe('是否尝试解析本地图片路径；会更慢，通常只在需要预览候选时打开'),
  }),
  execute: async ({ query, kind, sessionId, startTimeMs, endTimeMs, direction, limit, includeLocalPaths }) => {
    try {
      const kinds: ChatSearchMediaKind[] = kind === 'all' ? ['image', 'emoji'] : [kind]
      const rows = await listRowsWithBootstrap({
        sessionId,
        kinds,
        startTimeMs,
        endTimeMs,
        direction,
        limit: Math.max(limit * 4, limit),
      })

      const terms = normalizeQuery(query || '')
      const { chatSearchIndexService } = await import('../../search/chatSearchIndexService')
      const withContext = rows.map((row) => {
        const rowKind = mediaKindFromRow(row)
        const context = chatSearchIndexService.getPrecedingText(row.sessionId, row.sortSeq)
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120)
        const imageInfo = rowKind === 'image' ? parseImageInfo(row.rawContent) : {}
        const emojiInfo = rowKind === 'emoji' ? parseEmojiInfo(row.rawContent) : {}
        const haystack = [
          mediaLabel(rowKind),
          context,
          row.parsedContent,
          imageInfo.md5,
          emojiInfo.md5,
          emojiInfo.productId
        ].join(' ').toLowerCase()
        const score = terms.length === 0
          ? 1
          : terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0)
        return { row, kind: rowKind, context, imageInfo, emojiInfo, score }
      })

      const matched = terms.length === 0 ? undefined : withContext.some((item) => item.score > 0)
      const picked = (terms.length > 0 ? withContext.filter((item) => item.score > 0) : withContext)
        .sort((a, b) => b.score - a.score || b.row.sortSeq - a.row.sortSeq || b.row.createTime - a.row.createTime)
        .slice(0, limit)

      const names = await resolveSenders(
        picked.flatMap((item) => [item.row.sessionId, item.row.senderUsername || ''])
      )
      const hits = []
      for (const item of picked) {
        const localPath = includeLocalPaths ? await resolveRowToFile(item.row) : null
        hits.push({
          mediaId: encodeMediaId({
            source: 'chat',
            kind: item.kind,
            sessionId: item.row.sessionId,
            localId: item.row.localId,
            createTime: item.row.createTime,
          }),
          source: 'chat',
          kind: item.kind,
          mediaKind: item.kind,
          label: mediaLabel(item.kind),
          time: toLocalTime(item.row.createTime),
          from: names.get(item.row.sessionId) || item.row.sessionId,
          sender: item.row.isSend === 1
            ? '我'
            : names.get(item.row.senderUsername || '') || item.row.senderUsername || undefined,
          context: item.context || undefined,
          md5: item.kind === 'image' ? item.imageInfo.md5 : item.emojiInfo.md5,
          localPath: localPath || undefined,
          matchedBy: 'keyword',
        })
      }

      let vectorHits: ReturnType<typeof formatMediaVectorHit>[] = []
      if (String(query || '').trim()) {
        try {
          const { getEmbeddingConfig } = await import('../../ai/embeddingService')
          const { messageVectorService, embedQuery } = await import('../../search/messageVectorService')
          const cfg = getEmbeddingConfig()
          if (messageVectorService.isMediaReady(cfg)) {
            reportAgentProgress({
              stage: 'searching',
              title: '搜索已有历史图片向量',
              detail: query,
              sessionId,
            })
            const queryVec = await embedQuery(String(query), cfg)
            vectorHits = messageVectorService
              .searchMediaVectors(queryVec, { source: 'chat', sessionId, limit })
              .map((hit) => formatMediaVectorHit(hit))
          }
        } catch (error) {
          if (hits.length === 0) {
            return {
              error: `图片向量检索失败：${error instanceof Error ? error.message : String(error)}`,
              note: '如果当前嵌入模型支持图片向量化，请在设置 → 嵌入中开启“图片向量化”。',
              hits,
            }
          }
        }
      }

      const seen = new Set<string>()
      const mergedHits = [...vectorHits, ...hits]
        .map((hit) => {
          if (vectorHits.some((item) => item.mediaId === hit.mediaId) && hits.some((item) => item.mediaId === hit.mediaId)) {
            return { ...hit, matchedBy: 'both' }
          }
          return hit
        })
        .filter((hit) => {
          if (seen.has(hit.mediaId)) return false
          seen.add(hit.mediaId)
          return true
        })
        .slice(0, limit)

      return {
        matched: vectorHits.length > 0 ? true : matched,
        retrieval: vectorHits.length > 0 ? 'media_vector' : 'keyword',
        note: terms.length > 0 && matched === false
          ? '没有匹配语境的媒体；图片向量检索只使用已建立的媒体向量，不会现场向量化历史图片。'
          : undefined,
        hits: mergedHits,
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
})

export const searchMomentMedia = tool({
  description:
    '检索朋友圈里的正文图片、评论图片和评论表情包，返回统一 mediaId。' +
    '适合“某人朋友圈第一张图是什么 / 某条朋友圈图片 / 评论里的图或表情”。' +
    'keyword 存在且图片向量化已开启时，只搜索已经建立好的朋友圈图片向量，不会现场向量化历史图片。' +
    '用户说“朋友圈第一张图片”时默认 order=latest、target=post、limit=1，即最新含图朋友圈的第 1 张图。',
  inputSchema: z.object({
    usernames: z.array(z.string()).optional().describe('朋友圈发布者 username，可传多个；先用 list_contacts 解析联系人'),
    keyword: z.string().optional().describe('朋友圈正文/XML/评论关键词'),
    startTimeMs: z.number().optional().describe('起始时间，毫秒时间戳'),
    endTimeMs: z.number().optional().describe('结束时间，毫秒时间戳'),
    order: z.enum(['latest', 'oldest']).default('latest').describe('latest=从最新朋友圈开始，oldest=从最早朋友圈开始'),
    target: z.enum(['post', 'comment', 'all']).default('post').describe('post=正文图片，comment=评论图片/评论表情，all=全部'),
    limit: z.number().int().min(1).max(20).default(8).describe('返回媒体条数上限'),
  }),
  execute: async ({ usernames, keyword, startTimeMs, endTimeMs, order, target, limit }) => {
    try {
      reportAgentProgress({
        stage: 'searching',
        title: '搜索朋友圈媒体',
        detail: keyword || (usernames?.length ? usernames.join(', ') : '最近朋友圈'),
      })

      const { snsService, isVideoUrl } = await import('../../snsService')
      const fetchLimit = Math.min(MAX_MOMENT_FETCH_LIMIT, Math.max(limit * 10, 80))
      const result = await snsService.getTimeline(
        fetchLimit,
        0,
        usernames,
        keyword,
        msToSeconds(startTimeMs),
        msToSeconds(endTimeMs),
      )
      if (!result.success) return { error: result.error || '查询朋友圈失败' }

      const posts = (result.timeline || [])
        .slice()
        .sort((a, b) => order === 'oldest' ? a.createTime - b.createTime : b.createTime - a.createTime)
      const terms = normalizeQuery(keyword || '')
      const allHits: Array<ReturnType<typeof momentHitFromPayload> & { score: number }> = []
      let skippedVideos = 0

      for (const post of posts) {
        if (target !== 'comment') {
          for (let index = 0; index < (post.media || []).length; index += 1) {
            const media = post.media[index]
            if (!media?.url && !media?.thumb) continue
            if (isVideoUrl(media.url || media.thumb || '')) {
              skippedVideos += 1
              continue
            }
            const hit = momentHitFromPayload(momentImagePayload(post, media, index))
            const score = momentHitScore(hit, terms)
            if (terms.length === 0 || score > 0) allHits.push({ ...hit, score })
          }
        }

        if (target !== 'post') {
          for (const comment of post.comments || []) {
            const commentContent = comment.content || ''
            for (let index = 0; index < (comment.images || []).length; index += 1) {
              const image = comment.images?.[index]
              if (!image?.url && !image?.thumbUrl) continue
              const hit = momentHitFromPayload(
                commentImagePayload(post, image, comment.id, comment.nickname, index),
                { commentContent },
              )
              const score = momentHitScore(hit, terms)
              if (terms.length === 0 || score > 0) allHits.push({ ...hit, score })
            }
            for (let index = 0; index < (comment.emojis || []).length; index += 1) {
              const emoji = comment.emojis?.[index]
              if (!emoji?.url && !emoji?.encryptUrl) continue
              const hit = momentHitFromPayload(
                commentEmojiPayload(post, emoji, comment.id, comment.nickname, index),
                { commentContent },
              )
              const score = momentHitScore(hit, terms)
              if (terms.length === 0 || score > 0) allHits.push({ ...hit, score })
            }
          }
        }
      }

      const hits = allHits
        .sort((a, b) => b.score - a.score || (order === 'oldest'
          ? Number(new Date(a.time || 0)) - Number(new Date(b.time || 0))
          : Number(new Date(b.time || 0)) - Number(new Date(a.time || 0))))
        .slice(0, limit)
        .map(({ score: _score, ...hit }) => hit)

      let vectorHits: ReturnType<typeof formatMediaVectorHit>[] = []
      if (String(keyword || '').trim()) {
        try {
          const { getEmbeddingConfig } = await import('../../ai/embeddingService')
          const { messageVectorService, embedQuery } = await import('../../search/messageVectorService')
          const cfg = getEmbeddingConfig()
          if (messageVectorService.isMediaReady(cfg)) {
            reportAgentProgress({
              stage: 'searching',
              title: '搜索已有朋友圈图片向量',
              detail: keyword,
            })
            const queryVec = await embedQuery(String(keyword), cfg)
            vectorHits = messageVectorService
              .searchMediaVectors(queryVec, { source: 'moment', usernames, limit })
              .map((hit) => formatMediaVectorHit(hit))
          }
        } catch {
          /* 朋友圈图片向量失败时保留普通媒体检索结果 */
        }
      }

      const seen = new Set<string>()
      const mergedHits = [...vectorHits, ...hits]
        .map((hit) => {
          if (vectorHits.some((item) => item.mediaId === hit.mediaId) && hits.some((item) => item.mediaId === hit.mediaId)) {
            return { ...hit, matchedBy: 'both' }
          }
          return hit
        })
        .filter((hit) => {
          if (seen.has(hit.mediaId)) return false
          seen.add(hit.mediaId)
          return true
        })
        .slice(0, limit)

      return {
        scope: usernames?.length ? 'users' : 'all',
        order,
        target,
        retrieval: vectorHits.length > 0 ? 'media_vector' : 'metadata',
        hits: mergedHits,
        note: mergedHits.length === 0
          ? (skippedVideos > 0 ? '只找到视频/LivePhoto，暂不支持视频帧识别。' : '没有找到可用的朋友圈图片或表情包。')
          : undefined,
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
})

export const sendMediaFromHistory = tool({
  description:
    '把 search_media 或 search_moment_media 返回的一张历史图片/表情包作为当前回复图片展示或回复附件。' +
    '只在用户明确要看/发/抽取历史图片或表情包时使用；发出后不要输出路径。',
  inputSchema: z.object({
    mediaId: z.string().min(8).describe('来自 search_media/search_moment_media 命中的 mediaId'),
  }),
  execute: async ({ mediaId }) => {
    try {
      const resolved = await resolveSharedMediaIdToFile(mediaId)
      if (!resolved.success) return { error: resolved.error }
      return {
        ...resolved,
        note: `${resolved.source === 'moment' ? '朋友圈' : '聊天记录'}${mediaLabel(resolved.mediaKind)}已准备作为当前回复图片，回答里不要输出路径或链接。`,
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
})

export function createSearchSimilarMedia(uploadedMediaContext?: AgentUploadedMediaContext) {
  return tool({
    description:
      '用本轮用户上传的图片做以图找图，只从已经建立好的聊天记录和朋友圈历史图片向量里找相似媒体，不会现场向量化历史图片。' +
      'uploadedImageId 使用 upload-1、upload-2...；用户只发一张图时默认 upload-1。命中 mediaId 可继续交给 inspect_media_image 识别或 send_media_from_history 展示。',
    inputSchema: z.object({
      uploadedImageId: z.string().default('upload-1').describe('本轮用户上传图片 ID，如 upload-1；不确定时用 upload-1'),
      sessionId: z.string().optional().describe('限定某聊天会话/群 username'),
      usernames: z.array(z.string()).optional().describe('限定朋友圈发布者 username'),
      source: z.enum(['chat', 'moment', 'all']).default('all').describe('搜索范围'),
      limit: z.number().int().min(1).max(20).default(8).describe('返回条数上限'),
    }),
    execute: async ({ uploadedImageId, sessionId, usernames, source, limit }) => {
      try {
        const image = (uploadedMediaContext?.images || []).find((item) => item.id === uploadedImageId)
          || uploadedMediaContext?.images?.[0]
        if (!image) {
          return {
            error: '本轮没有可用于以图找图的上传图片。',
            availableUploadedImageIds: uploadedMediaContext?.images?.map((item) => item.id) || [],
          }
        }
        const decoded = imageDataUrlToBuffer(image.dataUrl)
        if (!decoded) return { error: '上传图片不是可读取的 data URL，无法向量化。' }

        const { getEmbeddingConfig, embedImage } = await import('../../ai/embeddingService')
        const { messageVectorService } = await import('../../search/messageVectorService')
        const cfg = getEmbeddingConfig()
        if (!messageVectorService.isMediaReady(cfg)) {
          return {
            error: '图片向量化未开启或嵌入模型未配置。请在设置 → 嵌入中启用嵌入模型，并打开“图片向量化”。',
          }
        }

        reportAgentProgress({
          stage: 'searching',
          title: '搜索已有历史图片向量',
          detail: image.filename || uploadedImageId,
          sessionId,
        })

        const query = await embedImage({ data: decoded.buffer, mediaType: decoded.mediaType, filename: image.filename }, cfg, { timeoutMs: 45000 })
        const hits = messageVectorService
          .searchMediaVectors(query.embedding, { source, sessionId, usernames, limit })
          .map((hit) => formatMediaVectorHit(hit))
        return {
          success: true,
          uploadedImageId: image.id,
          source,
          imageInputMode: query.imageInputMode,
          hits,
          note: hits.length === 0 ? '没有找到相似历史图片；本工具只查已经建立好的历史图片向量，不会现场向量化聊天记录或朋友圈图片。' : undefined,
        }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/** 当前模型是否标记支持图像输入（models.dev 模态数据）；目录里查不到返回 undefined（未知，可尝试）。回复建议引擎也复用。 */
export function currentModelVisionSupport(providerConfig: AgentProviderConfig): boolean | undefined {
  try {
    const def = getProviderDefinition(providerConfig.name)
    const details = def?.modelDetails || []
    if (details.length === 0) return undefined
    const model = providerConfig.model.toLowerCase()
    const detail = details.find((item) => {
      const id = item.id.toLowerCase()
      const name = item.name.toLowerCase()
      return id === model || name === model
    })
    if (!detail) return undefined
    return detail.modalities.input.includes('image')
  } catch {
    return undefined
  }
}

function buildVisionPrompt(resolved: ResolvedMediaFile, question?: string): string {
  const source = resolved.source === 'moment' ? '朋友圈' : '聊天记录'
  const context = [
    `来源：${source}`,
    resolved.from ? `对象/发布者：${resolved.from}` : '',
    resolved.sender ? `发送者/评论者：${resolved.sender}` : '',
    resolved.time ? `时间：${resolved.time}` : '',
    resolved.content ? `相关文字：${resolved.content}` : '',
  ].filter(Boolean).join('\n')
  const task = String(question || '').trim() || '请用中文简洁描述这张图片里主要是什么。'
  return `${context}\n\n用户问题：${task}\n\n只根据图片画面和上面的来源信息回答；看不清就说看不清，不要脑补。`
}

export function createInspectMediaImage(providerConfig: AgentProviderConfig) {
  return tool({
    description:
      '把 search_media/search_moment_media 返回的 mediaId 自动下载/解密后交给当前 Agent 模型看图，回答图片里是什么。' +
      '用于“这张图是什么/朋友圈第一张图是什么/聊天记录上一张图里有什么”。只做识别，不把图片作为微信附件发送。',
    inputSchema: z.object({
      mediaId: z.string().min(8).describe('来自 search_media/search_moment_media 命中的 mediaId'),
      question: z.string().optional().describe('希望视觉模型回答的具体问题；不填则概述图片内容'),
    }),
    execute: async ({ mediaId, question }, { abortSignal }) => {
      const resolved = await resolveSharedMediaIdToFile(mediaId)
      if (!resolved.success) return { error: resolved.error }

      const support = currentModelVisionSupport(providerConfig)
      if (support === false) {
        return {
          success: false,
          error: `当前模型 ${providerConfig.name}/${providerConfig.model} 未标记支持图像输入。请切换到带“图像输入”的模型后再试。`,
          filePath: resolved.filePath,
          source: resolved.source,
          mediaKind: resolved.mediaKind,
          from: resolved.from,
          sender: resolved.sender,
          time: resolved.time,
        }
      }

      try {
        const filePath = stripSharedFileProtocol(resolved.filePath)
        if (!fs.existsSync(filePath)) return { error: '图片文件不存在或无法访问' }
        const buffer = fs.readFileSync(filePath)
        if (buffer.length === 0) return { error: '图片文件为空' }
        if (buffer.length > MAX_VISION_IMAGE_BYTES) {
          return {
            success: false,
            error: `图片过大（>${Math.round(MAX_VISION_IMAGE_BYTES / 1024 / 1024)}MB），暂不喂给模型。`,
            filePath,
            source: resolved.source,
            mediaKind: resolved.mediaKind,
            from: resolved.from,
            sender: resolved.sender,
            time: resolved.time,
          }
        }
        const mediaType = detectSharedImageMime(buffer)
        if (!mediaType) return { error: '图片格式不支持，无法识别' }

        reportAgentProgress({
          stage: 'tool_started',
          title: '理解历史图片',
          detail: `${providerConfig.name}/${providerConfig.model}`,
          visible: true,
          category: 'tool',
          toolName: 'inspect_media_image',
        })

        const messages: ModelMessage[] = [{
          role: 'user',
          content: [
            { type: 'text', text: buildVisionPrompt(resolved, question) },
            { type: 'image', image: buffer, mediaType },
          ],
        }]
        const instructions = '你是密语的图片理解工具。用中文回答，只说你从图里能确定的内容；看不清或信息不足时直接说明。'
        const description = (await generateText({
          model: createLanguageModel(providerConfig),
          system: instructions,
          messages,
          temperature: 0.2,
          abortSignal,
        })).text.trim()

        return {
          success: true,
          description,
          filePath,
          kind: 'image',
          source: resolved.source,
          mediaKind: resolved.mediaKind,
          from: resolved.from,
          sender: resolved.sender,
          time: resolved.time,
          postId: resolved.postId,
          content: resolved.content,
          visionModel: `${providerConfig.name}/${providerConfig.model}`,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          error: `图片已解密，但当前模型无法识别图片：${message}。请切换到带“图像输入”的模型后再试。`,
          filePath: resolved.filePath,
          source: resolved.source,
          mediaKind: resolved.mediaKind,
          from: resolved.from,
          sender: resolved.sender,
          time: resolved.time,
          visionModel: `${providerConfig.name}/${providerConfig.model}`,
        }
      }
    },
  })
}
