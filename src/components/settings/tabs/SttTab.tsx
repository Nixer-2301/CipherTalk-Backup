import { type SetStateAction, useEffect, useState } from 'react'
import { Alert, AlertDialog, Button, Card, Checkbox, CheckboxGroup, Chip, Description, InputGroup, Label, ListBox, NumberField, ProgressBar, Radio, RadioGroup, Select, Switch, Tabs, TextField, Typography, type Key } from '@heroui/react'
import { ArrowDownToLine, ArrowsRotateLeft, CircleCheck, CircleExclamation, Cloud, Cpu, Gpu, Layers, Pause, PlugConnection, Thunderbolt, TrashBin } from '@gravity-ui/icons'
import * as configService from '../../../services/config'
import { formatFileSize } from '../utils'
import { useSettingsStore } from '../settingsStore'

const sttLanguageOptions = [
  { value: 'zh', label: '中文', enLabel: 'Chinese' },
  { value: 'en', label: '英语', enLabel: 'English' },
  { value: 'ja', label: '日语', enLabel: 'Japanese' },
  { value: 'ko', label: '韩语', enLabel: 'Korean' },
  { value: 'yue', label: '粤语', enLabel: 'Cantonese' }
]

const sttModelTypeOptions = [
  { value: 'int8', label: 'int8 量化版', size: '235 MB', desc: '推荐，体积小、速度快' },
  { value: 'float32', label: 'float32 完整版', size: '920 MB', desc: '更高精度，体积较大' }
] as const

const sttOnlineLanguageOptions = [
  { value: 'auto', label: '自动识别' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: '英语' },
  { value: 'ja', label: '日语' },
  { value: 'ko', label: '韩语' },
  { value: 'yue', label: '粤语' }
]

const sttOnlineProviderOptions = [
  { value: 'openai-compatible', label: 'OpenAI 兼容' },
  { value: 'aliyun-qwen-asr', label: '阿里云 / 千问云（Qwen-ASR）' },
  { value: 'volcano-doubao', label: '火山豆包（极速版）' },
  { value: 'custom', label: '自定义接口' }
] as const

const whisperModelOptions = [
  { value: 'tiny', label: 'Tiny 模型', size: '75 MB', desc: '最快速度，适合实时场景' },
  { value: 'base', label: 'Base 模型', size: '145 MB', desc: '推荐使用，速度与精度平衡' },
  { value: 'small', label: 'Small 模型', size: '488 MB', desc: '更高精度，适合准确识别' },
  { value: 'large-v3-turbo-q5', label: 'Turbo-Q5 量化', size: '540 MB', desc: '极高精度 + 小体积（推荐）' },
  { value: 'large-v3-turbo-q8', label: 'Turbo-Q8 量化', size: '835 MB', desc: '极高精度 + 高质量量化' },
  { value: 'medium', label: 'Medium 模型', size: '1.5 GB', desc: '最佳精度，需要更多时间' },
  { value: 'large-v3-turbo', label: 'Large-v3-Turbo', size: '1.62 GB', desc: '极高精度 + 快速' },
  { value: 'large-v3', label: 'Large-v3 模型', size: '3.1 GB', desc: '极高精度，专业级识别' }
] as const

const STT_ONLINE_DEFAULTS = {
  'openai-compatible': {
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini-transcribe'
  },
  'aliyun-qwen-asr': {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3-asr-flash'
  },
  'volcano-doubao': {
    baseURL: 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash',
    model: 'volc.bigasr.auc_turbo'
  },
  custom: {
    baseURL: '',
    model: ''
  }
} as const

const DOWNLOAD_PAUSED_MESSAGE = '下载已暂停'
type SttMode = 'cpu' | 'gpu' | 'online'
type SttModelType = typeof sttModelTypeOptions[number]['value']
type SttOnlineProvider = typeof sttOnlineProviderOptions[number]['value']
type WhisperModelType = typeof whisperModelOptions[number]['value']

interface SttTabProps {
  active: boolean
  showMessage: (text: string, success: boolean) => void
}

interface ConfirmState {
  show: boolean
  title: string
  message: string
  status: 'warning' | 'danger'
  confirmLabel: string
  confirmVariant: 'primary' | 'danger'
  onConfirm: () => void | Promise<void>
}

const emptyConfirm: ConfirmState = {
  show: false,
  title: '',
  message: '',
  status: 'warning',
  confirmLabel: '确定',
  confirmVariant: 'primary',
  onConfirm: () => {}
}

const toSttMode = (key: Key): SttMode => String(key) as SttMode
const getSttProviderLabel = (value: SttOnlineProvider) => sttOnlineProviderOptions.find(option => option.value === value)?.label || 'OpenAI 兼容'
const getSttOnlineLanguageLabel = (value: string) => sttOnlineLanguageOptions.find(option => option.value === value)?.label || '自动识别'
const clampNumber = (value: number, min: number, max: number, fallback: number) => {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function SttTab({ active, showMessage }: SttTabProps) {
  const sttLanguages = useSettingsStore(s => s.config.sttLanguages)
  const sttModelType = useSettingsStore(s => s.config.sttModelType)
  const sttMode = useSettingsStore(s => s.config.sttMode)
  const sttOnlineProvider = useSettingsStore(s => s.config.sttOnlineProvider)
  const sttOnlineApiKey = useSettingsStore(s => s.config.sttOnlineApiKey)
  const sttOnlineBaseURL = useSettingsStore(s => s.config.sttOnlineBaseURL)
  const sttOnlineModel = useSettingsStore(s => s.config.sttOnlineModel)
  const sttOnlineLanguage = useSettingsStore(s => s.config.sttOnlineLanguage)
  const sttOnlineTimeoutMs = useSettingsStore(s => s.config.sttOnlineTimeoutMs)
  const sttOnlineMaxConcurrency = useSettingsStore(s => s.config.sttOnlineMaxConcurrency)
  const cachePath = useSettingsStore(s => s.config.cachePath)
  const setField = useSettingsStore(s => s.setField)
  const setSttLanguagesState = (value: string[]) => setField('sttLanguages', value)
  const setSttModelType = (value: SttModelType) => setField('sttModelType', value)
  const setSttMode = (value: SttMode) => setField('sttMode', value)
  const setSttOnlineProvider = (value: SttOnlineProvider) => setField('sttOnlineProvider', value)
  const setSttOnlineApiKey = (value: string) => setField('sttOnlineApiKey', value)
  const setSttOnlineBaseURL = (value: string) => setField('sttOnlineBaseURL', value)
  const setSttOnlineModel = (value: string) => setField('sttOnlineModel', value)
  const setSttOnlineLanguage = (value: string) => setField('sttOnlineLanguage', value)
  const setSttOnlineTimeoutMs = (value: SetStateAction<number>) => setField('sttOnlineTimeoutMs', typeof value === 'function' ? value(sttOnlineTimeoutMs) : value)
  const setSttOnlineMaxConcurrency = (value: SetStateAction<number>) => setField('sttOnlineMaxConcurrency', typeof value === 'function' ? value(sttOnlineMaxConcurrency) : value)

  const [sttModelStatus, setSttModelStatus] = useState<{ exists: boolean; sizeBytes?: number } | null>(null)
  const [isLoadingSttStatus, setIsLoadingSttStatus] = useState(false)
  const [isDownloadingSttModel, setIsDownloadingSttModel] = useState(false)
  const [sttDownloadProgress, setSttDownloadProgress] = useState(0)

  const [whisperGpuInfo, setWhisperGpuInfo] = useState<{ available: boolean; provider: string; info: string } | null>(null)
  const [whisperModelType, setWhisperModelType] = useState<WhisperModelType>('small')
  const [whisperModelStatus, setWhisperModelStatus] = useState<{ exists: boolean; modelPath?: string; sizeBytes?: number } | null>(null)
  const [isLoadingWhisperStatus, setIsLoadingWhisperStatus] = useState(false)
  const [isDownloadingWhisperModel, setIsDownloadingWhisperModel] = useState(false)
  const [whisperDownloadProgress, setWhisperDownloadProgress] = useState(0)
  const [useWhisperGpu, setUseWhisperGpu] = useState(false)

  const [gpuComponentsStatus, setGpuComponentsStatus] = useState<{ installed: boolean; missingFiles?: string[]; gpuDir?: string } | null>(null)
  const [isDownloadingGpuComponents, setIsDownloadingGpuComponents] = useState(false)
  const [gpuDownloadProgress, setGpuDownloadProgress] = useState({ overallProgress: 0, currentFile: '' })
  const [confirmState, setConfirmState] = useState<ConfirmState>(emptyConfirm)

  useEffect(() => {
    if (active) {
      loadSttModelStatus()
      loadWhisperStatus()
      loadSttMode()
      checkGpuComponents()
    }
  }, [active])

  const loadSttMode = async () => {
    const savedMode = await configService.getSttMode()
    setSttMode(savedMode || 'cpu')
  }

  const handleSttModeChange = async (mode: SttMode) => {
    setSttMode(mode)
    showMessage(
      mode === 'cpu'
        ? '已切换到 CPU 模式 (SenseVoice)'
        : mode === 'gpu'
          ? '已切换到 GPU 模式 (Whisper)'
          : '已切换到在线模式 (OpenAI 兼容)',
      true
    )
  }

  const handleSttOnlineProviderChange = (provider: SttOnlineProvider) => {
    setSttOnlineProvider(provider)

    if (provider === 'custom') return

    // 只在当前值为空、或仍是某个预设的默认值时才覆盖，避免冲掉用户自定义的配置
    const target = STT_ONLINE_DEFAULTS[provider]
    const presetBaseURLs: string[] = Object.values(STT_ONLINE_DEFAULTS).map(d => d.baseURL).filter(Boolean)
    const presetModels: string[] = Object.values(STT_ONLINE_DEFAULTS).map(d => d.model).filter(Boolean)

    if (!sttOnlineBaseURL || presetBaseURLs.includes(sttOnlineBaseURL)) {
      setSttOnlineBaseURL(target.baseURL)
    }
    if (!sttOnlineModel || presetModels.includes(sttOnlineModel)) {
      setSttOnlineModel(target.model)
    }
  }

  const handleTestOnlineSttConfig = async () => {
    const result = await window.electronAPI.stt.testOnlineConfig({
      provider: sttOnlineProvider,
      apiKey: sttOnlineApiKey,
      baseURL: sttOnlineBaseURL,
      model: sttOnlineModel,
      language: sttOnlineLanguage,
      timeoutMs: sttOnlineTimeoutMs
    })
    if (result.success) {
      showMessage('在线转写配置测试成功', true)
    } else {
      showMessage(result.error || '在线转写配置测试失败', false)
    }
  }

  useEffect(() => {
    const removeListener = window.electronAPI.stt.onDownloadProgress((progress) => {
      setSttDownloadProgress(progress.percent || 0)
    })
    return () => removeListener()
  }, [])

  const loadSttModelStatus = async () => {
    setIsLoadingSttStatus(true)
    try {
      const result = await window.electronAPI.stt.getModelStatus()
      if (result.success) {
        setSttModelStatus({
          exists: result.exists || false,
          sizeBytes: result.sizeBytes
        })
      }
    } catch (e) {
      console.error('获取 STT 模型状态失败:', e)
    } finally {
      setIsLoadingSttStatus(false)
    }
  }

  const handleDownloadSttModel = async () => {
    if (isDownloadingSttModel) return
    setIsDownloadingSttModel(true)
    setSttDownloadProgress(0)

    try {
      showMessage('正在下载语音识别模型...', true)
      const result = await window.electronAPI.stt.downloadModel()
      if (result.success) {
        showMessage('语音识别模型下载完成！', true)
        await loadSttModelStatus()
      } else if (result.error === DOWNLOAD_PAUSED_MESSAGE) {
        showMessage('语音识别模型下载已暂停，可再次点击下载继续', true)
      } else {
        showMessage(result.error || '模型下载失败', false)
      }
    } catch (e) {
      showMessage(`模型下载失败: ${e}`, false)
    } finally {
      setIsDownloadingSttModel(false)
    }
  }

  const handlePauseSttModelDownload = async () => {
    try {
      const result = await window.electronAPI.stt.cancelDownloadModel()
      if (!result.success || !result.cancelled) {
        showMessage(result.error || '暂停下载失败', false)
      }
    } catch (e) {
      const errorText = String(e)
      showMessage(errorText.includes('No handler registered') ? '主进程还没加载暂停接口，请重启应用后再试' : `暂停下载失败: ${errorText}`, false)
    }
  }

  const handleSttLanguageToggle = async (lang: string) => {
    if (sttLanguages.includes(lang) && sttLanguages.length === 1) {
      showMessage('必须至少选择一种语言', false)
      return
    }

    const newLangs = sttLanguages.includes(lang)
      ? sttLanguages.filter(l => l !== lang)
      : [...sttLanguages, lang]
    setSttLanguagesState(newLangs)
  }

  const applySttModelTypeChange = async (type: SttModelType, shouldClearCurrentModel: boolean) => {
    if (shouldClearCurrentModel) {
      try {
        await window.electronAPI.stt.clearModel()
      } catch (e) {
        console.error('清除模型失败:', e)
      }
    }

    setSttModelType(type)
    await loadSttModelStatus()
    showMessage(`模型类型已切换为 ${sttModelTypeOptions.find(o => o.value === type)?.label}`, true)
  }

  const handleSttModelTypeChange = async (type: SttModelType) => {
    if (type === sttModelType) return

    if (sttModelStatus?.exists) {
      setConfirmState({
        show: true,
        title: '切换模型版本',
        message:
          `切换模型类型需要重新下载模型。\n\n` +
          `当前: ${sttModelTypeOptions.find(o => o.value === sttModelType)?.label}\n` +
          `切换到: ${sttModelTypeOptions.find(o => o.value === type)?.label} (${sttModelTypeOptions.find(o => o.value === type)?.size})`,
        status: 'warning',
        confirmLabel: '切换',
        confirmVariant: 'primary',
        onConfirm: () => applySttModelTypeChange(type, true)
      })
      return
    }

    await applySttModelTypeChange(type, false)
  }

  const handleClearSttModel = () => {
    const currentModelSize = sttModelTypeOptions.find(o => o.value === sttModelType)?.size || '235 MB'
    setConfirmState({
      show: true,
      title: '清除语音识别模型',
      message: `确定要清除语音识别模型吗？下次使用需要重新下载 (${currentModelSize})。`,
      status: 'danger',
      confirmLabel: '清除模型',
      confirmVariant: 'danger',
      onConfirm: async () => {
        try {
          const result = await window.electronAPI.stt.clearModel()
          if (result.success) {
            showMessage('模型清除成功', true)
            await loadSttModelStatus()
          } else {
            showMessage(result.error || '模型清除失败', false)
          }
        } catch (e) {
          showMessage(`模型清除失败: ${e}`, false)
        }
      }
    })
  }

  const loadWhisperStatus = async () => {
    setIsLoadingWhisperStatus(true)
    try {
      const savedModelType = await window.electronAPI.config.get('whisperModelType') as WhisperModelType | undefined
      const modelType = savedModelType || 'small'
      setWhisperModelType(modelType)

      const gpuInfo = await window.electronAPI.sttWhisper.detectGPU()
      setWhisperGpuInfo(gpuInfo)

      const modelStatus = await window.electronAPI.sttWhisper.checkModel(modelType)
      setWhisperModelStatus(modelStatus)

      const savedUseWhisper = await window.electronAPI.config.get('useWhisperGpu') as boolean | undefined
      setUseWhisperGpu(savedUseWhisper || false)
    } catch (e) {
      console.error('加载 Whisper 状态失败:', e)
    } finally {
      setIsLoadingWhisperStatus(false)
    }
  }

  const handleDownloadWhisperModel = async () => {
    if (isDownloadingWhisperModel) return
    setIsDownloadingWhisperModel(true)
    setWhisperDownloadProgress(0)

    const unsubscribe = window.electronAPI.sttWhisper.onDownloadProgress((progress) => {
      if (progress.percent) {
        setWhisperDownloadProgress(progress.percent)
      }
    })

    try {
      const result = await window.electronAPI.sttWhisper.downloadModel(whisperModelType)
      if (result.success) {
        showMessage('Whisper 模型下载完成！', true)
        await loadWhisperStatus()
      } else if (result.error === DOWNLOAD_PAUSED_MESSAGE) {
        showMessage('Whisper 模型下载已暂停，可再次点击下载继续', true)
      } else {
        showMessage(result.error || 'Whisper 模型下载失败', false)
      }
    } catch (e) {
      showMessage(`Whisper 模型下载失败: ${e}`, false)
    } finally {
      unsubscribe()
      setIsDownloadingWhisperModel(false)
    }
  }

  const handlePauseWhisperModelDownload = async () => {
    try {
      const result = await window.electronAPI.sttWhisper.cancelDownloadModel(whisperModelType)
      if (!result.success || !result.cancelled) {
        showMessage(result.error || '暂停下载失败', false)
      }
    } catch (e) {
      const errorText = String(e)
      showMessage(errorText.includes('No handler registered') ? '主进程还没加载暂停接口，请重启应用后再试' : `暂停下载失败: ${errorText}`, false)
    }
  }

  const handleWhisperModelTypeChange = async (type: WhisperModelType) => {
    console.log('[SettingsPage] 切换 Whisper 模型类型:', type)
    setWhisperModelType(type)
    await window.electronAPI.config.set('whisperModelType', type)
    console.log('[SettingsPage] Whisper 模型类型已保存')
    await loadWhisperStatus()
  }

  const handleClearWhisperModel = () => {
    const currentModelSize = whisperModelOptions.find(option => option.value === whisperModelType)?.size || '488 MB'
    setConfirmState({
      show: true,
      title: '清除 Whisper 模型',
      message: `确定要清除 Whisper 模型吗？下次使用需要重新下载 (${currentModelSize})。`,
      status: 'danger',
      confirmLabel: '清除模型',
      confirmVariant: 'danger',
      onConfirm: async () => {
        try {
          const result = await window.electronAPI.sttWhisper.clearModel(whisperModelType)
          if (result.success) {
            showMessage('模型清除成功', true)
            await loadWhisperStatus()
          } else {
            showMessage(result.error || '模型清除失败', false)
          }
        } catch (e) {
          showMessage(`模型清除失败: ${e}`, false)
        }
      }
    })
  }

  const checkGpuComponents = async () => {
    try {
      const status = await window.electronAPI.sttWhisper.checkGPUComponents()
      setGpuComponentsStatus(status)
    } catch (e) {
      console.error('检查 GPU 组件失败:', e)
    }
  }

  const startDownloadGpuComponents = async () => {
    if (isDownloadingGpuComponents) return

    setIsDownloadingGpuComponents(true)
    setGpuDownloadProgress({ overallProgress: 0, currentFile: '' })

    const unsubscribe = window.electronAPI.sttWhisper.onGPUDownloadProgress((progress) => {
      setGpuDownloadProgress({
        overallProgress: progress.overallProgress,
        currentFile: progress.currentFile
      })
    })

    try {
      const result = await window.electronAPI.sttWhisper.downloadGPUComponents()
      if (result.success) {
        showMessage('GPU 组件下载完成！', true)
        await checkGpuComponents()
        await loadWhisperStatus()
      } else if (result.error === DOWNLOAD_PAUSED_MESSAGE) {
        showMessage('GPU 组件下载已暂停，可再次点击下载继续', true)
      } else {
        showMessage(result.error || 'GPU 组件下载失败', false)
      }
    } catch (e) {
      showMessage(`GPU 组件下载失败: ${e}`, false)
    } finally {
      unsubscribe()
      setIsDownloadingGpuComponents(false)
    }
  }

  const handleDownloadGpuComponents = async () => {
    if (isDownloadingGpuComponents) return

    if (!cachePath) {
      showMessage('请先设置缓存目录', false)
      return
    }

    setConfirmState({
      show: true,
      title: '下载 GPU 组件',
      message: '下载 GPU 组件约 645 MB，下载后将自动安装到缓存目录。',
      status: 'warning',
      confirmLabel: '开始下载',
      confirmVariant: 'primary',
      onConfirm: startDownloadGpuComponents
    })
  }

  const handlePauseGpuComponentsDownload = async () => {
    try {
      const result = await window.electronAPI.sttWhisper.cancelDownloadGPUComponents()
      if (!result.success || !result.cancelled) {
        showMessage(result.error || '暂停下载失败', false)
      }
    } catch (e) {
      const errorText = String(e)
      showMessage(errorText.includes('No handler registered') ? '主进程还没加载暂停接口，请重启应用后再试' : `暂停下载失败: ${errorText}`, false)
    }
  }

  const handleToggleWhisperGpu = async (enabled: boolean) => {
    setUseWhisperGpu(enabled)
    await window.electronAPI.config.set('useWhisperGpu', enabled)
    showMessage(enabled ? 'Whisper GPU 加速已启用' : 'Whisper GPU 加速已禁用', true)
  }

  const handleSttLanguagesChange = (languages: string[]) => {
    if (languages.length === 0) {
      showMessage('必须至少选择一种语言', false)
      return
    }

    setSttLanguagesState(languages)
  }

  const closeConfirm = () => setConfirmState(prev => ({ ...prev, show: false }))

  const handleConfirm = async () => {
    const action = confirmState.onConfirm
    closeConfirm()
    await action()
  }

  const renderStatusChip = (ready: boolean, readyText = '已就绪', missingText = '未下载') => (
    <Chip size="sm" variant="soft" color={ready ? 'success' : 'warning'}>
      {ready ? <CircleCheck width={12} height={12} /> : <CircleExclamation width={12} height={12} />}
      <Chip.Label>{ready ? readyText : missingText}</Chip.Label>
    </Chip>
  )

  const renderDownloadProgress = (label: string, value: number, onPause: () => void | Promise<void>, currentFile?: string) => (
    <div className="space-y-3">
      {currentFile && (
        <Typography.Paragraph size="xs" color="muted" className="truncate">
          {currentFile}
        </Typography.Paragraph>
      )}
      <ProgressBar value={value} valueLabel={`${value.toFixed(1)}%`}>
        <div className="flex items-center justify-between gap-3">
          <Label>{label}</Label>
          <ProgressBar.Output />
        </div>
        <ProgressBar.Track>
          <ProgressBar.Fill />
        </ProgressBar.Track>
      </ProgressBar>
      <Button type="button" variant="outline" size="sm" onPress={() => void onPause()}>
        <Pause width={16} height={16} /> 暂停下载
      </Button>
    </div>
  )

  const renderModelStatus = (
    status: { exists: boolean; sizeBytes?: number } | null,
    isLoading: boolean,
    readyLabel = '模型已就绪'
  ) => {
    if (isLoading) {
      return (
        <Alert status="default">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>正在检查模型状态...</Alert.Title>
          </Alert.Content>
        </Alert>
      )
    }

    if (!status) {
      return (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>无法获取模型状态</Alert.Title>
          </Alert.Content>
        </Alert>
      )
    }

    return (
      <Alert status={status.exists ? 'success' : 'warning'}>
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>{status.exists ? readyLabel : '模型未下载'}</Alert.Title>
          {status.exists && status.sizeBytes && (
            <Alert.Description>模型大小：{formatFileSize(status.sizeBytes)}</Alert.Description>
          )}
        </Alert.Content>
      </Alert>
    )
  }

  const renderCpuPanel = () => (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Card className="h-fit">
        <Card.Header className="flex-row items-start justify-between gap-3">
          <div className="min-w-0">
            <Card.Title>SenseVoice 本地模型</Card.Title>
            <Card.Description>适合离线使用，支持中文、英语、日语、韩语和粤语。</Card.Description>
          </div>
          {sttModelStatus && renderStatusChip(sttModelStatus.exists)}
        </Card.Header>
        <Card.Content className="space-y-5">
          <RadioGroup
            name="sttModelType"
            value={sttModelType}
            variant="secondary"
            onChange={(value) => void handleSttModelTypeChange(value as SttModelType)}
            className="grid gap-3 md:grid-cols-2"
            isDisabled={isDownloadingSttModel}
          >
            {sttModelTypeOptions.map(option => (
              <Radio key={option.value} value={option.value} className="relative">
                <Radio.Control className="absolute top-4 right-4">
                  <Radio.Indicator />
                </Radio.Control>
                <Radio.Content className="pr-8">
                  <div className="flex items-start gap-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-default text-foreground">
                      {option.value === 'int8' ? <Thunderbolt width={18} height={18} /> : <Layers width={18} height={18} />}
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Label>{option.label}</Label>
                        <Chip size="sm" variant="soft"><Chip.Label>{option.size}</Chip.Label></Chip>
                      </div>
                      <Description>{option.desc}</Description>
                    </div>
                  </div>
                </Radio.Content>
              </Radio>
            ))}
          </RadioGroup>

          {renderModelStatus(sttModelStatus, isLoadingSttStatus)}

          {isDownloadingSttModel && renderDownloadProgress('下载进度', sttDownloadProgress, handlePauseSttModelDownload)}
        </Card.Content>
        <Card.Footer className="flex flex-wrap gap-2">
          {!sttModelStatus?.exists && (
            <Button type="button" variant="primary" onPress={() => void handleDownloadSttModel()} isDisabled={isDownloadingSttModel}>
              <ArrowDownToLine width={16} height={16} /> {isDownloadingSttModel ? '下载中...' : '下载模型'}
            </Button>
          )}
          {sttModelStatus?.exists && (
            <Button type="button" variant="danger" onPress={handleClearSttModel}>
              <TrashBin width={16} height={16} /> 清除模型
            </Button>
          )}
          <Button type="button" variant="outline" onPress={() => void loadSttModelStatus()} isDisabled={isLoadingSttStatus}>
            <ArrowsRotateLeft width={16} height={16} className={isLoadingSttStatus ? 'spin' : undefined} /> 刷新状态
          </Button>
        </Card.Footer>
      </Card>

      <Card className="h-fit">
        <Card.Header>
          <Card.Title>识别语言</Card.Title>
          <Card.Description>选择需要识别的语言，支持多选。</Card.Description>
        </Card.Header>
        <Card.Content>
          <CheckboxGroup
            value={sttLanguages}
            onChange={handleSttLanguagesChange}
            variant="secondary"
            className="grid gap-3"
          >
            {sttLanguageOptions.map(option => {
              const checked = sttLanguages.includes(option.value)
              return (
                <Checkbox
                  key={option.value}
                  value={option.value}
                  isDisabled={checked && sttLanguages.length === 1}
                >
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <Checkbox.Content>
                    <Label>{option.label}</Label>
                    <Description>{option.enLabel}</Description>
                  </Checkbox.Content>
                </Checkbox>
              )
            })}
          </CheckboxGroup>
        </Card.Content>
      </Card>
    </div>
  )

  const renderGpuPanel = () => (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-5">
        <Card>
          <Card.Header className="flex-row items-start justify-between gap-3">
            <div className="min-w-0">
              <Card.Title>Whisper GPU 模型</Card.Title>
              <Card.Description>使用 Whisper.cpp 进行 GPU 加速识别，适合较大的转写任务。</Card.Description>
            </div>
            {whisperModelStatus && renderStatusChip(whisperModelStatus.exists)}
          </Card.Header>
          <Card.Content className="space-y-5">
            <RadioGroup
              name="whisperModelType"
              value={whisperModelType}
              variant="secondary"
              onChange={(value) => void handleWhisperModelTypeChange(value as WhisperModelType)}
              className="grid gap-3 md:grid-cols-2"
              isDisabled={isDownloadingWhisperModel}
            >
              {whisperModelOptions.map(option => (
                <Radio key={option.value} value={option.value} className="relative">
                  <Radio.Control className="absolute top-4 right-4">
                    <Radio.Indicator />
                  </Radio.Control>
                  <Radio.Content className="pr-8">
                    <div className="flex items-start gap-3">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-default text-foreground">
                        <Thunderbolt width={18} height={18} />
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Label>{option.label}</Label>
                          <Chip size="sm" variant="soft"><Chip.Label>{option.size}</Chip.Label></Chip>
                        </div>
                        <Description>{option.desc}</Description>
                      </div>
                    </div>
                  </Radio.Content>
                </Radio>
              ))}
            </RadioGroup>

            {renderModelStatus(whisperModelStatus, isLoadingWhisperStatus)}

            {isDownloadingWhisperModel && renderDownloadProgress('Whisper 模型下载进度', whisperDownloadProgress, handlePauseWhisperModelDownload)}
          </Card.Content>
          <Card.Footer className="flex flex-wrap gap-2">
            {!whisperModelStatus?.exists && (
              <Button type="button" variant="primary" onPress={() => void handleDownloadWhisperModel()} isDisabled={isDownloadingWhisperModel}>
                <ArrowDownToLine width={16} height={16} /> {isDownloadingWhisperModel ? '下载中...' : '下载模型'}
              </Button>
            )}
            {whisperModelStatus?.exists && (
              <Button type="button" variant="danger" onPress={handleClearWhisperModel}>
                <TrashBin width={16} height={16} /> 清除模型
              </Button>
            )}
            <Button type="button" variant="outline" onPress={() => void loadWhisperStatus()} isDisabled={isLoadingWhisperStatus}>
              <ArrowsRotateLeft width={16} height={16} className={isLoadingWhisperStatus ? 'spin' : undefined} /> 刷新状态
            </Button>
          </Card.Footer>
        </Card>
      </div>

      <div className="space-y-5">
        <Card>
          <Card.Header className="flex-row items-start justify-between gap-3">
            <div className="min-w-0">
              <Card.Title>GPU 检测</Card.Title>
              <Card.Description>当前机器的 GPU 可用性。</Card.Description>
            </div>
            {whisperGpuInfo && renderStatusChip(whisperGpuInfo.available, '可用', '不可用')}
          </Card.Header>
          <Card.Content>
            {isLoadingWhisperStatus ? (
              <Description>正在检测 GPU...</Description>
            ) : whisperGpuInfo ? (
              <div className="space-y-2">
                <Typography.Paragraph size="sm" weight="medium">{whisperGpuInfo.provider}</Typography.Paragraph>
                <Description>{whisperGpuInfo.info}</Description>
              </div>
            ) : (
              <Alert status="warning">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title>无法检测 GPU 状态</Alert.Title>
                </Alert.Content>
              </Alert>
            )}
          </Card.Content>
        </Card>

        <Card>
          <Card.Header className="flex-row items-start justify-between gap-3">
            <div className="min-w-0">
              <Card.Title>GPU 组件</Card.Title>
              <Card.Description>CUDA 运行组件，约 645 MB。</Card.Description>
            </div>
            {gpuComponentsStatus && renderStatusChip(gpuComponentsStatus.installed, '已安装', '未安装')}
          </Card.Header>
          <Card.Content className="space-y-4">
            {gpuComponentsStatus?.installed ? (
              <div className="space-y-1">
                <Typography.Paragraph size="xs" color="muted">安装位置</Typography.Paragraph>
                <Typography.Code className="block truncate">{gpuComponentsStatus.gpuDir || '未返回安装路径'}</Typography.Code>
              </div>
            ) : (
              <Alert status="accent">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title>需要下载 GPU 组件</Alert.Title>
                  <Alert.Description>组件会安装到缓存目录，下载支持暂停和恢复。</Alert.Description>
                </Alert.Content>
              </Alert>
            )}

            {isDownloadingGpuComponents && renderDownloadProgress('GPU 组件下载进度', gpuDownloadProgress.overallProgress, handlePauseGpuComponentsDownload, gpuDownloadProgress.currentFile)}
          </Card.Content>
          {!gpuComponentsStatus?.installed && (
            <Card.Footer>
              <Button type="button" variant="primary" className="w-full" onPress={() => void handleDownloadGpuComponents()} isDisabled={isDownloadingGpuComponents}>
                <ArrowDownToLine width={16} height={16} /> {isDownloadingGpuComponents ? '下载中...' : '下载 GPU 组件'}
              </Button>
            </Card.Footer>
          )}
        </Card>

        <Card>
          <Card.Header>
            <Card.Title>GPU 加速</Card.Title>
            <Card.Description>控制 Whisper 转写是否优先使用 GPU。</Card.Description>
          </Card.Header>
          <Card.Content>
            <Switch isSelected={useWhisperGpu} onChange={(enabled) => void handleToggleWhisperGpu(enabled)}>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <Switch.Content>
                <Label>启用 Whisper GPU 加速</Label>
                <Description>禁用后将回退到 CPU 执行 Whisper 转写。</Description>
              </Switch.Content>
            </Switch>
          </Card.Content>
        </Card>
      </div>
    </div>
  )

  const renderOnlinePanel = () => (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Card className="h-fit">
        <Card.Header>
          <Card.Title>在线语音转写</Card.Title>
          <Card.Description>无需下载本地模型，语音数据会发送到配置的第三方服务。</Card.Description>
        </Card.Header>
        <Card.Content className="space-y-5">
          <Select
            selectedKey={sttOnlineProvider}
            onSelectionChange={(key) => {
              if (key != null) handleSttOnlineProviderChange(String(key) as SttOnlineProvider)
            }}
            placeholder="选择提供商"
            variant="secondary"
            fullWidth
          >
            <Label>提供商</Label>
            <Select.Trigger>
              <Select.Value>{({ defaultChildren }) => getSttProviderLabel(sttOnlineProvider) || defaultChildren}</Select.Value>
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {sttOnlineProviderOptions.map(option => (
                  <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
                    {option.label}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
            <Description>
              {sttOnlineProvider === 'openai-compatible'
                ? '选择 OpenAI 兼容时会自动补全标准路径'
                : sttOnlineProvider === 'aliyun-qwen-asr'
                  ? '阿里云、千问云都走 DashScope 兼容入口；换模型直接改下方模型名'
                  : sttOnlineProvider === 'volcano-doubao'
                    ? '火山引擎·豆包录音文件极速版，新版控制台只需填一个 API Key'
                    : '自定义接口会直接使用你填写的完整 URL'}
            </Description>
          </Select>

          <TextField fullWidth value={sttOnlineBaseURL} onChange={setSttOnlineBaseURL}>
            <Label>接口 URL</Label>
            <InputGroup fullWidth variant="secondary">
              <InputGroup.Input
                placeholder={
                  sttOnlineProvider === 'openai-compatible'
                    ? 'https://api.openai.com/v1/audio/transcriptions'
                    : sttOnlineProvider === 'aliyun-qwen-asr'
                      ? 'https://dashscope.aliyuncs.com/compatible-mode/v1'
                      : sttOnlineProvider === 'volcano-doubao'
                        ? 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash'
                        : 'https://your-api.example.com/full/path'
                }
              />
            </InputGroup>
            <Description>
              {sttOnlineProvider === 'openai-compatible'
                ? '支持填写完整接口 URL，也兼容只填 /v1 基地址'
                : sttOnlineProvider === 'aliyun-qwen-asr'
                  ? '建议填写 DashScope 兼容入口'
                  : sttOnlineProvider === 'volcano-doubao'
                    ? '默认即火山极速版 flash 端点，一般无需修改'
                    : '系统会按你填写的地址原样发起请求'}
            </Description>
          </TextField>

          <div className="grid gap-4 lg:grid-cols-2">
            <TextField fullWidth value={sttOnlineApiKey} onChange={setSttOnlineApiKey}>
              <Label>API Key</Label>
              <InputGroup fullWidth variant="secondary">
                <InputGroup.Input type="password" placeholder="请输入在线 STT API Key" />
              </InputGroup>
              <Description>用于调用在线语音识别接口。</Description>
            </TextField>

            <TextField fullWidth value={sttOnlineModel} onChange={setSttOnlineModel}>
              <Label>模型名称</Label>
              <InputGroup fullWidth variant="secondary">
                <InputGroup.Input placeholder={sttOnlineProvider === 'aliyun-qwen-asr' ? 'qwen3-asr-flash' : sttOnlineProvider === 'volcano-doubao' ? 'volc.bigasr.auc_turbo' : 'gpt-4o-mini-transcribe'} />
              </InputGroup>
              <Description>
                {sttOnlineProvider === 'aliyun-qwen-asr'
                  ? '默认 qwen3-asr-flash，可改成 qwen-omni 等其他 qwen 系列语音模型'
                  : sttOnlineProvider === 'volcano-doubao'
                    ? '火山此处填 Resource-Id，默认 volc.bigasr.auc_turbo（极速版）'
                    : '可替换为兼容模型名'}
              </Description>
            </TextField>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Select
              selectedKey={sttOnlineLanguage}
              onSelectionChange={(key) => {
                if (key != null) setSttOnlineLanguage(String(key))
              }}
              placeholder="自动识别"
              variant="secondary"
              fullWidth
            >
              <Label>识别语言</Label>
              <Select.Trigger>
                <Select.Value>{({ defaultChildren }) => getSttOnlineLanguageLabel(sttOnlineLanguage) || defaultChildren}</Select.Value>
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {sttOnlineLanguageOptions.map(option => (
                    <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
                      {option.label}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>

            <NumberField
              value={sttOnlineTimeoutMs}
              minValue={5000}
              maxValue={300000}
              step={5000}
              onChange={(value) => setSttOnlineTimeoutMs(clampNumber(value, 5000, 300000, 60000))}
              fullWidth
              variant="secondary"
            >
              <Label>超时时间（毫秒）</Label>
              <NumberField.Group>
                <NumberField.DecrementButton />
                <NumberField.Input />
                <NumberField.IncrementButton />
              </NumberField.Group>
            </NumberField>

            <NumberField
              value={sttOnlineMaxConcurrency}
              minValue={1}
              maxValue={10}
              step={1}
              onChange={(value) => setSttOnlineMaxConcurrency(clampNumber(value, 1, 10, 2))}
              fullWidth
              variant="secondary"
            >
              <Label>批量并发数</Label>
              <NumberField.Group>
                <NumberField.DecrementButton />
                <NumberField.Input />
                <NumberField.IncrementButton />
              </NumberField.Group>
            </NumberField>
          </div>
        </Card.Content>
        <Card.Footer>
          <Button type="button" variant="secondary" onPress={() => void handleTestOnlineSttConfig()}>
            <PlugConnection width={16} height={16} /> 测试在线配置
          </Button>
        </Card.Footer>
      </Card>

      <Card className="h-fit">
        <Card.Header>
          <Card.Title>使用提醒</Card.Title>
          <Card.Description>在线模式不依赖本地模型。</Card.Description>
        </Card.Header>
        <Card.Content>
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>注意隐私与费用</Alert.Title>
              <Alert.Description>语音文件会发送到第三方 STT 服务，识别效果取决于服务商模型、网络状况和接口限流策略。</Alert.Description>
            </Alert.Content>
          </Alert>
        </Card.Content>
      </Card>
    </div>
  )

  const renderConfirmDialog = () => {
    if (!confirmState.show) return null

    return (
      <AlertDialog isOpen={confirmState.show} onOpenChange={(open) => {
        if (!open) closeConfirm()
      }}>
        <Button className="hidden" aria-hidden="true">打开确认框</Button>
        <AlertDialog.Backdrop>
          <AlertDialog.Container>
            <AlertDialog.Dialog className="sm:max-w-105">
              <AlertDialog.CloseTrigger />
              <AlertDialog.Header>
                <AlertDialog.Icon status={confirmState.status} />
                <AlertDialog.Heading>{confirmState.title}</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <Typography.Paragraph className="whitespace-pre-line">{confirmState.message}</Typography.Paragraph>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button slot="close" variant="tertiary">取消</Button>
                <Button slot="close" variant={confirmState.confirmVariant} onPress={() => void handleConfirm()}>
                  {confirmState.confirmLabel}
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    )
  }

  return (
    <div className="tab-content space-y-6">
      <section className="space-y-2">
        <Typography.Heading level={3} className="text-lg font-semibold text-foreground">语音转文字</Typography.Heading>
        <Typography.Paragraph size="sm" color="muted">
          根据使用场景选择本地 CPU、本地 GPU 或在线转写模式。
        </Typography.Paragraph>
      </section>

      <Tabs selectedKey={sttMode} onSelectionChange={(key) => void handleSttModeChange(toSttMode(key))} className="w-full">
        <Tabs.ListContainer>
          <Tabs.List aria-label="语音转文字模式" className="w-full *:flex-1 *:gap-2">
            <Tabs.Tab id="cpu"><Cpu width={16} height={16} aria-hidden />CPU 模式<Tabs.Indicator /></Tabs.Tab>
            <Tabs.Tab id="gpu"><Gpu width={16} height={16} aria-hidden />GPU 模式<Tabs.Indicator /></Tabs.Tab>
            <Tabs.Tab id="online"><Cloud width={16} height={16} aria-hidden />在线模式<Tabs.Indicator /></Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>

        <Tabs.Panel id="cpu" className="pt-5">
          {renderCpuPanel()}
        </Tabs.Panel>
        <Tabs.Panel id="gpu" className="pt-5">
          {renderGpuPanel()}
        </Tabs.Panel>
        <Tabs.Panel id="online" className="pt-5">
          {renderOnlinePanel()}
        </Tabs.Panel>
      </Tabs>

      {renderConfirmDialog()}
    </div>
  )
}

export default SttTab
