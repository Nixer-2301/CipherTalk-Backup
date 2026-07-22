import { randomUUID } from 'crypto'
import { ProxyAgent, WebSocket } from 'undici'
import { getResolvedProxyUrl } from './proxyFetch'

export interface VolcengineTtsOptions {
  apiKey: string
  endpoint?: string
  resourceId: string
  speaker: string
  text: string
  instructions?: string
  speed?: number
  audioFormat?: 'mp3' | 'pcm' | 'ogg_opus'
  onAudioChunk?: (chunk: Uint8Array) => void
  signal?: AbortSignal
}

export interface VolcengineTtsResult {
  success: boolean
  audioBase64?: string
  mimeType?: string
  error?: string
  errorCode?: 'NOT_CONFIGURED' | 'SYNTHESIS_FAILED'
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
}

enum MsgType {
  FullClientRequest = 0b0001,
  FullServerResponse = 0b1001,
  AudioOnlyServer = 0b1011,
  Error = 0b1111,
}

enum MsgFlag {
  NoSeq = 0,
  WithEvent = 0b0100,
}

enum Serialization {
  Raw = 0,
  JSON = 0b0001,
}

interface VolcengineMessage {
  type: MsgType
  flag: number
  serialization: number
  event?: EventType
  sessionId?: string
  connectId?: string
  errorCode?: number
  payload: Uint8Array
}

const VOLCENGINE_TTS_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection'
const VOLCENGINE_AUDIO_FORMAT: VolcengineTtsOptions['audioFormat'] = 'mp3'
const VOLCENGINE_SAMPLE_RATE = 24000
const VOLCENGINE_TIMEOUT_ERROR = '火山引擎 TTS 请求超时'

function jsonBytes(payload: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(payload), 'utf8')
}

function textFromBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8')
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
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

function marshalMessage(message: VolcengineMessage): Uint8Array {
  const header = new Uint8Array(4)
  header[0] = 0x11
  header[1] = (message.type << 4) | message.flag
  header[2] = (message.serialization << 4)
  header[3] = 0x00

  const parts: Uint8Array[] = [header]
  if (message.flag === MsgFlag.WithEvent && message.event !== undefined) {
    parts.push(int32Bytes(message.event))
    if (
      message.event !== EventType.StartConnection &&
      message.event !== EventType.FinishConnection
    ) {
      const sessionId = Buffer.from(message.sessionId || '', 'utf8')
      parts.push(uint32Bytes(sessionId.length), sessionId)
    }
  }
  parts.push(uint32Bytes(message.payload.length), message.payload)
  return concatBytes(parts)
}

function readUint32(data: Uint8Array, offset: number, label: string): { value: number; offset: number } {
  if (offset + 4 > data.length) throw new Error(`火山引擎响应缺少 ${label}`)
  const view = new DataView(data.buffer, data.byteOffset + offset, 4)
  return { value: view.getUint32(0, false), offset: offset + 4 }
}

function readInt32(data: Uint8Array, offset: number, label: string): { value: number; offset: number } {
  if (offset + 4 > data.length) throw new Error(`火山引擎响应缺少 ${label}`)
  const view = new DataView(data.buffer, data.byteOffset + offset, 4)
  return { value: view.getInt32(0, false), offset: offset + 4 }
}

function readBytes(data: Uint8Array, offset: number, size: number, label: string): { value: Uint8Array; offset: number } {
  if (offset + size > data.length) throw new Error(`火山引擎响应 ${label} 长度无效`)
  return { value: data.slice(offset, offset + size), offset: offset + size }
}

function readLengthPrefixedString(data: Uint8Array, offset: number, label: string): { value: string; offset: number } {
  const length = readUint32(data, offset, `${label} 长度`)
  const bytes = readBytes(data, length.offset, length.value, label)
  return { value: textFromBytes(bytes.value), offset: bytes.offset }
}

function shouldReadSessionId(event?: EventType): boolean {
  return event !== undefined &&
    event !== EventType.StartConnection &&
    event !== EventType.FinishConnection &&
    event !== EventType.ConnectionStarted &&
    event !== EventType.ConnectionFailed &&
    event !== EventType.ConnectionFinished
}

function shouldReadConnectId(event?: EventType): boolean {
  return event === EventType.ConnectionStarted ||
    event === EventType.ConnectionFailed ||
    event === EventType.ConnectionFinished
}

function unmarshalMessage(data: Uint8Array): VolcengineMessage {
  if (data.length < 4) throw new Error('火山引擎响应过短')

  const headerSize = data[0] & 0x0f
  const type = (data[1] >> 4) as MsgType
  const flag = data[1] & 0x0f
  const serialization = data[2] >> 4
  let offset = headerSize * 4

  const message: VolcengineMessage = {
    type,
    flag,
    serialization,
    payload: new Uint8Array(0),
  }

  if (type === MsgType.Error) {
    const error = readUint32(data, offset, '错误码')
    message.errorCode = error.value
    offset = error.offset
  }

  if (flag === MsgFlag.WithEvent) {
    const event = readInt32(data, offset, '事件号')
    message.event = event.value as EventType
    offset = event.offset

    if (shouldReadSessionId(message.event)) {
      const session = readLengthPrefixedString(data, offset, 'session id')
      message.sessionId = session.value
      offset = session.offset
    }

    if (shouldReadConnectId(message.event)) {
      const connect = readLengthPrefixedString(data, offset, 'connect id')
      message.connectId = connect.value
      offset = connect.offset
    }
  }

  const payloadLength = readUint32(data, offset, 'payload 长度')
  const payload = readBytes(data, payloadLength.offset, payloadLength.value, 'payload')
  message.payload = payload.value
  return message
}

function parseJsonPayload(payload: Uint8Array): any {
  const text = textFromBytes(payload).trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function describeServerPayload(payload: Uint8Array): string {
  const parsed = parseJsonPayload(payload)
  if (!parsed) return ''
  if (typeof parsed === 'string') return parsed.slice(0, 300)
  return String(parsed.message || parsed.error || JSON.stringify(parsed)).slice(0, 300)
}

function eventName(event?: EventType): string {
  return event === undefined ? 'None' : EventType[event] || String(event)
}

function messageName(type: MsgType): string {
  return MsgType[type] || String(type)
}

class VolcengineMessageReader {
  private queue: VolcengineMessage[] = []
  private waiters: Array<{
    resolve: (message: VolcengineMessage) => void
    reject: (error: Error) => void
  }> = []
  private closedError: Error | null = null

  constructor(private readonly ws: InstanceType<typeof WebSocket>) {
    ws.binaryType = 'arraybuffer'
    ws.addEventListener('message', (event: any) => {
      try {
        const data = event.data
        if (typeof data === 'string') {
          this.rejectAll(new Error(data))
          return
        }
        const bytes = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : Buffer.isBuffer(data)
              ? new Uint8Array(data)
              : null
        if (!bytes) throw new Error(`未知 WebSocket 消息类型: ${typeof data}`)
        this.push(unmarshalMessage(bytes))
      } catch (error) {
        this.rejectAll(error instanceof Error ? error : new Error(String(error)))
      }
    })
    ws.addEventListener('error', (event: any) => {
      this.rejectAll(new Error(event?.message || '火山引擎 WebSocket 错误'))
    })
    ws.addEventListener('close', (event: any) => {
      const reason = event?.reason ? `: ${event.reason}` : ''
      this.rejectAll(new Error(`火山引擎 WebSocket 已关闭${reason}`))
    })
  }

  receive(signal?: AbortSignal): Promise<VolcengineMessage> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!)
    if (this.closedError) return Promise.reject(this.closedError)
    if (signal?.aborted) return Promise.reject(new Error(VOLCENGINE_TIMEOUT_ERROR))

    return new Promise((resolve, reject) => {
      let queuedWaiter: {
        resolve: (message: VolcengineMessage) => void
        reject: (error: Error) => void
      }
      const abort = () => {
        this.waiters = this.waiters.filter((item) => item !== queuedWaiter)
        reject(new Error(VOLCENGINE_TIMEOUT_ERROR))
      }
      if (signal) signal.addEventListener('abort', abort, { once: true })
      queuedWaiter = {
        resolve: (message) => {
          if (signal) signal.removeEventListener('abort', abort)
          resolve(message)
        },
        reject: (error) => {
          if (signal) signal.removeEventListener('abort', abort)
          reject(error)
        },
      }
      this.waiters.push(queuedWaiter)
    })
  }

  private push(message: VolcengineMessage): void {
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.resolve(message)
      return
    }
    this.queue.push(message)
  }

  private rejectAll(error: Error): void {
    this.closedError = error
    const waiters = this.waiters.splice(0)
    for (const waiter of waiters) waiter.reject(error)
  }
}

function sendMessage(ws: InstanceType<typeof WebSocket>, message: VolcengineMessage): void {
  if (ws.readyState !== WebSocket.OPEN) {
    throw new Error('火山引擎 WebSocket 尚未连接')
  }
  ws.send(marshalMessage(message))
}

async function waitForOpen(ws: InstanceType<typeof WebSocket>, signal?: AbortSignal): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return
  if (signal?.aborted) throw new Error(VOLCENGINE_TIMEOUT_ERROR)

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      ws.removeEventListener('open', onOpen)
      ws.removeEventListener('error', onError)
      ws.removeEventListener('close', onClose)
      signal?.removeEventListener('abort', onAbort)
    }
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = (event: any) => {
      cleanup()
      reject(new Error(event?.message || '火山引擎 WebSocket 连接失败'))
    }
    const onClose = (event: any) => {
      cleanup()
      reject(new Error(`火山引擎 WebSocket 建连被关闭${event?.reason ? `: ${event.reason}` : ''}`))
    }
    const onAbort = () => {
      cleanup()
      try { ws.close() } catch { /* ignore */ }
      reject(new Error(VOLCENGINE_TIMEOUT_ERROR))
    }
    ws.addEventListener('open', onOpen)
    ws.addEventListener('error', onError)
    ws.addEventListener('close', onClose)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function waitForEvent(
  reader: VolcengineMessageReader,
  type: MsgType,
  event: EventType,
  signal?: AbortSignal,
): Promise<VolcengineMessage> {
  const message = await reader.receive(signal)
  if (message.type === MsgType.Error) {
    throw new Error(`火山引擎错误 ${message.errorCode || ''}: ${describeServerPayload(message.payload)}`)
  }
  if (message.type !== type || message.event !== event) {
    throw new Error(`火山引擎响应事件异常: type=${messageName(message.type)}, event=${eventName(message.event)}`)
  }
  if (
    event === EventType.ConnectionFailed ||
    event === EventType.SessionFailed
  ) {
    throw new Error(describeServerPayload(message.payload) || `火山引擎 ${eventName(event)}`)
  }
  return message
}

function createClientMessage(event: EventType, payload: unknown, sessionId?: string): VolcengineMessage {
  return {
    type: MsgType.FullClientRequest,
    flag: MsgFlag.WithEvent,
    serialization: Serialization.JSON,
    event,
    sessionId,
    payload: jsonBytes(payload),
  }
}

function mimeTypeForFormat(format: string): string {
  if (format === 'ogg_opus') return 'audio/ogg'
  if (format === 'pcm') return 'audio/pcm'
  return 'audio/mpeg'
}

function volcengineSpeechRate(speed?: number): number | undefined {
  if (!Number.isFinite(speed || NaN)) return undefined
  const clamped = Math.min(Math.max(Number(speed), 0.5), 2)
  const rate = Math.round((clamped - 1) * 100)
  return rate === 0 ? undefined : rate
}

function createRequestTemplate(options: VolcengineTtsOptions): Record<string, unknown> {
  const instructions = String(options.instructions || '').trim().slice(0, 1000)
  const additions: Record<string, unknown> = {
    disable_markdown_filter: false,
  }
  if (instructions) {
    additions.context_texts = [instructions]
  }

  const audioParams: Record<string, unknown> = {
    format: options.audioFormat || VOLCENGINE_AUDIO_FORMAT,
    sample_rate: VOLCENGINE_SAMPLE_RATE,
  }
  const speechRate = volcengineSpeechRate(options.speed)
  if (speechRate !== undefined) {
    audioParams.speech_rate = speechRate
  }

  return {
    user: { uid: randomUUID() },
    namespace: 'BidirectionalTTS',
    req_params: {
      speaker: options.speaker,
      audio_params: audioParams,
      additions: JSON.stringify(additions),
    },
  }
}

function createWebSocket(options: VolcengineTtsOptions): InstanceType<typeof WebSocket> {
  const proxyUrl = getResolvedProxyUrl()
  let dispatcher: ProxyAgent | undefined
  if (proxyUrl && !proxyUrl.startsWith('socks')) {
    try {
      dispatcher = new ProxyAgent(proxyUrl)
    } catch (error) {
      console.warn('[TTS] 火山引擎 WebSocket 代理创建失败，回退直连:', error)
    }
  }

  return new WebSocket(options.endpoint || VOLCENGINE_TTS_ENDPOINT, {
    headers: {
      'X-Api-Key': options.apiKey,
      'X-Api-Resource-Id': options.resourceId,
      'X-Api-Connect-Id': randomUUID(),
      'X-Control-Require-Usage-Tokens-Return': 'text_words',
    },
    dispatcher,
  })
}

export async function synthesizeViaVolcengineBidirectional(
  options: VolcengineTtsOptions,
): Promise<VolcengineTtsResult> {
  if (!options.apiKey) return { success: false, error: '未配置火山引擎 API Key', errorCode: 'NOT_CONFIGURED' }
  if (!options.resourceId) return { success: false, error: '未配置火山引擎 Resource ID', errorCode: 'NOT_CONFIGURED' }
  if (!options.speaker) return { success: false, error: '未配置火山引擎音色 Speaker', errorCode: 'NOT_CONFIGURED' }

  const ws = createWebSocket(options)
  const abort = () => {
    try { ws.close() } catch { /* ignore */ }
  }
  options.signal?.addEventListener('abort', abort, { once: true })

  try {
    await waitForOpen(ws, options.signal)
    const reader = new VolcengineMessageReader(ws)
    const sessionId = randomUUID()
    const requestTemplate = createRequestTemplate(options)

    sendMessage(ws, createClientMessage(EventType.StartConnection, {}))
    await waitForEvent(reader, MsgType.FullServerResponse, EventType.ConnectionStarted, options.signal)

    sendMessage(ws, createClientMessage(EventType.StartSession, {
      ...requestTemplate,
      event: EventType.StartSession,
    }, sessionId))
    await waitForEvent(reader, MsgType.FullServerResponse, EventType.SessionStarted, options.signal)

    sendMessage(ws, createClientMessage(EventType.TaskRequest, {
      ...requestTemplate,
      event: EventType.TaskRequest,
      req_params: {
        ...(requestTemplate.req_params as Record<string, unknown>),
        text: options.text,
      },
    }, sessionId))

    sendMessage(ws, createClientMessage(EventType.FinishSession, {}, sessionId))

    const chunks: Uint8Array[] = []
    while (true) {
      const message = await reader.receive(options.signal)
      if (message.type === MsgType.Error) {
        throw new Error(`火山引擎错误 ${message.errorCode || ''}: ${describeServerPayload(message.payload)}`)
      }
      if (message.event === EventType.SessionFailed) {
        throw new Error(describeServerPayload(message.payload) || '火山引擎会话失败')
      }
      if (message.type === MsgType.AudioOnlyServer && message.payload.length > 0) {
        chunks.push(message.payload)
        options.onAudioChunk?.(message.payload)
      }
      if (message.event === EventType.SessionFinished) {
        break
      }
    }

    sendMessage(ws, createClientMessage(EventType.FinishConnection, {}))
    await waitForEvent(reader, MsgType.FullServerResponse, EventType.ConnectionFinished, options.signal)

    if (chunks.length === 0) {
      return { success: false, error: '火山引擎未返回音频数据', errorCode: 'SYNTHESIS_FAILED' }
    }

    const audio = concatBytes(chunks)
    return {
      success: true,
      audioBase64: Buffer.from(audio).toString('base64'),
      mimeType: mimeTypeForFormat(options.audioFormat || VOLCENGINE_AUDIO_FORMAT),
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      errorCode: options.signal?.aborted ? 'SYNTHESIS_FAILED' : 'SYNTHESIS_FAILED',
    }
  } finally {
    options.signal?.removeEventListener('abort', abort)
    try { ws.close() } catch { /* ignore */ }
  }
}

export const VOLCENGINE_DEFAULT_TTS_ENDPOINT = VOLCENGINE_TTS_ENDPOINT
