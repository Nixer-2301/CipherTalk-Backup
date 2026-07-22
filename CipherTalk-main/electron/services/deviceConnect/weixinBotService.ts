/**
 * 微信机器人服务 —— 把项目内 Agent 接到微信。
 * 扫码连接（绑定 bot 通道，非登录）→ 长轮询收消息 → 过 Agent → 回发。
 * 状态/二维码经 ctx.broadcastToWindows 推给渲染端。
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { createDecipheriv } from 'crypto'
import { join } from 'path'
import QRCode from 'qrcode'
import type { FileUIPart, UIMessage, UIMessageChunk } from 'ai'
import { getUserDataPath } from '../runtimePaths'
import type { MainProcessContext } from '../../main/context'
import {
  ILINK_BASE_URL,
  fetchQrcode,
  fetchQrcodeStatus,
  getUpdates,
  sendText,
  sendImage,
  sendFile,
  sendVideo,
  sendVoice,
  getConfig,
  sendTyping,
  notifyStart,
  notifyStop,
  isSessionExpiredError,
  type IlinkSession,
  type IlinkMessage,
} from './weixinIlinkClient'
import { synthesizeWeixinVoice } from './weixinVoiceService'
import type { PersonaTtsVoiceBinding } from '../agent/persona/personaTypes'

const TOKEN_FILE = 'wechat-bot-token.json'
const MODE_FILE = 'wechat-bot-modes.json'
const QR_DEADLINE_MS = 5 * 60_000
const QR_CODE_RENDER_OPTIONS = { width: 280, margin: 2, errorCorrectionLevel: 'H' as const }
const TYPING_KEEPALIVE_MS = 5_000
const PENDING_SELECTION_TTL_MS = 2 * 60_000
const PERSONA_BUBBLE_SEND_PAUSE_MIN_MS = 700
const PERSONA_BUBBLE_SEND_PAUSE_MAX_MS = 2200
const PERSONA_PENDING_FLUSH_MIN_MS = 5_000
const PERSONA_PENDING_FLUSH_MAX_MS = 10_000
const PERSONA_PENDING_AFTER_BUSY_MS = 1_200
const WECHAT_TEXT_BUBBLE_SEPARATOR = '---wx-next---'
const WECHAT_REPLY_FALLBACK_TEXT = '不好意思，我有点嘎了，等一会儿哈！'
const WECHAT_INCOMING_MAX_FILES = 6
const WECHAT_INCOMING_MAX_FILE_BYTES = 8 * 1024 * 1024
const WECHAT_INCOMING_FETCH_TIMEOUT_MS = 15_000

export type WechatBotStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface WechatBotStatusPayload {
  status: WechatBotStatus
  botId: string | null
  userId: string | null
  error: string | null
}

interface StoredToken extends IlinkSession {
  savedAt: string
}

interface BotLogger {
  info(category: string, message: string, data?: unknown): void
  warn(category: string, message: string, data?: unknown): void
  error(category: string, message: string, data?: unknown): void
}

type TypingIndicator = {
  stop: () => Promise<void>
}

type WechatBotMedia = {
  kind: 'image' | 'file' | 'video' | 'voice'
  source?: 'desktop_screenshot' | 'tool' | 'directive'
  filePath?: string
  text?: string
  caption?: string
  personaVoice?: PersonaTtsVoiceBinding | null
  ttsInstructions?: string
  durationMs?: number
  sampleRate?: number
}

type WechatIncomingAttachment = {
  kind: 'image' | 'file' | 'video'
  label: string
  filename?: string
  mediaType: string
  sizeBytes?: number
  url?: string
  aesKey?: string
}

type ParsedWechatIncomingMessage = {
  textSegments: string[]
  attachments: WechatIncomingAttachment[]
}

type PreparedWechatIncomingMessage = {
  plainText: string
  agentText: string
  logText: string
  fileParts: FileUIPart[]
  attachmentCount: number
  attachedFileCount: number
}

type WechatBotReply = {
  text: string
  textBubbles?: string[]
  savedText?: string
  savedTextBubbles?: string[]
  media: WechatBotMedia[]
  personaActions: WechatPersonaAction[]
  personaVoice?: PersonaTtsVoiceBinding | null
  ttsInstructions?: string
}

type WechatConversationMode = {
  mode: 'persona'
  sessionId: string
  displayName: string
}

type WechatContactCandidate = {
  username: string
  displayName: string
  kind: 'person' | 'group' | 'official'
}

type WechatPersonaAction = {
  action: 'open_persona_chat' | 'build_persona' | 'build_session_vectors' | 'ask_persona_build'
  sessionId: string
  displayName: string
}

type PendingPersonaSelection = {
  query: string
  candidates: WechatContactCandidate[]
  createdAt: number
}

type PendingPersonaQueue = {
  from: string
  mode: WechatConversationMode
  conversationId?: number
  texts: string[]
  contextToken?: string
  timer: ReturnType<typeof setTimeout> | null
  running: boolean
  typing: TypingIndicator | null
  cancelled: boolean
}

type WechatPersonaBubbleContext = {
  personaVoice?: PersonaTtsVoiceBinding | null
  ttsInstructions?: string
}

interface StoredModes {
  modes?: Record<string, WechatConversationMode>
}

function truncateLogText(value: unknown, max = 1200): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  return text.length > max ? `${text.slice(0, max)}...` : text
}

function errorToLogData(error: unknown): Record<string, unknown> {
  const e = error as {
    name?: unknown
    message?: unknown
    stack?: unknown
    status?: unknown
    statusCode?: unknown
    url?: unknown
    responseBody?: unknown
    cause?: unknown
  }
  const data: Record<string, unknown> = {
    error: error instanceof Error ? error.message : String(error),
  }
  if (typeof e?.name === 'string') data.name = e.name
  if (typeof e?.message === 'string') data.message = e.message
  if (typeof e?.stack === 'string') data.stack = e.stack
  if (typeof e?.status === 'number') data.status = e.status
  if (typeof e?.statusCode === 'number') data.statusCode = e.statusCode
  if (typeof e?.url === 'string') data.url = e.url
  if (e?.responseBody !== undefined) data.responseBody = truncateLogText(e.responseBody)
  if (e?.cause !== undefined) {
    const cause = e.cause as { message?: unknown; stack?: unknown }
    data.cause = typeof cause?.message === 'string'
      ? { message: cause.message, stack: typeof cause.stack === 'string' ? cause.stack : undefined }
      : truncateLogText(e.cause, 800)
  }
  return data
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function readString(record: Record<string, unknown> | null | undefined, key: string): string {
  const value = record?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

function readNumber(record: Record<string, unknown> | null | undefined, key: string): number | undefined {
  const value = record?.[key]
  const num = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : NaN
  return Number.isFinite(num) && num > 0 ? num : undefined
}

function normalizeIncomingMediaUrl(url: string): string {
  return url.trim().replace(/&amp;/g, '&')
}

function guessMediaTypeFromFilename(filename: string): string {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.txt')) return 'text/plain'
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown'
  if (lower.endsWith('.json')) return 'application/json'
  if (lower.endsWith('.csv')) return 'text/csv'
  return 'application/octet-stream'
}

function detectMediaTypeFromBuffer(buffer: Buffer): string | null {
  if (buffer.length < 4) return null
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif'
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp'
  }
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return 'application/pdf'
  return null
}

function normalizeMediaType(mediaType: string): string {
  const normalized = mediaType.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream'
  return normalized === 'image/jpg' ? 'image/jpeg' : normalized
}

function isAgentReadableMediaType(mediaType: string): boolean {
  const normalized = normalizeMediaType(mediaType)
  return normalized.startsWith('image/') ||
    normalized.startsWith('text/') ||
    normalized === 'application/pdf' ||
    normalized === 'application/json'
}

function formatIncomingBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)}MB`
}

function normalizeWechatAesKey(value?: string): Buffer | null {
  const trimmed = String(value || '').trim()
  if (!trimmed) return null
  if (/^[0-9a-f]{32}$/i.test(trimmed)) return Buffer.from(trimmed, 'hex')
  try {
    const decoded = Buffer.from(trimmed, 'base64')
    const decodedText = decoded.toString('utf8').trim()
    if (/^[0-9a-f]{32}$/i.test(decodedText)) return Buffer.from(decodedText, 'hex')
    if (decoded.length === 16) return decoded
  } catch {
    return null
  }
  return null
}

function decryptWechatCdnBuffer(buffer: Buffer, aesKey?: string): Buffer | null {
  const key = normalizeWechatAesKey(aesKey)
  if (!key) return null
  try {
    const decipher = createDecipheriv('aes-128-ecb', key, null)
    return Buffer.concat([decipher.update(buffer), decipher.final()])
  } catch {
    return null
  }
}

function looksMostlyText(buffer: Buffer): boolean {
  if (buffer.length === 0) return false
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096))
  let control = 0
  for (const byte of sample) {
    if (byte === 0) return false
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control += 1
  }
  return control / sample.length < 0.02
}

function decodeIncomingMediaBuffer(buffer: Buffer, attachment: WechatIncomingAttachment): Buffer {
  if (!attachment.aesKey) return buffer
  if (detectMediaTypeFromBuffer(buffer)) return buffer
  const decrypted = decryptWechatCdnBuffer(buffer, attachment.aesKey)
  if (!decrypted) return buffer
  const decryptedMediaType = detectMediaTypeFromBuffer(decrypted)
  if (decryptedMediaType) return decrypted
  if ((attachment.mediaType.startsWith('text/') || attachment.mediaType === 'application/json') && looksMostlyText(decrypted)) {
    return decrypted
  }
  if (attachment.kind === 'image') return decrypted
  return buffer
}

function buildIncomingDataUrl(buffer: Buffer, mediaType: string): string {
  return `data:${mediaType};base64,${buffer.toString('base64')}`
}

function attachmentLine(attachment: WechatIncomingAttachment, status: string): string {
  const name = attachment.filename ? `：${attachment.filename}` : ''
  const size = formatIncomingBytes(attachment.sizeBytes)
  const sizeText = size ? `，${size}` : ''
  return `[微信${attachment.label}${name}${sizeText}，${status}]`
}

function parseWechatIncomingMessage(msg: IlinkMessage): ParsedWechatIncomingMessage {
  const textSegments: string[] = []
  const attachments: WechatIncomingAttachment[] = []

  for (const [index, rawItem] of (msg.item_list ?? []).entries()) {
    const item = asRecord(rawItem)
    const type = readNumber(item, 'type')

    if (type === 1) {
      const text = readString(asRecord(item?.text_item), 'text')
      if (text) textSegments.push(text)
      continue
    }

    if (type === 3) {
      const voice = asRecord(item?.voice_item)
      const transcript = readString(voice, 'text')
      textSegments.push(transcript ? `[语音] ${transcript}` : '[语音]')
      continue
    }

    if (type === 2) {
      const image = asRecord(item?.image_item)
      const media = asRecord(image?.media)
      attachments.push({
        kind: 'image',
        label: '图片',
        filename: `wechat-image-${index + 1}.jpg`,
        mediaType: 'image/jpeg',
        sizeBytes: readNumber(image, 'hd_size') || readNumber(image, 'mid_size') || readNumber(image, 'thumb_size'),
        url: normalizeIncomingMediaUrl(readString(media, 'full_url')),
        aesKey: readString(image, 'aeskey') || readString(image, 'aes_key') || readString(media, 'aes_key'),
      })
      continue
    }

    if (type === 4) {
      const file = asRecord(item?.file_item)
      const media = asRecord(file?.media)
      const filename = readString(file, 'file_name') || `wechat-file-${index + 1}`
      attachments.push({
        kind: 'file',
        label: '文件',
        filename,
        mediaType: guessMediaTypeFromFilename(filename),
        sizeBytes: readNumber(file, 'len'),
        url: normalizeIncomingMediaUrl(readString(media, 'full_url')),
        aesKey: readString(file, 'aeskey') || readString(file, 'aes_key') || readString(media, 'aes_key'),
      })
      continue
    }

    if (type === 5) {
      const video = asRecord(item?.video_item)
      const media = asRecord(video?.media)
      attachments.push({
        kind: 'video',
        label: '视频',
        filename: `wechat-video-${index + 1}.mp4`,
        mediaType: 'video/mp4',
        sizeBytes: readNumber(video, 'video_size'),
        url: normalizeIncomingMediaUrl(readString(media, 'full_url')),
        aesKey: readString(video, 'aeskey') || readString(video, 'aes_key') || readString(media, 'aes_key'),
      })
    }
  }

  return { textSegments, attachments }
}

function textFromUiMessage(message: UIMessage): string {
  const anyMessage = message as any
  if (typeof anyMessage.content === 'string') return anyMessage.content
  if (!Array.isArray(anyMessage.parts)) return ''
  return anyMessage.parts
    .map((part: any) => {
      if (!part || typeof part !== 'object') return ''
      if (part.type === 'text') return String(part.text || '')
      if (typeof part.text === 'string') return part.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function lastUserTextFromUiMessages(messages: UIMessage[] = []): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return textFromUiMessage(messages[i])
  }
  return ''
}

function rememberToolNameFromChunk(chunk: UIMessageChunk, toolNames: Map<string, string>): void {
  const c = chunk as { toolCallId?: unknown; toolName?: unknown }
  if (typeof c.toolCallId === 'string' && typeof c.toolName === 'string') {
    toolNames.set(c.toolCallId, c.toolName)
  }
}

function extractMediaFromToolChunk(
  chunk: UIMessageChunk,
  toolNames: Map<string, string>,
  options: { allowDesktopScreenshotReply?: boolean } = {},
): WechatBotMedia | null {
  const c = chunk as {
    type?: string
    toolCallId?: string
    toolName?: string
    output?: { success?: unknown; filePath?: unknown; error?: unknown; kind?: unknown; caption?: unknown }
  }
  if (c.type !== 'tool-output-available' || c.output?.success !== true) return null
  const filePath = typeof c.output.filePath === 'string' ? c.output.filePath.trim() : ''
  if (!filePath) return null

  const toolName = c.toolName || (c.toolCallId ? toolNames.get(c.toolCallId) : undefined)
  switch (toolName) {
    case 'generate_image':
    case 'send_random_image':
    case 'send_sticker':
    case 'send_media_from_history':
      return { kind: 'image', filePath, source: 'tool' }
    case 'send_wechat_file':
      return { kind: 'file', filePath, source: 'tool' }
    case 'desktop_screenshot':
      return options.allowDesktopScreenshotReply
        ? { kind: 'image', filePath, source: 'desktop_screenshot' }
        : null
    case 'send_wechat_media': {
      const kind = c.output.kind === 'image' || c.output.kind === 'video' || c.output.kind === 'file'
        ? c.output.kind
        : 'file'
      const caption = typeof c.output.caption === 'string' ? c.output.caption.trim() : ''
      return { kind, filePath, caption, source: 'tool' }
    }
    default:
      return null
  }
}

function extractPersonaActionFromToolChunk(chunk: UIMessageChunk, toolNames: Map<string, string>): WechatPersonaAction | null {
  const c = chunk as {
    type?: string
    toolCallId?: string
    toolName?: string
    output?: {
      success?: unknown
      action?: unknown
      sessionId?: unknown
      displayName?: unknown
    }
  }
  if (c.type !== 'tool-output-available' || c.output?.success !== true) return null
  const toolName = c.toolName || (c.toolCallId ? toolNames.get(c.toolCallId) : undefined)
  if (toolName !== 'persona_control') return null
  const action = c.output.action
  if (
    action !== 'open_persona_chat' &&
    action !== 'build_persona' &&
    action !== 'build_session_vectors' &&
    action !== 'ask_persona_build'
  ) {
    return null
  }
  const sessionId = typeof c.output.sessionId === 'string' ? c.output.sessionId.trim() : ''
  if (!sessionId) return null
  const displayName = typeof c.output.displayName === 'string' && c.output.displayName.trim()
    ? c.output.displayName.trim()
    : sessionId
  return { action, sessionId, displayName }
}

function dedupeMedia(media: WechatBotMedia[]): WechatBotMedia[] {
  const seen = new Set<string>()
  const result: WechatBotMedia[] = []
  for (const item of media) {
    const key = `${item.kind}:${item.filePath || item.text || ''}:${item.caption || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

function dedupePersonaActions(actions: WechatPersonaAction[]): WechatPersonaAction[] {
  const seen = new Set<string>()
  const result: WechatPersonaAction[] = []
  for (const item of actions) {
    const key = `${item.action}:${item.sessionId}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

const VOICE_MARKER_RE = /^[\[【]\s*(?:语音|voice)\s*[\]】]\s*/i

function wantsVoiceReply(text: string): boolean {
  return /(?:发|回|用|说|讲|来).{0,8}(?:语音|声音)|(?:语音|声音).{0,8}(?:回复|说|讲|发|回)|听你说|想听/i.test(text)
}

function wantsDesktopScreenshotReply(text: string): boolean {
  const normalized = text.replace(/\s+/g, '')
  if (/(?:怎么|如何|怎样).{0,8}(?:截图|截屏)/.test(normalized)) return false
  return (
    /(?:截图|截屏|屏幕截图|桌面截图)/.test(normalized) &&
    /(?:发我|发给我|给我|发来|发一下|发|传我|看看|看下|看一下)/.test(normalized)
  ) || /(?:截个?|拍个?).{0,4}(?:图|屏).{0,8}(?:发|给我|看看|看下|看一下)/.test(normalized)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function splitVoiceMarkedReply(reply: WechatBotReply, forceVoice: boolean): WechatBotReply {
  const text = reply.text.trim()
  if (!text) return reply
  const sourceBubbles = reply.textBubbles?.length ? reply.textBubbles : [text]
  const savedTextBubbles = reply.savedTextBubbles?.length ? reply.savedTextBubbles : sourceBubbles
  const savedText = reply.savedText || savedTextBubbles.join('\n')
  const textBubbles: string[] = []
  const media: WechatBotMedia[] = [...reply.media]
  let hasVoiceMarker = false

  for (const bubble of sourceBubbles) {
    const trimmed = bubble.trim()
    if (!trimmed) continue
    if (VOICE_MARKER_RE.test(trimmed)) {
      hasVoiceMarker = true
      const voiceText = trimmed.replace(VOICE_MARKER_RE, '').trim()
      if (voiceText) media.push({ kind: 'voice', text: voiceText, personaVoice: reply.personaVoice, ttsInstructions: reply.ttsInstructions })
    } else {
      textBubbles.push(trimmed)
    }
  }

  if (!hasVoiceMarker && forceVoice) {
    media.push({ kind: 'voice', text, personaVoice: reply.personaVoice, ttsInstructions: reply.ttsInstructions })
    return { ...reply, text: '', textBubbles: [], savedText, savedTextBubbles, media: dedupeMedia(media), personaActions: reply.personaActions }
  }

  return { ...reply, text: textBubbles.join('\n'), textBubbles, savedText, savedTextBubbles, media: dedupeMedia(media), personaActions: reply.personaActions }
}

function splitWechatExplicitBubbles(text: string): string[] {
  return text
    .split(new RegExp(`^\\s*${escapeRegExp(WECHAT_TEXT_BUBBLE_SEPARATOR)}\\s*$`, 'm'))
    .map((bubble) => bubble.trim())
    .filter(Boolean)
}

function normalizeWechatTextBubbles(bubbles: string[]): string[] {
  return bubbles.flatMap(splitWechatExplicitBubbles)
}

function personaBubbleSendPauseMs(index: number): number {
  if (index <= 0) return 0
  return Math.round(PERSONA_BUBBLE_SEND_PAUSE_MIN_MS + Math.random() * (PERSONA_BUBBLE_SEND_PAUSE_MAX_MS - PERSONA_BUBBLE_SEND_PAUSE_MIN_MS))
}

function splitWechatMarkedBubbles(text: string): string[] {
  return splitWechatExplicitBubbles(text)
}

async function extractMediaDirectivesFromBubbles(bubbles: string[]): Promise<{ text: string; textBubbles: string[]; media: WechatBotMedia[] }> {
  const textBubbles: string[] = []
  const media: WechatBotMedia[] = []
  for (const bubble of bubbles) {
    const extracted = await extractMediaDirectives(bubble)
    if (extracted.text) {
      textBubbles.push(extracted.text)
    }
    media.push(...extracted.media)
  }
  return { text: textBubbles.join('\n'), textBubbles, media }
}

function getReplyTextBubbles(reply: WechatBotReply): string[] {
  if (reply.textBubbles?.length) {
    return normalizeWechatTextBubbles(reply.textBubbles)
  }
  const text = reply.text.trim()
  return text ? [text] : []
}

const PERSONA_STICKER_BUBBLE_RE = /^\[表情包\]\{.*\}$/

function stripPersonaStickerBubbles(reply: WechatBotReply): WechatBotReply {
  const bubbles = getReplyTextBubbles(reply)
  const textBubbles = bubbles.filter((line) => !PERSONA_STICKER_BUBBLE_RE.test(line))
  return { ...reply, text: textBubbles.join('\n'), textBubbles }
}

const MEDIA_DIRECTIVE_RE = /^MEDIA:\s*(.+)$/i

function stripMediaDirectiveLines(text: string): string {
  return text
    .split(/\n/)
    .filter((line) => !MEDIA_DIRECTIVE_RE.test(line.trim()))
    .join('\n')
    .trim()
}

function summarizeWechatMedia(item: WechatBotMedia): string {
  if (item.kind === 'voice') {
    const text = String(item.text || '').trim()
    return text ? `[语音] ${text}` : '[已发送语音]'
  }
  if (item.source === 'desktop_screenshot') return '[已发送截图]'
  const label = item.kind === 'image' ? '图片' : item.kind === 'video' ? '视频' : '文件'
  const caption = String(item.caption || '').trim()
  return caption ? `[已发送${label}] ${caption}` : `[已发送${label}]`
}

function summarizePersonaAction(action: WechatPersonaAction): string {
  switch (action.action) {
    case 'open_persona_chat':
      return `[已打开数字分身] ${action.displayName}`
    case 'build_persona':
      return `[已创建数字分身] ${action.displayName}`
    case 'build_session_vectors':
      return `[已构建聊天索引] ${action.displayName}`
    case 'ask_persona_build':
      return `[已询问是否创建数字分身] ${action.displayName}`
    default:
      return `[数字分身动作] ${action.displayName}`
  }
}

function buildSavedReplyBubbles(rawBubbles: string[], media: WechatBotMedia[], personaActions: WechatPersonaAction[]): string[] {
  const bubbles = rawBubbles
    .map(stripMediaDirectiveLines)
    .filter(Boolean)
  const summaries = [
    ...media.map(summarizeWechatMedia),
    ...personaActions.map(summarizePersonaAction),
  ].filter(Boolean)
  return [...normalizeWechatTextBubbles(bubbles), ...summaries]
}

/** 落库用的分气泡数组：每个气泡存成独立 text part，桌面历史才能像微信一样分条显示。 */
function getSavedAssistantBubbles(reply: WechatBotReply): string[] {
  const savedBubbles = reply.savedTextBubbles?.length ? normalizeWechatTextBubbles(reply.savedTextBubbles) : []
  if (savedBubbles.length) return savedBubbles

  const savedText = reply.savedText?.trim()
  if (savedText) return [savedText]

  const text = reply.text.trim()
  if (text) return normalizeWechatTextBubbles([text])

  const summaries = [
    ...reply.media.map(summarizeWechatMedia),
    ...reply.personaActions.map(summarizePersonaAction),
  ].filter(Boolean)
  return summaries.length ? summaries : ['[微信回复已处理]']
}

function getSavedAssistantText(reply: WechatBotReply): string {
  return getSavedAssistantBubbles(reply).join('\n')
}

async function extractMediaDirectives(text: string): Promise<{ text: string; media: WechatBotMedia[] }> {
  const media: WechatBotMedia[] = []
  const textLines: string[] = []
  const failures: string[] = []
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.trim()
    const match = line.match(MEDIA_DIRECTIVE_RE)
    if (!match) {
      textLines.push(rawLine)
      continue
    }
    try {
      const { prepareWechatMedia } = await import('../agent/tools/wechatMedia')
      const prepared = await prepareWechatMedia(match[1].trim())
      media.push({ kind: prepared.kind, filePath: prepared.filePath })
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (failures.length > 0) {
    textLines.push(`媒体准备失败：${failures[0]}`)
  }
  return { text: textLines.join('\n').trim(), media }
}

function parseOpenPersonaCommand(text: string): string | null {
  const normalized = text.trim()
  const patterns = [
    /^(?:#|\/)?(?:打开|开启|启动|进入|切换到|切到)\s*(.+?)\s*(?:的)?\s*(?:数字分身|克隆好友|好友分身|分身)\s*(?:聊天|对话)?$/i,
    /^(?:#|\/)?(?:和|跟)\s*(.+?)\s*(?:的)?\s*(?:数字分身|克隆好友|好友分身|分身)\s*(?:聊天|对话)?$/i,
  ]
  for (const pattern of patterns) {
    const match = normalized.match(pattern)
    const query = match?.[1]?.trim()
    if (query) return query
  }
  return null
}

function isExitPersonaCommand(text: string): boolean {
  return /^(?:#|\/)?(?:退出|关闭|结束|停止)\s*(?:数字分身|克隆好友|好友分身|分身|克隆模式)$/i.test(text.trim())
}

function isStatusCommand(text: string): boolean {
  return /^(?:#|\/)?(?:当前模式|模式|状态|status)$/i.test(text.trim())
}

function isNewConversationCommand(text: string): boolean {
  return /^(?:\/new|#new|新会话|开启新会话|开始新会话|重新开始)$/i.test(text.trim())
}

function isHelpCommand(text: string): boolean {
  return /^(?:#|\/)?(?:帮助|help|命令)$/i.test(text.trim())
}

function classifyContact(username: string): WechatContactCandidate['kind'] {
  if (username.endsWith('@chatroom')) return 'group'
  if (username.startsWith('gh_')) return 'official'
  return 'person'
}

class WeixinBotService {
  private ctx: MainProcessContext | null = null
  private session: IlinkSession | null = null
  private status: WechatBotStatus = 'disconnected'
  private error: string | null = null
  private loopRunning = false
  private loopAbort: AbortController | null = null
  private connectAbort: AbortController | null = null
  private modes: Record<string, WechatConversationMode> = {}
  private pendingPersonaSelections = new Map<string, PendingPersonaSelection>()
  private pendingPersonaQueues = new Map<string, PendingPersonaQueue>()
  private sentConversationReplyMessageIds = new Set<string>()

  // logger 实时从 ctx 取，不缓存：init 在建窗(setLogService)之前注册，缓存会永久拿到 null
  private get logger(): BotLogger | null {
    return this.ctx?.getLogService() ?? null
  }

  init(ctx: MainProcessContext): void {
    if (this.ctx) return
    this.ctx = ctx
    this.modes = this.loadModes()
    const stored = this.loadToken()
    if (stored) {
      this.session = stored
      this.status = 'connected'
      this.startLoop()
    }
  }

  getStatus(): WechatBotStatusPayload {
    return {
      status: this.status,
      botId: this.session?.botId ?? null,
      userId: this.session?.userId ?? null,
      error: this.error,
    }
  }

  /**
   * Send a desktop-generated assistant reply back to the bound WeChat bot conversation.
   * Only external conversations with source=wechat/wechat-persona are allowed; messageId prevents resend on history reload.
   */
  async sendConversationReplyToWechat(input: {
    conversationId: number
    messageId: string
    bubbles: string[]
    contextToken?: string
  }): Promise<{ success: boolean; sent?: boolean; skipped?: boolean; error?: string }> {
    const conversationId = Number(input.conversationId)
    const messageId = String(input.messageId || '').trim()
    const bubbles = normalizeWechatTextBubbles(input.bubbles.map((bubble) => String(bubble || '').trim()).filter(Boolean))
    if (!Number.isFinite(conversationId) || conversationId <= 0) return { success: false, error: 'Invalid conversation ID' }
    if (!messageId) return { success: false, error: 'Missing message ID' }
    if (bubbles.length === 0) return { success: true, skipped: true }

    const sentKey = `${conversationId}:${messageId}`
    if (this.sentConversationReplyMessageIds.has(sentKey)) return { success: true, skipped: true }
    if (!this.session) return { success: false, error: 'WeChat bot is not connected' }

    const { agentConversationStore } = await import('../agent/conversationStore')
    const conversation = agentConversationStore.load(conversationId)
    if (!conversation) return { success: false, error: 'AI conversation not found' }

    const message = conversation.messages.find((item: any) => String(item?.id || '') === messageId)
    if (!message || message.role !== 'assistant') return { success: false, error: 'Only saved assistant messages can be pushed to WeChat' }

    const source = String(conversation.source || '')
    const externalId = String(conversation.externalId || '').trim()
    let toUserId = ''
    if (source === 'wechat') {
      toUserId = externalId
    } else if (source === 'wechat-persona') {
      toUserId = externalId.split(':')[0] || ''
    } else {
      return { success: true, skipped: true }
    }
    if (!toUserId) return { success: false, error: 'Conversation is not bound to a WeChat bot user' }

    await this.sendTextBubbles(toUserId, bubbles, input.contextToken)
    this.sentConversationReplyMessageIds.add(sentKey)
    this.logger?.warn('WechatBot', 'Desktop assistant reply pushed to WeChat bot', {
      conversationId,
      messageId,
      source,
      toUserId,
      bubbleCount: bubbles.length,
    })
    return { success: true, sent: true }
  }

  /** Start QR connection: fetch QR code, render, push to renderer, then poll confirmation. */
  async startConnect(): Promise<{ success: boolean; qrcodeImage?: string; error?: string }> {
    try {
      this.cancelConnect()
      this.error = null
      const qr = await fetchQrcode()
      const qrcodeImage = await QRCode.toDataURL(qr.qrcodeContent, QR_CODE_RENDER_OPTIONS)
      this.setStatus('connecting')
      this.broadcast('qrcode', { qrcodeImage })
      void this.pollQrcode(qr.qrcode)
      return { success: true, qrcodeImage }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      this.error = error
      this.setStatus('error')
      return { success: false, error }
    }
  }

  cancelConnect(): void {
    if (this.connectAbort) {
      this.connectAbort.abort()
      this.connectAbort = null
    }
    if (this.status === 'connecting') {
      this.setStatus(this.session ? 'connected' : 'disconnected')
    }
  }

  async disconnect(): Promise<void> {
    this.cancelConnect()
    this.stopLoop()
    this.clearAllPersonaQueues()
    const session = this.session
    this.session = null
    this.clearToken()
    this.error = null
    this.setStatus('disconnected')
    if (session) {
      try { await notifyStop(session) } catch { /* 下线通知失败无所谓 */ }
    }
  }

  shutdown(): void {
    this.cancelConnect()
    this.stopLoop()
    this.clearAllPersonaQueues()
  }

  // ── 扫码状态轮询 ──
  private async pollQrcode(initialQrcode: string): Promise<void> {
    const abort = new AbortController()
    this.connectAbort = abort
    const deadline = Date.now() + QR_DEADLINE_MS
    let qrcode = initialQrcode
    let refreshCount = 0

    while (Date.now() < deadline && !abort.signal.aborted) {
      let resp
      try {
        resp = await fetchQrcodeStatus(qrcode)
      } catch (e) {
        this.logger?.warn('WechatBot', '查询二维码状态失败', { error: String(e) })
        await this.sleep(1500)
        continue
      }
      if (abort.signal.aborted) return

      if (resp.status === 'expired') {
        refreshCount += 1
        if (refreshCount > 3) {
          this.failConnect('二维码多次过期，请重试')
          return
        }
        try {
          const newQr = await fetchQrcode()
          qrcode = newQr.qrcode
          const qrcodeImage = await QRCode.toDataURL(newQr.qrcodeContent, QR_CODE_RENDER_OPTIONS)
          this.broadcast('qrcode', { qrcodeImage })
        } catch {
          this.failConnect('刷新二维码失败')
          return
        }
      } else if (resp.status === 'scaned') {
        this.broadcast('scanState', { state: 'scaned' })
      } else if (resp.status === 'confirmed') {
        const session: IlinkSession = {
          token: resp.bot_token || '',
          baseUrl: resp.baseurl || ILINK_BASE_URL,
          botId: resp.ilink_bot_id || '',
          userId: resp.ilink_user_id || '',
        }
        this.session = session
        this.saveToken(session)
        this.connectAbort = null
        this.error = null
        this.setStatus('connected')
        this.startLoop()
        return
      }

      await this.sleep(1000)
    }

    if (!abort.signal.aborted) this.failConnect('扫码超时，请重试')
  }

  private failConnect(message: string): void {
    this.error = message
    this.connectAbort = null
    this.broadcast('scanState', { state: 'failed', error: message })
    this.setStatus(this.session ? 'connected' : 'error')
  }

  // ── 收消息循环 ──
  private startLoop(): void {
    if (this.loopRunning || !this.session) return
    this.loopRunning = true
    this.loopAbort = new AbortController()
    void this.runLoop(this.loopAbort.signal)
  }

  private stopLoop(): void {
    this.loopRunning = false
    this.clearAllPersonaQueues()
    if (this.loopAbort) {
      this.loopAbort.abort()
      this.loopAbort = null
    }
  }

  private async prepareIncomingMessage(msg: IlinkMessage): Promise<PreparedWechatIncomingMessage> {
    const parsed = parseWechatIncomingMessage(msg)
    const fileParts: FileUIPart[] = []
    const attachmentLines: string[] = []

    for (const attachment of parsed.attachments) {
      if (fileParts.length >= WECHAT_INCOMING_MAX_FILES) {
        attachmentLines.push(attachmentLine(attachment, `未传给模型：附件数量超过 ${WECHAT_INCOMING_MAX_FILES} 个`))
        continue
      }
      if (attachment.kind === 'video') {
        attachmentLines.push(attachmentLine(attachment, '未传给模型：暂不支持视频输入'))
        continue
      }
      if (!attachment.url) {
        attachmentLines.push(attachmentLine(attachment, '未传给模型：微信未返回下载地址'))
        continue
      }
      if (attachment.sizeBytes && attachment.sizeBytes > WECHAT_INCOMING_MAX_FILE_BYTES) {
        attachmentLines.push(attachmentLine(attachment, `未传给模型：超过 ${formatIncomingBytes(WECHAT_INCOMING_MAX_FILE_BYTES)}`))
        continue
      }
      if (!isAgentReadableMediaType(attachment.mediaType)) {
        attachmentLines.push(attachmentLine(attachment, `未传给模型：不支持 ${attachment.mediaType}`))
        continue
      }

      try {
        fileParts.push(await this.downloadIncomingAttachmentAsFilePart(attachment))
        attachmentLines.push(attachmentLine(attachment, '已随消息上传给模型'))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        attachmentLines.push(attachmentLine(attachment, `未传给模型：${message}`))
        this.logger?.warn('WechatBot', '微信入站附件准备失败', {
          kind: attachment.kind,
          filename: attachment.filename,
          sizeBytes: attachment.sizeBytes,
          mediaType: attachment.mediaType,
          error: message,
        })
      }
    }

    const plainText = parsed.textSegments.join('\n').trim()
    const agentText = [...parsed.textSegments, ...attachmentLines].join('\n').trim()
    const logText = agentText || (parsed.attachments.length > 0 ? parsed.attachments.map((item) => `[${item.label}]`).join(' ') : '')
    return {
      plainText,
      agentText,
      logText,
      fileParts,
      attachmentCount: parsed.attachments.length,
      attachedFileCount: fileParts.length,
    }
  }

  private async downloadIncomingAttachmentAsFilePart(attachment: WechatIncomingAttachment): Promise<FileUIPart> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), WECHAT_INCOMING_FETCH_TIMEOUT_MS)
    try {
      const response = await fetch(attachment.url || '', {
        headers: {
          Accept: '*/*',
          'User-Agent': 'Mozilla/5.0 MicroMessenger CipherTalk',
        },
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(`下载失败 HTTP ${response.status}`)
      }
      const contentLength = readNumber({ value: response.headers.get('content-length') || '' }, 'value')
      if (contentLength && contentLength > WECHAT_INCOMING_MAX_FILE_BYTES) {
        throw new Error(`超过 ${formatIncomingBytes(WECHAT_INCOMING_MAX_FILE_BYTES)}`)
      }
      const rawBuffer = Buffer.from(await response.arrayBuffer())
      if (rawBuffer.length === 0) throw new Error('下载内容为空')
      if (rawBuffer.length > WECHAT_INCOMING_MAX_FILE_BYTES) {
        throw new Error(`超过 ${formatIncomingBytes(WECHAT_INCOMING_MAX_FILE_BYTES)}`)
      }

      const buffer = decodeIncomingMediaBuffer(rawBuffer, attachment)
      const detectedMediaType = detectMediaTypeFromBuffer(buffer)
      const headerMediaType = normalizeMediaType(response.headers.get('content-type') || '')
      const mediaType = normalizeMediaType(detectedMediaType || (headerMediaType !== 'application/octet-stream' ? headerMediaType : attachment.mediaType))
      const expectedMediaType = normalizeMediaType(attachment.mediaType)
      if ((expectedMediaType.startsWith('image/') || attachment.kind === 'image') && !detectedMediaType?.startsWith('image/')) {
        throw new Error('图片解密失败或格式不支持')
      }
      if ((expectedMediaType === 'application/pdf' || headerMediaType === 'application/pdf') && detectedMediaType !== 'application/pdf') {
        throw new Error('PDF 解密失败或格式不支持')
      }
      if ((expectedMediaType.startsWith('text/') || expectedMediaType === 'application/json') && !looksMostlyText(buffer)) {
        throw new Error('文本文件解码失败')
      }
      if (!isAgentReadableMediaType(mediaType)) {
        throw new Error(`不支持 ${mediaType}`)
      }

      return {
        type: 'file',
        mediaType,
        filename: attachment.filename,
        url: buildIncomingDataUrl(buffer, mediaType),
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('下载超时')
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    let buf = ''
    const initialSession = this.session
    if (!initialSession) return
    // 先上线通知：不调这个，bot 会显示"暂无法连接 OpenClaw"，且消息不会推过来
    try {
      const r = await notifyStart(initialSession)
      console.log(`[WechatBot] notifyStart ret=${r?.ret ?? 'null'} errmsg=${r?.errmsg ?? ''}`)
      if (r && r.ret !== undefined && r.ret !== 0) {
        this.logger?.warn('WechatBot', 'notifyStart 返回非 0', { ret: r.ret, errmsg: r.errmsg })
      }
    } catch (e) {
      console.warn('[WechatBot] notifyStart 失败（忽略，继续轮询）：', e)
    }
    if (signal.aborted || !this.session) return
    this.logger?.warn('WechatBot', '开始长轮询收消息', { botId: this.session?.botId })
    console.log('[WechatBot] 长轮询已启动 botId=', this.session?.botId)
    while (this.loopRunning && !signal.aborted && this.session) {
      try {
        const session = this.session
        if (!session) break
        const pollStart = Date.now()
        const resp = await getUpdates(session, buf, signal)
        if (signal.aborted) break
        const msgs = resp.msgs ?? []
        if (msgs.length > 0 || (resp.ret !== undefined && resp.ret !== 0)) {
          console.log(`[WechatBot] getUpdates 返回 ret=${resp.ret} msgs=${msgs.length} 耗时=${Date.now() - pollStart}ms buf=${(resp.get_updates_buf || '').slice(0, 20)}`)
        }
        if (resp.ret !== undefined && resp.ret !== 0) {
          console.warn(`[WechatBot] getUpdates 返回非 0 错误码 ret=${resp.ret}，完整响应：`, JSON.stringify(resp))
        }
        if (resp.get_updates_buf) buf = resp.get_updates_buf
        if (msgs.length > 0) {
          console.log('[WechatBot] 收到消息原始内容：', JSON.stringify(msgs))
        }
        for (const msg of msgs) {
          if (signal.aborted) break
          if (msg.message_type !== 1) {
            console.log(`[WechatBot] 跳过非用户消息 message_type=${msg.message_type}`)
            continue // 只处理用户发来的
          }
          const from = msg.from_user_id || ''
          const incoming = await this.prepareIncomingMessage(msg)
          if (!from || (!incoming.agentText && incoming.fileParts.length === 0)) {
            console.log('[WechatBot] 跳过空消息', { from, text: incoming.logText })
            continue
          }
          await this.handleMessage(from, incoming, msg.context_token)
        }
      } catch (e) {
        if (signal.aborted) break
        if (isSessionExpiredError(e)) {
          this.logger?.error('WechatBot', '微信连接已过期，需重新扫码', {})
          this.session = null
          this.clearToken()
          this.loopRunning = false
          this.error = '微信连接已过期，请重新扫码连接'
          this.setStatus('error')
          return
        }
        this.logger?.warn('WechatBot', '收消息出错，3 秒后重试', { error: String(e) })
        await this.sleep(3000)
      }
    }
  }

  private async handleMessage(from: string, incoming: PreparedWechatIncomingMessage, contextToken?: string): Promise<void> {
    if (!this.session) return
    const text = incoming.agentText
    const commandText = incoming.plainText || text
    this.logger?.warn('WechatBot', '收到微信消息', {
      from,
      textLength: text.length,
      attachmentCount: incoming.attachmentCount,
      attachedFileCount: incoming.attachedFileCount,
    })
    console.log(`[WechatBot] 收到消息 from=${from} text="${incoming.logText}" attachments=${incoming.attachmentCount} files=${incoming.attachedFileCount} 开始调用 Agent...`)
    let typing: TypingIndicator | null = null
    try {
      if (await this.handleWechatCommand(from, commandText, contextToken)) return
      void import('../agent/agentCapabilityService')
        .then(({ agentCapabilityService }) => {
          agentCapabilityService.notifyWechatIncomingMessage({ from, text: commandText, at: Date.now() })
        })
        .catch(() => undefined)
      const personaMode = this.getConversationMode(from)
      if (personaMode?.mode === 'persona') {
        await this.handlePersonaModeMessage(from, text, personaMode, contextToken)
        return
      }

      // 这条微信消息也记入 AI 助手历史（source='wechat'，按联系人 from_user_id 归档）
      const { agentConversationStore } = await import('../agent/conversationStore')
      const conv = agentConversationStore.getOrCreateExternal({
        source: 'wechat',
        externalId: from,
        title: `微信 · ${text.slice(0, 16)}`,
      })
      const parts: UIMessage['parts'] = []
      if (text) parts.push({ type: 'text', text })
      parts.push(...incoming.fileParts)
      const userMsg: UIMessage = { id: `wx-u-${Date.now()}`, role: 'user', parts }
      agentConversationStore.append(conv.id, [userMsg])

      const history = agentConversationStore.load(conv.id)?.messages ?? [userMsg]
      typing = await this.startTypingIndicator(from, contextToken)
      const forceVoice = wantsVoiceReply(commandText)
      const allowDesktopScreenshotReply = wantsDesktopScreenshotReply(commandText)
      console.log(`[WechatBot] 开始调用普通 Agent history=${history.length} forceVoice=${forceVoice}`)
      let rawReply = await this.runAgent(history, { allowDesktopScreenshotReply })
      rawReply = await this.completeDesktopScreenshotReplyIfNeeded(rawReply, allowDesktopScreenshotReply)
      console.log(`[WechatBot] 普通 Agent 原始回复 textLength=${rawReply.text.length} bubbles=${rawReply.textBubbles?.length || 0} media=${rawReply.media.length}`)
      const reply = splitVoiceMarkedReply(rawReply, forceVoice)
      console.log(`[WechatBot] Agent 回复长度=${reply.text.length} 媒体=${reply.media.length} voiceMedia=${reply.media.filter((item) => item.kind === 'voice').length} 内容="${reply.text.slice(0, 120)}"`)

      if (reply.text || reply.media.length > 0 || reply.personaActions.length > 0) {
        await typing?.stop()
        typing = null
        const session = this.session
        if (!session) return
        const assistantMsg: UIMessage = {
          id: `wx-a-${Date.now()}`,
          role: 'assistant',
          parts: [{ type: 'text', text: getSavedAssistantText(reply) }]
        }
        agentConversationStore.append(conv.id, [assistantMsg])
        if (reply.text) {
          await this.sendTextBubbles(from, getReplyTextBubbles(reply), contextToken)
        }
        await this.sendReplyMedia(from, reply.media, contextToken)
        await this.executePersonaActions(from, reply.personaActions, contextToken)
        this.logger?.warn('WechatBot', '已回复微信消息', { from, replyLength: reply.text.length, mediaCount: reply.media.length })
        console.log('[WechatBot] 已调用 sendmessage 发送回复')
      } else {
        console.warn('[WechatBot] Agent 回复为空，未发送')
      }
    } catch (e) {
      const errorData = errorToLogData(e)
      this.logger?.error('WechatBot', '生成或发送回复失败，准备发送兜底回复', {
        from,
        textLength: text.length,
        attachmentCount: incoming.attachmentCount,
        attachedFileCount: incoming.attachedFileCount,
        mode: this.getConversationMode(from)?.mode || 'agent',
        fallbackText: WECHAT_REPLY_FALLBACK_TEXT,
        ...errorData,
      })
      console.error('[WechatBot] 生成或发送回复失败，准备发送兜底回复：', JSON.stringify({ from, textLength: text.length, attachmentCount: incoming.attachmentCount, attachedFileCount: incoming.attachedFileCount, ...errorData }))
      console.error('[WechatBot] 原始错误对象：', e)
      try {
        await typing?.stop()
        typing = null
        const session = this.session
        if (session) await sendText(session, from, WECHAT_REPLY_FALLBACK_TEXT, contextToken)
      } catch (e2) {
        this.logger?.error('WechatBot', '兜底回复发送失败', {
          from,
          fallbackText: WECHAT_REPLY_FALLBACK_TEXT,
          ...errorToLogData(e2),
        })
        console.error('[WechatBot] 兜底回复也发送失败：', e2)
      }
    } finally {
      await typing?.stop()
    }
  }

  private async handleWechatCommand(from: string, text: string, contextToken?: string): Promise<boolean> {
    const session = this.session
    if (!session) return false
    const trimmed = text.trim()
    const pending = this.pendingPersonaSelections.get(from)
    if (pending && Date.now() - pending.createdAt > PENDING_SELECTION_TTL_MS) {
      this.pendingPersonaSelections.delete(from)
    } else if (pending && /^\d+$/.test(trimmed)) {
      const index = Number(trimmed) - 1
      const candidate = pending.candidates[index]
      if (!candidate) {
        await sendText(session, from, `请回复 1-${pending.candidates.length} 之间的编号。`, contextToken)
        return true
      }
      this.pendingPersonaSelections.delete(from)
      await this.activatePersonaMode(from, candidate, contextToken)
      return true
    }

    if (isExitPersonaCommand(trimmed)) {
      const mode = this.getConversationMode(from)
      this.clearPersonaQueues(from)
      this.clearConversationMode(from)
      await sendText(session, from, mode
        ? `已退出「${mode.displayName}」的数字分身，恢复普通 AI 助手。`
        : '当前已经是普通 AI 助手模式。',
      contextToken)
      return true
    }

    if (isStatusCommand(trimmed)) {
      const mode = this.getConversationMode(from)
      await sendText(session, from, mode
        ? `当前模式：${mode.displayName} 的数字分身。发送「退出数字分身」可恢复普通 AI 助手。`
        : '当前模式：普通 AI 助手。发送「打开XXX的数字分身」可切换。',
      contextToken)
      return true
    }

    if (isNewConversationCommand(trimmed)) {
      const { agentConversationStore } = await import('../agent/conversationStore')
      const mode = this.getConversationMode(from)
      if (mode?.mode === 'persona') {
        this.detachPersonaQueue(from, mode.sessionId)
        agentConversationStore.createExternal({
          source: 'wechat-persona',
          externalId: `${from}:${mode.sessionId}`,
          title: `微信分身 · ${mode.displayName}`,
          scope: { kind: 'persona', sessionId: mode.sessionId, displayName: mode.displayName },
        })
        await sendText(session, from, '好，我们从这儿重新聊。', contextToken)
      } else {
        agentConversationStore.createExternal({
          source: 'wechat',
          externalId: from,
          title: '微信 · 新会话',
        })
        await sendText(session, from, '好，我们重新开始。', contextToken)
      }
      return true
    }

    if (isHelpCommand(trimmed)) {
      await sendText(session, from,
        '可用命令：\n/new\n打开XXX的数字分身\n和XXX的分身聊天\n退出数字分身\n当前模式',
        contextToken)
      return true
    }

    const query = parseOpenPersonaCommand(trimmed)
    if (!query) return false

    const candidates = await this.searchPersonaContactCandidates(query)
    if (candidates.length === 0) {
      await sendText(session, from, `没有找到「${query}」对应的好友。可以试试备注名、昵称或微信号。`, contextToken)
      return true
    }
    if (candidates.length > 1) {
      this.pendingPersonaSelections.set(from, { query, candidates, createdAt: Date.now() })
      const list = candidates.map((c, i) => `${i + 1}. ${c.displayName}`).join('\n')
      await sendText(session, from, `找到多个「${query}」：\n${list}\n回复编号选择。`, contextToken)
      return true
    }

    await this.activatePersonaMode(from, candidates[0], contextToken)
    return true
  }

  private async activatePersonaMode(from: string, candidate: WechatContactCandidate, contextToken?: string): Promise<void> {
    const session = this.session
    if (!session) return
    const { personaStore } = await import('../agent/persona/personaStore')
    let persona = personaStore.get(candidate.username)
    if (!persona) {
      await sendText(session, from, `还没有「${candidate.displayName}」的数字分身，开始自动克隆。`, contextToken)
      const { buildPersonaFromSession } = await import('../agent/persona/personaBuildService')
      let lastProgressAt = 0
      let lastStage = ''
      const result = await buildPersonaFromSession({
        sessionId: candidate.username,
        displayName: candidate.displayName,
        logger: this.logger,
        onProgress: (progress) => {
          const progressSession = this.session
          if (!progressSession) return
          const now = Date.now()
          if (progress.stage === 'done' || progress.stage === 'error' || progress.stage !== lastStage || now - lastProgressAt > 20_000) {
            lastStage = progress.stage
            lastProgressAt = now
            const detail = progress.detail ? `：${progress.detail}` : ''
            void sendText(progressSession, from, `${progress.title}${detail}`, contextToken).catch((e) => {
              this.logger?.warn('WechatBot', '发送克隆进度失败', { from, error: String(e) })
            })
          }
        },
      })
      if (!result.success) {
        const failSession = this.session
        if (failSession) await sendText(failSession, from, `克隆「${candidate.displayName}」失败：${result.error}`, contextToken)
        return
      }
      persona = result.persona
    }

    this.clearPersonaQueues(from)
    this.setConversationMode(from, {
      mode: 'persona',
      sessionId: persona.sessionId,
      displayName: persona.displayName || candidate.displayName,
    })
    const activeSession = this.session
    if (activeSession) {
      await sendText(activeSession, from, `已开启「${persona.displayName || candidate.displayName}」的数字分身。发送「退出数字分身」可回到普通 AI 助手。`, contextToken)
    }
  }

  private async executePersonaActions(from: string, actions: WechatPersonaAction[], contextToken?: string): Promise<void> {
    if (actions.length === 0) return
    for (const action of actions) {
      try {
        if (action.action === 'ask_persona_build') continue

        if (action.action === 'open_persona_chat') {
          await this.activatePersonaMode(from, {
            username: action.sessionId,
            displayName: action.displayName,
            kind: 'person',
          }, contextToken)
          continue
        }

        if (action.action === 'build_persona') {
          await this.buildPersonaForWechat(from, action.sessionId, action.displayName, contextToken)
          continue
        }

        if (action.action === 'build_session_vectors') {
          await this.buildSessionVectorsForWechat(from, action.sessionId, action.displayName, contextToken)
        }
      } catch (e) {
        this.logger?.error('WechatBot', '执行数字分身动作失败', {
          from,
          action,
          ...errorToLogData(e),
        })
        const session = this.session
        if (session) {
          await sendText(session, from, `执行「${action.displayName}」的数字分身操作失败：${e instanceof Error ? e.message : String(e)}`, contextToken)
        }
      }
    }
  }

  private async buildPersonaForWechat(from: string, sessionId: string, displayName: string, contextToken?: string): Promise<void> {
    const { buildPersonaFromSession } = await import('../agent/persona/personaBuildService')
    let lastProgressAt = 0
    let lastStage = ''
    const result = await buildPersonaFromSession({
      sessionId,
      displayName,
      logger: this.logger,
      onProgress: (progress) => {
        const progressSession = this.session
        if (!progressSession) return
        const now = Date.now()
        if (progress.stage === 'done' || progress.stage === 'error' || progress.stage !== lastStage || now - lastProgressAt > 20_000) {
          lastStage = progress.stage
          lastProgressAt = now
          const detail = progress.detail ? `：${progress.detail}` : ''
          void sendText(progressSession, from, `${progress.title}${detail}`, contextToken).catch((e) => {
            this.logger?.warn('WechatBot', '发送克隆进度失败', { from, error: String(e) })
          })
        }
      },
    })
    const session = this.session
    if (!session) return
    if (!result.success) {
      await sendText(session, from, `克隆「${displayName}」失败：${result.error}`, contextToken)
      return
    }
    await sendText(session, from, `「${result.persona.displayName || displayName}」的数字分身已创建成功。发送「打开${result.persona.displayName || displayName}的数字分身」进入对话。`, contextToken)
  }

  private async buildSessionVectorsForWechat(from: string, sessionId: string, displayName: string, contextToken?: string): Promise<void> {
    const { getEmbeddingConfig } = await import('../ai/embeddingService')
    const { messageVectorService } = await import('../search/messageVectorService')
    const { refreshResolvedProxyUrl } = await import('../ai/proxyFetch')
    const cfg = getEmbeddingConfig()
    const session = this.session
    if (!session) return
    if (!messageVectorService.isReady(cfg)) {
      await sendText(session, from, '未启用或未配置嵌入模型，请先在设置里的嵌入页配置并启用。', contextToken)
      return
    }
    await sendText(session, from, `开始为「${displayName}」建立语义索引。`, contextToken)
    await refreshResolvedProxyUrl()
    let lastProgressAt = 0
    const indexed = await messageVectorService.ensureSessionVectors(sessionId, cfg, undefined, (progress: unknown) => {
      const progressSession = this.session
      if (!progressSession) return
      const now = Date.now()
      if (now - lastProgressAt < 20_000) return
      lastProgressAt = now
      const data = progress as { message?: unknown; current?: unknown; total?: unknown }
      const message = typeof data.message === 'string'
        ? data.message
        : Number.isFinite(Number(data.current)) && Number.isFinite(Number(data.total))
          ? `已处理 ${Number(data.current)}/${Number(data.total)}`
          : '正在建立语义索引'
      void sendText(progressSession, from, message, contextToken).catch((e) => {
        this.logger?.warn('WechatBot', '发送向量化进度失败', { from, error: String(e) })
      })
    })
    let mediaIndexed = 0
    if (messageVectorService.isMediaReady(cfg)) {
      mediaIndexed = await messageVectorService.ensureSessionMediaVectors(sessionId, cfg, undefined, (progress: unknown) => {
        const progressSession = this.session
        if (!progressSession) return
        const now = Date.now()
        if (now - lastProgressAt < 20_000) return
        lastProgressAt = now
        const data = progress as { message?: unknown; current?: unknown; total?: unknown }
        const message = typeof data.message === 'string'
          ? data.message
          : Number.isFinite(Number(data.current)) && Number.isFinite(Number(data.total))
            ? `已处理 ${Number(data.current)}/${Number(data.total)}`
            : '正在建立媒体向量索引'
        void sendText(progressSession, from, message, contextToken).catch((e) => {
          this.logger?.warn('WechatBot', '发送媒体向量化进度失败', { from, error: String(e) })
        })
      })
    }
    const doneSession = this.session
    if (doneSession) await sendText(doneSession, from, `「${displayName}」的语义索引已建立，文本 ${indexed} 条，媒体 ${mediaIndexed} 张。`, contextToken)
  }

  private async handlePersonaModeMessage(from: string, text: string, mode: WechatConversationMode, contextToken?: string): Promise<void> {
    if (!this.session) return
    const queue = await this.getOrCreatePersonaQueue(from, mode, contextToken)
    queue.mode = mode
    queue.contextToken = contextToken
    queue.texts.push(text)
    this.armPersonaQueueFlush(queue)
    this.logger?.warn('WechatBot', '微信数字分身消息已进入等待队列', {
      from,
      sessionId: mode.sessionId,
      pendingCount: queue.texts.length,
      running: queue.running,
    })
  }

  private personaQueueKey(from: string, sessionId: string): string {
    return `${from}:${sessionId}`
  }

  private async getOrCreatePersonaQueue(
    from: string,
    mode: WechatConversationMode,
    contextToken?: string,
  ): Promise<PendingPersonaQueue> {
    const key = this.personaQueueKey(from, mode.sessionId)
    let queue = this.pendingPersonaQueues.get(key)
    if (!queue) {
      const { agentConversationStore } = await import('../agent/conversationStore')
      const conv = agentConversationStore.getOrCreateExternal({
        source: 'wechat-persona',
        externalId: `${from}:${mode.sessionId}`,
        title: `微信分身 · ${mode.displayName}`,
        scope: { kind: 'persona', sessionId: mode.sessionId, displayName: mode.displayName },
      })
      queue = {
        from,
        mode,
        conversationId: conv.id,
        texts: [],
        contextToken,
        timer: null,
        running: false,
        typing: null,
        cancelled: false,
      }
      this.pendingPersonaQueues.set(key, queue)
    }
    if (!queue.typing) {
      queue.typing = await this.startTypingIndicator(from, contextToken)
    }
    return queue
  }

  private armPersonaQueueFlush(queue: PendingPersonaQueue, delayMs?: number): void {
    if (queue.timer) clearTimeout(queue.timer)
    const delay = delayMs ?? PERSONA_PENDING_FLUSH_MIN_MS + Math.random() * (PERSONA_PENDING_FLUSH_MAX_MS - PERSONA_PENDING_FLUSH_MIN_MS)
    queue.timer = setTimeout(() => {
      queue.timer = null
      void this.flushPersonaQueue(queue).catch((e) => {
        this.logger?.error('WechatBot', '微信数字分身队列处理失败', {
          from: queue.from,
          sessionId: queue.mode.sessionId,
          ...errorToLogData(e),
        })
      })
    }, delay)
  }

  private async flushPersonaQueue(queue: PendingPersonaQueue): Promise<void> {
    if (queue.cancelled) return
    if (queue.running) return
    if (queue.texts.length === 0) {
      await this.stopPersonaQueueTyping(queue)
      return
    }

    const activeMode = this.getConversationMode(queue.from)
    if (!activeMode || activeMode.sessionId !== queue.mode.sessionId) {
      this.clearPersonaQueue(queue)
      return
    }

    queue.running = true
    const texts = queue.texts.splice(0)
    const combinedText = texts.join('\n')
    const contextToken = queue.contextToken

    try {
      const { agentConversationStore } = await import('../agent/conversationStore')
      const conv = queue.conversationId
        ? agentConversationStore.loadMeta(queue.conversationId, false) || agentConversationStore.getOrCreateExternal({
          source: 'wechat-persona',
          externalId: `${queue.from}:${queue.mode.sessionId}`,
          title: `微信分身 · ${queue.mode.displayName}`,
          scope: { kind: 'persona', sessionId: queue.mode.sessionId, displayName: queue.mode.displayName },
        })
        : agentConversationStore.getOrCreateExternal({
          source: 'wechat-persona',
          externalId: `${queue.from}:${queue.mode.sessionId}`,
          title: `微信分身 · ${queue.mode.displayName}`,
          scope: { kind: 'persona', sessionId: queue.mode.sessionId, displayName: queue.mode.displayName },
        })
      // 微信里分条发的每条消息存成独立 text part，桌面历史才能像微信一样分条显示（而非挤进一个气泡）
      const userParts = texts.map((t) => t.trim()).filter(Boolean).map((text) => ({ type: 'text' as const, text }))
      const userMsg: UIMessage = {
        id: `wxp-u-${Date.now()}`,
        role: 'user',
        parts: userParts.length ? userParts : [{ type: 'text', text: combinedText }],
      }
      agentConversationStore.append(conv.id, [userMsg])

      const history = agentConversationStore.load(conv.id)?.messages ?? [userMsg]
      const forceVoice = texts.some(wantsVoiceReply)
      let streamedBubbleCount = 0
      let sendChain: Promise<void> = Promise.resolve()
      const enqueuePersonaBubbleSend = (bubble: string, bubbleContext: WechatPersonaBubbleContext) => {
        if (forceVoice) return
        const trimmed = bubble.trim()
        if (!trimmed || PERSONA_STICKER_BUBBLE_RE.test(trimmed)) return
        sendChain = sendChain.then(async () => {
          if (queue.cancelled || !this.session) return
          await this.stopPersonaQueueTyping(queue)
          if (VOICE_MARKER_RE.test(trimmed)) {
            const voiceText = trimmed.replace(VOICE_MARKER_RE, '').trim()
            if (voiceText) {
              await this.sendReplyMedia(queue.from, [{
                kind: 'voice',
                text: voiceText,
                personaVoice: bubbleContext.personaVoice,
                ttsInstructions: bubbleContext.ttsInstructions,
              }], contextToken)
              streamedBubbleCount += 1
            }
            return
          }
          await this.sendTextBubbles(queue.from, [trimmed], contextToken)
          streamedBubbleCount += 1
        })
      }
      const reply = splitVoiceMarkedReply(
        stripPersonaStickerBubbles(await this.runPersonaChat(queue.mode, history, enqueuePersonaBubbleSend)),
        forceVoice,
      )
      await sendChain

      if (queue.cancelled) return
      if (!this.session || (!reply.text && reply.media.length === 0)) return
      await this.stopPersonaQueueTyping(queue)
      agentConversationStore.append(conv.id, [{
        id: `wxp-a-${Date.now()}`,
        role: 'assistant',
        parts: getSavedAssistantBubbles(reply).map((text) => ({ type: 'text' as const, text })),
      }])
      if (forceVoice || streamedBubbleCount === 0) {
        if (reply.text) await this.sendTextBubbles(queue.from, getReplyTextBubbles(reply), contextToken)
        await this.sendReplyMedia(queue.from, reply.media, contextToken)
      }
      this.logger?.warn('WechatBot', '已回复微信数字分身消息', {
        from: queue.from,
        sessionId: queue.mode.sessionId,
        mergedCount: texts.length,
        replyLength: reply.text.length,
        mediaCount: reply.media.length,
        streamedBubbleCount,
      })
    } catch (e) {
      await this.stopPersonaQueueTyping(queue)
      this.logger?.error('WechatBot', '生成或发送微信数字分身回复失败，准备发送兜底回复', {
        from: queue.from,
        sessionId: queue.mode.sessionId,
        displayName: queue.mode.displayName,
        mergedCount: texts.length,
        combinedTextLength: combinedText.length,
        fallbackText: WECHAT_REPLY_FALLBACK_TEXT,
        ...errorToLogData(e),
      })
      const session = this.session
      if (session) {
        try {
          await sendText(session, queue.from, WECHAT_REPLY_FALLBACK_TEXT, contextToken)
        } catch (fallbackError) {
          this.logger?.error('WechatBot', '微信数字分身兜底回复发送失败', {
            from: queue.from,
            sessionId: queue.mode.sessionId,
            fallbackText: WECHAT_REPLY_FALLBACK_TEXT,
            ...errorToLogData(fallbackError),
          })
        }
      }
    } finally {
      queue.running = false
      if (queue.cancelled) {
        await this.stopPersonaQueueTyping(queue)
      } else if (queue.texts.length > 0) {
        queue.typing = queue.typing || await this.startTypingIndicator(queue.from, queue.contextToken)
        this.armPersonaQueueFlush(queue, PERSONA_PENDING_AFTER_BUSY_MS)
      } else {
        await this.stopPersonaQueueTyping(queue)
      }
    }
  }

  private async stopPersonaQueueTyping(queue: PendingPersonaQueue): Promise<void> {
    const typing = queue.typing
    queue.typing = null
    await typing?.stop()
  }

  private clearPersonaQueue(queue: PendingPersonaQueue): void {
    queue.cancelled = true
    if (queue.timer) {
      clearTimeout(queue.timer)
      queue.timer = null
    }
    void this.stopPersonaQueueTyping(queue).catch(() => {})
    this.pendingPersonaQueues.delete(this.personaQueueKey(queue.from, queue.mode.sessionId))
  }

  private detachPersonaQueue(from: string, sessionId: string): void {
    this.pendingPersonaQueues.delete(this.personaQueueKey(from, sessionId))
  }

  private clearPersonaQueues(from: string, exceptSessionId?: string): void {
    for (const queue of Array.from(this.pendingPersonaQueues.values())) {
      if (queue.from === from && queue.mode.sessionId !== exceptSessionId) {
        this.clearPersonaQueue(queue)
      }
    }
  }

  private clearAllPersonaQueues(): void {
    for (const queue of Array.from(this.pendingPersonaQueues.values())) {
      this.clearPersonaQueue(queue)
    }
  }

  private async sendTextBubbles(toUserId: string, bubbles: string[], contextToken?: string): Promise<void> {
    const normalized = normalizeWechatTextBubbles(bubbles)
    for (let i = 0; i < normalized.length; i += 1) {
      const pauseMs = personaBubbleSendPauseMs(i)
      if (pauseMs > 0) await this.sleep(pauseMs)
      const session = this.session
      if (!session) return
      await sendText(session, toUserId, normalized[i], contextToken)
    }
  }

  private async prepareDesktopScreenshotMedia(): Promise<{ success: true; media: WechatBotMedia } | { success: false; error: string }> {
    try {
      const { agentCapabilityService } = await import('../agent/agentCapabilityService')
      const result = await agentCapabilityService.handleCall('desktop_screenshot', {}) as Record<string, unknown>
      if (result?.success !== true) {
        return { success: false, error: String(result?.error || '截图失败') }
      }
      const filePath = typeof result.filePath === 'string' ? result.filePath.trim() : ''
      if (!filePath) return { success: false, error: '截图成功但没有生成文件路径' }
      return { success: true, media: { kind: 'image', filePath, source: 'desktop_screenshot' } }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async completeDesktopScreenshotReplyIfNeeded(reply: WechatBotReply, allowed: boolean): Promise<WechatBotReply> {
    if (!allowed) return reply
    const doneText = '截好了，发你了'
    if (reply.media.some((item) => item.source === 'desktop_screenshot')) {
      return {
        ...reply,
        text: doneText,
        textBubbles: [doneText],
        savedText: `${doneText}\n[已发送截图]`,
        savedTextBubbles: [doneText, '[已发送截图]'],
      }
    }

    const screenshot = await this.prepareDesktopScreenshotMedia()
    if (!screenshot.success) {
      const text = `截图失败：${screenshot.error}`
      return {
        ...reply,
        text,
        textBubbles: [text],
        savedText: text,
        savedTextBubbles: [text],
      }
    }

    const media = dedupeMedia([...reply.media, screenshot.media])
    return {
      ...reply,
      text: doneText,
      textBubbles: [doneText],
      savedText: `${doneText}\n[已发送截图]`,
      savedTextBubbles: [doneText, '[已发送截图]'],
      media,
    }
  }

  private async sendReplyMedia(toUserId: string, media: WechatBotMedia[], contextToken?: string): Promise<void> {
    if (media.length === 0) return
    for (const item of media) {
      try {
        const session = this.session
        if (!session) return
        if (item.caption && item.kind !== 'voice') {
          await sendText(session, toUserId, item.caption, contextToken)
        }
        if (item.kind === 'image') {
          if (!item.filePath) throw new Error('图片路径为空')
          await sendImage(session, toUserId, item.filePath, contextToken)
        } else if (item.kind === 'video') {
          if (!item.filePath) throw new Error('视频路径为空')
          await sendVideo(session, toUserId, item.filePath, contextToken)
        } else if (item.kind === 'voice') {
          const voiceText = String(item.text || '').trim()
          if (!voiceText) throw new Error('语音文本为空')
          console.log(`[WechatBot] 开始合成微信语音 textLength=${voiceText.length}`)
          const voice = await synthesizeWeixinVoice(voiceText, {
            personaVoice: item.personaVoice,
            instructions: item.ttsInstructions,
          })
          console.log(`[WechatBot] 微信语音合成完成 file=${voice.filePath} durationMs=${voice.durationMs} sampleRate=${voice.sampleRate}`)
          await sendVoice(session, toUserId, voice.filePath, {
            playtimeMs: voice.durationMs,
            sampleRate: voice.sampleRate,
            text: voiceText,
            contextToken,
          })
          console.log(`[WechatBot] 微信语音发送完成 to=${toUserId}`)
        } else {
          if (!item.filePath) throw new Error('文件路径为空')
          await sendFile(session, toUserId, item.filePath, contextToken)
        }
        this.logger?.warn('WechatBot', '已回复当前微信会话媒体', { to: toUserId, kind: item.kind, filePath: item.filePath, textLength: item.text?.length })
      } catch (e) {
        const errorData = errorToLogData(e)
        this.logger?.error('WechatBot', '发送微信媒体失败，准备发送文本兜底', {
          to: toUserId,
          kind: item.kind,
          filePath: item.filePath,
          textLength: item.text?.length,
          fallbackText: item.kind === 'voice' && item.text ? item.text : WECHAT_REPLY_FALLBACK_TEXT,
          ...errorData,
        })
        console.error('[WechatBot] 发送媒体失败，准备发送文本兜底：', JSON.stringify({ to: toUserId, kind: item.kind, filePath: item.filePath, textLength: item.text?.length, ...errorData }))
        console.error('[WechatBot] 原始媒体错误对象：', e)
        try {
          const session = this.session
          if (session && item.kind === 'voice' && item.text) {
            await sendText(session, toUserId, item.text, contextToken)
          } else if (session) {
            await sendText(session, toUserId, WECHAT_REPLY_FALLBACK_TEXT, contextToken)
          }
        } catch (fallbackError) {
          this.logger?.error('WechatBot', '媒体失败后的文本兜底也发送失败', {
            to: toUserId,
            kind: item.kind,
            filePath: item.filePath,
            ...errorToLogData(fallbackError),
          })
        }
      }
    }
  }

  private async startTypingIndicator(toUserId: string, contextToken?: string): Promise<{ stop: () => Promise<void> } | null> {
    if (!this.session) return null
    const session = this.session
    let ticket = ''
    try {
      const config = await getConfig(session, toUserId, contextToken)
      if (config?.ret !== undefined && config.ret !== 0) {
        this.logger?.warn('WechatBot', '获取 typing_ticket 返回非 0', { ret: config.ret, errmsg: config.errmsg })
        return null
      }
      ticket = config?.typing_ticket || ''
      if (!ticket) return null
      await sendTyping(session, toUserId, ticket, 1)
      this.logger?.warn('WechatBot', '已发送微信正在输入状态', { to: toUserId })
    } catch (e) {
      this.logger?.warn('WechatBot', '发送微信正在输入状态失败', { to: toUserId, error: String(e) })
      return null
    }

    let stopped = false
    const timer: ReturnType<typeof setInterval> = setInterval(() => {
      if (stopped) return
      void sendTyping(session, toUserId, ticket, 1).catch((e) => {
        this.logger?.warn('WechatBot', '微信正在输入状态保活失败', { to: toUserId, error: String(e) })
      })
    }, TYPING_KEEPALIVE_MS)

    return {
      stop: async () => {
        if (stopped) return
        stopped = true
        clearInterval(timer)
        try {
          await sendTyping(session, toUserId, ticket, 2)
          this.logger?.warn('WechatBot', '已取消微信正在输入状态', { to: toUserId })
        } catch (e) {
          this.logger?.warn('WechatBot', '取消微信正在输入状态失败', { to: toUserId, error: String(e) })
        }
      },
    }
  }

  /** 把对话（历史 + 本轮）交给项目内 Agent，收集流式文本作为当前微信机器人会话的回复。 */
  private async runAgent(
    uiMessages: UIMessage[],
    options: { allowDesktopScreenshotReply?: boolean } = {},
  ): Promise<WechatBotReply> {
    const { convertToModelMessages } = await import('ai')
    const { agentProcessService } = await import('../agent/agentProcessService')
    const { agentProfileService } = await import('../agent/agentProfileService')
    agentProcessService.setLogger(this.logger as never)
    const profile = await agentProfileService.resolve({
      mode: 'wechat-bot',
      scope: { kind: 'global' },
      ensureCodeWorkspace: true,
      includeMcpSkills: true,
      queryText: lastUserTextFromUiMessages(uiMessages),
    })
    const messages = await convertToModelMessages(uiMessages)
    let reply = ''
    const textBlocks: string[] = []
    const textBlockIndexes = new Map<string, number>()
    const media: WechatBotMedia[] = []
    const personaActions: WechatPersonaAction[] = []
    const toolNames = new Map<string, string>()
    await agentProcessService.run(
      {
        messages,
        providerConfig: profile.providerConfig,
        scope: profile.scope,
        mcpTools: profile.mcpTools,
        skills: profile.skills,
        toolMode: 'default',
        outputMode: 'wechat',
        allowWechatReplyMedia: true,
        planMode: false,
        toolProfile: profile.toolProfile,
        codeWorkspace: profile.codeWorkspace,
      },
      (chunk) => {
        rememberToolNameFromChunk(chunk, toolNames)
        const c = chunk as { type?: string; id?: string; delta?: string; text?: string }
        if (c?.type === 'text-start') {
          const id = c.id || `text-${textBlocks.length}`
          if (!textBlockIndexes.has(id)) {
            textBlockIndexes.set(id, textBlocks.length)
            textBlocks.push('')
          }
        } else if (c?.type === 'text-delta') {
          const delta = c.delta ?? c.text ?? ''
          reply += delta
          const id = c.id || 'default'
          let index = textBlockIndexes.get(id)
          if (index === undefined) {
            index = textBlocks.length
            textBlockIndexes.set(id, index)
            textBlocks.push('')
          }
          textBlocks[index] += delta
        }
        const item = extractMediaFromToolChunk(chunk, toolNames, {
          allowDesktopScreenshotReply: options.allowDesktopScreenshotReply,
        })
        if (item) {
          media.push(item)
          this.logger?.warn('WechatBot', '已收集 Agent 媒体输出', { kind: item.kind, filePath: item.filePath })
        }
        const personaAction = extractPersonaActionFromToolChunk(chunk, toolNames)
        if (personaAction) {
          personaActions.push(personaAction)
          this.logger?.warn('WechatBot', '已收集 Agent 数字分身动作', personaAction)
        }
      },
    )
    const rawReplyBubbles = textBlocks.length > 0
      ? normalizeWechatTextBubbles(textBlocks)
      : normalizeWechatTextBubbles([reply])
    const replyBubbles = rawReplyBubbles.flatMap(splitWechatMarkedBubbles)
    const directiveReply = await extractMediaDirectivesFromBubbles(replyBubbles)
    const mediaOut = dedupeMedia([...media, ...directiveReply.media])
    const personaActionsOut = dedupePersonaActions(personaActions)
    const savedTextBubbles = buildSavedReplyBubbles(rawReplyBubbles, mediaOut, personaActionsOut)
    return {
      text: directiveReply.text,
      textBubbles: directiveReply.textBubbles,
      savedText: savedTextBubbles.join('\n'),
      savedTextBubbles,
      media: mediaOut,
      personaActions: personaActionsOut,
    }
  }

  private async runPersonaChat(
    mode: WechatConversationMode,
    uiMessages: UIMessage[],
    onTextBubble?: (bubble: string, context: WechatPersonaBubbleContext) => void,
  ): Promise<WechatBotReply> {
    const { personaStore } = await import('../agent/persona/personaStore')
    const persona = personaStore.get(mode.sessionId)
    if (!persona) {
      return { text: `「${mode.displayName}」的数字分身不存在，请重新发送「打开${mode.displayName}的数字分身」。`, media: [], personaActions: [] }
    }
    const { resolveProviderConfig } = await import('../agent/resolveProviderConfig')
    const { refreshResolvedProxyUrl } = await import('../ai/proxyFetch')
    const { convertToModelMessages } = await import('ai')
    const { agentProcessService } = await import('../agent/agentProcessService')
    agentProcessService.setLogger(this.logger as never)
    const providerConfig = resolveProviderConfig()
    await refreshResolvedProxyUrl()
    let notes: import('../agent/persona/personaTypes').PersonaNotes | undefined
    try {
      const { personaNotesStore } = await import('../agent/persona/personaNotesStore')
      notes = personaNotesStore.getNotes(mode.sessionId)
    } catch {
      // 无笔记照常聊
    }
    const messages = await convertToModelMessages(uiMessages)
    const textBubbles: string[] = []
    const textBlocks: string[] = []
    const textBlockIndexes = new Map<string, number>()
    const emittedTextBlockIndexes = new Set<number>()
    const bubbleContext: WechatPersonaBubbleContext = {
      personaVoice: persona.ttsVoice,
      ttsInstructions: persona.card.ttsInstructions,
    }
    const ensureTextBlock = (id: string): number => {
      let index = textBlockIndexes.get(id)
      if (index !== undefined) return index
      index = textBlocks.length
      textBlockIndexes.set(id, index)
      textBlocks.push('')
      return index
    }
    const emitTextBlock = (id: string) => {
      const index = textBlockIndexes.get(id)
      if (index === undefined || emittedTextBlockIndexes.has(index)) return
      emittedTextBlockIndexes.add(index)
      for (const bubble of normalizeWechatTextBubbles([textBlocks[index]])) {
        textBubbles.push(bubble)
        onTextBubble?.(bubble, bubbleContext)
      }
    }
    await agentProcessService.personaChat({
      providerConfig,
      persona: {
        sessionId: persona.sessionId,
        displayName: persona.displayName,
        card: persona.card,
        fewShots: persona.fewShots,
        stats: persona.stats,
        profile: persona.profile,
        notes,
        stickers: persona.stickers,
        ttsVoice: persona.ttsVoice,
      },
      messages,
      outputMode: 'wechat',
    }, (chunk) => {
      const c = chunk as { type?: string; id?: string; delta?: string; text?: string }
      if (c?.type === 'text-start') {
        ensureTextBlock(c.id || `text-${textBlocks.length}`)
      } else if (c?.type === 'text-delta') {
        const id = c.id || 'default'
        const index = ensureTextBlock(id)
        textBlocks[index] += c.delta ?? c.text ?? ''
      } else if (c?.type === 'text-end') {
        emitTextBlock(c.id || 'default')
      }
    })
    for (const [id] of textBlockIndexes) emitTextBlock(id)
    return {
      text: textBubbles.join('\n'),
      textBubbles: normalizeWechatTextBubbles(textBubbles),
      media: [],
      personaActions: [],
      personaVoice: persona.ttsVoice,
      ttsInstructions: persona.card.ttsInstructions,
    }
  }

  // ── token 持久化（userData 下独立 JSON，不混入共享 config） ──
  private tokenPath(): string {
    return join(getUserDataPath(), TOKEN_FILE)
  }

  private loadToken(): IlinkSession | null {
    try {
      const p = this.tokenPath()
      if (!existsSync(p)) return null
      const data = JSON.parse(readFileSync(p, 'utf-8')) as StoredToken
      if (!data.token) return null
      return { token: data.token, baseUrl: data.baseUrl || ILINK_BASE_URL, botId: data.botId || '', userId: data.userId || '' }
    } catch {
      return null
    }
  }

  private saveToken(session: IlinkSession): void {
    try {
      const payload: StoredToken = { ...session, savedAt: new Date().toISOString() }
      writeFileSync(this.tokenPath(), JSON.stringify(payload, null, 2), 'utf-8')
    } catch (e) {
      this.logger?.warn('WechatBot', '保存 token 失败', { error: String(e) })
    }
  }

  private clearToken(): void {
    try {
      const p = this.tokenPath()
      if (existsSync(p)) unlinkSync(p)
    } catch {
      /* ignore */
    }
  }

  private modePath(): string {
    return join(getUserDataPath(), MODE_FILE)
  }

  private loadModes(): Record<string, WechatConversationMode> {
    try {
      const p = this.modePath()
      if (!existsSync(p)) return {}
      const data = JSON.parse(readFileSync(p, 'utf-8')) as StoredModes
      return data.modes && typeof data.modes === 'object' ? data.modes : {}
    } catch {
      return {}
    }
  }

  private saveModes(): void {
    try {
      writeFileSync(this.modePath(), JSON.stringify({ modes: this.modes }, null, 2), 'utf-8')
    } catch (e) {
      this.logger?.warn('WechatBot', '保存微信模式状态失败', { error: String(e) })
    }
  }

  private getConversationMode(from: string): WechatConversationMode | null {
    const mode = this.modes[from]
    return mode?.mode === 'persona' && mode.sessionId ? mode : null
  }

  private setConversationMode(from: string, mode: WechatConversationMode): void {
    this.modes[from] = mode
    this.saveModes()
  }

  private clearConversationMode(from: string): void {
    if (!this.modes[from]) return
    delete this.modes[from]
    this.saveModes()
  }

  private async searchPersonaContactCandidates(query: string): Promise<WechatContactCandidate[]> {
    const q = query.trim()
    if (!q) return []
    const { dbAdapter } = await import('../dbAdapter')
    const cols = await dbAdapter.all<{ name: string }>('contact', '', 'PRAGMA table_info(contact)')
    const colSet = new Set(cols.map((c) => c.name))
    if (!colSet.has('username')) return []
    const selectCols = ['username', 'remark', 'nick_name', 'alias'].filter((c) => colSet.has(c))
    const likeCols = ['remark', 'nick_name', 'alias', 'username'].filter((c) => colSet.has(c))
    if (likeCols.length === 0) return []
    const where = likeCols.map((c) => `${c} LIKE ?`).join(' OR ')
    const rows = await dbAdapter.all<any>('contact', '', `SELECT ${selectCols.join(', ')} FROM contact WHERE ${where} LIMIT ?`, [
      ...likeCols.map(() => `%${q}%`),
      20,
    ])
    const seen = new Set<string>()
    return rows
      .map((row): WechatContactCandidate => {
        const username = String(row.username || '').trim()
        return {
          username,
          displayName: String(row.remark || row.nick_name || row.alias || username).trim() || username,
          kind: classifyContact(username),
        }
      })
      .filter((item) => {
        if (!item.username || item.kind !== 'person' || seen.has(item.username)) return false
        seen.add(item.username)
        return true
      })
      .sort((a, b) => {
        const rank = (item: WechatContactCandidate) => {
          if (item.displayName === q || item.username === q) return 0
          if (item.displayName.startsWith(q) || item.username.startsWith(q)) return 1
          return 2
        }
        return rank(a) - rank(b) || a.displayName.localeCompare(b.displayName, 'zh-CN')
      })
      .slice(0, 8)
  }

  // ── 工具 ──
  private setStatus(status: WechatBotStatus): void {
    this.status = status
    this.broadcast('status', this.getStatus())
  }

  private broadcast(event: string, payload: unknown): void {
    this.ctx?.broadcastToWindows(`deviceConnect:wechat:${event}`, payload)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

export const weixinBotService = new WeixinBotService()
