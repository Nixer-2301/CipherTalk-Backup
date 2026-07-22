/**
 * 文字转语音设置 —— 朗读 AI 回复、微信消息、克隆好友语音回复共用。
 * 小米MiMo、火山引擎/豆包、通义千问/百炼的服务商配置分别保存。
 * 自带 IPC（tts:getConfig/setConfig/test），未配置时各处朗读回退系统语音。
 */
import { useEffect, useRef, useState } from 'react'
import { Button, Card, ComboBox, Description, Input, InputGroup, Label, ListBox, Select, Switch, TextArea, TextField } from '@heroui/react'
import { ArrowUpRightFromSquare, CircleCheck, CircleExclamation, Volume } from '@gravity-ui/icons'
import type { TtsConfig, TtsProviderConfig, TtsProviderId } from '@/types/electron'
import {
  VOLCENGINE_DEFAULT_TTS,
  VOLCENGINE_SPEECH_CONSOLE_URL,
  VOLCENGINE_TTS_ENDPOINTS,
  VOLCENGINE_TTS_RESOURCES,
  VOLCENGINE_TTS_SUPPORTED_ENDPOINTS,
  VOLCENGINE_TTS_VOICES,
  findVolcengineEndpoint,
  findVolcengineResource,
  findVolcengineVoice,
  getDefaultVolcengineSpeaker,
  isLegacyVolcengineTtsVoice,
  isVolcengineVoiceCompatibleWithResource,
} from '@/lib/volcengineTtsCatalog'
import {
  ALIYUN_QWEN_DEFAULT_TTS,
  ALIYUN_QWEN_TTS_MODELS,
  ALIYUN_QWEN_TTS_REALTIME_DOC_URL,
  ALIYUN_QWEN_TTS_VOICE_CLONE_DOC_URL,
  ALIYUN_QWEN_TTS_VOICES,
  findAliyunQwenTtsModel,
  findAliyunQwenTtsVoice,
  getDefaultAliyunQwenVoice,
  isAliyunQwenVoiceCloneModel,
} from '@/lib/aliyunQwenTtsCatalog'
import {
  XIAOMI_MIMO_DEFAULT_TTS,
  XIAOMI_MIMO_TTS_DOC_URL,
  XIAOMI_MIMO_TTS_MODELS,
  XIAOMI_MIMO_TTS_VOICES,
  findXiaomiMimoTtsModel,
  findXiaomiMimoTtsVoice,
  getDefaultXiaomiMimoVoice,
  isXiaomiMimoVoiceCloneSample,
} from '@/lib/xiaomiMimoTtsCatalog'

const DEFAULT_XIAOMI_CFG: TtsProviderConfig = {
  protocol: 'xiaomi-mimo-tts',
  apiKey: '',
  baseURL: XIAOMI_MIMO_DEFAULT_TTS.baseURL,
  model: XIAOMI_MIMO_DEFAULT_TTS.model,
  voice: XIAOMI_MIMO_DEFAULT_TTS.voice,
  instructions: '',
  speed: 1,
}

const DEFAULT_VOLCENGINE_CFG: TtsProviderConfig = {
  protocol: 'volcengine-bidirectional',
  apiKey: '',
  realtimeAppId: '',
  realtimeAccessKey: '',
  baseURL: VOLCENGINE_DEFAULT_TTS.endpoint,
  model: VOLCENGINE_DEFAULT_TTS.resourceId,
  voice: VOLCENGINE_DEFAULT_TTS.speaker,
  instructions: '',
  speed: 1,
}

const DEFAULT_ALIYUN_QWEN_CFG: TtsProviderConfig = {
  protocol: 'aliyun-qwen-realtime',
  apiKey: '',
  baseURL: ALIYUN_QWEN_DEFAULT_TTS.baseURL,
  model: ALIYUN_QWEN_DEFAULT_TTS.model,
  voice: ALIYUN_QWEN_DEFAULT_TTS.voice,
  instructions: '',
  speed: 1,
}

const DEFAULT_CFG: TtsConfig = {
  enabled: false,
  activeProvider: 'xiaomi',
  ...DEFAULT_XIAOMI_CFG,
  providers: {
    xiaomi: { ...DEFAULT_XIAOMI_CFG },
    volcengine: { ...DEFAULT_VOLCENGINE_CFG },
    'aliyun-qwen': { ...DEFAULT_ALIYUN_QWEN_CFG },
  },
}

const PROVIDER_OPTIONS: Array<{ value: TtsProviderId; label: string; hint: string }> = [
  { value: 'xiaomi', label: '小米MiMo', hint: '小米MiMo 语音合成：api-key + /chat/completions + audio 参数，内置模型与预置音色' },
  { value: 'volcengine', label: '火山引擎 / 豆包', hint: '支持声音复刻、流式 TTS 与端到端 Realtime 通话；三项产品使用各自对应的控制台凭据' },
  { value: 'aliyun-qwen', label: '通义千问 / 百炼', hint: '使用百炼 Qwen-TTS Realtime WebSocket：Bearer API Key + response.audio.delta PCM 分片' },
]

const VOLCENGINE_CLONE_SPEAKER_HINT_ID = '__volcengine_clone_speaker_hint__'

const VOLCENGINE_LEGACY_RESOURCE_MIGRATIONS: Record<string, string> = {
  'seed-tts-1.0': 'seed-tts-2.0',
  'seed-tts-1.0-concurr': 'seed-tts-2.0',
  'seed-icl-1.0': 'seed-icl-2.0',
  'seed-icl-1.0-concurr': 'seed-icl-2.0',
}

function normalizeVolcengineResourceId(resourceId: string): string {
  const normalized = String(resourceId || '').trim()
  return VOLCENGINE_LEGACY_RESOURCE_MIGRATIONS[normalized] || normalized
}

function resolveVolcengineSpeakerForResource(resourceId: string, currentSpeaker: string): string {
  const normalizedResourceId = normalizeVolcengineResourceId(resourceId)
  const speaker = currentSpeaker.trim()
  const resource = findVolcengineResource(normalizedResourceId)
  if (!resource) return speaker
  if (!speaker) return getDefaultVolcengineSpeaker(normalizedResourceId)
  if (resource.family === 'tts' && isLegacyVolcengineTtsVoice(speaker)) {
    return getDefaultVolcengineSpeaker(normalizedResourceId)
  }

  const voice = findVolcengineVoice(speaker)
  if (!voice) return speaker
  return voice.resourceIds.includes(normalizedResourceId) ? speaker : getDefaultVolcengineSpeaker(normalizedResourceId)
}

function normalizeVolcengineTtsConfig(config: TtsProviderConfig): TtsProviderConfig {
  if (config.protocol !== 'volcengine-bidirectional') return config

  const model = normalizeVolcengineResourceId(config.model) || VOLCENGINE_DEFAULT_TTS.resourceId
  const baseURL = config.baseURL.trim() || VOLCENGINE_DEFAULT_TTS.endpoint
  const voice = resolveVolcengineSpeakerForResource(model, config.voice)

  if (baseURL === config.baseURL && model === config.model && voice === config.voice) return config
  return { ...config, baseURL, model, voice }
}

function resolveXiaomiMimoVoiceForModel(model: string, currentVoice: string): string {
  const modelOption = findXiaomiMimoTtsModel(model)
  if (!modelOption) return currentVoice.trim()
  if (!modelOption.requiresVoice) return ''
  if (modelOption.kind === 'voice-clone') return isXiaomiMimoVoiceCloneSample(currentVoice) ? currentVoice.trim() : ''
  return currentVoice.trim() || getDefaultXiaomiMimoVoice(model, XIAOMI_MIMO_DEFAULT_TTS.voice)
}

function normalizeXiaomiMimoTtsConfig(config: TtsProviderConfig): TtsProviderConfig {
  if (config.protocol !== 'xiaomi-mimo-tts') return config

  const baseURL = config.baseURL.trim() || XIAOMI_MIMO_DEFAULT_TTS.baseURL
  const model = config.model.trim() || XIAOMI_MIMO_DEFAULT_TTS.model
  const voice = resolveXiaomiMimoVoiceForModel(model, config.voice)

  if (baseURL === config.baseURL && model === config.model && voice === config.voice) return config
  return { ...config, baseURL, model, voice }
}

function resolveAliyunQwenVoiceForModel(model: string, currentVoice: string): string {
  const modelOption = findAliyunQwenTtsModel(model)
  if (!modelOption) return currentVoice.trim()
  if (!modelOption.requiresVoice) return ''
  if (modelOption.kind === 'voice-clone') return findAliyunQwenTtsVoice(currentVoice) ? '' : currentVoice.trim()
  return currentVoice.trim() || getDefaultAliyunQwenVoice(model, ALIYUN_QWEN_DEFAULT_TTS.voice)
}

function normalizeAliyunQwenTtsConfig(config: TtsProviderConfig): TtsProviderConfig {
  if (config.protocol !== 'aliyun-qwen-realtime') return config

  const baseURL = config.baseURL.trim() || ALIYUN_QWEN_DEFAULT_TTS.baseURL
  const model = config.model.trim() || ALIYUN_QWEN_DEFAULT_TTS.model
  const voice = resolveAliyunQwenVoiceForModel(model, config.voice)

  if (baseURL === config.baseURL && model === config.model && voice === config.voice) return config
  return { ...config, baseURL, model, voice }
}

function getProviderIdForProtocol(protocol: unknown): TtsProviderId {
  if (protocol === 'volcengine-bidirectional') return 'volcengine'
  if (protocol === 'aliyun-qwen-realtime') return 'aliyun-qwen'
  return 'xiaomi'
}

function normalizeProviderId(provider: unknown, fallback: TtsProviderId = 'xiaomi'): TtsProviderId {
  return provider === 'xiaomi' || provider === 'volcengine' || provider === 'aliyun-qwen' ? provider : fallback
}

function normalizeProviderConfig(provider: TtsProviderId, config: Partial<TtsProviderConfig> = {}): TtsProviderConfig {
  const defaults = provider === 'volcengine'
    ? DEFAULT_VOLCENGINE_CFG
    : provider === 'aliyun-qwen'
      ? DEFAULT_ALIYUN_QWEN_CFG
      : DEFAULT_XIAOMI_CFG
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

function normalizeTtsConfig(config: Partial<TtsConfig> = {}): TtsConfig {
  const rawProviders = (config.providers || {}) as Partial<Record<TtsProviderId, Partial<TtsProviderConfig>>>
  const activeProvider = normalizeProviderId(config.activeProvider, getProviderIdForProtocol(config.protocol))
  const providers: Record<TtsProviderId, TtsProviderConfig> = {
    xiaomi: normalizeProviderConfig('xiaomi', rawProviders.xiaomi),
    volcengine: normalizeProviderConfig('volcengine', rawProviders.volcengine),
    'aliyun-qwen': normalizeProviderConfig('aliyun-qwen', rawProviders['aliyun-qwen']),
  }

  if (config.protocol || config.apiKey != null || config.realtimeAppId != null || config.realtimeAccessKey != null || config.baseURL != null || config.model != null || config.voice != null || config.instructions != null || config.speed != null) {
    const flatProvider = normalizeProviderId(config.activeProvider, getProviderIdForProtocol(config.protocol))
    providers[flatProvider] = normalizeProviderConfig(flatProvider, {
      ...providers[flatProvider],
      protocol: config.protocol,
      apiKey: config.apiKey,
      realtimeAppId: config.realtimeAppId,
      realtimeAccessKey: config.realtimeAccessKey,
      baseURL: config.baseURL,
      model: config.model,
      voice: config.voice,
      instructions: config.instructions,
      speed: config.speed,
    })
  }

  const activeConfig = providers[activeProvider]
  return {
    ...DEFAULT_CFG,
    enabled: config.enabled === true,
    activeProvider,
    ...activeConfig,
    providers,
  }
}

function syncActiveProviderConfig(config: TtsConfig): TtsConfig {
  const activeConfig = normalizeProviderConfig(config.activeProvider, {
    protocol: config.protocol,
    apiKey: config.apiKey,
    realtimeAppId: config.realtimeAppId,
    realtimeAccessKey: config.realtimeAccessKey,
    baseURL: config.baseURL,
    model: config.model,
    voice: config.voice,
    instructions: config.instructions,
    speed: config.speed,
  })
  return normalizeTtsConfig({
    ...config,
    ...activeConfig,
    providers: {
      ...config.providers,
      [config.activeProvider]: activeConfig,
    },
  })
}

function switchActiveProviderConfig(config: TtsConfig, provider: TtsProviderId): TtsConfig {
  const synced = syncActiveProviderConfig(config)
  const nextProviderConfig = normalizeProviderConfig(provider, synced.providers[provider])
  return normalizeTtsConfig({
    ...synced,
    activeProvider: provider,
    ...nextProviderConfig,
    providers: {
      ...synced.providers,
      [provider]: nextProviderConfig,
    },
  })
}

export default function TtsTab() {
  const [cfg, setCfg] = useState<TtsConfig>(DEFAULT_CFG)
  const [loaded, setLoaded] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    void window.electronAPI.tts.getConfig().then((res) => {
      if (res.success && res.config) setCfg(normalizeTtsConfig(res.config))
      setLoaded(true)
    })
    return () => { previewAudioRef.current?.pause() }
  }, [])

  const patch = (p: Partial<TtsProviderConfig> & Partial<Pick<TtsConfig, 'enabled'>>) => {
    setCfg((current) => {
      const currentProviderConfig = normalizeProviderConfig(current.activeProvider, {
        ...current.providers[current.activeProvider],
        protocol: current.protocol,
        apiKey: current.apiKey,
        baseURL: current.baseURL,
        model: current.model,
        voice: current.voice,
        instructions: current.instructions,
        speed: current.speed,
        ...p,
      })
      return normalizeTtsConfig({
        ...current,
        ...p,
        ...currentProviderConfig,
        providers: {
          ...current.providers,
          [current.activeProvider]: currentProviderConfig,
        },
      })
    })
  }

  const persistConfig = async (nextCfg: TtsConfig, successText: string) => {
    setSaving(true)
    setStatus(null)
    try {
      const res = await window.electronAPI.tts.setConfig(nextCfg)
      if (res.success && res.config) {
        setCfg(normalizeTtsConfig(res.config))
        setStatus({ ok: true, text: successText })
      } else {
        setStatus({ ok: false, text: res.error || '保存失败' })
      }
      return res
    } finally {
      setSaving(false)
    }
  }

  const handleProviderChange = (provider: TtsProviderId) => {
    if (provider === cfg.activeProvider) return
    const nextCfg = switchActiveProviderConfig(cfg, provider)
    setCfg(nextCfg)
    void persistConfig(nextCfg, '已切换并保存语音服务')
  }

  const handleTest = async () => {
    setTesting(true)
    setStatus(null)
    const testCfg = syncActiveProviderConfig(cfg)
    if (testCfg !== cfg) setCfg(testCfg)
    try {
      const res = await window.electronAPI.tts.test(testCfg)
      if (res.success && res.audioBase64) {
        previewAudioRef.current?.pause()
        const audio = new Audio(`data:${res.mimeType || 'audio/mpeg'};base64,${res.audioBase64}`)
        previewAudioRef.current = audio
        void audio.play()
        setStatus({ ok: true, text: '合成成功，正在播放试听' })
      } else {
        setStatus({ ok: false, text: res.error || '试听失败' })
      }
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    const saveCfg = syncActiveProviderConfig(cfg)
    if (saveCfg !== cfg) setCfg(saveCfg)
    await persistConfig(saveCfg, '已保存')
  }

  const openVolcengineConsole = () => {
    void window.electronAPI.shell.openExternal(VOLCENGINE_SPEECH_CONSOLE_URL)
  }

  const openXiaomiMimoDocs = () => {
    void window.electronAPI.shell.openExternal(XIAOMI_MIMO_TTS_DOC_URL)
  }

  const openAliyunQwenRealtimeDocs = () => {
    void window.electronAPI.shell.openExternal(ALIYUN_QWEN_TTS_REALTIME_DOC_URL)
  }

  const openAliyunQwenVoiceCloneDocs = () => {
    void window.electronAPI.shell.openExternal(ALIYUN_QWEN_TTS_VOICE_CLONE_DOC_URL)
  }

  if (!loaded) return null

  const activeProvider = cfg.activeProvider || 'xiaomi'
  const providerOption = PROVIDER_OPTIONS.find((option) => option.value === activeProvider)
  const isVolcengine = activeProvider === 'volcengine'
  const isXiaomiMimo = activeProvider === 'xiaomi'
  const isAliyunQwen = activeProvider === 'aliyun-qwen'
  const volcengineEndpointOption = findVolcengineEndpoint(cfg.baseURL)
  const volcengineResourceOption = findVolcengineResource(cfg.model)
  const volcengineVoiceOption = findVolcengineVoice(cfg.voice)
  const volcengineVoiceCompatible = !isVolcengine || isVolcengineVoiceCompatibleWithResource(cfg.voice, cfg.model)
  const volcengineVoiceOptions = VOLCENGINE_TTS_VOICES.filter((option) => {
    const resourceId = cfg.model.trim()
    return !findVolcengineResource(resourceId) || option.resourceIds.includes(resourceId)
  })
  const volcengineSpeakerPlaceholder = volcengineResourceOption?.family === 'icl'
    ? 'S_xxx 或 icl_xxx'
    : getDefaultVolcengineSpeaker(cfg.model) || VOLCENGINE_DEFAULT_TTS.speaker
  const xiaomiMimoModelOption = findXiaomiMimoTtsModel(cfg.model)
  const xiaomiMimoVoiceOption = findXiaomiMimoTtsVoice(cfg.voice)
  const xiaomiMimoNeedsVoice = isXiaomiMimo && xiaomiMimoModelOption?.requiresVoice !== false
  const xiaomiMimoVoiceReady = xiaomiMimoModelOption?.kind === 'voice-clone'
    ? isXiaomiMimoVoiceCloneSample(cfg.voice)
    : Boolean(cfg.voice)
  const aliyunQwenModelOption = findAliyunQwenTtsModel(cfg.model)
  const aliyunQwenVoiceOption = findAliyunQwenTtsVoice(cfg.voice)
  const aliyunQwenNeedsVoice = isAliyunQwen && aliyunQwenModelOption?.requiresVoice !== false
  const aliyunQwenVoiceReady = !aliyunQwenNeedsVoice || Boolean(cfg.voice.trim())
  const canTest = Boolean(cfg.apiKey && cfg.model) &&
    (!isVolcengine || Boolean(cfg.voice)) &&
    (!xiaomiMimoNeedsVoice || xiaomiMimoVoiceReady) &&
    aliyunQwenVoiceReady

  return (
    <Card>
      <Card.Header className="flex-row items-start justify-between gap-3">
        <div>
          <Card.Title>文字转语音（TTS）</Card.Title>
          <Card.Description>
            启用后，AI 助手回复、微信消息右键「朗读」和克隆好友的语音回复都会用这里的音色合成语音；
            未启用时回退系统朗读。支持小米MiMo、火山引擎 / 豆包和通义千问 / 百炼，各服务商配置会分别保存。
          </Card.Description>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {isXiaomiMimo && (
            <Button
              aria-label="打开小米MiMo语音合成文档"
              onPress={openXiaomiMimoDocs}
              size="sm"
              type="button"
              variant="outline"
            >
              <ArrowUpRightFromSquare width={16} height={16} />
              官方文档
            </Button>
          )}
          {isVolcengine && (
            <Button
              aria-label="打开豆包语音控制台"
              onPress={openVolcengineConsole}
              size="sm"
              type="button"
              variant="outline"
            >
              <ArrowUpRightFromSquare width={16} height={16} />
              豆包控制台
            </Button>
          )}
          {isAliyunQwen && (
            <>
              <Button
                aria-label="打开通义千问实时 TTS 文档"
                onPress={openAliyunQwenRealtimeDocs}
                size="sm"
                type="button"
                variant="outline"
              >
                <ArrowUpRightFromSquare width={16} height={16} />
                实时文档
              </Button>
              <Button
                aria-label="打开通义千问声音复刻文档"
                onPress={openAliyunQwenVoiceCloneDocs}
                size="sm"
                type="button"
                variant="outline"
              >
                <ArrowUpRightFromSquare width={16} height={16} />
                复刻文档
              </Button>
            </>
          )}
          <Switch
            aria-label={cfg.enabled ? '关闭文字转语音' : '启用文字转语音'}
            isSelected={cfg.enabled}
            onChange={(v) => patch({ enabled: v })}
          >
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
          </Switch>
        </div>
      </Card.Header>
      <Card.Content className="space-y-5">
        <Select
          isDisabled={saving}
          selectedKey={activeProvider}
          onSelectionChange={(key) => {
            if (key != null) handleProviderChange(String(key) as TtsProviderId)
          }}
          placeholder="选择语音服务"
          variant="secondary"
          fullWidth
        >
          <Label>语音服务</Label>
          <Select.Trigger>
            <Select.Value>
              {({ defaultChildren }) => providerOption?.label || defaultChildren}
            </Select.Value>
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {PROVIDER_OPTIONS.map((option) => (
                <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
                  {option.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
          <Description>{providerOption?.hint}</Description>
        </Select>

        <TextField fullWidth onChange={(v) => patch({ apiKey: v })} value={cfg.apiKey}>
          <Label>{isVolcengine ? 'TTS / 声音复刻 API Key' : 'API Key'}</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input
              placeholder={isVolcengine ? '火山引擎新版控制台 X-Api-Key' : isAliyunQwen ? 'DASHSCOPE_API_KEY' : 'MIMO_API_KEY'}
              type="password"
            />
          </InputGroup>
          <Description>
            {isVolcengine
              ? '用于流式 TTS 与声音复刻的 X-Api-Key，仅保存在本地；端到端通话使用下方独立凭据。'
              : isAliyunQwen
                ? '从阿里云百炼 / DashScope 获取 API Key，请求时使用 Authorization: Bearer，仅保存在本地。'
                : '从小米MiMo控制台获取 API Key，请求时会使用 api-key 请求头，仅保存在本地。'}
          </Description>
        </TextField>

        {isVolcengine && (
          <div className="grid gap-4 md:grid-cols-2">
            <TextField fullWidth onChange={(value) => patch({ realtimeAppId: value })} value={cfg.realtimeAppId || ''}>
              <Label>Realtime App ID</Label>
              <InputGroup fullWidth variant="secondary">
                <InputGroup.Input placeholder="火山引擎控制台 APP ID" />
              </InputGroup>
              <Description>用于端到端实时语音握手的 X-Api-App-ID。</Description>
            </TextField>
            <TextField fullWidth onChange={(value) => patch({ realtimeAccessKey: value })} value={cfg.realtimeAccessKey || ''}>
              <Label>Realtime Access Key</Label>
              <InputGroup fullWidth variant="secondary">
                <InputGroup.Input placeholder="火山引擎控制台 Access Token" type="password" />
              </InputGroup>
              <Description>用于 X-Api-Access-Key，与上方新版 TTS X-Api-Key 分开保存。</Description>
            </TextField>
          </div>
        )}

        {isVolcengine ? (
          <ComboBox
            allowsCustomValue
            fullWidth
            inputValue={cfg.baseURL}
            selectedKey={VOLCENGINE_TTS_SUPPORTED_ENDPOINTS.some((option) => option.url === cfg.baseURL.trim()) ? cfg.baseURL.trim() : null}
            onInputChange={(value) => patch({ baseURL: value })}
            onSelectionChange={(key) => {
              if (key != null) patch({ baseURL: String(key) })
            }}
            menuTrigger="focus"
            variant="secondary"
          >
            <Label>接口地址</Label>
            <ComboBox.InputGroup>
              <Input placeholder={VOLCENGINE_DEFAULT_TTS.endpoint} variant="secondary" />
              <ComboBox.Trigger />
            </ComboBox.InputGroup>
            <ComboBox.Popover>
              <ListBox>
                {VOLCENGINE_TTS_SUPPORTED_ENDPOINTS.map((option) => (
                  <ListBox.Item key={option.url} id={option.url} textValue={`${option.label} ${option.url} ${option.scenario}`} className="shrink-0">
                    <div className="min-w-0">
                      <div>{option.label}</div>
                      <div className="text-xs text-muted-foreground break-all">{option.url}</div>
                    </div>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </ComboBox.Popover>
            <Description>
              {volcengineEndpointOption?.scenario || '当前实现使用 V3 双向 WebSocket；其他 V3 接口已内置在 catalog，待协议实现后可直接放开。'}
            </Description>
          </ComboBox>
        ) : isAliyunQwen ? (
          <TextField fullWidth onChange={(v) => patch({ baseURL: v })} value={cfg.baseURL}>
            <Label>实时 WebSocket 地址</Label>
            <InputGroup fullWidth variant="secondary">
              <InputGroup.Input placeholder={ALIYUN_QWEN_DEFAULT_TTS.baseURL} />
            </InputGroup>
            <Description>
              北京地域默认使用 dashscope.aliyuncs.com；系统会自动追加 model 查询参数。新加坡地域可填写 workspace 专属 maas 地址。
            </Description>
          </TextField>
        ) : (
          <TextField fullWidth onChange={(v) => patch({ baseURL: v })} value={cfg.baseURL}>
            <Label>接口地址</Label>
            <InputGroup fullWidth variant="secondary">
              <InputGroup.Input placeholder={XIAOMI_MIMO_DEFAULT_TTS.baseURL} />
            </InputGroup>
            <Description>填写小米MiMo /v1 地址，系统会自动拼接 /chat/completions。</Description>
          </TextField>
        )}

        {isVolcengine ? (
          <ComboBox
            allowsCustomValue
            fullWidth
            inputValue={cfg.model}
            selectedKey={volcengineResourceOption?.id || null}
            onInputChange={(value) => {
              const voice = resolveVolcengineSpeakerForResource(value, cfg.voice)
              patch(voice !== cfg.voice ? { model: value, voice } : { model: value })
            }}
            onSelectionChange={(key) => {
              if (key != null) {
                const resourceId = String(key)
                patch({ model: resourceId, voice: resolveVolcengineSpeakerForResource(resourceId, cfg.voice) })
              }
            }}
            menuTrigger="focus"
            variant="secondary"
          >
            <Label>Resource ID</Label>
            <ComboBox.InputGroup>
              <Input placeholder={VOLCENGINE_DEFAULT_TTS.resourceId} variant="secondary" />
              <ComboBox.Trigger />
            </ComboBox.InputGroup>
            <ComboBox.Popover>
              <ListBox>
                {VOLCENGINE_TTS_RESOURCES.map((option) => (
                  <ListBox.Item key={option.id} id={option.id} textValue={`${option.label} ${option.id} ${option.hint}`} className="shrink-0">
                    <div className="min-w-0">
                      <div>{option.label}</div>
                      <div className="text-xs text-muted-foreground break-all">{option.id}</div>
                    </div>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </ComboBox.Popover>
            <Description>
              {volcengineResourceOption
                ? `${volcengineResourceOption.hint} 计费：${volcengineResourceOption.billing}。`
                : '对应 X-Api-Resource-Id，可选择内置资源，也可手动填写控制台开通的资源 ID。'}
            </Description>
          </ComboBox>
        ) : isAliyunQwen ? (
          <ComboBox
            allowsCustomValue
            fullWidth
            inputValue={cfg.model}
            selectedKey={aliyunQwenModelOption?.id || null}
            onInputChange={(value) => patch({ model: value, voice: resolveAliyunQwenVoiceForModel(value, cfg.voice) })}
            onSelectionChange={(key) => {
              if (key != null) {
                const model = String(key)
                patch({ model, voice: resolveAliyunQwenVoiceForModel(model, cfg.voice) })
              }
            }}
            menuTrigger="focus"
            variant="secondary"
          >
            <Label>模型</Label>
            <ComboBox.InputGroup>
              <Input placeholder={ALIYUN_QWEN_DEFAULT_TTS.model} variant="secondary" />
              <ComboBox.Trigger />
            </ComboBox.InputGroup>
            <ComboBox.Popover>
              <ListBox>
                {ALIYUN_QWEN_TTS_MODELS.map((option) => (
                  <ListBox.Item key={option.id} id={option.id} textValue={`${option.label} ${option.id} ${option.hint}`} className="shrink-0">
                    <div className="min-w-0">
                      <div>{option.label}</div>
                      <div className="text-xs text-muted-foreground break-all">{option.id}</div>
                    </div>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </ComboBox.Popover>
            <Description>
              {aliyunQwenModelOption?.hint || '通义千问实时语音合成模型 ID。'}
            </Description>
          </ComboBox>
        ) : (
          <ComboBox
            allowsCustomValue
            fullWidth
            inputValue={cfg.model}
            selectedKey={xiaomiMimoModelOption?.id || null}
            onInputChange={(value) => patch({ model: value, voice: resolveXiaomiMimoVoiceForModel(value, cfg.voice) })}
            onSelectionChange={(key) => {
              if (key != null) {
                const model = String(key)
                patch({ model, voice: resolveXiaomiMimoVoiceForModel(model, cfg.voice) })
              }
            }}
            menuTrigger="focus"
            variant="secondary"
          >
            <Label>模型</Label>
            <ComboBox.InputGroup>
              <Input placeholder={XIAOMI_MIMO_DEFAULT_TTS.model} variant="secondary" />
              <ComboBox.Trigger />
            </ComboBox.InputGroup>
            <ComboBox.Popover>
              <ListBox>
                {XIAOMI_MIMO_TTS_MODELS.map((option) => (
                  <ListBox.Item key={option.id} id={option.id} textValue={`${option.label} ${option.id} ${option.hint}`} className="shrink-0">
                    <div className="min-w-0">
                      <div>{option.label}</div>
                      <div className="text-xs text-muted-foreground break-all">{option.id}</div>
                    </div>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </ComboBox.Popover>
            <Description>
              {xiaomiMimoModelOption?.hint || '小米MiMo 语音合成模型 ID。'}
            </Description>
          </ComboBox>
        )}

        {isVolcengine ? (
          <ComboBox
            allowsCustomValue
            fullWidth
            inputValue={cfg.voice}
            selectedKey={volcengineVoiceOptions.some((option) => option.id === cfg.voice.trim()) ? cfg.voice.trim() : null}
            onInputChange={(value) => patch({ voice: value })}
            onSelectionChange={(key) => {
              if (key != null && String(key) !== VOLCENGINE_CLONE_SPEAKER_HINT_ID) patch({ voice: String(key) })
            }}
            menuTrigger="focus"
            variant="secondary"
          >
            <Label>Speaker</Label>
            <ComboBox.InputGroup>
              <Input placeholder={volcengineSpeakerPlaceholder} variant="secondary" />
              <ComboBox.Trigger />
            </ComboBox.InputGroup>
            <ComboBox.Popover>
              <ListBox>
                {volcengineVoiceOptions.length > 0 ? (
                  volcengineVoiceOptions.map((option) => (
                    <ListBox.Item key={option.id} id={option.id} textValue={`${option.label} ${option.id} ${option.language} ${option.scene}`} className="shrink-0">
                      <div className="min-w-0">
                        <div>{option.label}</div>
                        <div className="text-xs text-muted-foreground break-all">{option.id}</div>
                      </div>
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))
                ) : (
                  <ListBox.Item id={VOLCENGINE_CLONE_SPEAKER_HINT_ID} textValue="声音复刻音色请填写自有 Speaker ID" isDisabled className="shrink-0">
                    声音复刻音色请填写自有 Speaker ID
                  </ListBox.Item>
                )}
              </ListBox>
            </ComboBox.Popover>
            <Description>
              {volcengineResourceOption?.family === 'icl'
                ? '声音复刻请填写控制台或查询接口返回的 S_ / icl_ Speaker ID。'
                : !volcengineVoiceCompatible
                ? `当前 Speaker 与 Resource ID 不匹配，试听/保存时会自动改为 ${getDefaultVolcengineSpeaker(cfg.model) || '对应资源的 Speaker'}。`
                : volcengineVoiceOption
                ? `${volcengineVoiceOption.language} · ${volcengineVoiceOption.scene} · ${volcengineVoiceOption.hint}`
                : '火山引擎音色 ID，也就是文档里的 req_params.speaker；可选内置音色或手动填写。'}
            </Description>
          </ComboBox>
        ) : isAliyunQwen ? (
          isAliyunQwenVoiceCloneModel(cfg.model) ? (
            <TextField fullWidth onChange={(v) => patch({ voice: v })} value={cfg.voice}>
              <Label>复刻 voice</Label>
              <InputGroup fullWidth variant="secondary">
                <InputGroup.Input placeholder="通义声音复刻返回的 voice" />
              </InputGroup>
              <Description>
                声音复刻模型需要填写 Qwen 声音复刻 HTTP API 返回的 output.voice；数字分身会自动绑定该值。
              </Description>
            </TextField>
          ) : (
            <ComboBox
              allowsCustomValue
              fullWidth
              inputValue={cfg.voice}
              selectedKey={aliyunQwenVoiceOption?.id || null}
              onInputChange={(value) => patch({ voice: value })}
              onSelectionChange={(key) => {
                if (key != null) patch({ voice: String(key) })
              }}
              menuTrigger="focus"
              variant="secondary"
            >
              <Label>音色</Label>
              <ComboBox.InputGroup>
                <Input placeholder={ALIYUN_QWEN_DEFAULT_TTS.voice} variant="secondary" />
                <ComboBox.Trigger />
              </ComboBox.InputGroup>
              <ComboBox.Popover>
                <ListBox>
                  {ALIYUN_QWEN_TTS_VOICES.map((option) => (
                    <ListBox.Item key={option.id} id={option.id} textValue={`${option.label} ${option.id} ${option.language} ${option.gender}`} className="shrink-0">
                      <div className="min-w-0">
                        <div>{option.label}</div>
                        <div className="text-xs text-muted-foreground break-all">{option.id}</div>
                      </div>
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </ComboBox.Popover>
              <Description>
                {aliyunQwenVoiceOption
                  ? `${aliyunQwenVoiceOption.language} · ${aliyunQwenVoiceOption.gender} · ${aliyunQwenVoiceOption.hint}`
                  : '通义千问实时 TTS 的 voice 参数，可使用系统音色或手动填写可用 voice。'}
              </Description>
            </ComboBox>
          )
        ) : xiaomiMimoModelOption?.kind === 'preset' ? (
          <ComboBox
            allowsCustomValue
            fullWidth
            inputValue={cfg.voice}
            selectedKey={xiaomiMimoVoiceOption?.id || null}
            onInputChange={(value) => patch({ voice: value })}
            onSelectionChange={(key) => {
              if (key != null) patch({ voice: String(key) })
            }}
            menuTrigger="focus"
            variant="secondary"
          >
            <Label>音色</Label>
            <ComboBox.InputGroup>
              <Input placeholder={XIAOMI_MIMO_DEFAULT_TTS.voice} variant="secondary" />
              <ComboBox.Trigger />
            </ComboBox.InputGroup>
            <ComboBox.Popover>
              <ListBox>
                {XIAOMI_MIMO_TTS_VOICES.map((option) => (
                  <ListBox.Item key={option.id} id={option.id} textValue={`${option.label} ${option.id} ${option.language} ${option.gender}`} className="shrink-0">
                    <div className="min-w-0">
                      <div>{option.label}</div>
                      <div className="text-xs text-muted-foreground break-all">{option.id}</div>
                    </div>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </ComboBox.Popover>
            <Description>
              {xiaomiMimoVoiceOption
                ? `${xiaomiMimoVoiceOption.language} · ${xiaomiMimoVoiceOption.gender} · ${xiaomiMimoVoiceOption.hint}`
                : '使用 audio.voice 传入小米预置音色 ID。'}
            </Description>
          </ComboBox>
        ) : (
          <TextField fullWidth onChange={(v) => patch({ voice: v })} value={cfg.voice}>
            <Label>{xiaomiMimoModelOption?.kind === 'voice-clone' ? '音色样本' : '音色'}</Label>
            <InputGroup fullWidth variant="secondary">
              <InputGroup.Input
                placeholder={xiaomiMimoModelOption?.kind === 'voice-clone' ? 'data:audio/mpeg;base64,... 或 data:audio/wav;base64,...' : '音色设计模型无需填写'}
              />
            </InputGroup>
            <Description>
              {xiaomiMimoModelOption?.kind === 'voice-clone'
                ? '音色复刻模型要求 audio.voice 为 mp3/wav 样本的 Base64 Data URL。'
                : '音色设计模型不使用预置音色；请在语气/风格指令里描述想要的声音。'}
            </Description>
          </TextField>
        )}

        <TextField fullWidth onChange={(v) => patch({ instructions: v })} value={cfg.instructions || ''}>
          <Label>语气/风格指令</Label>
          <TextArea
            maxLength={1000}
            placeholder="温柔、轻声、像微信语音一样自然，带一点笑意"
            rows={3}
            variant="secondary"
          />
          <Description>
            {isXiaomiMimo
              ? '小米会把这里作为 user message 的自然语言控制；朗读文本会放在 assistant message。也可直接在正文里使用音频标签。'
              : isAliyunQwen
                ? (aliyunQwenModelOption?.supportsInstructions
                  ? '仅 qwen3-tts-instruct-* 模型会发送 instructions/optimize_instructions；复刻模型和基础模型不会发送风格指令。'
                  : '当前通义模型不发送风格指令；如需语气控制请切换到 qwen3-tts-instruct-flash-realtime。')
                : '支持该能力的语音模型会按这里的自然语言控制朗读；克隆好友语音会优先使用画像自动生成的指令。'}
          </Description>
        </TextField>

        <TextField
          fullWidth
          onChange={(v) => {
            const value = Number(v)
            patch({ speed: Number.isFinite(value) && value > 0 ? Math.min(Math.max(value, 0.5), 2) : 1 })
          }}
          value={cfg.speed ? String(cfg.speed) : ''}
        >
          <Label>语速</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder="1" inputMode="decimal" />
          </InputGroup>
          <Description>
            {isVolcengine
              ? '1 = 正常语速；火山引擎会映射为 speech_rate，范围 0.5–2。'
              : isAliyunQwen
                ? '1 = 正常语速；通义实时模型不发送独立 speech_rate，会在 instruct 模型中转成自然语言风格提示。'
                : '1 = 正常语速；小米会转成自然语言风格提示，不发送独立 speed 参数。'}
          </Description>
        </TextField>

        {status && (
          <p className={`flex items-start gap-1.5 text-sm break-all ${status.ok ? 'text-green-600' : 'text-red-600'}`}>
            {status.ok ? <CircleCheck className="mt-0.5 shrink-0" width={16} height={16} /> : <CircleExclamation className="mt-0.5 shrink-0" width={16} height={16} />}
            <span>{status.text}</span>
          </p>
        )}
      </Card.Content>
      <Card.Footer className="flex flex-wrap gap-2">
        <Button isDisabled={testing || !canTest} onPress={() => void handleTest()} type="button" variant="outline">
          <Volume width={16} height={16} />
          {testing ? '合成中…' : '试听'}
        </Button>
        <Button isDisabled={saving} onPress={() => void handleSave()} type="button" variant="primary">
          {saving ? '保存中…' : '保存'}
        </Button>
      </Card.Footer>
    </Card>
  )
}
