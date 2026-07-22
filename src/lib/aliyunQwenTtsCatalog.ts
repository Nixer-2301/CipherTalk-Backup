export interface AliyunQwenTtsModelOption {
  id: string
  label: string
  kind: 'preset' | 'voice-clone'
  hint: string
  supportsInstructions: boolean
  requiresVoice: boolean
  defaultVoice?: string
}

export interface AliyunQwenTtsVoiceOption {
  id: string
  label: string
  language: string
  gender: string
  hint: string
}

export const ALIYUN_QWEN_TTS_REALTIME_DOC_URL = 'https://help.aliyun.com/zh/model-studio/interactive-process-of-qwen-tts-realtime-synthesis'
export const ALIYUN_QWEN_TTS_VOICE_CLONE_DOC_URL = 'https://help.aliyun.com/zh/model-studio/voice-clone-design-http-api'
export const ALIYUN_QWEN_TTS_BASE_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'

export const ALIYUN_QWEN_TTS_MODELS: AliyunQwenTtsModelOption[] = [
  {
    id: 'qwen3-tts-instruct-flash-realtime',
    label: 'Qwen3 TTS Instruct Flash Realtime',
    kind: 'preset',
    hint: '实时 WebSocket 模型，支持通过自然语言指令控制语气、情绪和表达方式。',
    supportsInstructions: true,
    requiresVoice: true,
    defaultVoice: 'Cherry',
  },
  {
    id: 'qwen3-tts-flash-realtime',
    label: 'Qwen3 TTS Flash Realtime',
    kind: 'preset',
    hint: '实时 WebSocket 基础系统音色模型，延迟低，不支持指令控制。',
    supportsInstructions: false,
    requiresVoice: true,
    defaultVoice: 'Cherry',
  },
  {
    id: 'qwen3-tts-vc-realtime-2026-01-15',
    label: 'Qwen3 TTS VC Realtime',
    kind: 'voice-clone',
    hint: '实时 WebSocket 声音复刻模型，需要填写声音复刻返回的专属 voice。',
    supportsInstructions: false,
    requiresVoice: true,
  },
]

export const ALIYUN_QWEN_TTS_VOICES: AliyunQwenTtsVoiceOption[] = [
  {
    id: 'Cherry',
    label: 'Cherry',
    language: '中文/英文等',
    gender: '女性',
    hint: '通义千问实时 TTS 默认系统音色，适合日常助手回复。',
  },
  {
    id: 'Serena',
    label: 'Serena',
    language: '中文/英文等',
    gender: '女性',
    hint: '清晰自然的女声，可用于聊天和叙述。',
  },
  {
    id: 'Ethan',
    label: 'Ethan',
    language: '中文/英文等',
    gender: '男性',
    hint: '自然男声，适合较稳的叙述场景。',
  },
  {
    id: 'Chelsie',
    label: 'Chelsie',
    language: '中文/英文等',
    gender: '女性',
    hint: '轻快女声，适合口语化回复。',
  },
]

export const ALIYUN_QWEN_DEFAULT_TTS = {
  baseURL: ALIYUN_QWEN_TTS_BASE_URL,
  model: 'qwen3-tts-instruct-flash-realtime',
  voice: 'Cherry',
} as const

export function findAliyunQwenTtsModel(model: string): AliyunQwenTtsModelOption | undefined {
  return ALIYUN_QWEN_TTS_MODELS.find((item) => item.id === String(model || '').trim())
}

export function findAliyunQwenTtsVoice(voice: string): AliyunQwenTtsVoiceOption | undefined {
  return ALIYUN_QWEN_TTS_VOICES.find((item) => item.id === String(voice || '').trim())
}

export function getDefaultAliyunQwenVoice(model: string, fallback = ''): string {
  const option = findAliyunQwenTtsModel(model)
  if (!option) return fallback
  return option.defaultVoice || ''
}

export function isAliyunQwenVoiceCloneModel(model: string): boolean {
  return findAliyunQwenTtsModel(model)?.kind === 'voice-clone'
}
