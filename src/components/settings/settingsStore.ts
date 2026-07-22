import { create } from 'zustand'

// 设置界面所有「需持久化 + 参与未保存检测」的配置字段集中存放于此。
// 关键规则:tab 组件只订阅叶子字段 —— useSettingsStore(s => s.config.xxx),
// 绝不订阅整个 config 对象,否则任意字段变化都会触发该组件重渲染,失去 tab 间隔离。

export interface SettingsConfig {
  // —— database 切片 ——
  decryptKey: string
  dbPath: string
  wxid: string
  cachePath: string
  imageXorKey: string
  imageAesKey: string
  displayName: string
  wechatNumber: string
  phone: string
  editingAccountId: string
  skipIntegrityCheck: boolean
  autoUpdateDatabase: boolean
  autoUpdateCheckInterval: number
  autoUpdateMinInterval: number
  autoUpdateDebounceTime: number

  // —— stt 切片 ——
  sttLanguages: string[]
  sttModelType: 'int8' | 'float32'
  sttMode: 'cpu' | 'gpu' | 'online'
  sttOnlineProvider: 'openai-compatible' | 'aliyun-qwen-asr' | 'volcano-doubao' | 'custom'
  sttOnlineApiKey: string
  sttOnlineBaseURL: string
  sttOnlineModel: string
  sttOnlineLanguage: string
  sttOnlineTimeoutMs: number
  sttOnlineMaxConcurrency: number

 // —— ai 切片 ——
 aiProvider: string
 aiApiKey: string
 aiModel: string

  // —— diary 切片 ——
  diaryEnabled: boolean

 // —— appearance / misc 切片 ——
  quoteStyle: 'default' | 'wechat' | 'card'
  exportPath: string
  exportDefaultDateRange: number
  closeToTray: boolean
  hardwareAccelerationEnabled: boolean
}

export const DEFAULT_SETTINGS_CONFIG: SettingsConfig = {
  decryptKey: '',
  dbPath: '',
  wxid: '',
  cachePath: '',
  imageXorKey: '',
  imageAesKey: '',
  displayName: '',
  wechatNumber: '',
  phone: '',
  editingAccountId: '',
  skipIntegrityCheck: false,
  autoUpdateDatabase: true,
  autoUpdateCheckInterval: 60,
  autoUpdateMinInterval: 1000,
  autoUpdateDebounceTime: 500,

  sttLanguages: [],
  sttModelType: 'int8',
  sttMode: 'cpu',
  sttOnlineProvider: 'openai-compatible',
  sttOnlineApiKey: '',
  sttOnlineBaseURL: 'https://api.openai.com/v1',
  sttOnlineModel: 'gpt-4o-mini-transcribe',
  sttOnlineLanguage: 'auto',
  sttOnlineTimeoutMs: 60000,
  sttOnlineMaxConcurrency: 2,

 aiProvider: 'deepseek',
 aiApiKey: '',
 aiModel: '',

  diaryEnabled: true,

 quoteStyle: 'default',
  exportPath: '',
  exportDefaultDateRange: 0,
  closeToTray: true,
  hardwareAccelerationEnabled: true
}

const CONFIG_KEYS = Object.keys(DEFAULT_SETTINGS_CONFIG) as (keyof SettingsConfig)[]

export const ACCOUNT_CONFIG_KEYS = [
  'decryptKey',
  'dbPath',
  'wxid',
  'cachePath',
  'imageXorKey',
  'imageAesKey',
  'displayName',
  'wechatNumber',
  'phone',
  'editingAccountId'
] as const satisfies readonly (keyof SettingsConfig)[]

// 逐字段浅比较 —— 比 JSON.stringify 更快,且不受 key 顺序影响。
// sttLanguages 是数组,单独按元素比较。
export function hasSettingsChanges(
  config: SettingsConfig,
  initial: SettingsConfig | null,
  keys: readonly (keyof SettingsConfig)[] = CONFIG_KEYS
): boolean {
  if (!initial) return false
  for (const key of keys) {
    if (key === 'sttLanguages') {
      const a = config.sttLanguages
      const b = initial.sttLanguages
      if (a.length !== b.length || a.some((v, i) => v !== b[i])) return true
    } else if (config[key] !== initial[key]) {
      return true
    }
  }
  return false
}

function isDirty(config: SettingsConfig, initial: SettingsConfig | null): boolean {
  return hasSettingsChanges(config, initial)
}

interface SettingsStore {
  config: SettingsConfig
  initialConfig: SettingsConfig | null
  hasUnsavedChanges: boolean
  isLoading: boolean
  isSaving: boolean

  setField: <K extends keyof SettingsConfig>(key: K, value: SettingsConfig[K]) => void
  setFields: (partialConfig: Partial<SettingsConfig>) => void
  rebaseFields: (partialConfig: Partial<SettingsConfig>) => void
  setLoading: (isLoading: boolean) => void
  setSaving: (isSaving: boolean) => void
  hydrate: (config: SettingsConfig) => void
  commit: () => void
  reset: () => void
}

export const useSettingsStore = create<SettingsStore>()((set) => ({
  config: { ...DEFAULT_SETTINGS_CONFIG },
  initialConfig: null,
  hasUnsavedChanges: false,
  isLoading: false,
  isSaving: false,

  setField: (key, value) =>
    set((state) => {
      const config = { ...state.config, [key]: value }
      return { config, hasUnsavedChanges: isDirty(config, state.initialConfig) }
    }),

  setFields: (partialConfig) =>
    set((state) => {
      const config = { ...state.config, ...partialConfig }
      return { config, hasUnsavedChanges: isDirty(config, state.initialConfig) }
    }),

  // 载入已持久化的局部配置时,同步更新这些字段的基线,保留其它字段的未保存状态。
  rebaseFields: (partialConfig) =>
    set((state) => {
      const config = { ...state.config, ...partialConfig }
      const initialConfig = state.initialConfig
        ? { ...state.initialConfig, ...partialConfig }
        : null
      return { config, initialConfig, hasUnsavedChanges: isDirty(config, initialConfig) }
    }),

  setLoading: (isLoading) => set({ isLoading }),
  setSaving: (isSaving) => set({ isSaving }),

  // 配置加载完成后调用一次:同时设置 config 与基线快照。
  hydrate: (config) =>
    set({
      config: { ...config },
      initialConfig: { ...config },
      hasUnsavedChanges: false,
      isLoading: false
    }),

  // 保存成功后调用:把当前 config 提升为新的基线快照。
  commit: () =>
    set((state) => ({
      initialConfig: { ...state.config },
      hasUnsavedChanges: false,
      isSaving: false
    })),

  reset: () =>
    set({
      config: { ...DEFAULT_SETTINGS_CONFIG },
      initialConfig: null,
      hasUnsavedChanges: false,
      isLoading: false,
      isSaving: false
    })
}))
