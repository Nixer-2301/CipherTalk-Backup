/**
 * 数字分身声音复刻：从好友历史语音取样，按当前 TTS 服务商绑定专属音色。
 * 豆包会创建远端 speaker；小米MiMo 按官方 voiceclone 方式保存本地样本，合成时作为 audio.voice Data URL 传入。
 */
import { createHash, randomUUID } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { chatService } from '../../chatService'
import { createProxyFetch, getResolvedProxyUrl } from '../../ai/proxyFetch'
import { getTtsConfig, type TtsConfig } from '../../ai/ttsService'
import { ConfigService } from '../../config'
import {
  ALIYUN_QWEN_DEFAULT_REALTIME_ENDPOINT,
  ALIYUN_QWEN_VOICE_CLONE_MODEL,
  ALIYUN_QWEN_VOICE_CLONE_TARGET_MODEL,
  resolveAliyunQwenCustomizationEndpoint,
} from '../../ai/aliyunQwenTtsProtocol'
import { VOLCENGINE_DEFAULT_TTS_ENDPOINT } from '../../ai/volcengineTtsProtocol'
import { sttRuntimeService } from '../../sttRuntimeService'
import type { PersonaRecord, PersonaTtsVoiceBinding } from './personaTypes'
import { personaStore } from './personaStore'

type PersonaVoiceCloneLogger = {
  info?(category: string, message: string, data?: unknown): void
  warn?(category: string, message: string, data?: unknown): void
  error?(category: string, message: string, data?: unknown): void
}

export interface PersonaVoiceCloneInput {
  sessionId: string
  displayName?: string
  logger?: PersonaVoiceCloneLogger | null
}

export type PersonaVoiceCloneResult =
  | { success: true; persona: PersonaRecord; voice: PersonaTtsVoiceBinding; warning?: string }
  | { success: false; error: string }

export interface PersonaVoiceSampleExportInput {
  sessionId: string
  displayName?: string
  outputPath: string
  minSeconds?: number
  logger?: PersonaVoiceCloneLogger | null
}

export type PersonaVoiceSampleExportResult =
  | { success: true; outputPath: string; sampleCount: number; sampleSeconds: number; audioBytes: number }
  | { success: false; error: string }

interface ParsedWav {
  sampleRate: number
  channels: number
  bitsPerSample: number
  pcm: Buffer
  durationSeconds: number
}

interface VoiceSample {
  audioBase64: string
  audioBytes: number
  sampleCount: number
  sampleSeconds: number
  text: string
}

interface CloneStatus {
  status?: number
  message?: string
  modelType?: number
}

interface CloneResult {
  speakerId: string
  status: CloneStatus
}

interface AliyunQwenCloneResult {
  voice: string
  targetModel: string
  fallbackMode: boolean
  fallbackReason?: string
}

interface VolcengineVoiceCloneLogContext {
  logger?: PersonaVoiceCloneLogger | null
  operation: 'clone' | 'status'
  sessionId?: string
  displayName?: string
  speakerId?: string
  sample?: Pick<VoiceSample, 'audioBytes' | 'sampleCount' | 'sampleSeconds'>
}

interface AliyunQwenVoiceCloneLogContext {
  logger?: PersonaVoiceCloneLogger | null
  sessionId?: string
  displayName?: string
  preferredName?: string
  sample?: Pick<VoiceSample, 'audioBytes' | 'sampleCount' | 'sampleSeconds'>
}

const VOLCENGINE_VOICE_CLONE_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/voice_clone'
const VOLCENGINE_VOICE_STATUS_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/get_voice'
const VOLCENGINE_REALTIME_VOICE_CLONE_ENDPOINT = 'https://openspeech.bytedance.com/api/v1/mega_tts/audio/upload'
const VOLCENGINE_REALTIME_VOICE_STATUS_ENDPOINT = 'https://openspeech.bytedance.com/api/v1/mega_tts/status'
// 合成用：存进音色 binding.model；大模型语音合成 V3 接口靠 X-Api-Resource-Id 选版本（seed-icl-2.0=声音复刻 2.0）。
// 音色复刻/查询接口（voice_clone、get_voice）按官方文档不传 X-Api-Resource-Id，只用 X-Api-Key 鉴权。
const VOLCENGINE_VOICE_RESOURCE_ID = 'seed-icl-2.0'
const VOLCENGINE_VOICE_MODEL_TYPE = 4
const XIAOMI_MIMO_DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1'
const XIAOMI_MIMO_VOICE_CLONE_MODEL = 'mimo-v2.5-tts-voiceclone'
const XIAOMI_MIMO_VOICE_SAMPLE_DIR = 'persona-voices'
const XIAOMI_MIMO_VOICE_SAMPLE_MIME = 'audio/wav'
const XIAOMI_MIMO_MAX_SAMPLE_BASE64_BYTES = 10 * 1024 * 1024
const ALIYUN_QWEN_VOICE_SAMPLE_MIME = 'audio/wav'
const VOICE_CLONE_MIN_SECONDS = 8
const VOICE_CLONE_TARGET_SECONDS = 18
const VOICE_CLONE_MAX_MESSAGES = 30
const VOICE_CLONE_POLL_INTERVAL_MS = 2_000
const VOICE_CLONE_TIMEOUT_MS = 180_000

type VoiceCloneProvider = 'xiaomi' | 'volcengine' | 'aliyun-qwen'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeCustomSpeakerId(sessionId: string): string {
  const digest = createHash('sha1').update(sessionId).digest('hex').slice(0, 12)
  const nonce = `${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 8)}`
  // 豆包端到端 Realtime SC2.0 只接受 S_ / saturn_ 前缀的克隆音色。
  return `S_ciphertalk_${digest}_${nonce}`
}

function makeXiaomiVoiceId(sessionId: string, sampleHash: string): string {
  const sessionDigest = createHash('sha1').update(sessionId).digest('hex').slice(0, 12)
  return `mimo_clone_${sessionDigest}_${sampleHash.slice(0, 10)}`
}

function makeAliyunQwenVoiceName(sessionId: string): string {
  const digest = createHash('sha1').update(sessionId).digest('hex').slice(0, 8)
  const nonce = Date.now().toString(36).slice(-5)
  return `ct_${digest}_${nonce}`.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 16)
}

function getPersonaVoiceSampleDir(): string {
  const cs = new ConfigService()
  try {
    const dir = join(cs.getCacheBasePath(), XIAOMI_MIMO_VOICE_SAMPLE_DIR)
    mkdirSync(dir, { recursive: true })
    return dir
  } finally {
    cs.close()
  }
}

function persistXiaomiVoiceSample(sessionId: string, sample: VoiceSample): {
  voiceId: string
  samplePath: string
  sampleHash: string
  sampleBytes: number
} {
  if (Buffer.byteLength(sample.audioBase64, 'utf8') > XIAOMI_MIMO_MAX_SAMPLE_BASE64_BYTES) {
    throw new Error('小米音色复刻样本超过 10 MB，请减少采样语音长度后重试')
  }

  const audio = Buffer.from(sample.audioBase64, 'base64')
  const sampleHash = createHash('sha256').update(audio).digest('hex')
  const voiceId = makeXiaomiVoiceId(sessionId, sampleHash)
  const samplePath = join(getPersonaVoiceSampleDir(), `${voiceId}.wav`)
  writeFileSync(samplePath, audio)
  return { voiceId, samplePath, sampleHash, sampleBytes: audio.length }
}

function pickVoiceCloneProvider(cfg: TtsConfig): VoiceCloneProvider | null {
  if (cfg.activeProvider === 'volcengine') return 'volcengine'
  if (cfg.activeProvider === 'aliyun-qwen') return 'aliyun-qwen'
  return 'xiaomi'
}

function getMissingProviderKeyMessage(provider: VoiceCloneProvider): string {
  if (provider === 'xiaomi') {
    return '当前 TTS 服务商是小米MiMo，但未配置 API Key，请先在 TTS 设置里填写并保存'
  }
  if (provider === 'aliyun-qwen') {
    return '当前 TTS 服务商是通义千问，但未配置通义千问 API Key，请先在 TTS 设置里填写并保存'
  }
  return '当前 TTS 服务商是豆包，但未配置火山引擎/豆包 API Key，请先在 TTS 设置里填写并保存'
}

function parseWav(base64: string): ParsedWav {
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('语音样本不是 WAV 数据')
  }

  let offset = 12
  let audioFormat = 0
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let pcm: Buffer | null = null

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    const chunkStart = offset + 8
    const chunkEnd = Math.min(chunkStart + chunkSize, buffer.length)

    if (chunkId === 'fmt ' && chunkSize >= 16) {
      audioFormat = buffer.readUInt16LE(chunkStart)
      channels = buffer.readUInt16LE(chunkStart + 2)
      sampleRate = buffer.readUInt32LE(chunkStart + 4)
      bitsPerSample = buffer.readUInt16LE(chunkStart + 14)
    } else if (chunkId === 'data') {
      pcm = Buffer.from(buffer.subarray(chunkStart, chunkEnd))
    }

    offset = chunkEnd + (chunkSize % 2)
  }

  if (!pcm || !channels || !sampleRate || !bitsPerSample) throw new Error('WAV 数据缺少音频块')
  if (audioFormat !== 1 || bitsPerSample !== 16) throw new Error('仅支持 PCM 16-bit WAV 语音样本')

  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8)
  return {
    sampleRate,
    channels,
    bitsPerSample,
    pcm,
    durationSeconds: pcm.length / bytesPerSecond,
  }
}

function buildWav(sample: Pick<ParsedWav, 'sampleRate' | 'channels' | 'bitsPerSample'>, pcm: Buffer): Buffer {
  const byteRate = sample.sampleRate * sample.channels * (sample.bitsPerSample / 8)
  const blockAlign = sample.channels * (sample.bitsPerSample / 8)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(sample.channels, 22)
  header.writeUInt32LE(sample.sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(sample.bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function isSameWavFormat(a: ParsedWav, b: ParsedWav): boolean {
  return a.sampleRate === b.sampleRate && a.channels === b.channels && a.bitsPerSample === b.bitsPerSample
}

async function collectVoiceSample(sessionId: string, options: { minSeconds?: number; actionLabel?: string; requireTranscript?: boolean } = {}): Promise<VoiceSample> {
  const requestedMinSeconds = Number(options.minSeconds)
  const minSeconds = Number.isFinite(requestedMinSeconds) && requestedMinSeconds > 0
    ? requestedMinSeconds
    : VOICE_CLONE_MIN_SECONDS
  const actionLabel = String(options.actionLabel || '复刻').trim() || '复刻'
  const result = await chatService.getAllVoiceMessages(sessionId)
  if (!result.success || !Array.isArray(result.messages)) {
    throw new Error(result.error || '读取好友语音消息失败')
  }

  const candidates = result.messages
    .filter((message) => Number(message.isSend || 0) !== 1)
    .sort((a, b) => Number(b.createTime || 0) - Number(a.createTime || 0))
    .slice(0, VOICE_CLONE_MAX_MESSAGES)

  if (candidates.length === 0) {
    throw new Error('没有找到对方发来的语音消息，无法复刻声音')
  }

  const samples: Array<{ audio: ParsedWav; text: string }> = []
  let base: ParsedWav | null = null
  let totalSeconds = 0
  let transcriptFailures = 0

  for (const message of candidates) {
    const localId = Number(message.localId || 0)
    if (!localId) continue
    const voice = await chatService.getVoiceData(sessionId, String(localId), message.createTime, message.serverId)
    if (!voice.success || !voice.data) continue

    try {
      const parsed = parseWav(voice.data)
      if (parsed.durationSeconds < 1) continue
      if (!base) base = parsed
      if (!isSameWavFormat(base, parsed)) continue
      let transcript = ''
      if (options.requireTranscript) {
        const result = await sttRuntimeService.transcribeWavBuffer(Buffer.from(voice.data, 'base64'), {
          cache: {
            sessionId,
            createTime: Number(message.createTime || 0),
            localId,
            allowLegacyCache: true,
          },
        })
        transcript = result.success ? String(result.transcript || '').trim() : ''
        if (!transcript) {
          transcriptFailures += 1
          continue
        }
      }
      samples.push({ audio: parsed, text: transcript })
      totalSeconds += parsed.durationSeconds
      if (totalSeconds >= VOICE_CLONE_TARGET_SECONDS) break
    } catch {
      // 单条语音损坏或格式不适配时跳过，继续尝试下一条。
    }
  }

  if (!base || samples.length === 0) {
    if (options.requireTranscript && transcriptFailures > 0) {
      throw new Error('豆包 Realtime 声音复刻需要训练音频对应文本，但所选语音均未能转写；请先确认 STT 模型或在线转写配置可用')
    }
    throw new Error('没有可用的 PCM WAV 语音样本')
  }
  if (totalSeconds < minSeconds) {
    throw new Error(`可用语音样本约 ${Math.round(totalSeconds)} 秒，建议至少 ${minSeconds} 秒后再${actionLabel}`)
  }

  const silence = Buffer.alloc(Math.round(base.sampleRate * base.channels * (base.bitsPerSample / 8) * 0.18))
  const pcmParts: Buffer[] = []
  samples.forEach((sample, index) => {
    if (index > 0) pcmParts.push(silence)
    pcmParts.push(sample.audio.pcm)
  })

  const audio = buildWav(base, Buffer.concat(pcmParts))
  return {
    audioBase64: audio.toString('base64'),
    audioBytes: audio.length,
    sampleCount: samples.length,
    sampleSeconds: Number(totalSeconds.toFixed(1)),
    text: samples.map((sample) => sample.text).filter(Boolean).join('。'),
  }
}

function formatApiError(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return String(payload || '')
  const data = payload as any
  return String(
    data.message ||
    data.error ||
    data.msg ||
    data.BaseResp?.StatusMessage ||
    data.status_text ||
    JSON.stringify(data),
  ).slice(0, 500)
}

function apiKeyFingerprint(apiKey: string): string {
  const key = String(apiKey || '')
  if (!key) return ''
  return createHash('sha256').update(key).digest('hex').slice(0, 12)
}

function endpointPath(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return url
  }
}

function safeJsonPreview(value: unknown, max = 1200): string {
  try {
    return JSON.stringify(value).slice(0, max)
  } catch {
    return String(value).slice(0, max)
  }
}

function sanitizeVolcengineRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const audio = body.audio && typeof body.audio === 'object' ? body.audio as Record<string, unknown> : null
  return {
    ...body,
    audio: audio
      ? {
        format: audio.format,
        dataBase64Chars: typeof audio.data === 'string' ? audio.data.length : 0,
      }
      : undefined,
  }
}

function sanitizeVolcengineRealtimeCloneBody(body: Record<string, unknown>): Record<string, unknown> {
  const audios = Array.isArray(body.audios) ? body.audios : []
  return {
    ...body,
    audios: audios.map((item) => {
      const audio = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      return {
        audio_format: audio.audio_format,
        audioBase64Chars: typeof audio.audio_bytes === 'string' ? audio.audio_bytes.length : 0,
        textChars: typeof audio.text === 'string' ? audio.text.length : 0,
      }
    }),
  }
}

function sanitizeAliyunQwenRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const input = body.input && typeof body.input === 'object' ? body.input as Record<string, unknown> : null
  const audio = input?.audio && typeof input.audio === 'object' ? input.audio as Record<string, unknown> : null
  return {
    ...body,
    input: input
      ? {
        ...input,
        audio: audio
          ? {
            dataBase64Chars: typeof audio.data === 'string' ? audio.data.length : 0,
          }
          : undefined,
      }
      : undefined,
  }
}

function logInfo(logger: PersonaVoiceCloneLogger | null | undefined, message: string, data?: unknown): void {
  if (logger?.info) logger.info('PersonaVoice', message, data)
  else logger?.warn?.('PersonaVoice', message, data)
}

function ensureVolcengineOk(payload: any): void {
  const code = payload?.code ?? payload?.status_code ?? payload?.BaseResp?.StatusCode
  if (code === undefined || code === null || Number(code) === 0) return
  throw new Error(`豆包声音复刻失败 ${code}: ${formatApiError(payload)}`)
}

function formatVolcengineHttpError(status: number, statusText: string, payload: unknown, logId: string): string {
  const detail = formatApiError(payload) || statusText
  const hints: string[] = []
  if (status === 403 && /requested resource not granted/i.test(detail)) {
    hints.push('音色复刻/查询接口只需 X-Api-Key、不传 X-Api-Resource-Id；请确认 API Key 取自新版控制台（console.volcengine.com/speech/new），且账号已开通声音复刻 2.0')
  }
  if (status === 500 && /resource ID is mismatched with speaker related resource/i.test(detail)) {
    hints.push('该 custom_speaker_id 可能已被旧资源/旧复刻记录占用；请换一个新的音色 ID，或到官方控制台删除对应音色后重试')
  }
  if (logId) hints.push(`X-Tt-Logid: ${logId}`)
  return [`豆包声音复刻 HTTP ${status}: ${detail}`, ...hints].join(' · ')
}

function formatAliyunQwenHttpError(status: number, statusText: string, payload: unknown): string {
  const detail = formatApiError(payload) || statusText
  const hints: string[] = []
  if (status === 401 || status === 403) hints.push('请确认 DashScope/百炼 API Key 有效，且账号已开通声音复刻能力')
  if (status === 429) hints.push('通义声音复刻触发限流或额度不足，请稍后重试或检查百炼额度')
  return [`通义声音复刻 HTTP ${status}: ${detail}`, ...hints].join(' · ')
}

async function postVolcengineJson(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  logContext: VolcengineVoiceCloneLogContext,
): Promise<any> {
  const fetchImpl = createProxyFetch(getResolvedProxyUrl()) || fetch
  const requestId = randomUUID()
  const requestLog = {
    operation: logContext.operation,
    sessionId: logContext.sessionId,
    displayName: logContext.displayName,
    endpoint: endpointPath(url),
    requestId,
    apiKeyLength: String(apiKey || '').length,
    apiKeyHash: apiKeyFingerprint(apiKey),
    hasXApiResourceId: false,
    resourceIdHeader: null,
    speakerId: logContext.speakerId,
    sample: logContext.sample,
    body: sanitizeVolcengineRequestBody(body),
  }
  logInfo(logContext.logger, '豆包声音复刻请求开始', requestLog)

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Api-Key': apiKey,
      'X-Api-Request-Id': requestId,
    },
    body: JSON.stringify(body),
  }) as Response
  const logId = response.headers.get('x-tt-logid') || response.headers.get('X-Tt-Logid') || ''
  const text = await response.text().catch(() => '')
  let payload: any = null
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    payload = { message: text }
  }
  const responseLog = {
    ...requestLog,
    httpStatus: response.status,
    httpStatusText: response.statusText,
    ok: response.ok,
    xTtLogid: logId,
    responseBody: safeJsonPreview(payload),
    responseText: text && typeof payload?.message === 'string' ? undefined : text.slice(0, 1200),
  }
  if (!response.ok) {
    logContext.logger?.error?.('PersonaVoice', '豆包声音复刻 HTTP 请求失败', responseLog)
    throw new Error(formatVolcengineHttpError(response.status, response.statusText, payload, logId))
  }
  logInfo(logContext.logger, '豆包声音复刻 HTTP 请求完成', responseLog)
  try {
    ensureVolcengineOk(payload)
  } catch (error) {
    logContext.logger?.error?.('PersonaVoice', '豆包声音复刻业务返回失败', {
      ...responseLog,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
  return payload
}

async function postVolcengineRealtimeCloneJson(
  url: string,
  accessKey: string,
  body: Record<string, unknown>,
  logContext: VolcengineVoiceCloneLogContext,
): Promise<any> {
  const fetchImpl = createProxyFetch(getResolvedProxyUrl()) || fetch
  const requestId = randomUUID()
  const requestLog = {
    operation: logContext.operation,
    sessionId: logContext.sessionId,
    displayName: logContext.displayName,
    endpoint: endpointPath(url),
    requestId,
    accessKeyLength: String(accessKey || '').length,
    accessKeyHash: apiKeyFingerprint(accessKey),
    resourceIdHeader: VOLCENGINE_VOICE_RESOURCE_ID,
    speakerId: logContext.speakerId,
    sample: logContext.sample,
    body: sanitizeVolcengineRealtimeCloneBody(body),
  }
  logInfo(logContext.logger, '豆包 Realtime 声音复刻请求开始', requestLog)

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer;${accessKey}`,
      'Resource-Id': VOLCENGINE_VOICE_RESOURCE_ID,
      'X-Api-Request-Id': requestId,
    },
    body: JSON.stringify(body),
  }) as Response
  const logId = response.headers.get('x-tt-logid') || response.headers.get('X-Tt-Logid') || ''
  const text = await response.text().catch(() => '')
  let payload: any = null
  try { payload = text ? JSON.parse(text) : {} } catch { payload = { message: text } }
  const responseLog = {
    ...requestLog,
    httpStatus: response.status,
    httpStatusText: response.statusText,
    ok: response.ok,
    xTtLogid: logId,
    responseBody: safeJsonPreview(payload),
  }
  if (!response.ok) {
    logContext.logger?.error?.('PersonaVoice', '豆包 Realtime 声音复刻 HTTP 请求失败', responseLog)
    const detail = formatApiError(payload) || response.statusText
    throw new Error(`豆包 Realtime 声音复刻 HTTP ${response.status}: ${detail}${logId ? ` · X-Tt-Logid: ${logId}` : ''}`)
  }
  ensureVolcengineOk(payload)
  logInfo(logContext.logger, '豆包 Realtime 声音复刻 HTTP 请求完成', responseLog)
  return payload
}

async function postAliyunQwenJson(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  logContext: AliyunQwenVoiceCloneLogContext,
): Promise<any> {
  const fetchImpl = createProxyFetch(getResolvedProxyUrl()) || fetch
  const requestId = randomUUID()
  const requestLog = {
    sessionId: logContext.sessionId,
    displayName: logContext.displayName,
    endpoint: endpointPath(url),
    requestId,
    apiKeyLength: String(apiKey || '').length,
    apiKeyHash: apiKeyFingerprint(apiKey),
    preferredName: logContext.preferredName,
    sample: logContext.sample,
    body: sanitizeAliyunQwenRequestBody(body),
  }
  logInfo(logContext.logger, '通义声音复刻请求开始', requestLog)

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  }) as Response
  const text = await response.text().catch(() => '')
  let payload: any = null
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    payload = { message: text }
  }
  const responseLog = {
    ...requestLog,
    httpStatus: response.status,
    httpStatusText: response.statusText,
    ok: response.ok,
    responseBody: safeJsonPreview(payload),
    responseText: text && typeof payload?.message === 'string' ? undefined : text.slice(0, 1200),
  }
  if (!response.ok) {
    logContext.logger?.error?.('PersonaVoice', '通义声音复刻 HTTP 请求失败', responseLog)
    throw new Error(formatAliyunQwenHttpError(response.status, response.statusText, payload))
  }
  logInfo(logContext.logger, '通义声音复刻 HTTP 请求完成', responseLog)
  return payload
}

function extractSpeakerId(payload: any, fallback: string): string {
  const value = payload?.speaker_id || payload?.data?.speaker_id || payload?.result?.speaker_id || ''
  const speaker = String(value || '').trim()
  return speaker && speaker !== 'custom_speaker_id' ? speaker : fallback
}

function extractCloneStatus(payload: any, speakerId: string): CloneStatus {
  const statuses = [
    ...(Array.isArray(payload?.speaker_status) ? payload.speaker_status : []),
    ...(Array.isArray(payload?.data?.speaker_status) ? payload.data.speaker_status : []),
  ]
  const matched = statuses.find((item: any) => String(item?.speaker_id || item?.speaker || '') === speakerId) || statuses[0]
  const source = matched || payload?.data || payload
  const statusValue = source?.status ?? source?.speaker_status
  return {
    status: statusValue === undefined || statusValue === null ? undefined : Number(statusValue),
    message: String(source?.message || source?.status_message || source?.status_text || payload?.message || '').trim(),
    modelType: source?.model_type === undefined ? undefined : Number(source.model_type),
  }
}

async function cloneVolcengineVoice(
  apiKey: string,
  speakerId: string,
  sample: VoiceSample,
  logContext: Omit<VolcengineVoiceCloneLogContext, 'operation' | 'speakerId' | 'sample'>,
): Promise<CloneResult> {
  const payload = await postVolcengineJson(VOLCENGINE_VOICE_CLONE_ENDPOINT, apiKey, {
    speaker_id: 'custom_speaker_id',
    custom_speaker_id: speakerId,
    audio: {
      data: sample.audioBase64,
      format: 'wav',
    },
    language: 0,
    extra_params: {
      voice_clone_denoise_model_id: '',
    },
  }, {
    ...logContext,
    operation: 'clone',
    speakerId,
    sample: {
      audioBytes: sample.audioBytes,
      sampleCount: sample.sampleCount,
      sampleSeconds: sample.sampleSeconds,
    },
  })

  const actualSpeakerId = extractSpeakerId(payload, speakerId)
  const startedAt = Date.now()
  let lastStatus: CloneStatus = extractCloneStatus(payload, actualSpeakerId)
  if (lastStatus.status === 2 || lastStatus.status === 4) return { speakerId: actualSpeakerId, status: lastStatus }

  while (Date.now() - startedAt < VOICE_CLONE_TIMEOUT_MS) {
    await sleep(VOICE_CLONE_POLL_INTERVAL_MS)
    const statusPayload = await postVolcengineJson(VOLCENGINE_VOICE_STATUS_ENDPOINT, apiKey, {
      speaker_id: 'custom_speaker_id',
      custom_speaker_id: actualSpeakerId,
    }, {
      ...logContext,
      operation: 'status',
      speakerId: actualSpeakerId,
    })
    lastStatus = extractCloneStatus(statusPayload, actualSpeakerId)
    if (lastStatus.status === 2 || lastStatus.status === 4) return { speakerId: actualSpeakerId, status: lastStatus }
    if (lastStatus.status === 3) {
      throw new Error(lastStatus.message || '豆包声音复刻失败')
    }
  }

  throw new Error(lastStatus.message || '豆包声音复刻超时，请稍后重试或到官方控制台查看状态')
}

async function cloneVolcengineRealtimeVoice(
  appId: string,
  accessKey: string,
  speakerId: string,
  sample: VoiceSample,
  logContext: Omit<VolcengineVoiceCloneLogContext, 'operation' | 'speakerId' | 'sample'>,
): Promise<CloneResult> {
  if (!sample.text.trim()) throw new Error('豆包 Realtime 声音复刻缺少训练音频对应文本')
  const requestContext = {
    ...logContext,
    speakerId,
    sample: {
      audioBytes: sample.audioBytes,
      sampleCount: sample.sampleCount,
      sampleSeconds: sample.sampleSeconds,
    },
  }
  const uploadPayload = await postVolcengineRealtimeCloneJson(
    VOLCENGINE_REALTIME_VOICE_CLONE_ENDPOINT,
    accessKey,
    {
      speaker_id: speakerId,
      appid: appId,
      audios: [{
        audio_bytes: sample.audioBase64,
        text: sample.text,
        audio_format: 'wav',
      }],
      model_type: VOLCENGINE_VOICE_MODEL_TYPE,
      source: 2,
    },
    { ...requestContext, operation: 'realtime-clone' },
  )

  const startedAt = Date.now()
  let lastStatus = extractCloneStatus(uploadPayload, speakerId)
  if (lastStatus.status === 2 || lastStatus.status === 4) return { speakerId, status: lastStatus }
  while (Date.now() - startedAt < VOICE_CLONE_TIMEOUT_MS) {
    await sleep(VOICE_CLONE_POLL_INTERVAL_MS)
    const statusPayload = await postVolcengineRealtimeCloneJson(
      VOLCENGINE_REALTIME_VOICE_STATUS_ENDPOINT,
      accessKey,
      { appid: appId, speaker_id: speakerId },
      { ...requestContext, operation: 'realtime-status' },
    )
    lastStatus = extractCloneStatus(statusPayload, speakerId)
    if (lastStatus.status === 2 || lastStatus.status === 4) return { speakerId, status: lastStatus }
    if (lastStatus.status === 3) throw new Error(lastStatus.message || '豆包 Realtime 声音复刻失败')
  }
  throw new Error(lastStatus.message || '豆包 Realtime 声音复刻超时，请稍后重试或到官方控制台查看状态')
}

async function cloneAliyunQwenVoice(
  apiKey: string,
  baseURL: string,
  preferredName: string,
  sample: VoiceSample,
  logContext: Omit<AliyunQwenVoiceCloneLogContext, 'preferredName' | 'sample'>,
): Promise<AliyunQwenCloneResult> {
  const endpoint = resolveAliyunQwenCustomizationEndpoint(baseURL)
  const payload = await postAliyunQwenJson(endpoint, apiKey, {
    model: ALIYUN_QWEN_VOICE_CLONE_MODEL,
    input: {
      action: 'create',
      target_model: ALIYUN_QWEN_VOICE_CLONE_TARGET_MODEL,
      preferred_name: preferredName,
      audio: {
        data: `data:${ALIYUN_QWEN_VOICE_SAMPLE_MIME};base64,${sample.audioBase64}`,
      },
      language: 'zh',
    },
  }, {
    ...logContext,
    preferredName,
    sample: {
      audioBytes: sample.audioBytes,
      sampleCount: sample.sampleCount,
      sampleSeconds: sample.sampleSeconds,
    },
  })

  const output = payload?.output || payload?.data?.output || payload?.data || {}
  const voice = String(output.voice || payload?.voice || '').trim()
  if (!voice) throw new Error(`通义声音复刻返回成功但缺少 output.voice：${safeJsonPreview(payload, 500)}`)
  const targetModel = String(output.target_model || payload?.target_model || ALIYUN_QWEN_VOICE_CLONE_TARGET_MODEL).trim()
  const fallbackValue = output.fallback_mode ?? payload?.fallback_mode
  const fallbackMode = fallbackValue === true || fallbackValue === 1 || fallbackValue === 'true'
  const fallbackReason = String(output.fallback_reason || payload?.fallback_reason || '').trim() || undefined
  return {
    voice,
    targetModel: targetModel || ALIYUN_QWEN_VOICE_CLONE_TARGET_MODEL,
    fallbackMode,
    fallbackReason,
  }
}

export async function exportPersonaVoiceSampleFromSession(input: PersonaVoiceSampleExportInput): Promise<PersonaVoiceSampleExportResult> {
  const sessionId = String(input.sessionId || '').trim()
  const outputPath = String(input.outputPath || '').trim()
  const logger = input.logger || null
  const requestedMinSeconds = Number(input.minSeconds)
  const minSeconds = Math.max(10, Number.isFinite(requestedMinSeconds) && requestedMinSeconds > 0 ? requestedMinSeconds : 10)
  try {
    if (!sessionId) return { success: false, error: '缺少 sessionId' }
    if (!outputPath) return { success: false, error: '缺少导出路径' }

    const displayName = String(input.displayName || sessionId).trim()
    logInfo(logger, '开始导出声音复刻样本', { sessionId, displayName, outputPath, minSeconds })

    const sample = await collectVoiceSample(sessionId, { minSeconds, actionLabel: '导出' })
    const audio = Buffer.from(sample.audioBase64, 'base64')
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, audio)

    logInfo(logger, '声音复刻样本导出完成', {
      sessionId,
      displayName,
      outputPath,
      sampleCount: sample.sampleCount,
      sampleSeconds: sample.sampleSeconds,
      audioBytes: audio.length,
    })
    return {
      success: true,
      outputPath,
      sampleCount: sample.sampleCount,
      sampleSeconds: sample.sampleSeconds,
      audioBytes: audio.length,
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logger?.error?.('PersonaVoice', '声音复刻样本导出失败', { sessionId, outputPath, error: message })
    return { success: false, error: message }
  }
}

export async function clonePersonaVoiceFromSession(input: PersonaVoiceCloneInput): Promise<PersonaVoiceCloneResult> {
  const sessionId = String(input.sessionId || '').trim()
  const logger = input.logger || null
  try {
    if (!sessionId) return { success: false, error: '缺少 sessionId' }
    const current = personaStore.get(sessionId)
    if (!current) return { success: false, error: '请先克隆数字分身，再克隆声音' }

    const displayName = String(input.displayName || current.displayName || sessionId).trim()
    const cfg = getTtsConfig()
    const provider = pickVoiceCloneProvider(cfg)
    if (!provider) {
      return { success: false, error: '未配置小米、豆包或通义 TTS API Key，请先在 TTS 设置里填写至少一个服务商密钥' }
    }
    const volcengineConfig = cfg.providers.volcengine
    const hasVolcengineRealtimeCredentials = provider === 'volcengine' &&
      Boolean(String(volcengineConfig.realtimeAppId || '').trim()) &&
      Boolean(String(volcengineConfig.realtimeAccessKey || '').trim())
    if (!String(cfg.providers[provider]?.apiKey || '').trim() && !hasVolcengineRealtimeCredentials) {
      return { success: false, error: getMissingProviderKeyMessage(provider) }
    }

    const providerConfig = cfg.providers[provider]
    logInfo(logger, '声音复刻准备开始', {
      sessionId,
      displayName,
      activeProvider: cfg.activeProvider,
      selectedProvider: provider,
      protocol: providerConfig.protocol,
      apiKeyLength: String(providerConfig.apiKey || '').length,
      apiKeyHash: apiKeyFingerprint(providerConfig.apiKey),
      realtimeRegistration: hasVolcengineRealtimeCredentials,
    })

    const sample = await collectVoiceSample(sessionId, { requireTranscript: hasVolcengineRealtimeCredentials })
    logInfo(logger, '声音复刻样本收集完成', {
      sessionId,
      displayName,
      selectedProvider: provider,
      sampleCount: sample.sampleCount,
      sampleSeconds: sample.sampleSeconds,
      audioBytes: sample.audioBytes,
    })
    const now = Date.now()

    let voice: PersonaTtsVoiceBinding
    let warning: string | undefined
    if (provider === 'xiaomi') {
      const xiaomi = cfg.providers.xiaomi
      const storedSample = persistXiaomiVoiceSample(sessionId, sample)
      voice = {
        provider: 'xiaomi',
        protocol: 'xiaomi-mimo-tts',
        source: 'xiaomi-mimo-voice-clone',
        baseURL: xiaomi.baseURL || XIAOMI_MIMO_DEFAULT_BASE_URL,
        model: XIAOMI_MIMO_VOICE_CLONE_MODEL,
        voice: storedSample.voiceId,
        displayName,
        sampleCount: sample.sampleCount,
        sampleSeconds: sample.sampleSeconds,
        sampleBytes: storedSample.sampleBytes,
        sampleMimeType: XIAOMI_MIMO_VOICE_SAMPLE_MIME,
        samplePath: storedSample.samplePath,
        sampleHash: storedSample.sampleHash,
        createdAt: current.ttsVoice?.provider === 'xiaomi' ? current.ttsVoice.createdAt : now,
        updatedAt: now,
      }
    } else if (provider === 'aliyun-qwen') {
      const aliyun = cfg.providers['aliyun-qwen']
      const cloneContext = {
        logger,
        sessionId,
        displayName,
      }
      const preferredName = makeAliyunQwenVoiceName(sessionId)
      const clone = await cloneAliyunQwenVoice(
        aliyun.apiKey,
        aliyun.baseURL || ALIYUN_QWEN_DEFAULT_REALTIME_ENDPOINT,
        preferredName,
        sample,
        cloneContext,
      )
      if (clone.fallbackMode) {
        warning = `通义声音复刻启用了降级模式${clone.fallbackReason ? `：${clone.fallbackReason}` : ''}`
      }
      voice = {
        provider: 'aliyun-qwen',
        protocol: 'aliyun-qwen-realtime',
        source: 'aliyun-qwen-voice-clone',
        baseURL: aliyun.baseURL || ALIYUN_QWEN_DEFAULT_REALTIME_ENDPOINT,
        model: clone.targetModel || ALIYUN_QWEN_VOICE_CLONE_TARGET_MODEL,
        voice: clone.voice,
        displayName,
        sampleCount: sample.sampleCount,
        sampleSeconds: sample.sampleSeconds,
        sampleBytes: sample.audioBytes,
        sampleMimeType: ALIYUN_QWEN_VOICE_SAMPLE_MIME,
        fallbackMode: clone.fallbackMode,
        fallbackReason: clone.fallbackReason,
        createdAt: current.ttsVoice?.provider === 'aliyun-qwen' ? current.ttsVoice.createdAt : now,
        updatedAt: now,
      }
    } else {
      const volcengine = cfg.providers.volcengine
      const cloneContext = {
        logger,
        sessionId,
        displayName,
      }
      const speakerId = makeCustomSpeakerId(sessionId)
      const realtimeAppId = String(volcengine.realtimeAppId || '').trim()
      const clone = hasVolcengineRealtimeCredentials
        ? await cloneVolcengineRealtimeVoice(
            realtimeAppId,
            String(volcengine.realtimeAccessKey || '').trim(),
            speakerId,
            sample,
            cloneContext,
          )
        : await cloneVolcengineVoice(volcengine.apiKey, speakerId, sample, cloneContext)
      voice = {
        provider: 'volcengine',
        protocol: 'volcengine-bidirectional',
        source: 'volcengine-voice-clone',
        baseURL: volcengine.baseURL || VOLCENGINE_DEFAULT_TTS_ENDPOINT,
        model: VOLCENGINE_VOICE_RESOURCE_ID,
        voice: clone.speakerId,
        ...(hasVolcengineRealtimeCredentials
          ? { realtimeAppId, realtimeResourceId: VOLCENGINE_VOICE_RESOURCE_ID }
          : {}),
        displayName,
        sampleCount: sample.sampleCount,
        sampleSeconds: sample.sampleSeconds,
        sampleBytes: sample.audioBytes,
        sampleMimeType: XIAOMI_MIMO_VOICE_SAMPLE_MIME,
        modelType: clone.status.modelType || VOLCENGINE_VOICE_MODEL_TYPE,
        createdAt: current.ttsVoice?.provider === 'volcengine' ? current.ttsVoice.createdAt : now,
        updatedAt: now,
      }
    }

    const updated = personaStore.patch(sessionId, { ttsVoice: voice })
    if (!updated) return { success: false, error: '保存分身音色失败' }

    logger?.warn?.('PersonaVoice', '声音复刻完成并绑定到数字分身', {
      sessionId,
      displayName,
      provider,
      voiceId: voice.voice,
      sampleCount: sample.sampleCount,
      sampleSeconds: sample.sampleSeconds,
      modelType: voice.modelType,
      fallbackMode: voice.fallbackMode,
      fallbackReason: voice.fallbackReason,
    })
    return { success: true, persona: updated, voice, warning }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logger?.error?.('PersonaVoice', '声音复刻失败', { sessionId, error: message })
    return { success: false, error: message }
  }
}
