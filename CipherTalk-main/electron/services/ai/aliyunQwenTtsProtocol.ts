import { randomUUID } from 'crypto'
import { ProxyAgent, WebSocket } from 'undici'
import { getResolvedProxyUrl } from './proxyFetch'

export interface AliyunQwenRealtimeTtsOptions {
  apiKey: string
  endpoint?: string
  model: string
  voice: string
  text: string
  instructions?: string
  onAudioChunk?: (chunk: Uint8Array) => void
  signal?: AbortSignal
}

export interface AliyunQwenRealtimeTtsResult {
  success: boolean
  audioBase64?: string
  mimeType?: string
  sampleRate?: number
  channels?: number
  error?: string
  errorCode?: 'NOT_CONFIGURED' | 'SYNTHESIS_FAILED'
}

interface AliyunQwenEvent {
  type?: string
  event_id?: string
  session?: Record<string, unknown>
  delta?: string
  error?: {
    code?: string
    message?: string
    type?: string
  }
  [key: string]: unknown
}

export const ALIYUN_QWEN_DEFAULT_REALTIME_ENDPOINT = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'
export const ALIYUN_QWEN_DEFAULT_CUSTOMIZATION_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization'
export const ALIYUN_QWEN_DEFAULT_REALTIME_MODEL = 'qwen3-tts-instruct-flash-realtime'
export const ALIYUN_QWEN_DEFAULT_VOICE = 'Cherry'
export const ALIYUN_QWEN_VOICE_CLONE_MODEL = 'qwen-voice-enrollment'
export const ALIYUN_QWEN_VOICE_CLONE_TARGET_MODEL = 'qwen3-tts-vc-realtime-2026-01-15'
export const ALIYUN_QWEN_TTS_SAMPLE_RATE = 24000
export const ALIYUN_QWEN_TTS_CHANNELS = 1

const ALIYUN_QWEN_TIMEOUT_ERROR = '通义千问 TTS 请求超时'

function bytesFromMessageData(data: unknown): Uint8Array | null {
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (Buffer.isBuffer(data)) return new Uint8Array(data)
  return null
}

function parseJsonEvent(data: unknown): AliyunQwenEvent {
  const bytes = bytesFromMessageData(data)
  if (!bytes) throw new Error(`未知 WebSocket 消息类型: ${typeof data}`)
  const text = Buffer.from(bytes).toString('utf8').trim()
  if (!text) return {}
  try {
    return JSON.parse(text) as AliyunQwenEvent
  } catch {
    throw new Error(`通义千问 TTS 事件 JSON 解析失败: ${text.slice(0, 300)}`)
  }
}

function eventErrorMessage(event: AliyunQwenEvent): string {
  const code = String(event.error?.code || event.code || '').trim()
  const message = String(event.error?.message || event.message || event.error?.type || '').trim()
  return [code, message].filter(Boolean).join(': ') || JSON.stringify(event).slice(0, 300)
}

function eventId(): string {
  return `ct_${randomUUID().replace(/-/g, '')}`
}

function sendJson(ws: InstanceType<typeof WebSocket>, payload: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) throw new Error('通义千问 WebSocket 尚未连接')
  ws.send(JSON.stringify({
    event_id: eventId(),
    ...payload,
  }))
}

export function isAliyunQwenInstructModel(model: string): boolean {
  return /^qwen3-tts-instruct-/i.test(String(model || '').trim())
}

export function resolveAliyunQwenRealtimeEndpoint(endpoint?: string, model?: string): string {
  const raw = String(endpoint || '').trim() || ALIYUN_QWEN_DEFAULT_REALTIME_ENDPOINT
  const url = new URL(raw)
  if (url.protocol === 'https:') url.protocol = 'wss:'
  if (url.protocol === 'http:') url.protocol = 'ws:'
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
    throw new Error('通义千问实时 TTS 地址必须是 ws:// 或 wss://')
  }
  const resolvedModel = String(model || '').trim() || ALIYUN_QWEN_DEFAULT_REALTIME_MODEL
  if (resolvedModel) url.searchParams.set('model', resolvedModel)
  return url.toString()
}

export function resolveAliyunQwenCustomizationEndpoint(baseURL?: string): string {
  const raw = String(baseURL || '').trim()
  if (!raw) return ALIYUN_QWEN_DEFAULT_CUSTOMIZATION_ENDPOINT
  const url = new URL(raw)
  url.protocol = 'https:'
  url.search = ''
  url.hash = ''
  if (/\/api\/v1\/services\/audio\/tts\/customization\/?$/i.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString()
  }
  url.pathname = '/api/v1/services/audio/tts/customization'
  return url.toString()
}

class AliyunQwenEventReader {
  private queue: AliyunQwenEvent[] = []
  private waiters: Array<{
    resolve: (event: AliyunQwenEvent) => void
    reject: (error: Error) => void
  }> = []
  private closedError: Error | null = null
  private finished = false

  constructor(private readonly ws: InstanceType<typeof WebSocket>) {
    ws.binaryType = 'arraybuffer'
    ws.addEventListener('message', (event: any) => {
      try {
        this.push(parseJsonEvent(event.data))
      } catch (error) {
        this.rejectAll(error instanceof Error ? error : new Error(String(error)))
      }
    })
    ws.addEventListener('error', (event: any) => {
      this.rejectAll(new Error(event?.message || '通义千问 WebSocket 错误'))
    })
    ws.addEventListener('close', (event: any) => {
      if (this.finished) return
      const reason = event?.reason ? `: ${event.reason}` : ''
      this.rejectAll(new Error(`通义千问 WebSocket 已关闭${reason}`))
    })
  }

  markFinished(): void {
    this.finished = true
  }

  receive(signal?: AbortSignal): Promise<AliyunQwenEvent> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!)
    if (this.closedError) return Promise.reject(this.closedError)
    if (signal?.aborted) return Promise.reject(new Error(ALIYUN_QWEN_TIMEOUT_ERROR))

    return new Promise((resolve, reject) => {
      let queuedWaiter: {
        resolve: (event: AliyunQwenEvent) => void
        reject: (error: Error) => void
      }
      const abort = () => {
        this.waiters = this.waiters.filter((item) => item !== queuedWaiter)
        reject(new Error(ALIYUN_QWEN_TIMEOUT_ERROR))
      }
      if (signal) signal.addEventListener('abort', abort, { once: true })
      queuedWaiter = {
        resolve: (event) => {
          if (signal) signal.removeEventListener('abort', abort)
          resolve(event)
        },
        reject: (error) => {
          if (signal) signal.removeEventListener('abort', abort)
          reject(error)
        },
      }
      this.waiters.push(queuedWaiter)
    })
  }

  private push(event: AliyunQwenEvent): void {
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.resolve(event)
      return
    }
    this.queue.push(event)
  }

  private rejectAll(error: Error): void {
    this.closedError = error
    const waiters = this.waiters.splice(0)
    for (const waiter of waiters) waiter.reject(error)
  }
}

function createWebSocket(options: AliyunQwenRealtimeTtsOptions): InstanceType<typeof WebSocket> {
  const proxyUrl = getResolvedProxyUrl()
  let dispatcher: ProxyAgent | undefined
  if (proxyUrl && !proxyUrl.startsWith('socks')) {
    try {
      dispatcher = new ProxyAgent(proxyUrl)
    } catch (error) {
      console.warn('[TTS] 通义千问 WebSocket 代理创建失败，回退直连:', error)
    }
  }

  return new WebSocket(resolveAliyunQwenRealtimeEndpoint(options.endpoint, options.model), {
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
    },
    dispatcher,
  })
}

async function waitForOpen(ws: InstanceType<typeof WebSocket>, signal?: AbortSignal): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return
  if (signal?.aborted) throw new Error(ALIYUN_QWEN_TIMEOUT_ERROR)

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
      reject(new Error(event?.message || '通义千问 WebSocket 连接失败'))
    }
    const onClose = (event: any) => {
      cleanup()
      reject(new Error(`通义千问 WebSocket 建连被关闭${event?.reason ? `: ${event.reason}` : ''}`))
    }
    const onAbort = () => {
      cleanup()
      try { ws.close() } catch { /* ignore */ }
      reject(new Error(ALIYUN_QWEN_TIMEOUT_ERROR))
    }
    ws.addEventListener('open', onOpen)
    ws.addEventListener('error', onError)
    ws.addEventListener('close', onClose)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function waitForType(reader: AliyunQwenEventReader, type: string, signal?: AbortSignal): Promise<AliyunQwenEvent> {
  while (true) {
    const event = await reader.receive(signal)
    if (event.type === 'error') throw new Error(`通义千问 TTS 错误: ${eventErrorMessage(event)}`)
    if (event.type === type) return event
  }
}

function createSessionUpdate(options: AliyunQwenRealtimeTtsOptions): Record<string, unknown> {
  const model = String(options.model || '').trim()
  const instructions = String(options.instructions || '').trim().slice(0, 1000)
  const session: Record<string, unknown> = {
    voice: options.voice,
    mode: 'commit',
    language_type: 'Auto',
    response_format: 'pcm',
    sample_rate: ALIYUN_QWEN_TTS_SAMPLE_RATE,
  }
  if (instructions && isAliyunQwenInstructModel(model)) {
    session.instructions = instructions
    session.optimize_instructions = true
  }
  return {
    type: 'session.update',
    session,
  }
}

export async function synthesizeViaAliyunQwenRealtime(
  options: AliyunQwenRealtimeTtsOptions,
): Promise<AliyunQwenRealtimeTtsResult> {
  if (!options.apiKey) return { success: false, error: '未配置通义千问 API Key', errorCode: 'NOT_CONFIGURED' }
  if (!options.model) return { success: false, error: '未配置通义千问 TTS 模型', errorCode: 'NOT_CONFIGURED' }
  if (!options.voice) return { success: false, error: '未配置通义千问音色 voice', errorCode: 'NOT_CONFIGURED' }
  if (!options.text) return { success: false, error: '朗读内容为空', errorCode: 'SYNTHESIS_FAILED' }

  const ws = createWebSocket(options)
  const abort = () => {
    try { ws.close() } catch { /* ignore */ }
  }
  options.signal?.addEventListener('abort', abort, { once: true })

  try {
    const reader = new AliyunQwenEventReader(ws)
    await waitForOpen(ws, options.signal)
    await waitForType(reader, 'session.created', options.signal)

    sendJson(ws, createSessionUpdate(options))
    await waitForType(reader, 'session.updated', options.signal)

    sendJson(ws, {
      type: 'input_text_buffer.append',
      text: options.text,
    })
    sendJson(ws, { type: 'input_text_buffer.commit' })
    sendJson(ws, { type: 'session.finish' })

    const chunks: Uint8Array[] = []
    while (true) {
      const event = await reader.receive(options.signal)
      if (event.type === 'error') throw new Error(`通义千问 TTS 错误: ${eventErrorMessage(event)}`)
      if (event.type === 'response.audio.delta') {
        const data = String(event.delta || '').trim()
        if (!data) continue
        const bytes = Buffer.from(data, 'base64')
        if (bytes.length === 0) continue
        chunks.push(bytes)
        options.onAudioChunk?.(bytes)
      }
      if (event.type === 'session.finished') {
        reader.markFinished()
        break
      }
    }

    if (chunks.length === 0) {
      return { success: false, error: '通义千问实时 TTS 未返回音频数据', errorCode: 'SYNTHESIS_FAILED' }
    }

    return {
      success: true,
      audioBase64: Buffer.concat(chunks).toString('base64'),
      mimeType: 'audio/pcm',
      sampleRate: ALIYUN_QWEN_TTS_SAMPLE_RATE,
      channels: ALIYUN_QWEN_TTS_CHANNELS,
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      errorCode: 'SYNTHESIS_FAILED',
    }
  } finally {
    options.signal?.removeEventListener('abort', abort)
    try { ws.close() } catch { /* ignore */ }
  }
}
