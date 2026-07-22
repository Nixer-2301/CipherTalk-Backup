import { randomUUID } from 'crypto'
import { ProxyAgent, WebSocket } from 'undici'
import { getResolvedProxyUrl } from './proxyFetch'

export const VOLCENGINE_REALTIME_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue'
export const VOLCENGINE_REALTIME_RESOURCE_ID = 'volc.speech.dialog'
export const VOLCENGINE_REALTIME_APP_KEY = 'PlgvMymc7f3tQnJ6'

export type VolcengineRealtimeEvent =
  | { type: 'connected'; dialogId?: string }
  | { type: 'speech-started'; questionId?: string }
  | { type: 'asr'; text: string; interim: boolean }
  | { type: 'asr-ended' }
  | { type: 'chat'; text: string; questionId?: string; replyId?: string }
  | { type: 'chat-ended'; questionId?: string; replyId?: string }
  | { type: 'tts-start'; text?: string; questionId?: string; replyId?: string }
  | { type: 'audio'; audioBase64: string; sampleRate: 24000; channels: 1 }
  | { type: 'tts-ended'; questionId?: string; replyId?: string; statusCode?: string }
  | { type: 'ended' }
  | { type: 'error'; error: string; errorCode?: number }

export interface VolcengineRealtimeOptions {
  appId: string
  accessKey: string
  speaker: string
  botName: string
  model: '1.2.1.1' | '2.2.0.0'
  systemRole?: string
  speakingStyle?: string
  characterManifest?: string
  dialogContext?: Array<{ role: 'user' | 'assistant'; text: string; timestamp?: number }>
  endpoint?: string
  onEvent: (event: VolcengineRealtimeEvent) => void
}

enum EventType {
  StartConnection = 1,
  FinishConnection = 2,
  ConnectionStarted = 50,
  ConnectionFailed = 51,
  ConnectionFinished = 52,
  StartSession = 100,
  FinishSession = 102,
  SessionStarted = 150,
  SessionFinished = 152,
  SessionFailed = 153,
  TaskRequest = 200,
  ConversationTruncate = 513,
  TTSSentenceStart = 350,
  TTSResponse = 352,
  TTSEnded = 359,
  ASRInfo = 450,
  ASRResponse = 451,
  ASREnded = 459,
  ChatResponse = 550,
  ChatEnded = 559,
  DialogCommonError = 599,
}

enum MsgType {
  FullClientRequest = 0b0001,
  AudioOnlyClient = 0b0010,
  FullServerResponse = 0b1001,
  AudioOnlyServer = 0b1011,
  Error = 0b1111,
}

const WITH_EVENT = 0b0100
const SERIALIZATION_RAW = 0
const SERIALIZATION_JSON = 0b0001

type ProtocolMessage = {
  type: MsgType
  flag: number
  serialization: number
  event?: EventType
  sessionId?: string
  connectId?: string
  errorCode?: number
  payload: Uint8Array
}

function jsonBytes(payload: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(payload), 'utf8')
}

function uint32Bytes(value: number): Uint8Array {
  const buffer = Buffer.allocUnsafe(4)
  buffer.writeUInt32BE(value, 0)
  return buffer
}

function int32Bytes(value: number): Uint8Array {
  const buffer = Buffer.allocUnsafe(4)
  buffer.writeInt32BE(value, 0)
  return buffer
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

export function marshalVolcengineRealtimeMessage(message: ProtocolMessage): Uint8Array {
  const header = new Uint8Array([0x11, (message.type << 4) | message.flag, message.serialization << 4, 0])
  const parts: Uint8Array[] = [header]
  if (message.flag === WITH_EVENT && message.event !== undefined) {
    parts.push(int32Bytes(message.event))
    if (message.event !== EventType.StartConnection && message.event !== EventType.FinishConnection) {
      const sessionId = Buffer.from(message.sessionId || '', 'utf8')
      parts.push(uint32Bytes(sessionId.length), sessionId)
    }
  }
  parts.push(uint32Bytes(message.payload.length), message.payload)
  return concatBytes(parts)
}

function readUint32(data: Uint8Array, offset: number, label: string): { value: number; offset: number } {
  if (offset + 4 > data.length) throw new Error(`豆包 Realtime 响应缺少 ${label}`)
  return { value: new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, false), offset: offset + 4 }
}

function readInt32(data: Uint8Array, offset: number, label: string): { value: number; offset: number } {
  if (offset + 4 > data.length) throw new Error(`豆包 Realtime 响应缺少 ${label}`)
  return { value: new DataView(data.buffer, data.byteOffset + offset, 4).getInt32(0, false), offset: offset + 4 }
}

function readBytes(data: Uint8Array, offset: number, size: number, label: string): { value: Uint8Array; offset: number } {
  if (offset + size > data.length) throw new Error(`豆包 Realtime 响应 ${label} 长度无效`)
  return { value: data.slice(offset, offset + size), offset: offset + size }
}

function readString(data: Uint8Array, offset: number, label: string): { value: string; offset: number } {
  const size = readUint32(data, offset, `${label} 长度`)
  const bytes = readBytes(data, size.offset, size.value, label)
  return { value: Buffer.from(bytes.value).toString('utf8'), offset: bytes.offset }
}

function isConnectionEvent(event?: EventType): boolean {
  return event === EventType.ConnectionStarted || event === EventType.ConnectionFailed || event === EventType.ConnectionFinished
}

function hasSessionId(event?: EventType): boolean {
  return event !== undefined &&
    event !== EventType.StartConnection &&
    event !== EventType.FinishConnection &&
    !isConnectionEvent(event)
}

export function unmarshalVolcengineRealtimeMessage(data: Uint8Array): ProtocolMessage {
  if (data.length < 4) throw new Error('豆包 Realtime 响应过短')
  const type = (data[1] >> 4) as MsgType
  const flag = data[1] & 0x0f
  let offset = (data[0] & 0x0f) * 4
  const message: ProtocolMessage = {
    type,
    flag,
    serialization: data[2] >> 4,
    payload: new Uint8Array(0),
  }

  if (type === MsgType.Error) {
    const error = readUint32(data, offset, '错误码')
    message.errorCode = error.value
    offset = error.offset
  }
  if (flag === WITH_EVENT) {
    const event = readInt32(data, offset, '事件号')
    message.event = event.value as EventType
    offset = event.offset
    if (hasSessionId(message.event)) {
      const session = readString(data, offset, 'session id')
      message.sessionId = session.value
      offset = session.offset
    } else if (isConnectionEvent(message.event)) {
      const connect = readString(data, offset, 'connect id')
      message.connectId = connect.value
      offset = connect.offset
    }
  }
  const payloadSize = readUint32(data, offset, 'payload 长度')
  message.payload = readBytes(data, payloadSize.offset, payloadSize.value, 'payload').value
  return message
}

function parsePayload(payload: Uint8Array): any {
  const text = Buffer.from(payload).toString('utf8').trim()
  if (!text) return null
  try { return JSON.parse(text) } catch { return text }
}

function errorFromMessage(message: ProtocolMessage): Error {
  const payload = parsePayload(message.payload)
  const detail = typeof payload === 'string'
    ? payload
    : String(payload?.message || payload?.error || JSON.stringify(payload || {}))
  const code = message.errorCode ? ` ${message.errorCode}` : ''
  return new Error(`豆包 Realtime 错误${code}${detail ? `: ${detail}` : ''}`)
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (Buffer.isBuffer(data)) return new Uint8Array(data)
  return null
}

function waitForOpen(ws: InstanceType<typeof WebSocket>, timeoutMs = 15000): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('豆包 Realtime WebSocket 建连超时')), timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      ws.removeEventListener('open', onOpen)
      ws.removeEventListener('error', onError)
      ws.removeEventListener('close', onClose)
    }
    const done = (error?: Error) => {
      cleanup()
      if (error) reject(error); else resolve()
    }
    const onOpen = () => done()
    const onError = (event: any) => done(new Error(event?.message || '豆包 Realtime WebSocket 建连失败'))
    const onClose = (event: any) => done(new Error(`豆包 Realtime WebSocket 建连被关闭${event?.reason ? `: ${event.reason}` : ''}`))
    ws.addEventListener('open', onOpen)
    ws.addEventListener('error', onError)
    ws.addEventListener('close', onClose)
  })
}

export class VolcengineRealtimeSession {
  readonly sessionId = randomUUID()
  private ws: InstanceType<typeof WebSocket> | null = null
  private closing = false
  private closed = false
  private waiters = new Map<EventType, Array<{ resolve: (message: ProtocolMessage) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>>()

  constructor(private readonly options: VolcengineRealtimeOptions) {}

  async connect(): Promise<void> {
    if (!this.options.appId.trim()) throw new Error('未配置豆包 Realtime App ID')
    if (!this.options.accessKey.trim()) throw new Error('未配置豆包 Realtime Access Key')
    if (!this.options.speaker.trim()) throw new Error('数字分身尚未绑定豆包音色')

    const proxyUrl = getResolvedProxyUrl()
    let dispatcher: ProxyAgent | undefined
    if (proxyUrl && !proxyUrl.startsWith('socks')) {
      try { dispatcher = new ProxyAgent(proxyUrl) } catch (error) {
        console.warn('[Realtime] 豆包 WebSocket 代理创建失败，回退直连:', error)
      }
    }
    const ws = new WebSocket(this.options.endpoint || VOLCENGINE_REALTIME_ENDPOINT, {
      headers: {
        'X-Api-App-ID': this.options.appId.trim(),
        'X-Api-Access-Key': this.options.accessKey.trim(),
        'X-Api-Resource-Id': VOLCENGINE_REALTIME_RESOURCE_ID,
        'X-Api-App-Key': VOLCENGINE_REALTIME_APP_KEY,
        'X-Api-Connect-Id': randomUUID(),
      },
      dispatcher,
    })
    this.ws = ws
    await waitForOpen(ws)
    this.attachSocket(ws)

    const connectionStarted = this.waitFor(EventType.ConnectionStarted)
    this.sendJson(EventType.StartConnection, {})
    await connectionStarted

    const sessionStarted = this.waitFor(EventType.SessionStarted)
    this.sendJson(EventType.StartSession, this.createStartSessionPayload())
    const started = await sessionStarted
    const payload = parsePayload(started.payload)
    this.options.onEvent({ type: 'connected', dialogId: typeof payload === 'object' ? payload?.dialog_id : undefined })
  }

  sendAudio(pcm16le: Uint8Array): void {
    if (this.closing || this.closed || pcm16le.byteLength === 0) return
    this.send({
      type: MsgType.AudioOnlyClient,
      flag: WITH_EVENT,
      serialization: SERIALIZATION_RAW,
      event: EventType.TaskRequest,
      sessionId: this.sessionId,
      payload: pcm16le,
    })
  }

  truncate(replyId: string, audioEndMs: number): void {
    const id = String(replyId || '').trim()
    const endMs = Math.max(0, Math.round(audioEndMs))
    if (!id || endMs <= 0 || this.closing || this.closed) return
    this.sendJson(EventType.ConversationTruncate, { item_id: id, audio_end_ms: endMs })
  }

  async close(): Promise<void> {
    if (this.closed || this.closing) return
    this.closing = true
    try {
      if (this.ws?.readyState === WebSocket.OPEN) {
        const sessionFinished = this.waitFor(EventType.SessionFinished, 2500)
        this.sendJson(EventType.FinishSession, {})
        await sessionFinished.catch(() => undefined)

        const connectionFinished = this.waitFor(EventType.ConnectionFinished, 2500)
        this.sendJson(EventType.FinishConnection, {})
        await connectionFinished.catch(() => undefined)
      }
    } finally {
      this.closed = true
      this.rejectWaiters(new Error('豆包 Realtime 会话已结束'))
      try { this.ws?.close() } catch { /* ignore */ }
      this.ws = null
      this.options.onEvent({ type: 'ended' })
    }
  }

  private createStartSessionPayload(): Record<string, unknown> {
    const dialog: Record<string, unknown> = {
      bot_name: this.options.botName.trim().slice(0, 20) || '数字分身',
      dialog_id: '',
      extra: {
        input_mod: 'keep_alive',
        model: this.options.model,
        enable_loudness_norm: true,
        enable_conversation_truncate: true,
        enable_user_query_exit: false,
      },
    }
    if (this.options.dialogContext?.length) dialog.dialog_context = this.options.dialogContext.slice(-40)
    if (this.options.model === '2.2.0.0') {
      dialog.character_manifest = String(this.options.characterManifest || '').slice(0, 6000)
    } else {
      dialog.system_role = String(this.options.systemRole || '').slice(0, 3000)
      dialog.speaking_style = String(this.options.speakingStyle || '').slice(0, 1000)
    }
    return {
      asr: {
        audio_info: { format: 'pcm', sample_rate: 16000, channel: 1 },
        extra: { end_smooth_window_ms: 700, enable_custom_vad: true, enable_asr_twopass: true },
      },
      tts: {
        speaker: this.options.speaker,
        audio_config: { channel: 1, format: 'pcm_s16le', sample_rate: 24000 },
        extra: {},
      },
      dialog,
    }
  }

  private attachSocket(ws: InstanceType<typeof WebSocket>): void {
    ws.binaryType = 'arraybuffer'
    ws.addEventListener('message', (event: any) => {
      try {
        const bytes = toBytes(event.data)
        if (!bytes) throw new Error(`豆包 Realtime 返回未知消息类型: ${typeof event.data}`)
        this.handleMessage(unmarshalVolcengineRealtimeMessage(bytes))
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
    ws.addEventListener('error', (event: any) => this.fail(new Error(event?.message || '豆包 Realtime WebSocket 错误')))
    ws.addEventListener('close', (event: any) => {
      if (this.closing || this.closed) return
      this.fail(new Error(`豆包 Realtime WebSocket 已关闭${event?.reason ? `: ${event.reason}` : ''}`))
    })
  }

  private handleMessage(message: ProtocolMessage): void {
    if (message.type === MsgType.Error) {
      const error = errorFromMessage(message)
      this.options.onEvent({ type: 'error', error: error.message, errorCode: message.errorCode })
      this.rejectWaiters(error)
      return
    }
    if (message.event !== undefined) this.resolveWaiter(message.event, message)
    const payload = message.type === MsgType.AudioOnlyServer ? null : parsePayload(message.payload)

    if (message.event === EventType.ConnectionFailed || message.event === EventType.SessionFailed || message.event === EventType.DialogCommonError) {
      this.fail(errorFromMessage(message))
      return
    }
    switch (message.event) {
      case EventType.ASRInfo:
        this.options.onEvent({ type: 'speech-started', questionId: payload?.question_id })
        break
      case EventType.ASRResponse: {
        const result = Array.isArray(payload?.results) ? payload.results[payload.results.length - 1] : null
        const text = String(result?.text || '').trim()
        if (text) this.options.onEvent({ type: 'asr', text, interim: result?.is_interim === true })
        break
      }
      case EventType.ASREnded:
        this.options.onEvent({ type: 'asr-ended' })
        break
      case EventType.ChatResponse:
        this.options.onEvent({ type: 'chat', text: String(payload?.content || ''), questionId: payload?.question_id, replyId: payload?.reply_id })
        break
      case EventType.ChatEnded:
        this.options.onEvent({ type: 'chat-ended', questionId: payload?.question_id, replyId: payload?.reply_id })
        break
      case EventType.TTSSentenceStart:
        this.options.onEvent({ type: 'tts-start', text: payload?.text, questionId: payload?.question_id, replyId: payload?.reply_id })
        break
      case EventType.TTSResponse:
        if (message.payload.length > 0) {
          this.options.onEvent({ type: 'audio', audioBase64: Buffer.from(message.payload).toString('base64'), sampleRate: 24000, channels: 1 })
        }
        break
      case EventType.TTSEnded:
        this.options.onEvent({ type: 'tts-ended', questionId: payload?.question_id, replyId: payload?.reply_id, statusCode: payload?.status_code })
        break
      case EventType.SessionFinished:
        if (!this.closing) this.options.onEvent({ type: 'ended' })
        break
    }
  }

  private sendJson(event: EventType, payload: unknown): void {
    this.send({
      type: MsgType.FullClientRequest,
      flag: WITH_EVENT,
      serialization: SERIALIZATION_JSON,
      event,
      sessionId: this.sessionId,
      payload: jsonBytes(payload),
    })
  }

  private send(message: ProtocolMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('豆包 Realtime WebSocket 尚未连接')
    this.ws.send(marshalVolcengineRealtimeMessage(message))
  }

  private waitFor(event: EventType, timeoutMs = 15000): Promise<ProtocolMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const items = this.waiters.get(event) || []
        const remaining = items.filter((item) => item.resolve !== resolve)
        if (remaining.length) this.waiters.set(event, remaining); else this.waiters.delete(event)
        reject(new Error(`等待豆包 Realtime 事件 ${event} 超时`))
      }, timeoutMs)
      const items = this.waiters.get(event) || []
      items.push({ resolve, reject, timer })
      this.waiters.set(event, items)
    })
  }

  private resolveWaiter(event: EventType, message: ProtocolMessage): void {
    const items = this.waiters.get(event)
    const item = items?.shift()
    if (!item) return
    clearTimeout(item.timer)
    if (items?.length) this.waiters.set(event, items); else this.waiters.delete(event)
    item.resolve(message)
  }

  private rejectWaiters(error: Error): void {
    for (const items of this.waiters.values()) {
      for (const item of items) {
        clearTimeout(item.timer)
        item.reject(error)
      }
    }
    this.waiters.clear()
  }

  private fail(error: Error): void {
    if (this.closing || this.closed) return
    this.options.onEvent({ type: 'error', error: error.message })
    this.rejectWaiters(error)
  }
}
