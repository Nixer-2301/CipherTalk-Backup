import * as fs from 'fs'
import * as path from 'path'
import { detectImageExtension } from '../chat/emoji'
import { parseEmojiInfo, parseImageInfo } from '../chat/contentParsers'
import type { ChatSearchMediaKind, ChatSearchMediaMessageRow } from '../search/chatSearchIndexService'
import type { SnsCommentEmoji, SnsCommentImage, SnsMedia, SnsPost } from '../snsService'
import { ConfigService } from '../config'
import { resolveSenders, toLocalTime } from '../agent/tools/shared'

export type ChatMediaIdPayload = {
  source: 'chat'
  kind: ChatSearchMediaKind
  sessionId: string
  localId: number
  createTime: number
}

export type MomentMediaTarget = 'post' | 'comment_image' | 'comment_emoji'

export type MomentMediaIdPayload = {
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

export type MediaIdPayload = ChatMediaIdPayload | MomentMediaIdPayload

export type ResolvedMediaFile = {
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

export type ResolveMediaResult = ResolvedMediaFile | {
  success: false
  error: string
  filePath?: string
  source?: 'chat' | 'moment'
  mediaKind?: ChatSearchMediaKind
  from?: string
  sender?: string
  time?: string | null
}

export type MomentMediaHit = {
  mediaId: string
  source: 'moment'
  kind: ChatSearchMediaKind
  mediaKind: ChatSearchMediaKind
  target: MomentMediaTarget
  author: string
  from: string
  sender?: string
  time: string | null
  content?: string
  postId: string
  mediaIndex: number
  commentId?: string
}

export function safeFileSegment(value: string): string {
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

export function encodeMediaId(payload: MediaIdPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

export function decodeMediaId(value: string): MediaIdPayload | null {
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

    const sessionId = optionalString(parsed.sessionId)
    const localId = Number(parsed.localId)
    const createTime = Number(parsed.createTime || 0)
    if (!sessionId || !Number.isFinite(localId) || localId <= 0) return null
    return { source: 'chat', kind, sessionId, localId, createTime }
  } catch {
    return null
  }
}

export function extractAttr(content: string, name: string): string | undefined {
  const match = new RegExp(`${name}\\s*=\\s*['"]([^'"]+)['"]`, 'i').exec(content)
  return match ? match[1].replace(/&amp;/g, '&') : undefined
}

export function mediaKindFromRow(row: ChatSearchMediaMessageRow): ChatSearchMediaKind {
  return Number(row.localType) === 47 ? 'emoji' : 'image'
}

export function mediaLabel(kind: ChatSearchMediaKind): string {
  return kind === 'emoji' ? '表情包' : '图片'
}

export function normalizeMediaQuery(value: string): string[] {
  return String(value || '')
    .toLowerCase()
    .replace(/[，。！？；：、“”‘’（）()[\]{}<>《》|\\/+=*_~`#$%^&-]+/g, ' ')
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 8)
}

export function compactMomentText(value: string | undefined, limit = 160): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

export function stripFileProtocol(value: string): string {
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

export function detectImageMime(buffer: Buffer): string | null {
  const ext = detectImageExtension(buffer)
  if (ext === '.jpg') return 'image/jpeg'
  if (ext === '.png') return 'image/png'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  return null
}

async function getAiImageOutputDir(): Promise<string | null> {
  try {
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
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, Buffer.from(match[2], 'base64'))
    return filePath
  } catch {
    return null
  }
}

export async function resolveImageToFile(sessionId: string, localId: number, createTime: number): Promise<string | null> {
  const { chatService } = await import('../chatService')
  const res = await chatService.getImageData(sessionId, String(localId), createTime)
  if (!res.success || !res.data) return null
  const buffer = Buffer.from(res.data, 'base64')
  const ext = detectImageExtension(buffer) || '.jpg'
  const dir = await getAiImageOutputDir()
  if (!dir) return null
  const filePath = path.join(dir, `history-${safeFileSegment(sessionId)}-${localId}${ext}`)
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buffer)
  return filePath
}

export async function resolveEmojiToFile(rawContent: string, localId: number, createTime: number): Promise<string | null> {
  const info = parseEmojiInfo(rawContent)
  const md5 = info.md5 || ''
  const { chatService } = await import('../chatService')
  const res = await chatService.downloadEmoji(
    info.cdnUrl || '',
    md5,
    info.productId,
    createTime,
    extractAttr(rawContent, 'encrypturl'),
    extractAttr(rawContent, 'aeskey'),
  )
  if (!res.success || !res.localPath) return null
  return writeDataUrlToFile(res.localPath, `history-emoji-${safeFileSegment(md5 || String(localId))}`)
}

export async function resolveRowToFile(row: ChatSearchMediaMessageRow): Promise<string | null> {
  const kind = mediaKindFromRow(row)
  return kind === 'emoji'
    ? resolveEmojiToFile(row.rawContent, row.localId, row.createTime)
    : resolveImageToFile(row.sessionId, row.localId, row.createTime)
}

async function resolveChatPayloadToFile(payload: ChatMediaIdPayload): Promise<ResolveMediaResult> {
  const { chatService } = await import('../chatService')
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

export async function resolveMomentImageToFile(payload: MomentMediaIdPayload): Promise<string | null> {
  const { snsService } = await import('../snsService')
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

export async function resolveMomentEmojiToFile(payload: MomentMediaIdPayload): Promise<string | null> {
  const { snsService } = await import('../snsService')
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

export async function resolveMediaIdToFile(mediaId: string): Promise<ResolveMediaResult> {
  const payload = decodeMediaId(mediaId)
  if (!payload) return { success: false, error: 'mediaId 无效' }
  return payload.source === 'moment'
    ? resolveMomentPayloadToFile(payload)
    : resolveChatPayloadToFile(payload)
}

export function buildChatMediaId(row: ChatSearchMediaMessageRow): string {
  return encodeMediaId({
    source: 'chat',
    kind: mediaKindFromRow(row),
    sessionId: row.sessionId,
    localId: row.localId,
    createTime: row.createTime,
  })
}

export function chatMediaContext(row: ChatSearchMediaMessageRow, precedingText = ''): {
  mediaId: string
  mediaKind: ChatSearchMediaKind
  label: string
  context: string
  md5?: string
} {
  const kind = mediaKindFromRow(row)
  const imageInfo = kind === 'image' ? parseImageInfo(row.rawContent) : {}
  const emojiInfo = kind === 'emoji' ? parseEmojiInfo(row.rawContent) : {}
  return {
    mediaId: buildChatMediaId(row),
    mediaKind: kind,
    label: mediaLabel(kind),
    context: precedingText.replace(/\s+/g, ' ').trim().slice(0, 120),
    md5: kind === 'image' ? imageInfo.md5 : emojiInfo.md5,
  }
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

export function momentImagePayload(post: SnsPost, media: SnsMedia, mediaIndex: number): MomentMediaIdPayload {
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

export function commentImagePayload(post: SnsPost, image: SnsCommentImage, commentId: string, commentNickname: string, mediaIndex: number): MomentMediaIdPayload {
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

export function commentEmojiPayload(post: SnsPost, emoji: SnsCommentEmoji, commentId: string, commentNickname: string, mediaIndex: number): MomentMediaIdPayload {
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

export function momentHitFromPayload(payload: MomentMediaIdPayload, extra: { commentContent?: string } = {}): MomentMediaHit {
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

export function momentHitScore(hit: MomentMediaHit, terms: string[]): number {
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

export function collectMomentMediaHits(
  posts: SnsPost[],
  options: {
    keyword?: string
    order?: 'latest' | 'oldest'
    target?: 'post' | 'comment' | 'all'
    limit?: number
    skipVideo?: (url: string) => boolean
  } = {},
): { hits: Array<MomentMediaHit & { score: number }>; skippedVideos: number } {
  const order = options.order || 'latest'
  const target = options.target || 'post'
  const limit = Math.max(1, Math.min(200, Math.floor(Number(options.limit) || 20)))
  const terms = normalizeMediaQuery(options.keyword || '')
  const sorted = posts.slice().sort((a, b) => order === 'oldest' ? a.createTime - b.createTime : b.createTime - a.createTime)
  const hits: Array<MomentMediaHit & { score: number }> = []
  let skippedVideos = 0

  for (const post of sorted) {
    if (target !== 'comment') {
      for (let index = 0; index < (post.media || []).length; index += 1) {
        const media = post.media[index]
        if (!media?.url && !media?.thumb) continue
        if (options.skipVideo?.(media.url || media.thumb || '')) {
          skippedVideos += 1
          continue
        }
        const hit = momentHitFromPayload(momentImagePayload(post, media, index))
        const score = momentHitScore(hit, terms)
        if (terms.length === 0 || score > 0) hits.push({ ...hit, score })
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
          if (terms.length === 0 || score > 0) hits.push({ ...hit, score })
        }
        for (let index = 0; index < (comment.emojis || []).length; index += 1) {
          const emoji = comment.emojis?.[index]
          if (!emoji?.url && !emoji?.encryptUrl) continue
          const hit = momentHitFromPayload(
            commentEmojiPayload(post, emoji, comment.id, comment.nickname, index),
            { commentContent },
          )
          const score = momentHitScore(hit, terms)
          if (terms.length === 0 || score > 0) hits.push({ ...hit, score })
        }
      }
    }
  }

  return {
    hits: hits
      .sort((a, b) => b.score - a.score)
      .slice(0, limit),
    skippedVideos,
  }
}
