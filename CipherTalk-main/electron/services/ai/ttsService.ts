/**
 * 文字转语音服务 —— 独立的 TTS 配置（朗读 AI 回复/微信消息/角色语音回复用），与聊天模型分开。
 * 配置存 ConfigService.ttsConfig，支持三类服务：
 * - xiaomi-mimo-tts：小米 MiMo V2.5 TTS 专用 /chat/completions，按 api-key + audio 参数直连 fetch
 * - volcengine-bidirectional：火山引擎/豆包 V3 WebSocket 双向流式接口，普通合成返回完整音频，播放链路可边收边播
 * - aliyun-qwen-realtime：通义千问/百炼实时 WebSocket，接收 PCM 分片边播边收，结束后包装 WAV 缓存
 * 每个服务商配置独立保存在 providers 下，切换服务商不会覆盖另一套 key/model/voice。
 * 可在主进程与 AI 子进程复用（ConfigService 在两边都能解析路径）。
 */
import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ConfigService } from '../config'
import type { PersonaTtsVoiceBinding } from '../agent/persona/personaTypes'
import { createProxyFetch, getResolvedProxyUrl } from './proxyFetch'
import {
  ALIYUN_QWEN_DEFAULT_REALTIME_ENDPOINT,
  ALIYUN_QWEN_DEFAULT_REALTIME_MODEL,
  ALIYUN_QWEN_DEFAULT_VOICE,
  ALIYUN_QWEN_TTS_CHANNELS,
  ALIYUN_QWEN_TTS_SAMPLE_RATE,
  ALIYUN_QWEN_VOICE_CLONE_TARGET_MODEL,
  isAliyunQwenInstructModel,
  resolveAliyunQwenRealtimeEndpoint,
  synthesizeViaAliyunQwenRealtime,
} from './aliyunQwenTtsProtocol'
import { VOLCENGINE_DEFAULT_TTS_ENDPOINT, synthesizeViaVolcengineBidirectional } from './volcengineTtsProtocol'

export type TtsProviderId = 'xiaomi' | 'volcengine' | 'aliyun-qwen'
export type TtsProtocol = 'xiaomi-mimo-tts' | 'volcengine-bidirectional' | 'aliyun-qwen-realtime'

export interface TtsProviderConfig {
  protocol: TtsProtocol
  apiKey: string
  baseURL: string
  model: string
  voice: string
  instructions: string
  speed: number
}

export interface TtsConfig extends TtsProviderConfig {
  enabled: boolean
  activeProvider: TtsProviderId
  providers: Record<TtsProviderId, TtsProviderConfig>
}

export interface TtsSynthesisResult {
  success: boolean
  /** base64 音频数据（成功时） */
  audioBase64?: string
  mimeType?: string
  cached?: boolean
  error?: string
  /** NOT_CONFIGURED 时渲染端回退系统 speechSynthesis */
  errorCode?: 'NOT_CONFIGURED' | 'SYNTHESIS_FAILED'
}

export interface TtsAudioStreamChunk {
  data: Uint8Array
  format: 'pcm16'
  sampleRate: number
  channels: number
}

export interface TtsStreamingSynthesisResult extends TtsSynthesisResult {
  streamed?: boolean
  streamFormat?: 'pcm16'
  sampleRate?: number
  channels?: number
}

/** 单次合成的文本上限，超长截断，避免长消息造成 TTS 请求过大。 */
const MAX_TTS_INPUT_CHARS = 4000
const TTS_CHAT_TIMEOUT_MS = 90000
const TTS_CACHE_DB_NAME = 'tts-cache.db'
const TTS_CACHE_AUDIO_DIR = 'tts-audio'
const TTS_CACHE_VERSION = 2
const TTS_STREAM_SAMPLE_RATE = 24000
const TTS_STREAM_CHANNELS = 1

let cacheDb: Database.Database | null = null
let cacheDbPath: string | null = null
const pendingSyntheses = new Map<string, Promise<TtsSynthesisResult>>()

type VolcengineTtsResourceGroup = 'legacyTts' | 'tts2' | 'icl2'

const VOLCENGINE_RESOURCE_GROUPS: Record<string, VolcengineTtsResourceGroup> = {
  'seed-tts-2.0': 'tts2',
  'seed-icl-2.0': 'icl2',
}

const VOLCENGINE_LEGACY_RESOURCE_MIGRATIONS: Record<string, string> = {
  'seed-tts-1.0': 'seed-tts-2.0',
  'seed-tts-1.0-concurr': 'seed-tts-2.0',
  'seed-icl-1.0': 'seed-icl-2.0',
  'seed-icl-1.0-concurr': 'seed-icl-2.0',
}

const VOLCENGINE_RESOURCE_DEFAULT_SPEAKERS: Record<string, string> = {
  'seed-tts-2.0': 'zh_female_shuangkuaisisi_uranus_bigtts',
}

const XIAOMI_MIMO_DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1'
const XIAOMI_MIMO_DEFAULT_MODEL = 'mimo-v2.5-tts'
const XIAOMI_MIMO_DEFAULT_VOICE = 'mimo_default'
const PERSONA_VOICE_SAMPLE_DIR = 'persona-voices'

const XIAOMI_MIMO_MODEL_DEFAULT_VOICES: Record<string, string> = {
  'mimo-v2.5-tts': XIAOMI_MIMO_DEFAULT_VOICE,
  'mimo-v2.5-tts-voicedesign': '',
  'mimo-v2.5-tts-voiceclone': '',
}

const ALIYUN_QWEN_MODEL_DEFAULT_VOICES: Record<string, string> = {
  [ALIYUN_QWEN_DEFAULT_REALTIME_MODEL]: ALIYUN_QWEN_DEFAULT_VOICE,
  'qwen3-tts-flash-realtime': ALIYUN_QWEN_DEFAULT_VOICE,
  [ALIYUN_QWEN_VOICE_CLONE_TARGET_MODEL]: '',
}

const ALIYUN_QWEN_SYSTEM_VOICES = new Set(['Cherry', 'Serena', 'Ethan', 'Chelsie'])

const DEFAULT_XIAOMI_TTS_PROVIDER: TtsProviderConfig = {
  protocol: 'xiaomi-mimo-tts',
  apiKey: '',
  baseURL: XIAOMI_MIMO_DEFAULT_BASE_URL,
  model: XIAOMI_MIMO_DEFAULT_MODEL,
  voice: XIAOMI_MIMO_DEFAULT_VOICE,
  instructions: '',
  speed: 1,
}

const DEFAULT_VOLCENGINE_TTS_PROVIDER: TtsProviderConfig = {
  protocol: 'volcengine-bidirectional',
  apiKey: '',
  realtimeAppId: '',
  realtimeAccessKey: '',
  baseURL: VOLCENGINE_DEFAULT_TTS_ENDPOINT,
  model: 'seed-tts-2.0',
  voice: VOLCENGINE_RESOURCE_DEFAULT_SPEAKERS['seed-tts-2.0'],
  instructions: '',
  speed: 1,
}

const DEFAULT_ALIYUN_QWEN_TTS_PROVIDER: TtsProviderConfig = {
  protocol: 'aliyun-qwen-realtime',
  apiKey: '',
  baseURL: ALIYUN_QWEN_DEFAULT_REALTIME_ENDPOINT,
  model: ALIYUN_QWEN_DEFAULT_REALTIME_MODEL,
  voice: ALIYUN_QWEN_DEFAULT_VOICE,
  instructions: '',
  speed: 1,
}

const DEFAULT_TTS_PROVIDERS: Record<TtsProviderId, TtsProviderConfig> = {
  xiaomi: DEFAULT_XIAOMI_TTS_PROVIDER,
  volcengine: DEFAULT_VOLCENGINE_TTS_PROVIDER,
  'aliyun-qwen': DEFAULT_ALIYUN_QWEN_TTS_PROVIDER,
}

const DEFAULT_TTS_CONFIG: TtsConfig = {
  enabled: false,
  activeProvider: 'xiaomi',
  ...DEFAULT_XIAOMI_TTS_PROVIDER,
  providers: {
    xiaomi: { ...DEFAULT_XIAOMI_TTS_PROVIDER },
    volcengine: { ...DEFAULT_VOLCENGINE_TTS_PROVIDER },
    'aliyun-qwen': { ...DEFAULT_ALIYUN_QWEN_TTS_PROVIDER },
  },
}

function normalizeVolcengineResourceId(resourceId: string): string {
  const normalized = String(resourceId || '').trim()
  return VOLCENGINE_LEGACY_RESOURCE_MIGRATIONS[normalized] || normalized
}

function getVolcengineSpeakerGroup(speaker: string): VolcengineTtsResourceGroup | null {
  const normalized = String(speaker || '').trim()
  if (!normalized) return null
  if (/^(S_|icl_)/.test(normalized)) return 'icl2'
  if (normalized.endsWith('_uranus_bigtts') || /^saturn_.+_tob$/.test(normalized)) return 'tts2'
  if (
    normalized === 'custom_mix_bigtts' ||
    /^BV\d+_streaming$/i.test(normalized) ||
    normalized.endsWith('_moon_bigtts') ||
    normalized.endsWith('_mars_bigtts') ||
    normalized.includes('_emo_v2_mars_bigtts') ||
    normalized.includes('_conversation_wvae_bigtts')
  ) {
    return 'legacyTts'
  }
  return null
}

function normalizeVolcengineTtsConfig(cfg: TtsProviderConfig): TtsProviderConfig {
  if (cfg.protocol !== 'volcengine-bidirectional') return cfg

  const resourceId = normalizeVolcengineResourceId(cfg.model)
  const speaker = String(cfg.voice || '').trim()
  const resourceGroup = VOLCENGINE_RESOURCE_GROUPS[resourceId]
  const speakerGroup = getVolcengineSpeakerGroup(speaker)
  if (!resourceGroup || !speakerGroup || resourceGroup === speakerGroup) {
    return resourceId === cfg.model ? cfg : { ...cfg, model: resourceId }
  }

  const fallbackSpeaker = VOLCENGINE_RESOURCE_DEFAULT_SPEAKERS[resourceId] || ''
  if (resourceId === cfg.model && fallbackSpeaker === cfg.voice) return cfg
  return { ...cfg, model: resourceId, voice: fallbackSpeaker }
}

function normalizeXiaomiMimoTtsConfig(cfg: TtsProviderConfig): TtsProviderConfig {
  if (cfg.protocol !== 'xiaomi-mimo-tts') return cfg

  const baseURL = normalizeTtsBaseURL(cfg.baseURL) || XIAOMI_MIMO_DEFAULT_BASE_URL
  const model = String(cfg.model || '').trim() || XIAOMI_MIMO_DEFAULT_MODEL
  const defaultVoice = XIAOMI_MIMO_MODEL_DEFAULT_VOICES[model]
  const voice = model === 'mimo-v2.5-tts-voicedesign'
    ? ''
    : defaultVoice === undefined
      ? String(cfg.voice || '').trim()
      : String(cfg.voice || defaultVoice).trim()

  if (baseURL === cfg.baseURL && model === cfg.model && voice === cfg.voice) return cfg
  return { ...cfg, baseURL, model, voice }
}

function normalizeAliyunQwenTtsConfig(cfg: TtsProviderConfig): TtsProviderConfig {
  if (cfg.protocol !== 'aliyun-qwen-realtime') return cfg

  let baseURL = String(cfg.baseURL || '').trim() || ALIYUN_QWEN_DEFAULT_REALTIME_ENDPOINT
  try {
    const url = new URL(baseURL)
    if (url.protocol === 'https:') url.protocol = 'wss:'
    if (url.protocol === 'http:') url.protocol = 'ws:'
    url.searchParams.delete('model')
    baseURL = url.toString().replace(/\?$/, '')
  } catch {
    baseURL = String(cfg.baseURL || '').trim()
  }
  const model = String(cfg.model || '').trim() || ALIYUN_QWEN_DEFAULT_REALTIME_MODEL
  const defaultVoice = ALIYUN_QWEN_MODEL_DEFAULT_VOICES[model]
  const rawVoice = String(cfg.voice || '').trim()
  const voice = model === ALIYUN_QWEN_VOICE_CLONE_TARGET_MODEL && ALIYUN_QWEN_SYSTEM_VOICES.has(rawVoice)
    ? ''
    : defaultVoice === undefined
      ? rawVoice
      : String(rawVoice || defaultVoice).trim()

  if (baseURL === cfg.baseURL && model === cfg.model && voice === cfg.voice) return cfg
  return { ...cfg, baseURL, model, voice }
}

function getProviderIdForProtocol(protocol: unknown): TtsProviderId {
  if (protocol === 'volcengine-bidirectional') return 'volcengine'
  if (protocol === 'aliyun-qwen-realtime') return 'aliyun-qwen'
  return 'xiaomi'
}

function normalizeProviderId(provider: unknown, fallback: TtsProviderId = 'xiaomi'): TtsProviderId {
  return provider === 'volcengine' || provider === 'xiaomi' || provider === 'aliyun-qwen'
    ? provider
    : fallback
}

function normalizeProviderConfig(provider: TtsProviderId, config: Partial<TtsProviderConfig> = {}): TtsProviderConfig {
  const defaults = DEFAULT_TTS_PROVIDERS[provider]
  const merged: TtsProviderConfig = {
    ...defaults,
    ...config,
    protocol: defaults.protocol,
    apiKey: String(config.apiKey ?? defaults.apiKey ?? ''),
    realtimeAppId: String(config.realtimeAppId ?? defaults.realtimeAppId ?? ''),
    realtimeAccessKey: String(config.realtimeAccessKey ?? defaults.realtimeAccessKey ?? ''),
    baseURL: String(config.baseURL ?? defaults.baseURL ?? ''),
    model: String(config.model ?? defaults.model ?? ''),
    voice: String(config.voice ?? defaults.voice ?? ''),
    instructions: String(config.instructions ?? defaults.instructions ?? ''),
    speed: Number.isFinite(Number(config.speed)) && Number(config.speed) > 0 ? Number(config.speed) : defaults.speed,
  }
  if (provider === 'volcengine') return normalizeVolcengineTtsConfig(merged)
  if (provider === 'aliyun-qwen') return normalizeAliyunQwenTtsConfig(merged)
  return normalizeXiaomiMimoTtsConfig(merged)
}

function hasFlatProviderPatch(value: Partial<TtsConfig>): boolean {
  return ['protocol', 'apiKey', 'realtimeAppId', 'realtimeAccessKey', 'baseURL', 'model', 'voice', 'instructions', 'speed']
    .some((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function normalizeTtsConfig(raw: Partial<TtsConfig> = {}): TtsConfig {
  const rawProviders = (raw.providers && typeof raw.providers === 'object'
    ? raw.providers
    : {}) as Partial<Record<TtsProviderId, Partial<TtsProviderConfig>>>
  const fallbackProvider = getProviderIdForProtocol(raw.protocol)
  const activeProvider = normalizeProviderId(raw.activeProvider, fallbackProvider)
  const providers: Record<TtsProviderId, TtsProviderConfig> = {
    xiaomi: normalizeProviderConfig('xiaomi', rawProviders.xiaomi),
    volcengine: normalizeProviderConfig('volcengine', rawProviders.volcengine),
    'aliyun-qwen': normalizeProviderConfig('aliyun-qwen', rawProviders['aliyun-qwen']),
  }

  if (hasFlatProviderPatch(raw)) {
    const flatProvider = normalizeProviderId(raw.activeProvider, getProviderIdForProtocol(raw.protocol))
    providers[flatProvider] = normalizeProviderConfig(flatProvider, {
      ...providers[flatProvider],
      protocol: raw.protocol,
      apiKey: raw.apiKey,
      realtimeAppId: raw.realtimeAppId,
      realtimeAccessKey: raw.realtimeAccessKey,
      baseURL: raw.baseURL,
      model: raw.model,
      voice: raw.voice,
      instructions: raw.instructions,
      speed: raw.speed,
    })
  }

  const activeConfig = providers[activeProvider]
  return {
    ...DEFAULT_TTS_CONFIG,
    enabled: raw.enabled === true,
    activeProvider,
    ...activeConfig,
    providers,
  }
}

function isXiaomiMimoVoiceCloneSample(voice: string): boolean {
  return /^data:audio\/(?:mpeg|mp3|wav|x-wav);base64,/i.test(String(voice || '').trim())
}

/** 读取持久化的 TTS 配置。 */
export function getTtsConfig(): TtsConfig {
  const cs = new ConfigService()
  try {
    const cfg = cs.get('ttsConfig')
    return normalizeTtsConfig(cfg as Partial<TtsConfig>)
  } finally {
    cs.close()
  }
}

function getPersonaXiaomiVoiceDataUrl(ttsVoice: PersonaTtsVoiceBinding): string {
  const voice = String(ttsVoice.voice || '').trim()
  if (isXiaomiMimoVoiceCloneSample(voice)) return voice

  const samplePath = getPersonaXiaomiSamplePath(ttsVoice)
  if (!samplePath || !existsSync(samplePath)) return voice

  const mimeType = String(ttsVoice.sampleMimeType || 'audio/wav').trim() || 'audio/wav'
  return `data:${mimeType};base64,${readFileSync(samplePath).toString('base64')}`
}

function getPersonaXiaomiSamplePath(ttsVoice: PersonaTtsVoiceBinding): string {
  const explicitPath = String(ttsVoice.samplePath || '').trim()
  if (explicitPath) return explicitPath

  const voiceId = String(ttsVoice.voice || '').trim()
  if (!/^[a-zA-Z0-9_-]+$/.test(voiceId)) return ''
  return join(getTtsCacheBasePath(), PERSONA_VOICE_SAMPLE_DIR, `${voiceId}.wav`)
}

/** persona 专属音色是否可用：绑定存在，且对应全局 provider 留有 API Key。 */
export function isPersonaTtsVoiceAvailable(ttsVoice?: PersonaTtsVoiceBinding | null): boolean {
  if (!ttsVoice?.voice) return false
  const cfg = getTtsConfig()
  if (ttsVoice.provider === 'xiaomi') {
    const xiaomi = cfg.providers.xiaomi
    const hasSample = isXiaomiMimoVoiceCloneSample(ttsVoice.voice) ||
      Boolean(getPersonaXiaomiSamplePath(ttsVoice) && existsSync(getPersonaXiaomiSamplePath(ttsVoice)))
    return Boolean(xiaomi?.apiKey && hasSample)
  }
  if (ttsVoice.provider === 'aliyun-qwen') {
    const aliyun = cfg.providers['aliyun-qwen']
    return Boolean(aliyun?.apiKey && (ttsVoice.model || ALIYUN_QWEN_VOICE_CLONE_TARGET_MODEL) && ttsVoice.voice)
  }
  if (ttsVoice.provider !== 'volcengine') return false
  const volcengine = cfg.providers.volcengine
  return Boolean(volcengine?.apiKey && (ttsVoice.model || 'seed-icl-2.0'))
}

/**
 * 把 persona 专属音色转换为一次性 TTS 配置。
 * 不保存密钥到 persona；这里从全局对应 provider 取 key，保证分身不跟随全局当前服务商漂移。
 */
export function resolvePersonaVoiceTtsConfig(
  ttsVoice: PersonaTtsVoiceBinding,
  overrides: Partial<TtsConfig> = {},
): Partial<TtsConfig> {
  const cfg = getTtsConfig()
  if (ttsVoice.provider === 'xiaomi') {
    const xiaomi = cfg.providers.xiaomi
    const instructions = String(overrides.instructions ?? '').trim() || xiaomi.instructions
    const speed = Number.isFinite(Number(overrides.speed)) && Number(overrides.speed) > 0
      ? Number(overrides.speed)
      : xiaomi.speed

    return {
      enabled: true,
      activeProvider: 'xiaomi',
      protocol: 'xiaomi-mimo-tts',
      apiKey: xiaomi.apiKey,
      baseURL: String(ttsVoice.baseURL || xiaomi.baseURL || XIAOMI_MIMO_DEFAULT_BASE_URL),
      model: String(ttsVoice.model || 'mimo-v2.5-tts-voiceclone'),
      voice: getPersonaXiaomiVoiceDataUrl(ttsVoice),
      instructions,
      speed,
    }
  }

  if (ttsVoice.provider === 'aliyun-qwen') {
    const aliyun = cfg.providers['aliyun-qwen']
    const model = String(ttsVoice.model || ALIYUN_QWEN_VOICE_CLONE_TARGET_MODEL)
    const instructions = isAliyunQwenInstructModel(model)
      ? String(overrides.instructions ?? '').trim() || aliyun.instructions
      : ''
    const speed = Number.isFinite(Number(overrides.speed)) && Number(overrides.speed) > 0
      ? Number(overrides.speed)
      : aliyun.speed

    return {
      enabled: true,
      activeProvider: 'aliyun-qwen',
      protocol: 'aliyun-qwen-realtime',
      apiKey: aliyun.apiKey,
      baseURL: String(ttsVoice.baseURL || aliyun.baseURL || ALIYUN_QWEN_DEFAULT_REALTIME_ENDPOINT),
      model,
      voice: String(ttsVoice.voice || ''),
      instructions,
      speed,
    }
  }

  const volcengine = cfg.providers.volcengine
  const instructions = String(overrides.instructions ?? '').trim() || volcengine.instructions
  const speed = Number.isFinite(Number(overrides.speed)) && Number(overrides.speed) > 0
    ? Number(overrides.speed)
    : volcengine.speed

  return {
    enabled: true,
    activeProvider: 'volcengine',
    protocol: 'volcengine-bidirectional',
    apiKey: volcengine.apiKey,
    baseURL: String(ttsVoice.baseURL || volcengine.baseURL || VOLCENGINE_DEFAULT_TTS_ENDPOINT),
    model: String(ttsVoice.model || 'seed-icl-2.0'),
    voice: String(ttsVoice.voice || ''),
    instructions,
    speed,
  }
}

/** 写入 TTS 配置（部分字段合并）。 */
export function saveTtsConfig(patch: Partial<TtsConfig>): TtsConfig {
  const cs = new ConfigService()
  try {
    const stored = normalizeTtsConfig(cs.get('ttsConfig') as Partial<TtsConfig>)
    const next = normalizeTtsConfig({
      ...stored,
      ...patch,
      providers: {
        ...stored.providers,
        ...(patch.providers || {}),
      },
    })
    cs.set('ttsConfig', next)
    return next
  } finally {
    cs.close()
  }
}

/** TTS 是否可用：启用且配了 key/模型。渲染端据此决定走在线合成还是系统朗读。 */
export function isTtsAvailable(cfg: TtsConfig = getTtsConfig()): boolean {
  const needsXiaomiVoice = cfg.protocol === 'xiaomi-mimo-tts' &&
    cfg.model !== 'mimo-v2.5-tts-voicedesign'
  const needsAliyunQwenVoice = cfg.protocol === 'aliyun-qwen-realtime'
  return cfg.enabled &&
    Boolean(cfg.apiKey) &&
    Boolean(cfg.model) &&
    (cfg.protocol !== 'volcengine-bidirectional' || Boolean(cfg.voice)) &&
    (!needsAliyunQwenVoice || Boolean(cfg.voice)) &&
    (!needsXiaomiVoice || Boolean(cfg.voice))
}

function validateTtsConfig(cfg: TtsConfig): string | null {
  if (!cfg.apiKey) return '未配置 TTS API Key'
  if (!cfg.model) return '未配置 TTS 模型'
  if (cfg.protocol === 'volcengine-bidirectional' && !cfg.voice) return '未配置火山引擎音色 Speaker'
  if (cfg.protocol === 'aliyun-qwen-realtime' && !cfg.voice) return '未配置通义千问音色 voice'
  if (cfg.protocol === 'xiaomi-mimo-tts' && cfg.model !== 'mimo-v2.5-tts-voicedesign' && !cfg.voice) {
    return cfg.model === 'mimo-v2.5-tts-voiceclone'
      ? '未配置小米音色样本 Data URL'
      : '未配置小米预置音色'
  }
  if (cfg.protocol === 'xiaomi-mimo-tts' && cfg.model === 'mimo-v2.5-tts-voiceclone' && !isXiaomiMimoVoiceCloneSample(cfg.voice)) {
    return '小米音色复刻样本必须是 data:audio/mpeg;base64,... 或 data:audio/wav;base64,...'
  }
  if (cfg.baseURL) {
    try {
      new URL(cfg.baseURL)
    } catch {
      return 'TTS 接口地址格式无效'
    }
  }
  return null
}

function getVolcengineEndpoint(cfg: TtsConfig): string {
  return normalizeTtsBaseURL(cfg.baseURL) || VOLCENGINE_DEFAULT_TTS_ENDPOINT
}

function getAliyunQwenEndpoint(cfg: TtsConfig): string {
  return resolveAliyunQwenRealtimeEndpoint(cfg.baseURL || ALIYUN_QWEN_DEFAULT_REALTIME_ENDPOINT, cfg.model)
}

/** 把各种异常拼成带 HTTP 状态/响应体的可诊断信息（AI SDK 的 APICallError 自带这些字段）。 */
function describeTtsError(e: unknown): string {
  const err = e as { statusCode?: number; responseBody?: string; message?: string }
  const parts: string[] = []
  if (err?.statusCode) parts.push(`HTTP ${err.statusCode}`)
  if (err?.responseBody) parts.push(String(err.responseBody).slice(0, 300))
  if (parts.length === 0) parts.push(e instanceof Error ? e.message : String(e))
  return parts.join(' · ')
}

function getTtsCacheBasePath(): string {
  const cs = new ConfigService()
  try {
    return cs.getCacheBasePath()
  } finally {
    cs.close()
  }
}

function ensureTtsCacheDb(): Database.Database {
  const basePath = getTtsCacheBasePath()
  if (!existsSync(basePath)) {
    mkdirSync(basePath, { recursive: true })
  }
  const dbPath = join(basePath, TTS_CACHE_DB_NAME)
  if (cacheDb && cacheDbPath === dbPath) return cacheDb

  if (cacheDb) {
    cacheDb.close()
    cacheDb = null
  }

  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tts_audio_cache (
      cache_key TEXT PRIMARY KEY,
      text_hash TEXT NOT NULL,
      protocol TEXT NOT NULL,
      base_url TEXT NOT NULL,
      model TEXT NOT NULL,
      voice TEXT NOT NULL,
      instructions TEXT NOT NULL DEFAULT '',
      speed REAL NOT NULL,
      mime_type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tts_audio_cache_last_used
      ON tts_audio_cache(last_used_at);
  `)
  try { db.exec("ALTER TABLE tts_audio_cache ADD COLUMN instructions TEXT NOT NULL DEFAULT ''") } catch { /* column exists */ }
  cacheDb = db
  cacheDbPath = dbPath
  return db
}

function normalizeTtsBaseURL(baseURL: string): string {
  return String(baseURL || '').trim().replace(/\/+$/, '')
}

function normalizeTtsSpeed(speed: number): number {
  return Number.isFinite(speed) && speed > 0 ? Number(speed.toFixed(3)) : 1
}

function normalizeTtsInstructions(instructions: string): string {
  return String(instructions || '').trim().slice(0, 1000)
}

function getChatCompletionsEndpoint(baseURL: string): string {
  const normalized = normalizeTtsBaseURL(baseURL)
  if (/\/chat\/completions$/i.test(normalized)) return normalized
  return `${normalized}/chat/completions`
}

function getXiaomiMimoSpeedInstruction(speed: number): string {
  const normalized = normalizeTtsSpeed(speed)
  if (normalized <= 0.85) return '语速偏慢，停顿更从容。'
  if (normalized >= 1.15) return '语速偏快，表达更轻快。'
  return ''
}

function getAliyunQwenSpeedInstruction(speed: number): string {
  const normalized = normalizeTtsSpeed(speed)
  if (normalized <= 0.85) return '请用偏慢语速朗读，停顿更从容。'
  if (normalized >= 1.15) return '请用偏快语速朗读，表达更轻快。'
  return ''
}

function getAliyunQwenInstructions(cfg: TtsConfig): string {
  if (!isAliyunQwenInstructModel(cfg.model)) return ''
  return [
    normalizeTtsInstructions(cfg.instructions),
    getAliyunQwenSpeedInstruction(cfg.speed),
  ].filter(Boolean).join('\n')
}

function stripBase64DataUrl(value: string): string {
  return String(value || '').trim().replace(/^data:[^;]+;base64,/i, '')
}

function buildPcm16Wav(pcm: Buffer, sampleRate = TTS_STREAM_SAMPLE_RATE, channels = TTS_STREAM_CHANNELS): Buffer {
  const bitsPerSample = 16
  const byteRate = sampleRate * channels * (bitsPerSample / 8)
  const blockAlign = channels * (bitsPerSample / 8)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function createTtsCacheKey(text: string, cfg: TtsConfig): string {
  return createHash('sha256').update(JSON.stringify({
    version: TTS_CACHE_VERSION,
    text,
    protocol: cfg.protocol,
    baseURL: normalizeTtsBaseURL(cfg.baseURL),
    model: cfg.model,
    voice: cfg.voice || '',
    instructions: normalizeTtsInstructions(cfg.instructions),
    speed: normalizeTtsSpeed(cfg.speed),
    format: cfg.protocol === 'volcengine-bidirectional' ? 'mp3' : 'wav',
  })).digest('hex')
}

function getAudioExtension(mimeType: string): string {
  const normalized = String(mimeType || '').split(';')[0].trim().toLowerCase()
  if (normalized === 'audio/mpeg' || normalized === 'audio/mp3') return '.mp3'
  if (normalized === 'audio/wav' || normalized === 'audio/x-wav') return '.wav'
  if (normalized === 'audio/ogg') return '.ogg'
  if (normalized === 'audio/aac') return '.aac'
  if (normalized === 'audio/flac') return '.flac'
  return '.mp3'
}

function readTtsCache(cacheKey: string): TtsSynthesisResult | null {
  try {
    const db = ensureTtsCacheDb()
    const row = db.prepare(`
      SELECT mime_type AS mimeType, file_path AS filePath
      FROM tts_audio_cache
      WHERE cache_key = ?
    `).get(cacheKey) as { mimeType: string; filePath: string } | undefined

    if (!row) return null
    if (!existsSync(row.filePath)) {
      db.prepare('DELETE FROM tts_audio_cache WHERE cache_key = ?').run(cacheKey)
      return null
    }

    db.prepare('UPDATE tts_audio_cache SET last_used_at = ? WHERE cache_key = ?').run(Date.now(), cacheKey)
    return {
      success: true,
      audioBase64: readFileSync(row.filePath).toString('base64'),
      mimeType: row.mimeType || 'audio/mpeg',
      cached: true,
    }
  } catch (e) {
    console.warn('[TTS] 读取缓存失败:', e)
    return null
  }
}

function writeTtsCache(cacheKey: string, text: string, cfg: TtsConfig, result: TtsSynthesisResult): void {
  if (!result.success || !result.audioBase64) return

  try {
    const basePath = getTtsCacheBasePath()
    const audioDir = join(basePath, TTS_CACHE_AUDIO_DIR)
    if (!existsSync(audioDir)) {
      mkdirSync(audioDir, { recursive: true })
    }

    const mimeType = result.mimeType || 'audio/mpeg'
    const buffer = Buffer.from(result.audioBase64, 'base64')
    const filePath = join(audioDir, `${cacheKey}${getAudioExtension(mimeType)}`)
    writeFileSync(filePath, buffer)

    const db = ensureTtsCacheDb()
    const now = Date.now()
    db.prepare(`
      INSERT OR REPLACE INTO tts_audio_cache (
        cache_key, text_hash, protocol, base_url, model, voice, instructions, speed,
        mime_type, file_path, size_bytes, created_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      cacheKey,
      createHash('sha256').update(text).digest('hex'),
      cfg.protocol,
      normalizeTtsBaseURL(cfg.baseURL),
      cfg.model,
      cfg.voice || '',
      normalizeTtsInstructions(cfg.instructions),
      normalizeTtsSpeed(cfg.speed),
      mimeType,
      filePath,
      buffer.length,
      now,
      now,
    )
  } catch (e) {
    console.warn('[TTS] 写入缓存失败:', e)
  }
}

export function closeTtsCache(): void {
  if (cacheDb) {
    cacheDb.close()
    cacheDb = null
    cacheDbPath = null
  }
  pendingSyntheses.clear()
}

export function getTtsCachePaths(): { dbPath: string; audioDir: string } {
  const basePath = getTtsCacheBasePath()
  return {
    dbPath: join(basePath, TTS_CACHE_DB_NAME),
    audioDir: join(basePath, TTS_CACHE_AUDIO_DIR),
  }
}

export function clearTtsCache(): { success: boolean; error?: string } {
  try {
    closeTtsCache()
    const { dbPath, audioDir } = getTtsCachePaths()
    for (const filePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
      if (existsSync(filePath)) rmSync(filePath, { force: true })
    }
    if (existsSync(audioDir)) rmSync(audioDir, { recursive: true, force: true })
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

/** xiaomi-mimo-tts：小米 MiMo V2.5 TTS，按官方 /chat/completions 音频参数调用。 */
async function synthesizeViaXiaomiMimoApi(text: string, cfg: TtsConfig, signal?: AbortSignal): Promise<TtsSynthesisResult> {
  const fetchImpl = createProxyFetch(getResolvedProxyUrl()) || fetch
  const endpoint = getChatCompletionsEndpoint(cfg.baseURL || XIAOMI_MIMO_DEFAULT_BASE_URL)
  const model = String(cfg.model || XIAOMI_MIMO_DEFAULT_MODEL).trim()
  const instructions = normalizeTtsInstructions(cfg.instructions)
  const speedInstruction = getXiaomiMimoSpeedInstruction(cfg.speed)
  const userInstruction = [instructions, speedInstruction].filter(Boolean).join('\n')
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []

  if (userInstruction || model === 'mimo-v2.5-tts-voicedesign' || model === 'mimo-v2.5-tts-voiceclone') {
    messages.push({
      role: 'user',
      content: userInstruction || (model === 'mimo-v2.5-tts-voicedesign'
        ? '请生成自然、清晰、适合日常对话的中文音色。'
        : ''),
    })
  }
  messages.push({ role: 'assistant', content: text })

  const audio: Record<string, unknown> = { format: 'wav' }
  if (model === 'mimo-v2.5-tts-voicedesign') {
    audio.optimize_text_preview = true
  } else {
    audio.voice = cfg.voice || XIAOMI_MIMO_DEFAULT_VOICE
  }

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'api-key': cfg.apiKey,
    },
    body: JSON.stringify({
      model,
      messages,
      audio,
      stream: false,
    }),
    signal,
  }) as Response

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    return { success: false, error: `HTTP ${response.status} · ${detail.slice(0, 300) || response.statusText}`, errorCode: 'SYNTHESIS_FAILED' }
  }

  const payload: any = await response.json().catch(() => null)
  const responseAudio = payload?.choices?.[0]?.message?.audio
  const data = stripBase64DataUrl(String(responseAudio?.data || ''))
  if (data) {
    const format = String(responseAudio?.format || 'wav').toLowerCase()
    return {
      success: true,
      audioBase64: data,
      mimeType: format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
    }
  }

  const url = String(responseAudio?.url || '').trim()
  if (url) {
    const audioResponse = await fetchImpl(url, { signal })
    if (!audioResponse.ok) {
      return { success: false, error: `下载音频失败: HTTP ${audioResponse.status}`, errorCode: 'SYNTHESIS_FAILED' }
    }
    const mimeType = audioResponse.headers.get('content-type')?.split(';')[0] || 'audio/wav'
    const buffer = Buffer.from(await audioResponse.arrayBuffer())
    return { success: true, audioBase64: buffer.toString('base64'), mimeType }
  }

  const preview = JSON.stringify(payload)?.slice(0, 300) || '空响应'
  return { success: false, error: `小米接口返回成功但没有音频数据（message.audio.data/url 均为空）：${preview}`, errorCode: 'SYNTHESIS_FAILED' }
}

function canUseLowLatencyStreaming(cfg: TtsConfig): boolean {
  if (cfg.protocol === 'aliyun-qwen-realtime') return true
  if (cfg.protocol === 'volcengine-bidirectional') return true
  return cfg.protocol === 'xiaomi-mimo-tts' && String(cfg.model || '').trim() === XIAOMI_MIMO_DEFAULT_MODEL
}

async function readSseJsonStream(
  response: Response,
  onJson: (payload: any) => void,
): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('流式响应缺少 body')

  const decoder = new TextDecoder()
  let buffer = ''

  const consumeBlock = (block: string) => {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim()
    if (!data || data === '[DONE]') return
    try {
      onJson(JSON.parse(data))
    } catch {
      throw new Error(`小米流式响应 JSON 解析失败: ${data.slice(0, 300)}`)
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    let index = buffer.indexOf('\n\n')
    while (index >= 0) {
      consumeBlock(buffer.slice(0, index))
      buffer = buffer.slice(index + 2)
      index = buffer.indexOf('\n\n')
    }
  }

  buffer += decoder.decode()
  if (buffer.trim()) consumeBlock(buffer.replace(/\r\n/g, '\n'))
}

/** 小米 MiMo 标准 TTS 低延迟流式：官方要求 stream=true + audio.format=pcm16。 */
async function synthesizeViaXiaomiMimoStreamingApi(
  text: string,
  cfg: TtsConfig,
  onAudioChunk: (chunk: TtsAudioStreamChunk) => void,
  signal?: AbortSignal,
): Promise<TtsStreamingSynthesisResult> {
  const fetchImpl = createProxyFetch(getResolvedProxyUrl()) || fetch
  const endpoint = getChatCompletionsEndpoint(cfg.baseURL || XIAOMI_MIMO_DEFAULT_BASE_URL)
  const instructions = normalizeTtsInstructions(cfg.instructions)
  const speedInstruction = getXiaomiMimoSpeedInstruction(cfg.speed)
  const userInstruction = [instructions, speedInstruction].filter(Boolean).join('\n')
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []
  if (userInstruction) messages.push({ role: 'user', content: userInstruction })
  messages.push({ role: 'assistant', content: text })

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'api-key': cfg.apiKey,
    },
    body: JSON.stringify({
      model: XIAOMI_MIMO_DEFAULT_MODEL,
      messages,
      audio: {
        format: 'pcm16',
        voice: cfg.voice || XIAOMI_MIMO_DEFAULT_VOICE,
      },
      stream: true,
    }),
    signal,
  }) as Response

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    return { success: false, error: `HTTP ${response.status} · ${detail.slice(0, 300) || response.statusText}`, errorCode: 'SYNTHESIS_FAILED' }
  }

  const chunks: Buffer[] = []
  await readSseJsonStream(response, (payload) => {
    const audio = payload?.choices?.[0]?.delta?.audio
    const data = stripBase64DataUrl(String(audio?.data || ''))
    if (!data) return
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length === 0) return
    chunks.push(bytes)
    onAudioChunk({
      data: bytes,
      format: 'pcm16',
      sampleRate: TTS_STREAM_SAMPLE_RATE,
      channels: TTS_STREAM_CHANNELS,
    })
  })

  if (chunks.length === 0) {
    return { success: false, error: '小米流式接口未返回音频数据', errorCode: 'SYNTHESIS_FAILED' }
  }

  return {
    success: true,
    streamed: true,
    streamFormat: 'pcm16',
    sampleRate: TTS_STREAM_SAMPLE_RATE,
    channels: TTS_STREAM_CHANNELS,
    audioBase64: buildPcm16Wav(Buffer.concat(chunks)).toString('base64'),
    mimeType: 'audio/wav',
  }
}

/** volcengine-bidirectional：火山引擎/豆包 V3 WebSocket 双向流式 TTS。 */
async function synthesizeViaVolcengineApi(text: string, cfg: TtsConfig, signal?: AbortSignal): Promise<TtsSynthesisResult> {
  return synthesizeViaVolcengineBidirectional({
    apiKey: cfg.apiKey,
    endpoint: getVolcengineEndpoint(cfg),
    resourceId: cfg.model,
    speaker: cfg.voice,
    text,
    instructions: cfg.instructions,
    speed: cfg.speed,
    signal,
  })
}

/** aliyun-qwen-realtime：通义千问/百炼实时 WebSocket TTS，返回 PCM 后包装 WAV。 */
async function synthesizeViaAliyunQwenApi(text: string, cfg: TtsConfig, signal?: AbortSignal): Promise<TtsSynthesisResult> {
  const result = await synthesizeViaAliyunQwenRealtime({
    apiKey: cfg.apiKey,
    endpoint: getAliyunQwenEndpoint(cfg),
    model: cfg.model,
    voice: cfg.voice,
    text,
    instructions: getAliyunQwenInstructions(cfg),
    signal,
  })

  if (!result.success || !result.audioBase64) return result
  const pcm = Buffer.from(stripBase64DataUrl(result.audioBase64), 'base64')
  return {
    success: true,
    audioBase64: buildPcm16Wav(pcm, result.sampleRate || ALIYUN_QWEN_TTS_SAMPLE_RATE, result.channels || ALIYUN_QWEN_TTS_CHANNELS).toString('base64'),
    mimeType: 'audio/wav',
  }
}

/** 豆包 WebSocket 流式播放路径：请求 PCM 分片，结束后包装成 WAV 供缓存复用。 */
async function synthesizeViaVolcengineStreamingApi(
  text: string,
  cfg: TtsConfig,
  onAudioChunk: (chunk: TtsAudioStreamChunk) => void,
  signal?: AbortSignal,
): Promise<TtsStreamingSynthesisResult> {
  const result = await synthesizeViaVolcengineBidirectional({
    apiKey: cfg.apiKey,
    endpoint: getVolcengineEndpoint(cfg),
    resourceId: cfg.model,
    speaker: cfg.voice,
    text,
    instructions: cfg.instructions,
    speed: cfg.speed,
    audioFormat: 'pcm',
    onAudioChunk: (chunk) => {
      onAudioChunk({
        data: chunk,
        format: 'pcm16',
        sampleRate: TTS_STREAM_SAMPLE_RATE,
        channels: TTS_STREAM_CHANNELS,
      })
    },
    signal,
  })

  if (!result.success || !result.audioBase64) return { ...result, streamed: false }
  const pcm = Buffer.from(stripBase64DataUrl(result.audioBase64), 'base64')
  return {
    ...result,
    streamed: true,
    streamFormat: 'pcm16',
    sampleRate: TTS_STREAM_SAMPLE_RATE,
    channels: TTS_STREAM_CHANNELS,
    audioBase64: buildPcm16Wav(pcm).toString('base64'),
    mimeType: 'audio/wav',
  }
}

/** 通义 WebSocket 流式播放路径：response.audio.delta 是 PCM base64 分片。 */
async function synthesizeViaAliyunQwenStreamingApi(
  text: string,
  cfg: TtsConfig,
  onAudioChunk: (chunk: TtsAudioStreamChunk) => void,
  signal?: AbortSignal,
): Promise<TtsStreamingSynthesisResult> {
  const result = await synthesizeViaAliyunQwenRealtime({
    apiKey: cfg.apiKey,
    endpoint: getAliyunQwenEndpoint(cfg),
    model: cfg.model,
    voice: cfg.voice,
    text,
    instructions: getAliyunQwenInstructions(cfg),
    onAudioChunk: (chunk) => {
      onAudioChunk({
        data: chunk,
        format: 'pcm16',
        sampleRate: ALIYUN_QWEN_TTS_SAMPLE_RATE,
        channels: ALIYUN_QWEN_TTS_CHANNELS,
      })
    },
    signal,
  })

  if (!result.success || !result.audioBase64) return { ...result, streamed: false }
  const pcm = Buffer.from(stripBase64DataUrl(result.audioBase64), 'base64')
  return {
    success: true,
    streamed: true,
    streamFormat: 'pcm16',
    sampleRate: result.sampleRate || ALIYUN_QWEN_TTS_SAMPLE_RATE,
    channels: result.channels || ALIYUN_QWEN_TTS_CHANNELS,
    audioBase64: buildPcm16Wav(pcm, result.sampleRate || ALIYUN_QWEN_TTS_SAMPLE_RATE, result.channels || ALIYUN_QWEN_TTS_CHANNELS).toString('base64'),
    mimeType: 'audio/wav',
  }
}

/** 合成语音。cfg 缺省读持久化配置（试听时传 overrides）。 */
export async function synthesizeSpeech(
  text: string,
  options: { config?: Partial<TtsConfig>; signal?: AbortSignal; useCache?: boolean } = {},
): Promise<TtsSynthesisResult> {
  const cfg: TtsConfig = normalizeTtsConfig({ ...getTtsConfig(), ...options.config })
  if (!options.config && !isTtsAvailable(cfg)) {
    return { success: false, error: '未启用或未配置文字转语音', errorCode: 'NOT_CONFIGURED' }
  }
  const invalid = validateTtsConfig(cfg)
  if (invalid) return { success: false, error: invalid, errorCode: 'NOT_CONFIGURED' }

  const input = String(text || '').trim().slice(0, MAX_TTS_INPUT_CHARS)
  if (!input) return { success: false, error: '朗读内容为空', errorCode: 'SYNTHESIS_FAILED' }

  if (!isTtsAvailable(cfg) && options.useCache !== false) {
    return { success: false, error: '未启用或未配置文字转语音', errorCode: 'NOT_CONFIGURED' }
  }

  const shouldUseCache = options.useCache ?? !options.config
  const cacheKey = shouldUseCache ? createTtsCacheKey(input, cfg) : ''
  if (cacheKey) {
    const cached = readTtsCache(cacheKey)
    if (cached) return cached
    const pending = pendingSyntheses.get(cacheKey)
    if (pending) return pending
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TTS_CHAT_TIMEOUT_MS)
  options.signal?.addEventListener('abort', () => controller.abort())

  const runSynthesis = async (): Promise<TtsSynthesisResult> => {
    if (cfg.protocol === 'aliyun-qwen-realtime') {
      return synthesizeViaAliyunQwenApi(input, cfg, controller.signal)
    }
    if (cfg.protocol === 'volcengine-bidirectional') {
      return synthesizeViaVolcengineApi(input, cfg, controller.signal)
    }
    return synthesizeViaXiaomiMimoApi(input, cfg, controller.signal)
  }

  const task = (async (): Promise<TtsSynthesisResult> => {
    try {
      const result = await runSynthesis()
      if (cacheKey && result.success && result.audioBase64) {
        writeTtsCache(cacheKey, input, cfg, result)
      }
      return result
    } catch (e) {
      const detail = controller.signal.aborted && !options.signal?.aborted
        ? '请求超时'
        : describeTtsError(e)
      console.error('[TTS] 合成失败:', detail)
      return { success: false, error: detail, errorCode: 'SYNTHESIS_FAILED' }
    } finally {
      clearTimeout(timeout)
      if (cacheKey) pendingSyntheses.delete(cacheKey)
    }
  })()

  if (cacheKey) pendingSyntheses.set(cacheKey, task)
  return task
}

/** 流式合成语音。支持低延迟的 provider 会通过 onAudioChunk 推 PCM16 分片；否则回退完整合成。 */
export async function synthesizeSpeechStream(
  text: string,
  options: {
    config?: Partial<TtsConfig>
    signal?: AbortSignal
    useCache?: boolean
    onAudioChunk: (chunk: TtsAudioStreamChunk) => void
  },
): Promise<TtsStreamingSynthesisResult> {
  const cfg: TtsConfig = normalizeTtsConfig({ ...getTtsConfig(), ...options.config })
  if (!options.config && !isTtsAvailable(cfg)) {
    return { success: false, error: '未启用或未配置文字转语音', errorCode: 'NOT_CONFIGURED' }
  }
  const invalid = validateTtsConfig(cfg)
  if (invalid) return { success: false, error: invalid, errorCode: 'NOT_CONFIGURED' }

  const input = String(text || '').trim().slice(0, MAX_TTS_INPUT_CHARS)
  if (!input) return { success: false, error: '朗读内容为空', errorCode: 'SYNTHESIS_FAILED' }

  if (!isTtsAvailable(cfg) && options.useCache !== false) {
    return { success: false, error: '未启用或未配置文字转语音', errorCode: 'NOT_CONFIGURED' }
  }

  const shouldUseCache = options.useCache ?? !options.config
  const cacheKey = shouldUseCache ? createTtsCacheKey(input, cfg) : ''
  if (cacheKey) {
    const cached = readTtsCache(cacheKey)
    if (cached) return { ...cached, streamed: false }
  }

  if (!canUseLowLatencyStreaming(cfg)) {
    const complete = await synthesizeSpeech(input, {
      config: options.config,
      signal: options.signal,
      useCache: options.useCache,
    })
    return { ...complete, streamed: false }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TTS_CHAT_TIMEOUT_MS)
  options.signal?.addEventListener('abort', () => controller.abort())

  try {
    const result = cfg.protocol === 'aliyun-qwen-realtime'
      ? await synthesizeViaAliyunQwenStreamingApi(input, cfg, options.onAudioChunk, controller.signal)
      : cfg.protocol === 'volcengine-bidirectional'
        ? await synthesizeViaVolcengineStreamingApi(input, cfg, options.onAudioChunk, controller.signal)
        : await synthesizeViaXiaomiMimoStreamingApi(input, cfg, options.onAudioChunk, controller.signal)

    if (cacheKey && result.success && result.audioBase64) {
      writeTtsCache(cacheKey, input, cfg, result)
    }
    return result
  } catch (e) {
    const detail = controller.signal.aborted && !options.signal?.aborted
      ? '请求超时'
      : describeTtsError(e)
    console.error('[TTS] 流式合成失败:', detail)
    return { success: false, streamed: false, error: detail, errorCode: 'SYNTHESIS_FAILED' }
  } finally {
    clearTimeout(timeout)
  }
}

/** 只清理缺失音频文件的陈旧记录；供测试/维护调用。 */
export function pruneTtsCache(): { success: boolean; removed: number; error?: string } {
  try {
    const db = ensureTtsCacheDb()
    const rows = db.prepare('SELECT cache_key AS cacheKey, file_path AS filePath FROM tts_audio_cache')
      .all() as Array<{ cacheKey: string; filePath: string }>
    let removed = 0
    const deleteStmt = db.prepare('DELETE FROM tts_audio_cache WHERE cache_key = ?')
    for (const row of rows) {
      if (existsSync(row.filePath)) continue
      deleteStmt.run(row.cacheKey)
      removed += 1
    }
    return { success: true, removed }
  } catch (e) {
    return { success: false, removed: 0, error: String(e) }
  }
}

/** 测试配置：合成一小段试听音频，成功即配置可用（音频回给 UI 播放）。 */
export async function testTtsConfig(cfg: Partial<TtsConfig>): Promise<TtsSynthesisResult> {
  return synthesizeSpeech('你好，这是密语的语音试听。', { config: cfg, useCache: false })
}
