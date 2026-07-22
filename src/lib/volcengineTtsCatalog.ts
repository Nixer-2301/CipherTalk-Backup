export interface VolcengineTtsEndpointOption {
  id: string
  label: string
  url: string
  scenario: string
  supported: boolean
}

export interface VolcengineTtsResourceOption {
  id: string
  label: string
  family: 'tts' | 'icl'
  version: '2.0'
  billing: string
  hint: string
  defaultSpeaker?: string
}

export interface VolcengineTtsVoiceOption {
  id: string
  label: string
  resourceIds: string[]
  language: string
  scene: string
  hint: string
}

export const VOLCENGINE_TTS_ENDPOINTS: VolcengineTtsEndpointOption[] = [
  {
    id: 'ws-bidirectional-v3',
    label: 'WebSocket 双向流式 V3',
    url: 'wss://openspeech.bytedance.com/api/v3/tts/bidirection',
    scenario: '实时交互；支持流式输入文本、流式输出音频',
    supported: true,
  },
  {
    id: 'ws-unidirectional-v3',
    label: 'WebSocket 单向流式 V3',
    url: 'wss://openspeech.bytedance.com/api/v3/tts/unidirectional/stream',
    scenario: '一次性输入文本、流式输出音频',
    supported: false,
  },
  {
    id: 'http-chunked-v3',
    label: 'HTTP Chunked 单向流式 V3',
    url: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
    scenario: 'HTTP chunked 流式输出音频',
    supported: false,
  },
  {
    id: 'http-sse-v3',
    label: 'HTTP SSE 单向流式 V3',
    url: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse',
    scenario: 'Server-Sent Events 流式输出音频',
    supported: false,
  },
]

export const VOLCENGINE_TTS_SUPPORTED_ENDPOINTS = VOLCENGINE_TTS_ENDPOINTS.filter((item) => item.supported)

export const VOLCENGINE_SPEECH_CONSOLE_URL = 'https://console.volcengine.com/speech/new/overview'

export const VOLCENGINE_TTS_RESOURCES: VolcengineTtsResourceOption[] = [
  {
    id: 'seed-tts-2.0',
    label: '豆包语音合成模型 2.0',
    family: 'tts',
    version: '2.0',
    billing: '语音合成 2.0 字符版',
    hint: '仅支持豆包语音合成模型 2.0 音色，推荐优先使用。',
    defaultSpeaker: 'zh_female_shuangkuaisisi_uranus_bigtts',
  },
  {
    id: 'seed-icl-2.0',
    label: '豆包声音复刻模型 2.0',
    family: 'icl',
    version: '2.0',
    billing: '声音复刻 2.0 字符版',
    hint: '用于声音复刻 2.0 音色，Speaker 通常来自控制台或查询接口。',
  },
]

export const VOLCENGINE_TTS_VOICES: VolcengineTtsVoiceOption[] = [
  {
    id: 'zh_female_shuangkuaisisi_uranus_bigtts',
    label: '爽快思思 2.0',
    resourceIds: ['seed-tts-2.0'],
    language: '中文',
    scene: '通用',
    hint: '爽朗活泼女声，适合日常助手回复。',
  },
  {
    id: 'zh_female_cancan_uranus_bigtts',
    label: '知性灿灿 2.0',
    resourceIds: ['seed-tts-2.0'],
    language: '中文',
    scene: '角色扮演',
    hint: '支持情感变化、指令遵循、ASMR 等 2.0 能力。',
  },
  {
    id: 'zh_female_tianmeixiaoyuan_uranus_bigtts',
    label: '甜美小源 2.0',
    resourceIds: ['seed-tts-2.0'],
    language: '中文',
    scene: '通用',
    hint: '甜美女声，适合轻松、亲近的语气。',
  },
  {
    id: 'zh_female_vv_uranus_bigtts',
    label: 'Vivi 2.0',
    resourceIds: ['seed-tts-2.0'],
    language: '中文/日文/印尼语/墨西哥西语',
    scene: '通用/方言',
    hint: '文档示例中支持东北话、陕西话、四川话方言参数。',
  },
  {
    id: 'zh_female_xiaohe_uranus_bigtts',
    label: '小何 2.0',
    resourceIds: ['seed-tts-2.0'],
    language: '中文',
    scene: '通用',
    hint: '通用中文女声。',
  },
  {
    id: 'zh_male_m191_uranus_bigtts',
    label: '云舟 2.0',
    resourceIds: ['seed-tts-2.0'],
    language: '中文',
    scene: '通用',
    hint: '稳重男声，适合播报和较正式的回复。',
  },
  {
    id: 'zh_male_taocheng_uranus_bigtts',
    label: '小天 2.0',
    resourceIds: ['seed-tts-2.0'],
    language: '中文',
    scene: '通用',
    hint: '年轻清晰男声。',
  },
  {
    id: 'en_female_dacey_uranus_bigtts',
    label: 'Dacey',
    resourceIds: ['seed-tts-2.0'],
    language: '美式英语',
    scene: '英文',
    hint: '英文女声。',
  },
  {
    id: 'en_male_tim_uranus_bigtts',
    label: 'Tim',
    resourceIds: ['seed-tts-2.0'],
    language: '美式英语',
    scene: '英文',
    hint: '英文男声。',
  },
]

export const VOLCENGINE_DEFAULT_TTS = {
  endpoint: VOLCENGINE_TTS_SUPPORTED_ENDPOINTS[0]?.url || VOLCENGINE_TTS_ENDPOINTS[0].url,
  resourceId: 'seed-tts-2.0',
  speaker: 'zh_female_shuangkuaisisi_uranus_bigtts',
} as const

export function findVolcengineEndpoint(url: string): VolcengineTtsEndpointOption | undefined {
  const normalized = String(url || '').trim().replace(/\/+$/, '')
  return VOLCENGINE_TTS_ENDPOINTS.find((item) => item.url.replace(/\/+$/, '') === normalized)
}

export function findVolcengineResource(resourceId: string): VolcengineTtsResourceOption | undefined {
  return VOLCENGINE_TTS_RESOURCES.find((item) => item.id === String(resourceId || '').trim())
}

export function findVolcengineVoice(speaker: string): VolcengineTtsVoiceOption | undefined {
  return VOLCENGINE_TTS_VOICES.find((item) => item.id === String(speaker || '').trim())
}

export function isVolcengineVoiceCompatibleWithResource(speaker: string, resourceId: string): boolean {
  const voice = findVolcengineVoice(speaker)
  if (!voice) return true
  return voice.resourceIds.includes(String(resourceId || '').trim())
}

export function isLegacyVolcengineTtsVoice(speaker: string): boolean {
  const normalized = String(speaker || '').trim()
  return normalized === 'custom_mix_bigtts' ||
    /^BV\d+_streaming$/i.test(normalized) ||
    normalized.endsWith('_moon_bigtts') ||
    normalized.endsWith('_mars_bigtts') ||
    normalized.includes('_emo_v2_mars_bigtts') ||
    normalized.includes('_conversation_wvae_bigtts')
}

export function getDefaultVolcengineSpeaker(resourceId: string, fallback = ''): string {
  const resource = findVolcengineResource(resourceId)
  return resource?.defaultSpeaker || fallback
}
