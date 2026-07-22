export interface XiaomiMimoTtsModelOption {
  id: string
  label: string
  kind: 'preset' | 'voice-design' | 'voice-clone'
  hint: string
  requiresVoice: boolean
  defaultVoice?: string
}

export interface XiaomiMimoTtsVoiceOption {
  id: string
  label: string
  language: string
  gender: string
  hint: string
}

export const XIAOMI_MIMO_TTS_DOC_URL = 'https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/multimodal-understanding/speech-synthesis-v2.5'
export const XIAOMI_MIMO_CONSOLE_URL = 'https://platform.xiaomimimo.com'

export const XIAOMI_MIMO_TTS_BASE_URL = 'https://api.xiaomimimo.com/v1'

export const XIAOMI_MIMO_TTS_MODELS: XiaomiMimoTtsModelOption[] = [
  {
    id: 'mimo-v2.5-tts',
    label: 'MiMo V2.5 TTS',
    kind: 'preset',
    hint: '使用预置精品音色进行语音合成，支持自然语言与标签风格控制。',
    requiresVoice: true,
    defaultVoice: 'mimo_default',
  },
  {
    id: 'mimo-v2.5-tts-voicedesign',
    label: 'MiMo V2.5 TTS Voice Design',
    kind: 'voice-design',
    hint: '通过语气/风格指令描述自动生成音色，不使用预置音色。',
    requiresVoice: false,
  },
  {
    id: 'mimo-v2.5-tts-voiceclone',
    label: 'MiMo V2.5 TTS Voice Clone',
    kind: 'voice-clone',
    hint: '通过 mp3/wav 样本 Base64 Data URL 复刻音色。',
    requiresVoice: true,
  },
]

export const XIAOMI_MIMO_TTS_VOICES: XiaomiMimoTtsVoiceOption[] = [
  {
    id: 'mimo_default',
    label: 'MiMo 默认',
    language: '随部署集群而异',
    gender: '自动',
    hint: '中国集群默认为冰糖，其他集群默认为 Mia。',
  },
  {
    id: '冰糖',
    label: '冰糖',
    language: '中文',
    gender: '女性',
    hint: '中文女声，适合自然日常语音。',
  },
  {
    id: '茉莉',
    label: '茉莉',
    language: '中文',
    gender: '女性',
    hint: '中文女声，适合轻柔清晰表达。',
  },
  {
    id: '苏打',
    label: '苏打',
    language: '中文',
    gender: '男性',
    hint: '中文男声，适合清爽口语。',
  },
  {
    id: '白桦',
    label: '白桦',
    language: '中文',
    gender: '男性',
    hint: '中文男声，适合稳重叙述。',
  },
  {
    id: 'Mia',
    label: 'Mia',
    language: '英文',
    gender: '女性',
    hint: '英文女声。',
  },
  {
    id: 'Chloe',
    label: 'Chloe',
    language: '英文',
    gender: '女性',
    hint: '英文女声。',
  },
  {
    id: 'Milo',
    label: 'Milo',
    language: '英文',
    gender: '男性',
    hint: '英文男声。',
  },
  {
    id: 'Dean',
    label: 'Dean',
    language: '英文',
    gender: '男性',
    hint: '英文男声。',
  },
]

export const XIAOMI_MIMO_DEFAULT_TTS = {
  baseURL: XIAOMI_MIMO_TTS_BASE_URL,
  model: 'mimo-v2.5-tts',
  voice: 'mimo_default',
} as const

export function findXiaomiMimoTtsModel(model: string): XiaomiMimoTtsModelOption | undefined {
  return XIAOMI_MIMO_TTS_MODELS.find((item) => item.id === String(model || '').trim())
}

export function findXiaomiMimoTtsVoice(voice: string): XiaomiMimoTtsVoiceOption | undefined {
  return XIAOMI_MIMO_TTS_VOICES.find((item) => item.id === String(voice || '').trim())
}

export function getDefaultXiaomiMimoVoice(model: string, fallback = ''): string {
  const option = findXiaomiMimoTtsModel(model)
  if (!option) return fallback
  return option.defaultVoice || ''
}

export function isXiaomiMimoVoiceCloneSample(voice: string): boolean {
  return /^data:audio\/(?:mpeg|mp3|wav|x-wav);base64,/i.test(String(voice || '').trim())
}
