/**
 * 微信 iLink Bot API 裸调客户端 —— 直连 ilinkai.weixin.qq.com，不经 OpenClaw。
 * 协议参考 Tencent/openclaw-weixin（开源插件）。本文件只做无状态 HTTP 调用，
 * 连接状态/循环/token 持久化都在 weixinBotService。
 */
import crypto from 'crypto'
import { createCipheriv } from 'crypto'
import { existsSync, readFileSync, statSync } from 'fs'
import { basename, extname } from 'path'

export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
const BOT_TYPE = '3'
// 与官方插件 @tencent-weixin/openclaw-weixin 对齐：服务器据此识别合法客户端并标记"已连接"
const CHANNEL_VERSION = '2.4.4'
const ILINK_APP_ID = 'bot' // 插件 package.json 的 ilink_appid 字段
const BOT_AGENT = 'OpenClaw'
const CDN_UPLOAD_RETRIES = 3
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_FILE_BYTES = 100 * 1024 * 1024
const MAX_VIDEO_BYTES = 100 * 1024 * 1024
const MAX_VOICE_BYTES = 10 * 1024 * 1024

const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const

const MessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const

/** iLink-App-ClientVersion：uint32 = major<<16 | minor<<8 | patch（高 8 位固定 0）。 */
function buildClientVersion(version: string): number {
  const parts = version.split('.').map((p) => parseInt(p, 10))
  const major = parts[0] ?? 0
  const minor = parts[1] ?? 0
  const patch = parts[2] ?? 0
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}
const ILINK_APP_CLIENT_VERSION = String(buildClientVersion(CHANNEL_VERSION))

/** 每个请求都带的客户端标识头（GET/POST 通用） */
function commonHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
  }
}

function buildBaseInfo(): Record<string, string> {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT }
}

export interface IlinkSession {
  token: string
  baseUrl: string
  botId: string
  userId: string
}

export interface IlinkQrcode {
  /** 轮询状态用的二维码标识 */
  qrcode: string
  /** 待编码成二维码图片的内容（微信扫码连接用的 URL 字符串，不是图片本身） */
  qrcodeContent: string
}

export type IlinkQrStatus = 'wait' | 'scaned' | 'expired' | 'confirmed'

export interface IlinkQrStatusResp {
  status: IlinkQrStatus
  bot_token?: string
  baseurl?: string
  ilink_bot_id?: string
  ilink_user_id?: string
}

export interface IlinkMessageItem {
  type: number
  text_item?: { text?: string }
  image_item?: IlinkImageItem
  voice_item?: IlinkVoiceItem
  file_item?: IlinkFileItem
  video_item?: IlinkVideoItem
}

export interface IlinkMessage {
  from_user_id?: string
  to_user_id?: string
  message_type?: number
  context_token?: string
  item_list?: IlinkMessageItem[]
}

export interface IlinkUpdates {
  ret?: number
  msgs?: IlinkMessage[]
  get_updates_buf?: string
}

export interface IlinkConfigResp {
  ret?: number
  errmsg?: string
  typing_ticket?: string
}

export type IlinkTypingStatus = 1 | 2

export interface IlinkUploadUrlResp {
  upload_param?: string
  thumb_upload_param?: string
  upload_full_url?: string
}

interface UploadedMediaInfo {
  filekey: string
  downloadEncryptedQueryParam: string
  aeskey: string
  fileSize: number
  fileSizeCiphertext: number
}

interface IlinkCdnMedia {
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
  full_url?: string
}

interface IlinkImageItem {
  aeskey?: string
  media?: IlinkCdnMedia
  mid_size?: number
  thumb_size?: number
  hd_size?: number
}

interface IlinkVoiceItem {
  aeskey?: string
  media?: IlinkCdnMedia
  encode_type?: number
  bits_per_sample?: number
  sample_rate?: number
  playtime?: number
  text?: string
}

interface IlinkFileItem {
  aeskey?: string
  media?: IlinkCdnMedia
  file_name?: string
  len?: string
}

interface IlinkVideoItem {
  aeskey?: string
  media?: IlinkCdnMedia
  video_size?: number
  play_length?: number
  video_md5?: string
}

/** X-WECHAT-UIN：随机 uint32 → 十进制字符串 → base64（每请求一变） */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf-8').toString('base64')
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    ...commonHeaders(),
  }
  // 注意：不要手动设 Content-Length，undici 会自动按 body 计算，手动设会报 invalid content-length
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

async function apiGet<T>(baseUrl: string, path: string): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, '')}/${path}`
  const res = await fetch(url, { headers: commonHeaders() })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`)
  return JSON.parse(text) as T
}

/** POST：自动包 base_info；返回 null 表示长轮询超时（正常）。 */
async function apiPost<T>(
  baseUrl: string,
  endpoint: string,
  body: Record<string, unknown>,
  token?: string,
  timeoutMs = 15_000,
  signal?: AbortSignal,
): Promise<T | null> {
  const url = `${baseUrl.replace(/\/$/, '')}/${endpoint}`
  const payload = { ...body, base_info: buildBaseInfo() }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(token),
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`)
    return JSON.parse(text) as T
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return null
    throw err
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

async function apiPostRaw(
  baseUrl: string,
  endpoint: string,
  body: Record<string, unknown>,
  token?: string,
  timeoutMs = 15_000,
): Promise<void> {
  await apiPost(baseUrl, endpoint, body, token, timeoutMs)
}

/** 获取扫码连接二维码 */
export async function fetchQrcode(): Promise<IlinkQrcode> {
  const resp = await apiGet<{ qrcode: string; qrcode_img_content: string }>(
    ILINK_BASE_URL,
    `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
  )
  return { qrcode: resp.qrcode, qrcodeContent: resp.qrcode_img_content }
}

/** 轮询二维码状态 */
export async function fetchQrcodeStatus(qrcode: string): Promise<IlinkQrStatusResp> {
  return apiGet<IlinkQrStatusResp>(
    ILINK_BASE_URL,
    `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
  )
}

/** 通知微信：本通道客户端已上线（不调这个 bot 会显示"暂无法连接"）。 */
export async function notifyStart(session: IlinkSession): Promise<{ ret?: number; errmsg?: string } | null> {
  return apiPost<{ ret?: number; errmsg?: string }>(
    session.baseUrl,
    'ilink/bot/msg/notifystart',
    {},
    session.token,
    10_000,
  )
}

/** 通知微信：本通道客户端下线。 */
export async function notifyStop(session: IlinkSession): Promise<{ ret?: number; errmsg?: string } | null> {
  return apiPost<{ ret?: number; errmsg?: string }>(
    session.baseUrl,
    'ilink/bot/msg/notifystop',
    {},
    session.token,
    10_000,
  )
}

/** 长轮询取新消息（服务器最多 hold 35s，这里 38s 超时） */
export async function getUpdates(session: IlinkSession, buf: string, signal?: AbortSignal): Promise<IlinkUpdates> {
  const resp = await apiPost<IlinkUpdates>(
    session.baseUrl,
    'ilink/bot/getupdates',
    { get_updates_buf: buf ?? '' },
    session.token,
    38_000,
    signal,
  )
  return resp ?? { ret: 0, msgs: [], get_updates_buf: buf }
}

/** 获取媒体上传地址。mediaType: 1=图片，3=文件。 */
export async function getUploadUrl(
  session: IlinkSession,
  mediaType: number,
  toUserId: string,
  fileName: string,
  fileSize: number,
  rawFileMd5: string,
  aeskey: string,
): Promise<IlinkUploadUrlResp> {
  const filekey = createFileKey(fileName)
  return apiPost<IlinkUploadUrlResp>(
    session.baseUrl,
    'ilink/bot/getuploadurl',
    {
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize: fileSize,
      rawfilemd5: rawFileMd5,
      filesize: aesEcbPaddedSize(fileSize),
      no_need_thumb: true,
      aeskey,
    },
    session.token,
  ).then((resp) => ({ ...(resp || {}), filekey } as IlinkUploadUrlResp & { filekey: string }))
}

/** 上传加密后的媒体到微信 CDN，返回 x-encrypted-param。 */
export async function uploadEncryptedMedia(
  uploadUrl: string,
  encryptedBuffer: Buffer,
): Promise<string> {
  let lastError: unknown
  for (let attempt = 1; attempt <= CDN_UPLOAD_RETRIES; attempt += 1) {
    try {
      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(encryptedBuffer),
      })
      if (res.status >= 400 && res.status < 500) {
        const detail = res.headers.get('x-error-message') || await res.text().catch(() => '')
        throw new Error(`CDN upload client error ${res.status}: ${detail}`)
      }
      if (res.status !== 200) {
        const detail = res.headers.get('x-error-message') || `status ${res.status}`
        throw new Error(`CDN upload server error: ${detail}`)
      }
      const encryptedParam = res.headers.get('x-encrypted-param')
      if (!encryptedParam) throw new Error('CDN upload response missing x-encrypted-param')
      return encryptedParam
    } catch (err) {
      lastError = err
      if (err instanceof Error && err.message.includes('client error')) throw err
    }
  }
  throw lastError instanceof Error ? lastError : new Error('CDN upload failed')
}

/** 获取账号配置，包含发送 typing 状态需要的 typing_ticket。 */
export async function getConfig(
  session: IlinkSession,
  ilinkUserId: string,
  contextToken?: string,
): Promise<IlinkConfigResp | null> {
  return apiPost<IlinkConfigResp>(
    session.baseUrl,
    'ilink/bot/getconfig',
    {
      ilink_user_id: ilinkUserId,
      context_token: contextToken,
    },
    session.token,
    10_000,
  )
}

/** 发送或取消“正在输入中”状态：1=正在输入，2=取消。 */
export async function sendTyping(
  session: IlinkSession,
  ilinkUserId: string,
  typingTicket: string,
  status: IlinkTypingStatus,
): Promise<void> {
  await apiPost(
    session.baseUrl,
    'ilink/bot/sendtyping',
    {
      ilink_user_id: ilinkUserId,
      typing_ticket: typingTicket,
      status,
    },
    session.token,
    10_000,
  )
}

/** 发送文本消息（必须回传 context_token，否则消息关联不上会话） */
export async function sendText(
  session: IlinkSession,
  toUserId: string,
  text: string,
  contextToken?: string,
): Promise<void> {
  await apiPost(
    session.baseUrl,
    'ilink/bot/sendmessage',
    {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: `ct-${crypto.randomUUID()}`,
        message_type: 2, // BOT
        message_state: 2, // FINISH
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
    },
    session.token,
  )
}

export async function sendImage(
  session: IlinkSession,
  toUserId: string,
  filePath: string,
  contextToken?: string,
): Promise<void> {
  const uploaded = await uploadLocalMedia(session, toUserId, filePath, UploadMediaType.IMAGE, MAX_IMAGE_BYTES)
  await sendMediaItem(session, toUserId, {
    type: MessageItemType.IMAGE,
    image_item: {
      media: toCdnMedia(uploaded),
      mid_size: uploaded.fileSizeCiphertext,
    },
  }, contextToken)
}

export async function sendFile(
  session: IlinkSession,
  toUserId: string,
  filePath: string,
  contextToken?: string,
): Promise<void> {
  const uploaded = await uploadLocalMedia(session, toUserId, filePath, UploadMediaType.FILE, MAX_FILE_BYTES)
  await sendMediaItem(session, toUserId, {
    type: MessageItemType.FILE,
    file_item: {
      media: toCdnMedia(uploaded),
      file_name: basename(filePath),
      len: String(uploaded.fileSize),
    },
  }, contextToken)
}

export async function sendVideo(
  session: IlinkSession,
  toUserId: string,
  filePath: string,
  contextToken?: string,
): Promise<void> {
  const uploaded = await uploadLocalMedia(session, toUserId, filePath, UploadMediaType.VIDEO, MAX_VIDEO_BYTES)
  await sendMediaItem(session, toUserId, {
    type: MessageItemType.VIDEO,
    video_item: {
      media: toCdnMedia(uploaded),
      video_size: uploaded.fileSizeCiphertext,
    },
  }, contextToken)
}

export async function sendVoice(
  session: IlinkSession,
  toUserId: string,
  filePath: string,
  options: { playtimeMs: number; sampleRate?: number; text?: string; contextToken?: string },
): Promise<void> {
  const uploaded = await uploadLocalMedia(session, toUserId, filePath, UploadMediaType.VOICE, MAX_VOICE_BYTES)
  await sendMediaItem(session, toUserId, {
    type: MessageItemType.VOICE,
    voice_item: {
      media: toCdnMedia(uploaded),
      encode_type: 6,
      bits_per_sample: 16,
      sample_rate: options.sampleRate || 24000,
      playtime: Math.max(1, Math.round(options.playtimeMs)),
      text: options.text,
    },
  }, options.contextToken)
}

/** 从消息 item_list 提取可读文本（非文本类型给占位标记） */
export function extractText(msg: IlinkMessage): string {
  for (const item of msg.item_list ?? []) {
    if (item.type === 1 && item.text_item?.text) return item.text_item.text
    if (item.type === 3 && item.voice_item?.text) return `[语音] ${item.voice_item.text}`
    if (item.type === 2) return '[图片]'
    if (item.type === 4) return `[文件] ${item.file_item?.file_name ?? ''}`
    if (item.type === 5) return '[视频]'
  }
  return ''
}

/** 判断是否为会话过期错误（需重新扫码连接） */
export function isSessionExpiredError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('session timeout') || msg.includes('-14')
}

function createFileKey(fileName: string): string {
  const ext = extname(fileName).replace(/[^a-z0-9.]/gi, '').slice(0, 16)
  return `${crypto.randomBytes(16).toString('hex')}${ext}`
}

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16
}

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

function buildCdnUploadUrl(baseUrl: string, uploadParam: string, filekey: string): string {
  return `${baseUrl.replace(/\/$/, '')}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
}

async function uploadLocalMedia(
  session: IlinkSession,
  toUserId: string,
  filePath: string,
  mediaType: number,
  maxBytes: number,
): Promise<UploadedMediaInfo> {
  if (!existsSync(filePath)) throw new Error(`媒体文件不存在: ${filePath}`)
  const stat = statSync(filePath)
  if (!stat.isFile()) throw new Error(`媒体路径不是文件: ${filePath}`)
  if (stat.size <= 0) throw new Error('媒体文件为空')
  if (stat.size > maxBytes) throw new Error(`媒体文件过大，最大 ${Math.floor(maxBytes / 1024 / 1024)}MB`)

  const plaintext = readFileSync(filePath)
  const rawFileMd5 = crypto.createHash('md5').update(plaintext).digest('hex')
  const aeskey = crypto.randomBytes(16)
  const filekey = createFileKey(filePath)
  const uploadUrlResp = await apiPost<IlinkUploadUrlResp>(
    session.baseUrl,
    'ilink/bot/getuploadurl',
    {
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize: plaintext.length,
      rawfilemd5: rawFileMd5,
      filesize: aesEcbPaddedSize(plaintext.length),
      no_need_thumb: true,
      aeskey: aeskey.toString('hex'),
    },
    session.token,
  )

  const uploadFullUrl = uploadUrlResp?.upload_full_url?.trim()
  const uploadParam = uploadUrlResp?.upload_param
  if (!uploadFullUrl && !uploadParam) throw new Error('getuploadurl 未返回上传地址')
  const uploadUrl = uploadFullUrl || buildCdnUploadUrl(session.baseUrl, String(uploadParam), filekey)
  const encryptedBuffer = encryptAesEcb(plaintext, aeskey)
  const downloadEncryptedQueryParam = await uploadEncryptedMedia(uploadUrl, encryptedBuffer)

  return {
    filekey,
    downloadEncryptedQueryParam,
    aeskey: aeskey.toString('hex'),
    fileSize: plaintext.length,
    fileSizeCiphertext: encryptedBuffer.length,
  }
}

function toCdnMedia(uploaded: UploadedMediaInfo): IlinkCdnMedia {
  return {
    encrypt_query_param: uploaded.downloadEncryptedQueryParam,
    aes_key: Buffer.from(uploaded.aeskey).toString('base64'),
    encrypt_type: 1,
  }
}

async function sendMediaItem(
  session: IlinkSession,
  toUserId: string,
  item: IlinkMessageItem,
  contextToken?: string,
): Promise<void> {
  await apiPostRaw(
    session.baseUrl,
    'ilink/bot/sendmessage',
    {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: `ct-${crypto.randomUUID()}`,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [item],
      },
    },
    session.token,
  )
}
