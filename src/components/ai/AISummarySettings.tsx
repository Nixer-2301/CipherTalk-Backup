import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Alert,
  Button,
  Card,
  Chip,
  CloseButton,
  ComboBox,
  Description,
  Drawer,
  FieldError,
  Fieldset,
  Form,
  Input,
  InputGroup,
  Label,
  ListBox,
  Modal,
  Select,
  Spinner,
  Tabs,
  TextField,
  Tooltip,
  Typography,
  useOverlayState,
  type Key
} from '@heroui/react'
import { ArrowUpRight, ArrowsRotateLeft, Bulb, CircleCheck, CircleQuestion, CurlyBrackets, Eye, EyeSlash, FileText, GearDot, Pencil, Picture, Plus, Sparkles, Speedometer, TrashBin, Wallet, Wrench } from '@gravity-ui/icons'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { getAIProviders, type AIModelInfo, type AIProviderInfo } from '../../types/ai'
import * as configService from '../../services/config'
import { cn } from '../../lib/utils'
import { useSettingsStore } from '../settings/settingsStore'
import AIProviderLogo from './AIProviderLogo'
import EmbeddingTab from '../settings/tabs/EmbeddingTab'
import RerankTab from '../settings/tabs/RerankTab'
import TtsTab from '../settings/tabs/TtsTab'
import ImageGenTab from '../settings/tabs/ImageGenTab'
import LocalCodingAgentSettings from './LocalCodingAgentSettings'
import ChatGPTSubscriptionAuth from './ChatGPTSubscriptionAuth'

type AiProviderProtocol = configService.AiProviderProtocol
type PresetTab = 'name' | 'provider' | 'config'
type ConfigMode = 'llm' | 'vector' | 'rerank' | 'tts' | 'imageGen' | 'localAgent'

interface AISummarySettingsProps {
  showMessage: (text: string, success: boolean) => void
}

interface PresetDraft {
  provider: string
  apiKey: string
  model: string
  baseURL: string
  protocol: AiProviderProtocol
}

interface SelectOption {
  value: string
  label: string
  description?: string
  content?: ReactNode
  disabled?: boolean
}

const DEEPSEEK_LEGACY_MODEL_MAP: Record<string, string> = {
  'DeepSeek V3': 'deepseek-v4-flash',
  'DeepSeek R1 (推理)': 'deepseek-v4-flash',
  'deepseek-chat': 'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-flash'
}

const LEGACY_CUSTOM_PROVIDER_MAP: Record<string, string> = {
  gemini: 'google',
  qwen: 'alibaba-cn',
  kimi: 'moonshotai-cn',
  siliconflow: 'siliconflow-cn',
  zhipu: 'zhipuai',
  tencent: 'tencent-tokenhub',
  'custom-responses': 'openai'
}

const CUSTOM_PROTOCOL_OPTIONS: Array<{ value: AiProviderProtocol; label: string }> = [
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'openai-compatible', label: 'OpenAI Compatible' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'google', label: 'Google Gemini' }
]

const PROTOCOL_LABELS: Record<AiProviderProtocol, string> = {
  'openai-responses': 'OpenAI Responses',
  'openai-compatible': 'OpenAI Compatible',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  'codex-subscription': 'ChatGPT 订阅'
}

const CODEX_SUBSCRIPTION_PROVIDER_ID = 'openai-codex'

const AI_DROPDOWN_LIST_CLASS = 'ct-ai-dropdown-list max-h-80 overflow-y-auto'

function normalizeProviderId(providerId: string) {
  return LEGACY_CUSTOM_PROVIDER_MAP[providerId] || providerId
}

function normalizeProviderModel(providerId: string, modelName: string) {
  return providerId === 'deepseek'
    ? DEEPSEEK_LEGACY_MODEL_MAP[modelName] || modelName
    : modelName
}

function normalizeProviderBaseURL(providerId: string, baseURL: string) {
  if (providerId === 'ollama') {
    return (baseURL || 'http://localhost:11434/v1').trim().replace(/\/+$/, '')
  }
  return baseURL.trim().replace(/\/+$/, '')
}

function canFetchProviderModelList(providerId: string, baseURL: string, providerInfo?: AIProviderInfo) {
  if (!providerId) return false
  if (providerInfo?.allowCustomBaseURL && !baseURL.trim()) return false
  return true
}

function formatTokenLimit(value?: number) {
  if (!value) return ''
  return value >= 1000 ? `${Math.round(value / 1000)}K` : String(value)
}

function formatModelCost(modelDetail?: AIModelInfo) {
  if (modelDetail?.cost?.input === undefined || modelDetail.cost.output === undefined) return ''
  if (modelDetail.cost.input === 0 && modelDetail.cost.output === 0) return '免费'
  return `$${modelDetail.cost.input}/$${modelDetail.cost.output}`
}

function isFreeModelCost(modelDetail?: AIModelInfo) {
  return modelDetail?.cost?.input === 0 && modelDetail.cost.output === 0
}

function maskSecret(value: string) {
  const text = value.trim()
  if (!text) return '未填写'
  if (text.length <= 8) return `${text.slice(0, 2)}***`
  return `${text.slice(0, 4)}***${text.slice(-4)}`
}

function formatProtocolLabel(protocol?: AiProviderProtocol) {
  return protocol ? PROTOCOL_LABELS[protocol] || protocol : '未选择'
}

function formatModelStatus(status?: string) {
  const value = String(status || '').trim()
  if (!value) return null
  const lower = value.toLowerCase()
  if (isDeprecatedModelStatus(value)) {
    return { label: '已淘汰', color: 'danger' as const, tooltip: `models.dev 状态：${value}` }
  }
  if (['beta', 'preview', 'experimental'].some(item => lower.includes(item))) {
    return { label: value, color: 'warning' as const, tooltip: `models.dev 状态：${value}` }
  }
  return { label: value, color: 'default' as const, tooltip: `models.dev 状态：${value}` }
}

function isDeprecatedModelStatus(status?: string) {
  const lower = String(status || '').trim().toLowerCase()
  if (!lower) return false
  return ['deprecated', 'retired', 'disabled', 'legacy', 'sunset', 'removed'].some(item => lower.includes(item))
}

function isDeprecatedModel(modelDetail?: AIModelInfo) {
  return isDeprecatedModelStatus(modelDetail?.status)
}

function ModelCapabilityStrip({ modelDetail, compact = false }: { modelDetail?: AIModelInfo; compact?: boolean }) {
  if (!modelDetail) return null

  const context = formatTokenLimit(modelDetail.limits.context)
  const output = formatTokenLimit(modelDetail.limits.output)
  const price = formatModelCost(modelDetail)
  const isFree = isFreeModelCost(modelDetail)
  const status = formatModelStatus(modelDetail.status)
  const metrics = [
    { key: 'context', label: '上下文', value: context || '--', active: !!context, icon: Speedometer, tooltip: context ? `上下文 ${context}` : '上下文未知' },
    { key: 'output', label: '输出', value: output || '--', active: !!output, icon: ArrowUpRight, tooltip: output ? `最大输出 ${output}` : '最大输出未知' },
    {
      key: 'price',
      label: '价格',
      value: price || '--',
      active: !!price,
      color: isFree ? 'success' as const : undefined,
      icon: Wallet,
      tooltip: price
        ? (isFree ? '免费模型：输入和输出价格均为 0' : `${modelDetail.cost?.input}/1M input, ${modelDetail.cost?.output}/1M output`)
        : '价格未知'
    }
  ]
  const capabilities = [
    { key: 'reasoning', label: '推理', enabled: modelDetail.capabilities.reasoning, icon: Bulb },
    { key: 'tool', label: '工具调用', enabled: modelDetail.capabilities.toolCall, icon: Wrench },
    { key: 'structured', label: '结构化输出', enabled: modelDetail.capabilities.structuredOutput, icon: CurlyBrackets },
    { key: 'image', label: '图像输入', enabled: modelDetail.modalities.input.includes('image'), icon: Picture },
    { key: 'pdf', label: 'PDF', enabled: modelDetail.modalities.input.includes('pdf'), icon: FileText }
  ]

  return (
    <span className={cn('flex flex-wrap items-center', compact ? 'gap-1' : 'gap-1.5')}>
      {status && (
        <Tooltip delay={0}>
          <Chip size="md" variant="soft" color={status.color}>
            <Chip.Label>{status.label}</Chip.Label>
          </Chip>
          <Tooltip.Content>{status.tooltip}</Tooltip.Content>
        </Tooltip>
      )}
      {metrics.map(item => {
        const Icon = item.icon
        return (
          <Tooltip key={item.key} delay={0}>
            <Chip size="md" variant="soft" color={item.color || (item.active ? 'accent' : 'default')} className={cn(!item.active && 'opacity-60')}>
              <Icon width={12} height={12} />
              <Chip.Label>{item.value}</Chip.Label>
            </Chip>
            <Tooltip.Content>{item.tooltip}</Tooltip.Content>
          </Tooltip>
        )
      })}
      {capabilities.map(item => {
        const Icon = item.icon
        return (
          <Tooltip key={item.key} delay={0}>
            <Chip size="md" variant="soft" color={item.enabled ? 'success' : 'default'} className={cn(!item.enabled && 'opacity-60')}>
              <Icon width={12} height={12} />
              {!compact && <Chip.Label>{item.label}</Chip.Label>}
            </Chip>
            <Tooltip.Content>{`${item.label}: ${item.enabled ? '支持' : '不支持'}`}</Tooltip.Content>
          </Tooltip>
        )
      })}
    </span>
  )
}

function ModelOptionContent({ modelId, modelDetail }: { modelId: string; modelDetail?: AIModelInfo }) {
  const status = formatModelStatus(modelDetail?.status)
  const isFree = isFreeModelCost(modelDetail)
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-sm text-foreground">{modelDetail?.name || modelId}</span>
        {isFree && (
          <Chip size="sm" variant="soft" color="success" className="shrink-0">
            <Chip.Label>免费</Chip.Label>
          </Chip>
        )}
        {status?.color === 'danger' && (
          <Chip size="sm" variant="soft" color="danger" className="shrink-0">
            <Chip.Label>已淘汰</Chip.Label>
          </Chip>
        )}
      </span>
      <ModelCapabilityStrip modelDetail={modelDetail} compact />
    </span>
  )
}

function ProviderOptionContent({ providerInfo }: { providerInfo: AIProviderInfo }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <AIProviderLogo providerId={providerInfo.id} logo={providerInfo.logo} alt={providerInfo.displayName} className="shrink-0" size={18} />
      <span className="flex min-w-0 flex-col">
        <strong className="truncate text-sm font-medium text-foreground">{providerInfo.displayName}</strong>
        <span className="truncate text-xs text-muted-foreground">{providerInfo.id}</span>
      </span>
    </span>
  )
}

function GuideModal({ title, html, onClose }: { title: string; html: string; onClose: () => void }) {
  const modalState = useOverlayState({
    defaultOpen: true,
    onOpenChange: (open) => {
      if (!open) onClose()
    }
  })

  return (
    <Modal state={modalState}>
      <Modal.Backdrop variant="blur">
        <Modal.Container size="lg" scroll="inside" placement="center">
          <Modal.Dialog>
            <Modal.Header className="items-center justify-between">
              <Modal.Heading className="text-base font-semibold text-foreground">{title}</Modal.Heading>
              <CloseButton aria-label="关闭指南" onPress={onClose} />
            </Modal.Header>
            <Modal.Body>
              <Typography.Prose className="max-w-none">
                <div dangerouslySetInnerHTML={{ __html: html || '<p>加载中...</p>' }} />
              </Typography.Prose>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}

function AISummarySettings({ showMessage }: AISummarySettingsProps) {
  const provider = useSettingsStore(s => s.config.aiProvider)
  const apiKey = useSettingsStore(s => s.config.aiApiKey)
  const model = useSettingsStore(s => s.config.aiModel)
  const setField = useSettingsStore(s => s.setField)

  const [providers, setProviders] = useState<AIProviderInfo[]>([])
  const [providerConfigs, setProviderConfigs] = useState<Record<string, configService.AiProviderConfig>>({})
  const [baseURL, setBaseURL] = useState('')
  const [customProtocol, setCustomProtocol] = useState<AiProviderProtocol>('openai-responses')
  const [showApiKey, setShowApiKey] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [remoteModels, setRemoteModels] = useState<string[]>([])
  const [remoteModelDetails, setRemoteModelDetails] = useState<AIModelInfo[]>([])
  const [modelListError, setModelListError] = useState('')
  const [codexAuthenticated, setCodexAuthenticated] = useState(false)
  const [presets, setPresets] = useState<configService.AiConfigPreset[]>([])
  const [configMode, setConfigMode] = useState<ConfigMode>('llm')
  const [showPresetDrawer, setShowPresetDrawer] = useState(false)
  const [showSavePresetDialog, setShowSavePresetDialog] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [presetTab, setPresetTab] = useState<PresetTab>('name')
  const [presetDraft, setPresetDraft] = useState<PresetDraft>({
    provider: '',
    apiKey: '',
    model: '',
    baseURL: '',
    protocol: 'openai-responses'
  })
  const [presetRemoteModels, setPresetRemoteModels] = useState<string[]>([])
  const [presetRemoteModelDetails, setPresetRemoteModelDetails] = useState<AIModelInfo[]>([])
  const [isLoadingPresetModels, setIsLoadingPresetModels] = useState(false)
  const [presetModelListError, setPresetModelListError] = useState('')
  const presetModelRequestId = useRef(0)
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null)
  const [showOllamaHelp, setShowOllamaHelp] = useState(false)
  const [showCustomHelp, setShowCustomHelp] = useState(false)
  const [ollamaGuideContent, setOllamaGuideContent] = useState('')
  const [customGuideContent, setCustomGuideContent] = useState('')
  const [settingsPagePortalHost, setSettingsPagePortalHost] = useState<HTMLElement | null>(null)
  const savePresetModalState = useOverlayState({
    isOpen: showSavePresetDialog,
    onOpenChange: setShowSavePresetDialog
  })
  const presetDrawerState = useOverlayState({
    isOpen: showPresetDrawer,
    onOpenChange: setShowPresetDrawer
  })

  const currentProvider = providers.find(p => p.id === provider)
  const isCodexSubscription = provider === CODEX_SUBSCRIPTION_PROVIDER_ID || currentProvider?.protocol === 'codex-subscription'
  const currentProtocol: AiProviderProtocol = currentProvider?.protocolOptions?.length
    ? customProtocol
    : (currentProvider?.protocol || 'openai-responses')
  const modelDetails = remoteModelDetails.length > 0 ? remoteModelDetails : (currentProvider?.modelDetails || [])
  const modelDetailById = useMemo(() => new Map(modelDetails.map(item => [item.id, item])), [modelDetails])
  const currentModelDetail = modelDetailById.get(model)
  const modelOptions = useMemo<SelectOption[]>(() => {
    const models = remoteModels.length > 0 ? remoteModels : (currentProvider?.models || [])
    return models
      .filter(item => !isDeprecatedModel(modelDetailById.get(item)))
      .map(item => ({
        value: item,
        label: item,
        content: <ModelOptionContent modelId={item} modelDetail={modelDetailById.get(item)} />
      }))
  }, [currentProvider?.models, modelDetailById, remoteModels])
  const providerOptions = useMemo<SelectOption[]>(() => providers.map(item => ({
    value: item.id,
    label: item.displayName,
    description: [item.id, item.description, item.protocol].filter(Boolean).join(' '),
    content: <ProviderOptionContent providerInfo={item} />
  })), [providers])
  const protocolOptions = useMemo<SelectOption[]>(() => (
    CUSTOM_PROTOCOL_OPTIONS
      .filter(item => currentProvider?.protocolOptions?.includes(item.value))
      .map(item => ({ value: item.value, label: item.label }))
  ), [currentProvider?.protocolOptions])
  const presetDraftProvider = providers.find(p => p.id === presetDraft.provider)
  const presetDraftProtocolOptions = useMemo<SelectOption[]>(() => (
    CUSTOM_PROTOCOL_OPTIONS
      .filter(item => presetDraftProvider?.protocolOptions?.includes(item.value))
      .map(item => ({ value: item.value, label: item.label }))
  ), [presetDraftProvider?.protocolOptions])
  const presetDraftModelDetailById = useMemo(() => {
    const details = presetRemoteModelDetails.length > 0
      ? presetRemoteModelDetails
      : (presetDraftProvider?.modelDetails || [])
    return new Map(details.map(item => [item.id, item]))
  }, [presetDraftProvider?.modelDetails, presetRemoteModelDetails])
  const presetDraftModelOptions = useMemo<SelectOption[]>(() => {
    const models = presetRemoteModels.length > 0
      ? presetRemoteModels
      : (presetDraftProvider?.models || [])
    return models
      .filter(item => !isDeprecatedModel(presetDraftModelDetailById.get(item)))
      .map(item => ({
        value: item,
        label: item,
        content: <ModelOptionContent modelId={item} modelDetail={presetDraftModelDetailById.get(item)} />
      }))
  }, [presetDraftModelDetailById, presetDraftProvider?.models, presetRemoteModels])
  const presetDraftCurrentModelDetail = presetDraftModelDetailById.get(presetDraft.model)
  const currentBaseURLLabel = currentProvider?.allowCustomBaseURL
    ? (baseURL || '未填写')
    : (currentProvider?.baseURL || '固定服务地址')
  const currentProtocolOption = protocolOptions.find(option => option.value === customProtocol)
  const currentModelSelectedKey = modelOptions.some(option => option.value === model) ? model : null
  const presetProtocolOption = presetDraftProtocolOptions.find(option => option.value === presetDraft.protocol)
  const presetModelSelectedKey = presetDraftModelOptions.some(option => option.value === presetDraft.model) ? presetDraft.model : null
  useEffect(() => {
    void loadProviders()
    void loadAllProviderConfigs()
    void loadPresets()
  }, [])

  useEffect(() => {
    const host = document.querySelector('.settings-page')
    setSettingsPagePortalHost(host instanceof HTMLElement ? host : null)
  }, [])

  useEffect(() => {
    if (!provider) return
    const config = providerConfigs[provider]
    if (currentProvider?.allowCustomBaseURL) {
      setBaseURL(config?.baseURL || (provider === 'ollama' ? 'http://localhost:11434/v1' : ''))
    } else {
      setBaseURL('')
    }

    if (config) {
      setField('aiApiKey', config.apiKey || '')
      setField('aiModel', normalizeProviderModel(provider, config.model || ''))
    } else {
      setField('aiModel', normalizeProviderModel(provider, currentProvider?.models?.[0] || ''))
    }
    setCustomProtocol(config?.protocol || currentProvider?.protocol || 'openai-responses')
    setRemoteModels([])
    setRemoteModelDetails([])
    setModelListError('')
  }, [provider, providerConfigs, currentProvider?.models, currentProvider?.protocol])

  useEffect(() => {
    const normalized = normalizeProviderModel(provider, model)
    if (normalized !== model) {
      setField('aiModel', normalized)
    }
  }, [provider, model, setField])

  const loadProviders = async () => {
    const list = await getAIProviders()
    setProviders(list)
    const normalizedProvider = normalizeProviderId(provider)
    const nextProvider = list.some(item => item.id === normalizedProvider)
      ? normalizedProvider
      : list[0]?.id
    if (nextProvider && nextProvider !== provider) {
      setField('aiProvider', nextProvider)
      await configService.setAiProvider(nextProvider)
    }
  }

  const loadAllProviderConfigs = async () => {
    const configs = await configService.getAllAiProviderConfigs()
    setProviderConfigs(configs || {})
  }

  const loadPresets = async () => {
    setPresets(await configService.getAiConfigPresets())
  }

  const createPresetDraftFromProvider = (providerId: string): PresetDraft => {
    const nextProvider = normalizeProviderId(providerId || providers[0]?.id || '')
    const providerInfo = providers.find(item => item.id === nextProvider)

    return {
      provider: nextProvider,
      apiKey: '',
      model: '',
      baseURL: nextProvider === 'ollama' ? 'http://localhost:11434/v1' : '',
      protocol: providerInfo?.protocol || 'openai-responses'
    }
  }

  const updatePresetDraft = (patch: Partial<PresetDraft>) => {
    setPresetDraft(prev => ({ ...prev, ...patch }))
  }

  const handlePresetNextStep = () => {
    if (presetTab === 'name') {
      if (!presetName.trim()) {
        showMessage('请输入配置名称', false)
        return
      }
      setPresetTab('provider')
      return
    }
    if (presetTab === 'provider') {
      if (!presetDraft.provider) {
        showMessage('请选择服务商', false)
        return
      }
      setPresetTab('config')
    }
  }

  const handlePresetPrevStep = () => {
    setPresetTab(tab => {
      if (tab === 'config') return 'provider'
      if (tab === 'provider') return 'name'
      return tab
    })
  }

  const handlePresetTabChange = (key: Key) => {
    const nextTab = String(key) as PresetTab
    if (nextTab === 'provider' && !presetName.trim()) {
      showMessage('请输入配置名称', false)
      return
    }
    if (nextTab === 'config') {
      if (!presetName.trim()) {
        showMessage('请输入配置名称', false)
        return
      }
      if (!presetDraft.provider) {
        showMessage('请选择服务商', false)
        return
      }
    }
    setPresetTab(nextTab)
  }

  const persistProviderConfig = async (
    nextProvider = provider,
    nextApiKey = apiKey,
    nextModel = model,
    nextBaseURL = baseURL,
    nextProtocol = customProtocol
  ) => {
    const providerInfo = providers.find(item => item.id === nextProvider)
    const payload: configService.AiProviderConfig = {
      apiKey: nextApiKey,
      model: normalizeProviderModel(nextProvider, nextModel),
      baseURL: providerInfo?.allowCustomBaseURL
        ? normalizeProviderBaseURL(nextProvider, nextBaseURL)
        : undefined,
      protocol: providerInfo?.protocolOptions?.length ? nextProtocol : undefined
    }
    await configService.setAiProvider(nextProvider)
    await configService.setAiProviderConfig(nextProvider, payload)
    setProviderConfigs(prev => ({ ...prev, [nextProvider]: payload }))
  }

  const handleSelectProvider = async (providerId: string) => {
    const normalizedProviderId = normalizeProviderId(providerId)
    await persistProviderConfig()
    await configService.setActiveAiConfigPresetId('')
    setField('aiProvider', normalizedProviderId)
    await configService.setAiProvider(normalizedProviderId)
  }

  const handleRefreshModels = async () => {
    if (!canFetchProviderModelList(provider, baseURL, currentProvider)) {
      showMessage('请先填写当前服务商所需的 API 配置', false)
      return
    }
    setIsLoadingModels(true)
    setModelListError('')
    try {
      const result = await window.electronAPI.ai.listModels({
        provider,
        apiKey,
        baseURL,
        protocol: currentProvider?.protocolOptions?.length ? customProtocol : undefined
      })
      if (!result.success || !result.models?.length) {
        const error = result.error || '模型列表为空'
        setModelListError(error)
        showMessage(error, false)
        return
      }
      setRemoteModels(result.models)
      setRemoteModelDetails(result.modelDetails || [])
      const nextModelDetailsById = new Map((result.modelDetails || []).map(item => [item.id, item]))
      const availableModels = result.models.filter(item => !isDeprecatedModel(nextModelDetailsById.get(item)))
      if (!availableModels.includes(model)) {
        setField('aiModel', availableModels[0] || result.models[0])
      }
      showMessage('模型列表已刷新', true)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setModelListError(message)
      showMessage(`刷新模型失败: ${message}`, false)
    } finally {
      setIsLoadingModels(false)
    }
  }

  useEffect(() => {
    if (isCodexSubscription && codexAuthenticated) void handleRefreshModels()
  }, [isCodexSubscription, codexAuthenticated])

  const loadPresetDraftModels = async (notify = true) => {
    const providerInfo = providers.find(item => item.id === presetDraft.provider)
    if (!canFetchProviderModelList(presetDraft.provider, presetDraft.baseURL, providerInfo)) {
      if (notify) showMessage('请先填写预设所需的 API 配置', false)
      return
    }

    const requestId = ++presetModelRequestId.current
    setIsLoadingPresetModels(true)
    setPresetModelListError('')
    try {
      const result = await window.electronAPI.ai.listModels({
        provider: presetDraft.provider,
        apiKey: presetDraft.apiKey,
        baseURL: presetDraft.baseURL,
        protocol: providerInfo?.protocolOptions?.length ? presetDraft.protocol : undefined
      })
      if (requestId !== presetModelRequestId.current) return
      if (!result.success || !result.models?.length) {
        const error = result.error || '模型列表为空'
        setPresetModelListError(error)
        if (notify) showMessage(error, false)
        return
      }

      setPresetRemoteModels(result.models)
      setPresetRemoteModelDetails(result.modelDetails || [])
      const nextModelDetailsById = new Map((result.modelDetails || []).map(item => [item.id, item]))
      const availableModels = result.models.filter(item => !isDeprecatedModel(nextModelDetailsById.get(item)))
      setPresetDraft(prev => prev.model
        ? prev
        : { ...prev, model: availableModels[0] || result.models?.[0] || '' })
      if (notify) showMessage('预设模型列表已刷新', true)
    } catch (error) {
      if (requestId !== presetModelRequestId.current) return
      const message = error instanceof Error ? error.message : String(error)
      setPresetModelListError(message)
      if (notify) showMessage(`刷新模型失败: ${message}`, false)
    } finally {
      if (requestId === presetModelRequestId.current) setIsLoadingPresetModels(false)
    }
  }

  useEffect(() => {
    presetModelRequestId.current += 1
    setPresetRemoteModels([])
    setPresetRemoteModelDetails([])
    setPresetModelListError('')
    setIsLoadingPresetModels(false)
  }, [showSavePresetDialog, presetDraft.provider, presetDraft.apiKey, presetDraft.baseURL, presetDraft.protocol])

  useEffect(() => {
    if (
      showSavePresetDialog &&
      presetTab === 'config' &&
      presetDraftProvider?.protocol === 'codex-subscription' &&
      codexAuthenticated
    ) {
      void loadPresetDraftModels(false)
    }
  }, [showSavePresetDialog, presetTab, presetDraft.provider, codexAuthenticated])

  useEffect(() => {
    if (
      !showSavePresetDialog ||
      presetTab !== 'config' ||
      presetDraft.provider !== 'custom' ||
      !presetDraft.baseURL.trim()
    ) {
      return
    }

    const timer = window.setTimeout(() => {
      void loadPresetDraftModels(false)
    }, 600)
    return () => window.clearTimeout(timer)
  }, [
    showSavePresetDialog,
    presetTab,
    presetDraft.provider,
    presetDraft.apiKey,
    presetDraft.baseURL,
    presetDraft.protocol
  ])

  const handleTestConnection = async () => {
    if (provider !== 'ollama' && !isCodexSubscription && !apiKey.trim()) {
      showMessage('请先填写 API 密钥', false)
      return
    }
    if (currentProvider?.allowCustomBaseURL && !baseURL.trim()) {
      showMessage('自定义服务需要填写服务地址', false)
      return
    }
    if (!model.trim()) {
      showMessage('请先选择或输入要测试的模型', false)
      return
    }

    setIsTesting(true)
    try {
      const result = await window.electronAPI.ai.testConnection(
        provider,
        apiKey,
        baseURL,
        currentProvider?.protocolOptions?.length ? customProtocol : undefined,
        model,
      )
      showMessage(result.success ? '连接测试成功' : (result.error || '连接测试失败'), result.success)
      if (result.success) {
        await persistProviderConfig()
      }
    } finally {
      setIsTesting(false)
    }
  }

  const handleSaveCurrentProvider = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    await persistProviderConfig()
    await configService.setActiveAiConfigPresetId('')
    showMessage('AI 接入配置已保存', true)
  }

  const loadGuide = async (guideName: string) => {
    const result = await window.electronAPI.ai.readGuide(guideName)
    if (!result.success || !result.content) {
      showMessage(result.error || '指南加载失败', false)
      return ''
    }
    const html = await marked.parse(result.content)
    return DOMPurify.sanitize(html)
  }

  const openOllamaGuide = async () => {
    setShowOllamaHelp(true)
    if (!ollamaGuideContent) {
      setOllamaGuideContent(await loadGuide('Ollama使用指南.md'))
    }
  }

  const openCustomGuide = async () => {
    setShowCustomHelp(true)
    if (!customGuideContent) {
      setCustomGuideContent(await loadGuide('自定义AI服务使用指南.md'))
    }
  }

  const handleSavePreset = async () => {
    const name = presetName.trim()
    if (!name) {
      showMessage('请输入配置名称', false)
      setPresetTab('name')
      return
    }
    if (!presetDraft.provider) {
      showMessage('请选择服务商', false)
      setPresetTab('provider')
      return
    }

    const draftProviderInfo = providers.find(item => item.id === presetDraft.provider)
    const payload = {
      name,
      provider: presetDraft.provider,
      apiKey: presetDraft.apiKey,
      model: normalizeProviderModel(presetDraft.provider, presetDraft.model),
      baseURL: draftProviderInfo?.allowCustomBaseURL
        ? (normalizeProviderBaseURL(presetDraft.provider, presetDraft.baseURL) || undefined)
        : undefined,
      protocol: draftProviderInfo?.protocolOptions?.length ? presetDraft.protocol : undefined
    }
    if (editingPresetId) {
      await configService.updateAiConfigPreset(editingPresetId, payload)
      showMessage('配置预设已更新', true)
    } else {
      await configService.saveAiConfigPreset(payload)
      showMessage('配置预设已保存', true)
    }
    setShowSavePresetDialog(false)
    setEditingPresetId(null)
    setPresetName('')
    setPresetTab('name')
    await loadPresets()
  }

  const openNewPresetDialog = () => {
    setEditingPresetId(null)
    setPresetName('')
    setPresetTab('name')
    setPresetDraft({
      provider: '',
      apiKey: '',
      model: '',
      baseURL: '',
      protocol: 'openai-responses'
    })
    setShowSavePresetDialog(true)
  }

  const handleLoadPreset = async (presetId: string) => {
    const preset = await configService.loadAiConfigPreset(presetId)
    if (!preset) {
      showMessage('配置预设不存在', false)
      return
    }
    const presetProvider = normalizeProviderId(preset.provider)
    setField('aiProvider', presetProvider)
    setField('aiApiKey', preset.apiKey)
    setField('aiModel', normalizeProviderModel(presetProvider, preset.model))
    setCustomProtocol(preset.protocol || 'openai-responses')
    setBaseURL(preset.baseURL || '')
    await persistProviderConfig(presetProvider, preset.apiKey, preset.model, preset.baseURL || '', preset.protocol || 'openai-responses')
    await configService.setActiveAiConfigPresetId(preset.id)
    showMessage('配置预设已加载', true)
  }

  const handleEditPreset = (preset: configService.AiConfigPreset) => {
    setEditingPresetId(preset.id)
    setPresetName(preset.name)
    setPresetTab('name')
    const presetProvider = normalizeProviderId(preset.provider)
    setPresetDraft({
      provider: presetProvider,
      apiKey: preset.apiKey,
      model: normalizeProviderModel(presetProvider, preset.model),
      baseURL: preset.baseURL || '',
      protocol: preset.protocol || 'openai-responses'
    })
    setShowSavePresetDialog(true)
  }

  const handleDeletePreset = async (presetId: string) => {
    await configService.deleteAiConfigPreset(presetId)
    if (await configService.getActiveAiConfigPresetId() === presetId) {
      await configService.setActiveAiConfigPresetId('')
    }
    await loadPresets()
    showMessage('配置预设已删除', true)
  }

  const canFetchModels = canFetchProviderModelList(provider, baseURL, currentProvider)

  return (
    <div className="tab-content">
      <div className="mx-auto w-full max-w-290 space-y-6 px-2">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <Typography.Heading level={2} className="text-lg">AI 接入配置</Typography.Heading>
            <Typography.Paragraph size="sm" color="muted" className="mt-1">管理 AI 服务商、模型、账号登录、API 密钥和代理连接。</Typography.Paragraph>
          </div>
          <div className="ml-auto flex shrink-0 items-center justify-end">
            {/* 大模型 / 向量 / 重排 切换：同一套 UI 配置不同对象 */}
            <Tabs className="shrink-0" selectedKey={configMode} onSelectionChange={(key) => setConfigMode(key as ConfigMode)}>
              <Tabs.ListContainer>
                <Tabs.List aria-label="配置类型">
                  <Tabs.Tab className="whitespace-nowrap" id="llm">大模型<Tabs.Indicator /></Tabs.Tab>
                  <Tabs.Tab className="whitespace-nowrap" id="vector">向量<Tabs.Indicator /></Tabs.Tab>
                  <Tabs.Tab className="whitespace-nowrap" id="rerank">重排<Tabs.Indicator /></Tabs.Tab>
                  <Tabs.Tab className="whitespace-nowrap" id="tts">语音<Tabs.Indicator /></Tabs.Tab>
                  <Tabs.Tab className="whitespace-nowrap" id="imageGen">作图<Tabs.Indicator /></Tabs.Tab>
                  <Tabs.Tab className="whitespace-nowrap" id="localAgent">本地智能体<Tabs.Indicator /></Tabs.Tab>
                </Tabs.List>
              </Tabs.ListContainer>
            </Tabs>
          </div>
        </div>

        {configMode === 'llm' && (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="primary" size="sm" onPress={openNewPresetDialog}>
              <Plus width={16} height={16} /> 添加预设
            </Button>
            <Button type="button" variant="outline" size="sm" onPress={() => setShowPresetDrawer(true)}>
              <GearDot width={16} height={16} /> 预设管理
            </Button>
          </div>
        )}

        {configMode === 'llm' && (
          <Card>
            <Card.Content>
              <ChatGPTSubscriptionAuth compact onAuthenticationChange={setCodexAuthenticated} />
            </Card.Content>
          </Card>
        )}

        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_330px]" style={{ display: configMode !== 'llm' ? 'none' : undefined }}>
          <Card>
            <Card.Header className="flex-row items-start justify-between gap-4">
              <div className="min-w-0">
                <Card.Title>接入参数</Card.Title>
              </div>
              <AIProviderLogo providerId={provider} logo={currentProvider?.logo} alt={currentProvider?.displayName || provider} className="shrink-0" size={28} />
            </Card.Header>

            <Form onSubmit={handleSaveCurrentProvider}>
              <Card.Content>
                <Fieldset className="w-full">
                  <Fieldset.Group className="grid gap-4">
                    <Select
                      selectedKey={provider || null}
                      onSelectionChange={(key) => {
                        if (key != null) void handleSelectProvider(String(key))
                      }}
                      placeholder="请选择服务商"
                      variant="secondary"
                      fullWidth
                    >
                      <Label>服务商</Label>
                      <Select.Trigger>
                        <Select.Value>
                          {({ defaultChildren, isPlaceholder }) =>
                            isPlaceholder || !currentProvider ? defaultChildren : <ProviderOptionContent providerInfo={currentProvider} />
                          }
                        </Select.Value>
                        <Select.Indicator />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox className={AI_DROPDOWN_LIST_CLASS}>
                          {providerOptions.map(option => (
                            <ListBox.Item key={option.value} id={option.value} textValue={`${option.label} ${option.value} ${option.description || ''}`} isDisabled={option.disabled} className="shrink-0">
                              {option.content ?? option.label}
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Select.Popover>
                    </Select>

                  <div className="grid gap-4 lg:grid-cols-2">
                    {currentProvider?.allowCustomBaseURL && (
                      <TextField fullWidth value={baseURL} onChange={setBaseURL}>
                        <Label>服务地址</Label>
                        <InputGroup variant="secondary" fullWidth>
                          <InputGroup.Input placeholder={provider === 'ollama' ? 'http://localhost:11434/v1' : 'https://api.example.com/v1'} />
                          <InputGroup.Suffix>
                            <Tooltip delay={0}>
                              <Button
                                type="button"
                                variant="tertiary"
                                size="sm"
                                isIconOnly
                                onPress={provider === 'ollama' ? openOllamaGuide : openCustomGuide}
                                aria-label="查看接入指南"
                              >
                                <CircleQuestion width={18} height={18} />
                              </Button>
                              <Tooltip.Content>查看接入指南</Tooltip.Content>
                            </Tooltip>
                          </InputGroup.Suffix>
                        </InputGroup>
                      </TextField>
                    )}

                    {!!currentProvider?.protocolOptions?.length && (
                      <Select
                        selectedKey={customProtocol}
                        onSelectionChange={(key) => {
                          if (key != null) setCustomProtocol(key as AiProviderProtocol)
                        }}
                        placeholder="请选择协议"
                        variant="secondary"
                        fullWidth
                      >
                        <Label>协议</Label>
                        <Select.Trigger>
                          <Select.Value>{({ defaultChildren }) => currentProtocolOption?.label ?? defaultChildren}</Select.Value>
                          <Select.Indicator />
                        </Select.Trigger>
                        <Select.Popover>
                          <ListBox>
                            {protocolOptions.map(option => (
                              <ListBox.Item key={option.value} id={option.value} textValue={option.label} className="shrink-0">
                                {option.label}
                                <ListBox.ItemIndicator />
                              </ListBox.Item>
                            ))}
                          </ListBox>
                        </Select.Popover>
                      </Select>
                    )}
                  </div>

                  {!isCodexSubscription && <TextField fullWidth value={apiKey} onChange={(value) => setField('aiApiKey', value)} type={showApiKey ? 'text' : 'password'}>
                    <Label>API 密钥</Label>
                    <InputGroup variant="secondary" fullWidth>
                      <InputGroup.Input
                        type={showApiKey ? 'text' : 'password'}
                        placeholder={provider === 'ollama' ? '本地服务无需密钥（可选）' : '请输入 API 密钥'}
                      />
                      <InputGroup.Suffix>
                        <Tooltip delay={0}>
                          <Button
                            type="button"
                            variant="tertiary"
                            size="sm"
                            isIconOnly
                            onPress={() => setShowApiKey(!showApiKey)}
                            aria-label={showApiKey ? '隐藏 API 密钥' : '显示 API 密钥'}
                          >
                            {showApiKey ? <EyeSlash width={18} height={18} /> : <Eye width={18} height={18} />}
                          </Button>
                          <Tooltip.Content>{showApiKey ? '隐藏 API 密钥' : '显示 API 密钥'}</Tooltip.Content>
                        </Tooltip>
                      </InputGroup.Suffix>
                    </InputGroup>
                  </TextField>}

                  <div className="space-y-2">
                    <div className="flex min-w-0 items-end gap-2">
                      <ComboBox
                        allowsCustomValue
                        selectedKey={currentModelSelectedKey}
                        inputValue={model}
                        onInputChange={(value) => setField('aiModel', normalizeProviderModel(provider, value))}
                        onSelectionChange={(key) => {
                          if (key != null) setField('aiModel', normalizeProviderModel(provider, String(key)))
                        }}
                        menuTrigger="focus"
                        variant="secondary"
                        fullWidth
                        className="min-w-0 flex-1"
                      >
                        <Label>模型</Label>
                        <ComboBox.InputGroup>
                          <Input placeholder="请选择或输入模型名称" variant="secondary" />
                          <ComboBox.Trigger />
                        </ComboBox.InputGroup>
                        <ComboBox.Popover>
                          <ListBox className={AI_DROPDOWN_LIST_CLASS}>
                            {modelOptions.map(option => (
                              <ListBox.Item key={option.value} id={option.value} textValue={option.label} isDisabled={option.disabled} className="shrink-0">
                                {option.content ?? option.label}
                                <ListBox.ItemIndicator />
                              </ListBox.Item>
                            ))}
                          </ListBox>
                        </ComboBox.Popover>
                      </ComboBox>
                      <Tooltip delay={0}>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          isIconOnly
                          onPress={handleRefreshModels}
                          isDisabled={isLoadingModels || !canFetchModels}
                          aria-label="刷新模型列表"
                        >
                          {isLoadingModels ? <Spinner size="sm" /> : <ArrowsRotateLeft width={16} height={16} />}
                        </Button>
                        <Tooltip.Content>刷新模型列表</Tooltip.Content>
                      </Tooltip>
                    </div>
                    {currentModelDetail && <Description><ModelCapabilityStrip modelDetail={currentModelDetail} /></Description>}
                    {modelListError ? (
                      <Alert status="danger">
                        <Alert.Content>
                          <Alert.Title>模型列表刷新失败</Alert.Title>
                          <Alert.Description>{modelListError}</Alert.Description>
                        </Alert.Content>
                      </Alert>
                    ) : (
                      <Description>{remoteModels.length > 0 ? '远程模型列表' : '在线模型列表'}</Description>
                    )}
                  </div>
                  </Fieldset.Group>
                </Fieldset>
              </Card.Content>

              <Card.Footer className="justify-end gap-3">
                <Button type="button" variant="outline" size="sm" onPress={handleTestConnection} isDisabled={isTesting}>
                  {isTesting ? <Spinner size="sm" /> : <Sparkles width={16} height={16} />}
                  {isTesting ? '测试中...' : '测试连接'}
                </Button>
                <Button type="submit" variant="primary" size="sm">
                  保存当前服务商
                </Button>
              </Card.Footer>
            </Form>
          </Card>

          <aside className="space-y-4">
            <Card>
              <Card.Header className="flex-row items-center gap-3">
                <AIProviderLogo providerId={provider} logo={currentProvider?.logo} alt={currentProvider?.displayName || provider} className="shrink-0" size={34} />
                <div className="min-w-0">
                  <Card.Title className="truncate text-base">{currentProvider?.displayName || provider || '未选择'}</Card.Title>
                  <Card.Description className="truncate">{currentProvider?.description || 'OpenAI 兼容接口'}</Card.Description>
                </div>
              </Card.Header>

              <Card.Content>
              <dl className="space-y-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted">协议</dt>
                  <dd className="min-w-0">
                    <Chip size="sm" variant="soft" color="accent" className="max-w-full">
                      <Chip.Label className="truncate">{formatProtocolLabel(currentProtocol)}</Chip.Label>
                    </Chip>
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted">模型</dt>
                  <dd className="truncate font-medium text-foreground">{model || '未选择'}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted">认证</dt>
                  <dd className="truncate font-medium text-foreground">{isCodexSubscription ? 'ChatGPT 登录' : maskSecret(apiKey)}</dd>
                </div>
                <div className="flex items-start justify-between gap-3">
                  <dt className="shrink-0 text-muted">地址</dt>
                  <dd className="min-w-0 truncate text-right font-medium text-foreground">{currentBaseURLLabel}</dd>
                </div>
              </dl>
              </Card.Content>
            </Card>

            <Alert status="default">
              <Alert.Content>
                <Alert.Title>本地保存</Alert.Title>
                <Alert.Description>{isCodexSubscription ? 'ChatGPT 登录凭据仅保存在密语的数据目录中，不会读取或修改电脑上的 Codex 登录。' : 'API 密钥仅保存在本地。连接测试与模型刷新会向当前服务商发起请求。'}</Alert.Description>
              </Alert.Content>
            </Alert>
          </aside>
        </div>
        {configMode === 'vector' && <EmbeddingTab />}
        {configMode === 'rerank' && <RerankTab />}
        {configMode === 'tts' && <TtsTab />}
        {configMode === 'imageGen' && <ImageGenTab />}
        {configMode === 'localAgent' && <LocalCodingAgentSettings showMessage={showMessage} />}
      </div>

      {settingsPagePortalHost && createPortal(
        <Drawer state={presetDrawerState}>
          {showPresetDrawer && (
            <div className="absolute inset-0 z-160 overflow-hidden">
              <button
                aria-label="关闭预设管理"
                className="absolute inset-0 bg-backdrop/40 backdrop-blur-sm"
                onClick={() => setShowPresetDrawer(false)}
                type="button"
              />
              <div className="absolute inset-y-0 right-0 flex w-full justify-end">
                <Drawer.Dialog aria-label="配置预设管理" className="relative h-full w-full max-w-md rounded-l-lg border border-border/70 bg-overlay p-0 shadow-overlay">
                  <Drawer.Header className="border-border/60 border-b px-5 py-4">
                    <Drawer.Heading className="text-base font-semibold text-foreground">配置预设管理</Drawer.Heading>
                    <CloseButton aria-label="关闭预设管理" className="absolute right-4 top-4" onPress={() => setShowPresetDrawer(false)} />
                  </Drawer.Header>
                  <Drawer.Body className="p-5">
                    {presets.length === 0 ? (
                      <div className="flex flex-col items-center justify-center gap-1 py-16 text-center">
                        <Typography.Paragraph size="sm">暂无配置预设</Typography.Paragraph>
                        <Typography.Paragraph size="xs" color="muted">保存当前服务商配置后可快速切换。</Typography.Paragraph>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {presets.map(preset => {
                          const presetProviderInfo = providers.find(item => item.id === normalizeProviderId(preset.provider))
                          return (
                          <Card key={preset.id} variant="secondary" className="flex flex-col items-stretch gap-3 px-4 py-3 text-left">
                            <div className="flex min-w-0 items-start gap-3">
                              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-surface">
                                <AIProviderLogo
                                  providerId={preset.provider}
                                  logo={presetProviderInfo?.logo}
                                  alt={presetProviderInfo?.displayName || preset.provider}
                                  className="shrink-0"
                                  size={22}
                                />
                              </div>
                              <div className="min-w-0 flex-1 space-y-1">
                                <Typography.Paragraph size="sm" weight="medium" className="truncate text-left">{preset.name}</Typography.Paragraph>
                                <div className="grid gap-x-3 gap-y-1 text-left text-xs text-muted sm:grid-cols-[72px_minmax(0,1fr)]">
                                  <span className="text-muted-foreground">服务商</span>
                                  <span className="min-w-0 truncate text-foreground">{presetProviderInfo?.displayName || preset.provider}</span>
                                  <span className="text-muted-foreground">模型</span>
                                  <span className="min-w-0 truncate font-medium text-foreground">{preset.model || '未填写'}</span>
                                  <span className="text-muted-foreground">协议</span>
                                  <span className="min-w-0 truncate">{formatProtocolLabel(preset.protocol)}</span>
                                  {preset.baseURL && (
                                    <>
                                      <span className="text-muted-foreground">地址</span>
                                      <span className="min-w-0 truncate">{preset.baseURL}</span>
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>
                            <div className="flex flex-wrap items-center justify-end gap-1.5 border-border/50 border-t pt-3">
                              <Button
                                type="button"
                                variant="primary"
                                size="sm"
                                onPress={() => { void handleLoadPreset(preset.id); setShowPresetDrawer(false) }}
                              >
                                <CircleCheck width={15} height={15} />
                                加载
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onPress={() => handleEditPreset(preset)}
                              >
                                <Pencil width={15} height={15} />
                                编辑
                              </Button>
                              <Button
                                type="button"
                                variant="danger-soft"
                                size="sm"
                                onPress={() => void handleDeletePreset(preset.id)}
                              >
                                <TrashBin width={15} height={15} />
                                删除
                              </Button>
                            </div>
                          </Card>
                          )
                        })}
                      </div>
                    )}
                  </Drawer.Body>
                </Drawer.Dialog>
              </div>
            </div>
          )}
        </Drawer>,
        settingsPagePortalHost
      )}

      {showOllamaHelp && (
        <GuideModal title="Ollama 本地 AI 使用指南" html={ollamaGuideContent} onClose={() => setShowOllamaHelp(false)} />
      )}

      {showCustomHelp && (
        <GuideModal title="自定义 AI 服务使用指南" html={customGuideContent} onClose={() => setShowCustomHelp(false)} />
      )}

      {showSavePresetDialog && (
        <Modal state={savePresetModalState}>
          <Modal.Backdrop variant="blur">
            <Modal.Container size="lg" scroll="inside" placement="center">
              <Modal.Dialog className="relative max-w-190">
                <CloseButton
                  aria-label="关闭预设编辑"
                  className="absolute right-5 top-5 z-10"
                  onPress={() => setShowSavePresetDialog(false)}
                />
                <Modal.Header className="items-center text-center">
                  <Modal.Heading className="text-base font-semibold text-foreground">{editingPresetId ? '编辑配置预设' : '新增配置预设'}</Modal.Heading>
                </Modal.Header>

                <Modal.Body>
                  <Tabs selectedKey={presetTab} onSelectionChange={handlePresetTabChange} className="w-full">
                    <Tabs.ListContainer>
                      <Tabs.List aria-label="预设配置步骤" className="w-full *:flex-1">
                        <Tabs.Tab id="name">名称<Tabs.Indicator /></Tabs.Tab>
                        <Tabs.Tab id="provider">服务商<Tabs.Indicator /></Tabs.Tab>
                        <Tabs.Tab id="config">接入配置<Tabs.Indicator /></Tabs.Tab>
                      </Tabs.List>
                    </Tabs.ListContainer>

                    <Tabs.Panel id="name" className="pt-4">
                      <TextField
                        fullWidth
                        value={presetName}
                        onChange={setPresetName}
                        isInvalid={!presetName.trim() && presetTab !== 'name'}
                      >
                        <Label>配置名称</Label>
                        <Input placeholder="例如：OpenAI 主力配置" variant="secondary" />
                        <Description>用于在预设管理中快速识别这组配置。</Description>
                        <FieldError>请输入配置名称</FieldError>
                      </TextField>
                    </Tabs.Panel>

                    <Tabs.Panel id="provider" className="pt-4">
                      <Select
                        selectedKey={presetDraft.provider || null}
                        onSelectionChange={(key) => {
                          if (key != null) setPresetDraft(createPresetDraftFromProvider(String(key)))
                        }}
                        placeholder="请选择服务商"
                        variant="secondary"
                        fullWidth
                      >
                        <Label>服务商</Label>
                        <Select.Trigger>
                          <Select.Value>
                            {({ defaultChildren, isPlaceholder }) =>
                              isPlaceholder || !presetDraftProvider ? defaultChildren : <ProviderOptionContent providerInfo={presetDraftProvider} />
                            }
                          </Select.Value>
                          <Select.Indicator />
                        </Select.Trigger>
                        <Select.Popover>
                          <ListBox className={AI_DROPDOWN_LIST_CLASS}>
                            {providerOptions.map(option => (
                              <ListBox.Item key={option.value} id={option.value} textValue={`${option.label} ${option.value} ${option.description || ''}`} isDisabled={option.disabled} className="shrink-0">
                                {option.content ?? option.label}
                                <ListBox.ItemIndicator />
                              </ListBox.Item>
                            ))}
                          </ListBox>
                        </Select.Popover>
                      </Select>
                    </Tabs.Panel>

                    <Tabs.Panel id="config" className="pt-4">
                      <Fieldset className="space-y-4">
                        <Fieldset.Group className="grid gap-4">
                          {!!presetDraftProvider?.protocolOptions?.length && (
                            <Select
                              selectedKey={presetDraft.protocol}
                              onSelectionChange={(key) => {
                                if (key != null) updatePresetDraft({ protocol: key as AiProviderProtocol })
                              }}
                              placeholder="请选择协议"
                              variant="secondary"
                              fullWidth
                            >
                              <Label>协议</Label>
                              <Select.Trigger>
                                <Select.Value>{({ defaultChildren }) => presetProtocolOption?.label ?? defaultChildren}</Select.Value>
                                <Select.Indicator />
                              </Select.Trigger>
                              <Select.Popover>
                                <ListBox>
                                  {presetDraftProtocolOptions.map(option => (
                                    <ListBox.Item key={option.value} id={option.value} textValue={option.label} className="shrink-0">
                                      {option.label}
                                      <ListBox.ItemIndicator />
                                    </ListBox.Item>
                                  ))}
                                </ListBox>
                              </Select.Popover>
                            </Select>
                          )}

                          {presetDraftProvider?.allowCustomBaseURL && (
                            <TextField fullWidth value={presetDraft.baseURL} onChange={(value) => updatePresetDraft({ baseURL: value })}>
                              <Label>服务地址</Label>
                              <Input
                                placeholder={presetDraft.provider === 'ollama' ? 'http://localhost:11434/v1' : 'https://api.example.com/v1'}
                                variant="secondary"
                              />
                            </TextField>
                          )}

                          {presetDraftProvider?.protocol !== 'codex-subscription' && <TextField fullWidth value={presetDraft.apiKey} onChange={(value) => updatePresetDraft({ apiKey: value })} type="password">
                            <Label>API 密钥</Label>
                            <Input
                              type="password"
                              placeholder={presetDraft.provider === 'ollama' ? '本地服务无需密钥（可选）' : '请输入 API 密钥'}
                              variant="secondary"
                            />
                          </TextField>}

                          <div className="space-y-2">
                            <div className="flex min-w-0 items-end gap-2">
                              <ComboBox
                                allowsCustomValue
                                selectedKey={presetModelSelectedKey}
                                inputValue={presetDraft.model}
                                onInputChange={(value) => updatePresetDraft({ model: normalizeProviderModel(presetDraft.provider, value) })}
                                onSelectionChange={(key) => {
                                  if (key != null) updatePresetDraft({ model: normalizeProviderModel(presetDraft.provider, String(key)) })
                                }}
                                menuTrigger="focus"
                                variant="secondary"
                                fullWidth
                                className="min-w-0 flex-1"
                              >
                                <Label>模型</Label>
                                <ComboBox.InputGroup>
                                  <Input placeholder="请选择或输入模型名称" variant="secondary" />
                                  <ComboBox.Trigger />
                                </ComboBox.InputGroup>
                                <ComboBox.Popover>
                                  <ListBox className={AI_DROPDOWN_LIST_CLASS}>
                                    {presetDraftModelOptions.map(option => (
                                      <ListBox.Item key={option.value} id={option.value} textValue={option.label} isDisabled={option.disabled} className="shrink-0">
                                        {option.content ?? option.label}
                                        <ListBox.ItemIndicator />
                                      </ListBox.Item>
                                    ))}
                                  </ListBox>
                                </ComboBox.Popover>
                              </ComboBox>
                              <Tooltip delay={0}>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  isIconOnly
                                  onPress={() => void loadPresetDraftModels()}
                                  isDisabled={isLoadingPresetModels || !canFetchProviderModelList(presetDraft.provider, presetDraft.baseURL, presetDraftProvider)}
                                  aria-label="刷新预设模型列表"
                                >
                                  {isLoadingPresetModels ? <Spinner size="sm" /> : <ArrowsRotateLeft width={16} height={16} />}
                                </Button>
                                <Tooltip.Content>刷新模型列表</Tooltip.Content>
                              </Tooltip>
                            </div>
                            {presetDraftCurrentModelDetail && <Description><ModelCapabilityStrip modelDetail={presetDraftCurrentModelDetail} /></Description>}
                            {presetModelListError ? (
                              <Alert status="danger">
                                <Alert.Content>
                                  <Alert.Title>模型列表刷新失败</Alert.Title>
                                  <Alert.Description>{presetModelListError}</Alert.Description>
                                </Alert.Content>
                              </Alert>
                            ) : (
                              <Description>{presetRemoteModels.length > 0 ? '远程模型列表' : '在线模型列表'}</Description>
                            )}
                          </div>
                        </Fieldset.Group>
                      </Fieldset>
                    </Tabs.Panel>
                  </Tabs>
                </Modal.Body>

                <Modal.Footer className="justify-end">
                  <Button type="button" variant="outline" size="sm" onPress={() => setShowSavePresetDialog(false)}>取消</Button>
                  {presetTab !== 'name' && (
                    <Button type="button" variant="outline" size="sm" onPress={handlePresetPrevStep}>上一步</Button>
                  )}
                  {presetTab !== 'config' ? (
                    <Button type="button" variant="primary" size="sm" onPress={handlePresetNextStep}>下一步</Button>
                  ) : (
                    <Button type="button" variant="primary" size="sm" onPress={handleSavePreset}>保存预设</Button>
                  )}
                </Modal.Footer>
              </Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal>
      )}
    </div>
  )
}

export default AISummarySettings
