/**
 * AI Agent 对话页（Phase C）——使用 AI SDK 的 useChat + AI Elements 组件。
 * 数据：useChat 走 IpcChatTransport（IPC → AI 子进程 → 流式 UIMessageChunk）。
 * 提示词预设、记忆引导、@提及、消息渲染小组件等已拆到同目录下的多个文件，这里只保留主组件本身。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import { useChat } from '@ai-sdk/react'
import { isToolUIPart, lastAssistantMessageIsCompleteWithApprovalResponses, type ChatStatus, type UIMessage } from 'ai'
import { AlertDialog, Button as HeroButton, ButtonGroup, Dropdown, Header, Label, Modal, SearchField, Separator, Spinner, Surface, Switch, Toolbar, Tooltip, toast } from '@heroui/react'
import { ArrowDownToLine, ArrowsRotateLeft, ArrowUpRightFromSquare, Bulb, Check, ChevronDown, CircleInfo, Clock, Code, Display, FileText, LayoutSideContentLeft, ListCheck, MagicWand, PencilToLine, PencilToSquare, Terminal, TrashBin, Xmark } from '@gravity-ui/icons'
import { toPng } from 'dom-to-image-more'
import {
  Conversation,
  ConversationAutoScroll,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { Message, MessageContent } from '@/components/ai-elements/message'
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputController,
  type PromptInputMessage,
  type PromptInputControllerProps,
} from '@/components/ai-elements/prompt-input'
import { ImagePreview, type ImagePreviewOriginRect } from '@/components/ImagePreview'
import AIProviderLogo from '@/components/ai/AIProviderLogo'
import { getAIProviders, type AIModelInfo, type AIProviderInfo } from '@/types/ai'
import { Loader } from '@/components/ai-elements/loader'
import { IpcChatTransport, type AgentModelConfig, type AgentProgressEvent, type AgentReasoningEffort, type AgentScope, type AgentToolProfile, type CodeWorkspaceRef } from '@/features/aiagent/transport/ipcChatTransport'
import { CODE_WORKSPACE_FILE_REF_MIME, CodeWorkspacePanel, CodeWorkspacePanelPopover, CodeWorkspaceSidebar, type CodeWorkspaceFileDragReference, type CodeWorkspacePanelTab } from './CodeWorkspacePanel'
import { AgentApprovalBar, type ToolApprovalBarItem } from './AgentApprovalBar'
import * as configService from '@/services/config'
import { useTtsSpeaker } from '@/lib/ttsPlayer'
import type {
  AgentConversationUpdatedEvent,
  AgentToolApprovalPolicy,
  CodeWorkspaceApprovalPolicy,
  CodeWorkspaceApprovalRequest,
  CodeWorkspaceEvent,
  CodeWorkspaceState,
  LocalCodingAgentConfig,
  LocalCodingAgentEvent,
} from '@/types/electron'
import { AgentReasoningEffortControl } from './AgentReasoningEffortControl'
import {
  AgentPromptPrimaryAction,
  AgentToolApprovalPolicyDropdown,
  PromptInputControllerBridge,
  PromptPresetButton,
  SlashCommandButton,
  type SlashCommandItem,
} from './AgentPromptToolbar'
import { AgentMemoryIntro, type AgentMemoryIntroStatus } from './AgentMemoryIntro'
import {
  AgentPromptAssetHeader,
  MENTION_SESSION_PAGE_SIZE,
  MentionField,
  MentionTriggerButton,
  buildWorkspaceFilePrefix,
  displayBasename,
  hasWorkspaceFileDrag,
  parseWorkspaceFileDragPayload,
  toMentionTarget,
  type MentionTarget,
} from './AgentMentions'
import { describeToolApprovalRequest, extractSources, getPersonaControlOutput, toolProgressKey } from './agentMessageHelpers'
import { createLiquidGlassMap, type GlassFilterMap } from '@/utils/liquidGlass'
import { LottieView, type DotLottie } from '@/components/LottieView'
import welcomeLottieUrl from '@/assets/lottie/Welcome.lottie?url'
import {
  buildFallbackConversationTitle,
  finiteNumber,
  modelConfigId,
  modelConfigProvider,
  normalizeConversationRecord,
  normalizeLoadedConversation,
  NEW_AGENT_CONVERSATION_MARKER,
  parseAgentMessageMetadata,
  prepareAgentMessagesForPersist,
  presetMatchesCurrentConfig,
  readStoredActiveAgentConversation,
  readToolElapsedFromMessage,
  resolveDefaultPresetId,
  signatureAgentMessages,
  storeActiveAgentConversation,
  STREAMING_AGENT_SAVE_INTERVAL_MS,
  type AgentConversationLoaded,
  type AgentConversationRecord,
  type AgentMessageMetadata,
} from './agentConversationHelpers'
import { formatTokenCount } from './AgentUsageStats'
import { AgentShareCard, buildAgentSharePreviewData, formatAgentShareFileDate, sanitizeAgentShareFileName, type AgentSharePreviewData } from './AgentShareCard'
import { AGENT_PENDING_TITLE, ModelWaitingLine, SubAgentProgressPanel, mergeSubAgentProgress, shouldDisplayAgentProgress } from './AgentSubAgentProgress'
import { ModelCapabilityIcons, ModelItem, type AgentModelItem } from './AgentMessageBlocks'
import { AgentMessageItem } from './AgentMessageItem'
import { AgentCanvasPanel } from './canvas/AgentCanvasPanel'
import { useAgentCanvas } from './canvas/useAgentCanvas'
import type { AgentCanvasKind, AgentCanvasListItem, AgentCanvasRefData } from './canvas/agentCanvasTypes'
import { AgentRecordsMenu } from './AgentRecordsMenu'
import { buildPromptOptimizeContext, type PromptOptimizeContextMessage } from './promptOptimizeContext'
import {
  normalizeLocalCodingAgentConfig,
} from '@/lib/localCodingAgent'

// 没有图片/文件附件时给输入框更高的最小高度，避免空状态输入框过矮。
function AgentPromptTextarea({ workspaceReferenceCount }: { workspaceReferenceCount: number }) {
  const { attachments } = usePromptInputController()
  const hasAssets = attachments.files.length > 0 || workspaceReferenceCount > 0
  return (
    <PromptInputTextarea
      className={hasAssets ? 'min-h-10 max-h-40 py-2 text-sm leading-5' : 'min-h-14 max-h-40 py-2 text-sm leading-5'}
      placeholder="问问你的聊天记录，Enter 发送，Shift + Enter 换行…"
    />
  )
}

// 提示词优化按钮：挂在输入框（InputGroup）右上角，把当前草稿交给模型润色后回填；空输入或优化中不可点。
function AgentPromptOptimizeButton({ optimizing, onOptimize }: { optimizing: boolean; onOptimize: () => void }) {
  const { textInput } = usePromptInputController()
  const disabled = optimizing || !textInput.value.trim()
  return (
    <div className="absolute top-1.5 right-1.5 z-10">
      <Tooltip delay={0}>
        <HeroButton
          aria-label={optimizing ? '正在优化提示词' : '优化提示词'}
          className="agent-prompt-optimize-button size-7 p-0 text-muted-foreground"
          isDisabled={disabled}
          isIconOnly
          onPress={onOptimize}
          size="sm"
          variant="tertiary"
        >
          {optimizing ? <Spinner size="sm" /> : <MagicWand className="size-4" />}
        </HeroButton>
        <Tooltip.Content placement="top">{optimizing ? '正在优化提示词…' : 'AI 优化提示词'}</Tooltip.Content>
      </Tooltip>
    </div>
  )
}

// 滚动到底部按钮的液态玻璃折射滤镜：圆形按钮 36px，复用朋友圈图标的位移贴图参数。
// 贴图生成完成后 onReady 触发 .agent-glass-ready，CSS 再叠加 url(#agent-glass-36) 折射。
const AGENT_SCROLL_GLASS_SIZE = 36
const GLASS_CIRCLE = { halfX: 0.18, halfY: 0.18, radius: 0.18, edge: 0.02, feather: 0.35, strength: 3 }

function AgentGlassDefs({ onReady }: { onReady: () => void }) {
  const [map, setMap] = useState<GlassFilterMap | null>(null)
  useEffect(() => {
    const m = createLiquidGlassMap(AGENT_SCROLL_GLASS_SIZE, AGENT_SCROLL_GLASS_SIZE, GLASS_CIRCLE)
    if (m) {
      setMap(m)
      onReady()
    }
  }, [onReady])
  if (!map) return null
  return (
    <svg className="agent-glass-defs" aria-hidden="true" focusable="false">
      <filter
        id="agent-glass-36"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
        width={map.width}
        height={map.height}
        x="0"
        y="0"
      >
        <feImage href={map.href} xlinkHref={map.href} width={map.width} height={map.height} result="displacementMap" />
        <feDisplacementMap in="SourceGraphic" in2="displacementMap" scale={map.scale} xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  )
}

function createAgentTextMessage(role: 'user' | 'assistant', text: string, id = `${role}-${Date.now()}-${Math.random().toString(36).slice(2)}`): UIMessage {
  return {
    id,
    role,
    parts: [{ type: 'text', text }],
  } as UIMessage
}

function normalizeLocalAgentText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trimEnd()
}

function shouldShowLocalAgentStdout(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) return false
  return true
}

// 把本地智能体的 activity 事件转成密语标准的消息 part：思考→reasoning，工具/命令→tool-*。
// 这样就直接复用 buildRenderSegments/renderChainSegment 的折叠“执行过程”卡片，不必另写组件。
function buildLocalAgentActivityPart(
  event: Extract<LocalCodingAgentEvent, { type: 'activity' }>,
  seq: number,
): UIMessage['parts'][number] {
  if (event.activity === 'reasoning') {
    return { type: 'reasoning', text: event.text || '' } as UIMessage['parts'][number]
  }
  return {
    type: `tool-${event.toolName || 'tool'}`,
    toolCallId: `${event.jobId}-${seq}`,
    state: 'output-available',
    input: event.input,
    output: event.output,
  } as unknown as UIMessage['parts'][number]
}

function replaceMessageText(messages: UIMessage[], messageId: string, text: string): UIMessage[] {
  return messages.map((message) => {
    if (message.id !== messageId) return message
    return {
      ...message,
      parts: [{ type: 'text', text }],
    } as UIMessage
  })
}

type LocalAgentPatchRequest = {
  agentId: string
  assistantMessageId: string
  changedPaths: string[]
  jobId: string
  patch: string
  scope: AgentScope
  targetConversationId: number | null
}

type LocalAgentRunState = {
  agentId: string
  assistantMessageId: string
  jobId: string
  // 折叠链里的思考/工具卡片按到达顺序累积；最终回复正文单独放 finalText，重建时拼到 activityParts 之后。
  activityParts: UIMessage['parts']
  finalText: string
  scope: AgentScope
  targetConversationId: number | null
}

const LOCAL_AGENT_MODEL_ID_PREFIX = 'local-agent:'

function localAgentIdFromModelId(modelId: string): string | null {
  return modelId.startsWith(LOCAL_AGENT_MODEL_ID_PREFIX)
    ? modelId.slice(LOCAL_AGENT_MODEL_ID_PREFIX.length)
    : null
}

function localAgentModelId(agentId: string): string {
  return `${LOCAL_AGENT_MODEL_ID_PREFIX}${agentId}`
}

// 自定义服务商 /models 端点只回模型 id 时的兜底详情：能力元数据未知，按支持工具对待（否则会被整列禁用）
function toBasicModelDetail(id: string, providerId: string): AIModelInfo {
  return {
    id,
    name: id,
    providerId,
    modalities: { input: ['text'], output: ['text'] },
    capabilities: { attachment: false, reasoning: false, toolCall: true, structuredOutput: false, temperature: true, openWeights: false },
    limits: {},
  }
}

export default function AgentPage() {
  const [presets, setPresets] = useState<configService.AiConfigPreset[]>([])
  const [providersInfo, setProvidersInfo] = useState<AIProviderInfo[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState('current')
  const [reasoningEffort, setReasoningEffort] = useState<AgentReasoningEffort>('high')
  // 模型覆盖：在当前提供商（预设）下临时换用另一个模型；null = 用预设自带的模型
  const [modelOverride, setModelOverride] = useState<string | null>(null)
  // 各提供商条目实际拉到的模型列表（ai.listModels）：models.dev 没收录的自定义服务商悬停时按需拉取，刷新按钮强制重拉
  const [presetModels, setPresetModels] = useState<Record<string, AIModelInfo[]>>({})
  const [presetModelsLoading, setPresetModelsLoading] = useState<Record<string, boolean>>({})
  const presetModelsInFlightRef = useRef(new Set<string>())
  const [generatedImagePreview, setGeneratedImagePreview] = useState<{ src: string; originRect?: ImagePreviewOriginRect } | null>(null)
  // 滚动到底部按钮液态玻璃：位移贴图就绪后给根容器加 .agent-glass-ready
  const [agentGlassReady, setAgentGlassReady] = useState(false)
  const handleAgentGlassReady = useCallback(() => setAgentGlassReady(true), [])
  // 计划模式：开启后本轮只出执行计划、不下结论，等用户点"开始执行"再跑（参考 ClaudeCode/Codex）
  const [planMode, setPlanMode] = useState(false)
  const planModeRef = useRef(planMode)
  planModeRef.current = planMode
  // 标记当前在途的这次运行是否为计划模式（finish 前 metadata 还没回来，流式期间靠它判定计划卡片）
  const runIsPlanRef = useRef(false)
  const [agentToolApprovalPolicy, setAgentToolApprovalPolicy] = useState<AgentToolApprovalPolicy>('on-request')
  useEffect(() => {
    void window.electronAPI.config.get('agentToolApprovalPolicy').then((value) => {
      if (value === 'risk-based' || value === 'full-access') setAgentToolApprovalPolicy(value)
    })
  }, [])
  const [codeWorkspaceState, setCodeWorkspaceState] = useState<CodeWorkspaceState | null>(null)
  const [codeWorkspaceApproval, setCodeWorkspaceApproval] = useState<CodeWorkspaceApprovalRequest | null>(null)
  const [codeWorkspaceApprovalExpanded, setCodeWorkspaceApprovalExpanded] = useState(false)
  const [workspaceSidebarOpen, setWorkspaceSidebarOpen] = useState(false)
  const [codeWorkspacePanelOpen, setCodeWorkspacePanelOpen] = useState(false)
  const [codeWorkspacePanelTab, setCodeWorkspacePanelTab] = useState<CodeWorkspacePanelTab>('preview')
  const [codeWorkspaceLogs, setCodeWorkspaceLogs] = useState<string[]>([])
  const codeWorkspaceRef = useRef<CodeWorkspaceRef | null>(null)
  codeWorkspaceRef.current = codeWorkspaceState?.workspace ?? null
  const handleSelectCodeWorkspace = useCallback(async () => {
    const result = await window.electronAPI.agentWorkspace.selectWorkspace()
    if (result.success && result.state) {
      setCodeWorkspaceState(result.state)
      setCodeWorkspaceLogs(result.state.recentLogs || [])
      setAgentNotice('')
    } else if (!result.canceled) {
      setAgentNotice(`代码工作区选择失败：${result.error || '未知错误'}`)
    }
  }, [])
  const handleCodeWorkspaceApprovalPolicyChange = useCallback(async (policy: CodeWorkspaceApprovalPolicy) => {
    const result = await window.electronAPI.agentWorkspace.setApprovalPolicy(policy)
    if (result.success && result.state) {
      setCodeWorkspaceState(result.state)
      setCodeWorkspaceLogs(result.state.recentLogs || [])
      setAgentNotice('')
    } else {
      setAgentNotice(`代码权限设置失败：${result.error || '未知错误'}`)
    }
  }, [])
  // 输入框上只留一个审批策略下拉：AI SDK 工具审批和代码工作区审批风险模型不同，但用户只想调一个开关，
  // 所以改一个值同时写两边配置（各自的风险判定逻辑仍分开，见 toolApproval.ts / codeWorkspaceService.ts）。
  const handleAgentToolApprovalPolicyChange = useCallback((policy: AgentToolApprovalPolicy) => {
    setAgentToolApprovalPolicy(policy)
    void window.electronAPI.config.set('agentToolApprovalPolicy', policy)
    void handleCodeWorkspaceApprovalPolicyChange(policy)
  }, [handleCodeWorkspaceApprovalPolicyChange])
  const handleApproveCodeWorkspace = useCallback((requestId: string) => {
    setCodeWorkspaceApproval(null)
    void window.electronAPI.agentWorkspace.approve(requestId)
  }, [])
  const handleRejectCodeWorkspace = useCallback((requestId: string) => {
    setCodeWorkspaceApproval(null)
    void window.electronAPI.agentWorkspace.reject(requestId)
  }, [])
  const handleStopCodeDevServer = useCallback(async () => {
    const result = await window.electronAPI.agentWorkspace.stopDevServer()
    if (result.success && result.state) {
      setCodeWorkspaceState(result.state)
      setCodeWorkspaceLogs(result.state.recentLogs || [])
    } else if (!result.success) {
      setAgentNotice(`停止开发服务器失败：${result.error || '未知错误'}`)
    }
  }, [])
  useEffect(() => {
    let cancelled = false
    void window.electronAPI.agentWorkspace.getState().then((result) => {
      if (cancelled || !result.success || !result.state) return
      setCodeWorkspaceState(result.state)
      setCodeWorkspaceLogs(result.state.recentLogs || [])
    })
    const offApproval = window.electronAPI.agentWorkspace.onApprovalRequest((request) => {
      setCodeWorkspaceApproval(request)
      setCodeWorkspaceApprovalExpanded(false)
    })
    const offEvent = window.electronAPI.agentWorkspace.onWorkspaceEvent((event: CodeWorkspaceEvent) => {
      if (event.state) {
        setCodeWorkspaceState(event.state)
        setCodeWorkspaceLogs(event.state.recentLogs || [])
      }
      if (event.log) {
        setCodeWorkspaceLogs((prev) => [...prev, event.log!].slice(-600))
      }
      if (event.type === 'preview-url') {
        setCodeWorkspacePanelTab('preview')
      }
      if (event.type === 'approval-resolved' && event.requestId) {
        setCodeWorkspaceApproval((current) => current?.requestId === event.requestId ? null : current)
      }
    })
    return () => {
      cancelled = true
      offApproval()
      offEvent()
    }
  }, [])
  const [currentProviderId, setCurrentProviderId] = useState('')
  const [currentModelId, setCurrentModelId] = useState('')
  const [currentProviderConfig, setCurrentProviderConfig] = useState<configService.AiProviderConfig | null>(null)
  const [toolElapsedByKey, setToolElapsedByKey] = useState<Record<string, number>>({})
  const [agentProgress, setAgentProgress] = useState<AgentProgressEvent[]>([])
  const [agentRunPending, setAgentRunPending] = useState(false)
  const [subAgentProgress, setSubAgentProgress] = useState<AgentProgressEvent[]>([])
  const toolElapsedByKeyRef = useRef(toolElapsedByKey)
  toolElapsedByKeyRef.current = toolElapsedByKey
  const subAgentProgressRef = useRef(subAgentProgress)
  subAgentProgressRef.current = subAgentProgress
  const [agentNotice, setAgentNotice] = useState('')
  const [localAgentConfig, setLocalAgentConfig] = useState<LocalCodingAgentConfig | null>(null)
  const [localAgentRunning, setLocalAgentRunning] = useState(false)
  const [localAgentPatchRequest, setLocalAgentPatchRequest] = useState<LocalAgentPatchRequest | null>(null)
  const [localAgentPatchApplying, setLocalAgentPatchApplying] = useState(false)
  const localAgentRunRef = useRef<LocalAgentRunState | null>(null)
  const loadLocalAgentConfig = useCallback(async () => {
    const result = await window.electronAPI.localCodingAgent.getConfig()
    const nextConfig = normalizeLocalCodingAgentConfig(result.success ? result.config : null)
    setLocalAgentConfig(nextConfig)
    return nextConfig
  }, [])
  useEffect(() => {
    void loadLocalAgentConfig().catch(() => {
      setLocalAgentConfig(normalizeLocalCodingAgentConfig(null))
    })
  }, [loadLocalAgentConfig])
  const cancelLocalAgentRun = useCallback(async () => {
    const jobId = localAgentRunRef.current?.jobId
    localAgentRunRef.current = null
    setLocalAgentRunning(false)
    if (jobId) {
      await window.electronAPI.localCodingAgent.cancel(jobId).catch(() => ({ success: false }))
    }
  }, [])
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const { speakingKey: speakingMessageId, speak: speakMessage, stop: stopSpeakingMessage } = useTtsSpeaker()
  const promptInputControllerRef = useRef<PromptInputControllerProps | null>(null)
  const promptOptimizeContextRef = useRef<PromptOptimizeContextMessage[]>([])
  // 提示词优化：结合最近两轮完整问答消解指代，再把润色后的草稿原地回填
  const [promptOptimizing, setPromptOptimizing] = useState(false)
  const handleOptimizePrompt = useCallback(async () => {
    const controller = promptInputControllerRef.current
    const text = controller?.textInput.value.trim() ?? ''
    if (!controller || !text) return
    setPromptOptimizing(true)
    try {
      const result = await window.electronAPI.agent.optimizePrompt(
        text,
        selectedModelConfigRef.current,
        promptOptimizeContextRef.current,
      )
      const optimized = result.success ? (result.text?.trim() ?? '') : ''
      if (optimized) {
        controller.textInput.setInput(optimized)
      } else {
        toast.danger(`提示词优化失败：${result.error || '未知错误'}`, { timeout: 3000 })
      }
    } catch (error) {
      toast.danger(`提示词优化失败：${error instanceof Error ? error.message : String(error)}`, { timeout: 3000 })
    } finally {
      setPromptOptimizing(false)
    }
  }, [])
  // 跨窗口自动运行（聊天窗口「AI 摘要」）：待发送的提示词，等 @提及状态落地后由下方 effect 自动提交
  const [pendingAutoRun, setPendingAutoRun] = useState<string | null>(null)
  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.id === selectedPresetId) || null,
    [presets, selectedPresetId]
  )
  const modelInfoByKey = useMemo(() => {
    const map = new Map<string, AIModelInfo>()
    for (const provider of providersInfo) {
      for (const detail of provider.modelDetails || []) {
        map.set(`${provider.id}::${detail.id}`, detail)
        if (!map.has(detail.id)) map.set(detail.id, detail)
      }
    }
    return map
  }, [providersInfo])
  const models = useMemo<AgentModelItem[]>(() => {
    const localModels: AgentModelItem[] = localAgentConfig?.enabled
      ? Object.entries(localAgentConfig.agents).map(([agentId, agent]) => ({
          chef: '本地智能体',
          chefSlug: '',
          id: localAgentModelId(agentId),
          kind: 'local-agent',
          name: agent.name || agentId,
        }))
      : []
    const list = presets.map((preset) => ({
      chef: preset.provider || '其他',
      chefSlug: preset.provider || '',
      id: preset.id,
      name: preset.name,
      modelDetail: modelInfoByKey.get(`${preset.provider}::${preset.model}`) || modelInfoByKey.get(preset.model),
      disabled: (() => {
        const detail = modelInfoByKey.get(`${preset.provider}::${preset.model}`) || modelInfoByKey.get(preset.model)
        return detail ? !detail.capabilities.toolCall : false
      })(),
    }))
    if (presets.some((preset) => presetMatchesCurrentConfig(preset, currentProviderId, currentProviderConfig))) {
      return [...list, ...localModels]
    }
    if (!currentProviderId && !currentModelId) return [...list, ...localModels]
    const currentDetail = modelInfoByKey.get(`${currentProviderId}::${currentModelId}`) || modelInfoByKey.get(currentModelId)
    return [{
      chef: currentProviderId || 'custom',
      chefSlug: currentProviderId,
      id: 'current',
      name: currentModelId ? `当前配置 · ${currentModelId}` : '当前配置',
      modelDetail: currentDetail,
      disabled: currentDetail ? !currentDetail.capabilities.toolCall : false,
    }, ...list, ...localModels]
  }, [currentModelId, currentProviderConfig, currentProviderId, localAgentConfig, presets, modelInfoByKey])
  const chefs = useMemo(() => [...new Set(models.map((model) => model.chef))], [models])
  const selectedModelKeys = useMemo(() => new Set([selectedPresetId]), [selectedPresetId])
  const selectedModelData = models.find((model) => model.id === selectedPresetId)
  const selectedLocalAgentId = localAgentIdFromModelId(selectedPresetId)
  // 当前生效的提供商/模型（含覆盖）；模型详情优先取实拉列表（自定义服务商 catalog 里没有）
  const effectiveProviderId = selectedPreset?.provider || currentProviderId
  const effectiveModelId = modelOverride ?? (selectedPreset?.model || currentModelId)
  const effectiveModelDetail =
    presetModels[selectedPresetId]?.find((detail) => detail.id === effectiveModelId)
    || modelInfoByKey.get(`${effectiveProviderId}::${effectiveModelId}`)
    || modelInfoByKey.get(effectiveModelId)
  const selectedModelSupportsTools = selectedLocalAgentId
    ? true
    : effectiveModelDetail
      ? effectiveModelDetail.capabilities.toolCall
      : true
  useEffect(() => {
    const selected = models.find((model) => model.id === selectedPresetId)
    const fallback = models.find((model) => !model.disabled)
    if (!selected) {
      if (fallback) {
        setSelectedPresetId(fallback.id)
        setModelOverride(null)
      }
      return
    }
    // 预设默认模型不支持工具、但用户已手动换过模型时不强制切走
    if (selected.disabled && !modelOverride && fallback) {
      setSelectedPresetId(fallback.id)
      setModelOverride(null)
    }
  }, [models, selectedPresetId, modelOverride])
  const selectedModelConfig = useMemo<AgentModelConfig | null>(() => {
    if (!selectedPreset) {
      return modelOverride ? { model: modelOverride, reasoningEffort } : { reasoningEffort }
    }
    return {
      provider: selectedPreset.provider,
      apiKey: selectedPreset.apiKey,
      model: modelOverride || selectedPreset.model,
      baseURL: selectedPreset.baseURL,
      protocol: selectedPreset.protocol,
      reasoningEffort,
    }
  }, [selectedPreset, reasoningEffort, modelOverride])
  const selectedModelConfigRef = useRef<AgentModelConfig | null>(null)
  selectedModelConfigRef.current = selectedModelConfig

  // @ 提及：会话列表（选择源）+ 已选对象
  const [sessions, setSessions] = useState<MentionTarget[]>([])
  const [mentionHasMore, setMentionHasMore] = useState(true)
  const [mentionLoading, setMentionLoading] = useState(false)
  const [mentions, setMentions] = useState<MentionTarget[]>([])
  const [workspaceFileReferences, setWorkspaceFileReferences] = useState<CodeWorkspaceFileDragReference[]>([])
  const [workspaceFileDragOver, setWorkspaceFileDragOver] = useState(false)
  const [sourceNameById, setSourceNameById] = useState<Record<string, string>>({})
  const mentionOffsetRef = useRef(0)
  const mentionLoadingRef = useRef(false)
  const mentionHasMoreRef = useRef(true)
  const mentionConnectedRef = useRef(false)
  const mentionSeenRef = useRef(new Set<string>())
  const mentionSearchSeqRef = useRef(0)
  const addMention = useCallback(
    (m: MentionTarget) => setMentions((prev) => (prev.some((x) => x.username === m.username) ? prev : [...prev, m])),
    []
  )
  const removeMention = useCallback((m: MentionTarget) => {
    setMentions((prev) => prev.filter((item) => item.username !== m.username))
  }, [])
  const addWorkspaceFileReference = useCallback((ref: CodeWorkspaceFileDragReference) => {
    setWorkspaceFileReferences((prev) => (prev.some((item) => item.path === ref.path) ? prev : [...prev, ref]))
  }, [])
  const removeWorkspaceFileReference = useCallback((path: string) => {
    setWorkspaceFileReferences((prev) => prev.filter((item) => item.path !== path))
  }, [])
  useEffect(() => {
    setWorkspaceFileReferences([])
    setWorkspaceFileDragOver(false)
  }, [codeWorkspaceState?.workspace?.id])
  const handleWorkspaceFileDragOver = useCallback((event: DragEvent<HTMLFormElement>) => {
    if (!hasWorkspaceFileDrag(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setWorkspaceFileDragOver(true)
  }, [])
  const handleWorkspaceFileDragLeave = useCallback((event: DragEvent<HTMLFormElement>) => {
    if (!hasWorkspaceFileDrag(event.dataTransfer)) return
    const nextTarget = event.relatedTarget as Node | null
    if (nextTarget && event.currentTarget.contains(nextTarget)) return
    setWorkspaceFileDragOver(false)
  }, [])
  const handleWorkspaceFileDrop = useCallback((event: DragEvent<HTMLFormElement>) => {
    if (!hasWorkspaceFileDrag(event.dataTransfer)) return
    event.preventDefault()
    setWorkspaceFileDragOver(false)
    const ref = parseWorkspaceFileDragPayload(event.dataTransfer.getData(CODE_WORKSPACE_FILE_REF_MIME))
    if (ref) addWorkspaceFileReference(ref)
  }, [addWorkspaceFileReference])
  const processedPersonaActionsRef = useRef(new Set<string>())
  // 单个 @ → 锁定该会话 scope；多个/零个 → 全局（多个走消息注入，见 handleSubmit）
  const scopeRef = useRef<AgentScope>({ kind: 'global' })
  const submitScopeRef = useRef<AgentScope | null>(null)
  const activeScopeRef = useRef<AgentScope>({ kind: 'global' })
  scopeRef.current =
    mentions.length === 1
      ? { kind: 'session', sessionId: mentions[0].username, displayName: mentions[0].displayName }
      : { kind: 'global' }

  const handleAgentProgress = useCallback((progress: AgentProgressEvent) => {
    const displayProgress = shouldDisplayAgentProgress(progress)
    // 准备阶段的 run_started 步骤只进执行过程链，不推桌宠气泡。
    const petWorthy = progress.stage !== 'run_started'
    if ((progress.depth ?? 0) === 0 && petWorthy && (displayProgress || progress.stage === 'run_finished' || progress.stage === 'error')) {
      window.electronAPI.pet.sendAgentProgress({
        stage: progress.stage,
        title: progress.stage === 'run_finished' && !displayProgress ? 'AI 助手已完成' : progress.title,
        detail: progress.detail,
      })
    }
    if ((progress.depth ?? 0) > 0) {
      if (displayProgress) setSubAgentProgress((prev) => mergeSubAgentProgress(prev, progress))
    } else {
      if (displayProgress) {
        setAgentProgress((prev) => {
          const hasLocalPending = prev.some((item) => item.title === AGENT_PENDING_TITLE)
          return mergeSubAgentProgress(
            hasLocalPending ? prev.filter((item) => item.title !== AGENT_PENDING_TITLE) : prev,
            progress,
          )
        })
      }
      if (progress.stage === 'run_started') {
        setSubAgentProgress([])
      } else if (progress.stage === 'run_finished' || progress.stage === 'error') {
        setAgentRunPending(false)
      }
    }

    if (progress.stage === 'tool_finished' && progress.toolName && progress.elapsedMs != null) {
      setToolElapsedByKey((prev) => {
        const key = toolProgressKey(progress.toolName!, progress.toolCallId)
        if (prev[key] === progress.elapsedMs) return prev
        return {
          ...prev,
          [key]: progress.elapsedMs!,
        }
      })
    }
  }, [])

  const handleCopyAssistantMessage = useCallback(async (messageId: string, text: string) => {
    if (!text || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return
    await navigator.clipboard.writeText(text)
    setCopiedMessageId(messageId)
    window.setTimeout(() => {
      setCopiedMessageId((current) => current === messageId ? null : current)
    }, 1600)
  }, [])

  const handleCopyUserMessage = useCallback(async (messageId: string, text: string) => {
    if (!text || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return
    await navigator.clipboard.writeText(text)
    setCopiedMessageId(messageId)
    window.setTimeout(() => {
      setCopiedMessageId((current) => current === messageId ? null : current)
    }, 1600)
  }, [])

  const handleSpeakAssistantMessage = useCallback((messageId: string, text: string) => {
    if (!text) return
    void speakMessage(messageId, text)
  }, [speakMessage])

  useEffect(() => {
    return () => { stopSpeakingMessage() }
  }, [stopSpeakingMessage])
  const [conversationId, setConversationId] = useState<number | null>(null)
  const conversationIdRef = useRef(conversationId)
  conversationIdRef.current = conversationId
  const applyConversationId = useCallback((nextId: number | null) => {
    const normalized = nextId && nextId > 0 ? nextId : null
    setConversationId(normalized)
    conversationIdRef.current = normalized
    storeActiveAgentConversation(normalized)
  }, [])
  const clientIdRef = useRef(`agent-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  // Agent Canvas：面板/自动保存/冲突状态都在 useAgentCanvas；transport 经 ref 取活动画布上下文
  const canvas = useAgentCanvas({
    conversationId,
    clientId: clientIdRef.current,
    onError: (message) => toast.danger(message, { timeout: 3000 }),
  })
  const canvasRef = useRef(canvas)
  canvasRef.current = canvas
  const [canvasMenuOpen, setCanvasMenuOpen] = useState(false)
  const [canvasMenuLoading, setCanvasMenuLoading] = useState(false)
  const [canvasItems, setCanvasItems] = useState<AgentCanvasListItem[]>([])
  useEffect(() => {
    setCanvasMenuOpen(false)
    setCanvasMenuLoading(false)
    setCanvasItems([])
  }, [conversationId])
  const handleCanvasMenuOpenChange = useCallback((nextOpen: boolean) => {
    setCanvasMenuOpen(nextOpen)
    if (!nextOpen) return
    const targetConversationId = conversationIdRef.current
    if (!targetConversationId) {
      setCanvasItems([])
      return
    }
    setCanvasItems([])
    setCanvasMenuLoading(true)
    void window.electronAPI.agentCanvas.list(targetConversationId)
      .then((result) => {
        if (conversationIdRef.current !== targetConversationId) return
        if (result.success && result.canvases) setCanvasItems(result.canvases)
        else toast.danger(result.error || '画布列表加载失败', { timeout: 3000 })
      })
      .catch((error) => {
        if (conversationIdRef.current !== targetConversationId) return
        toast.danger(error instanceof Error ? error.message : '画布列表加载失败', { timeout: 3000 })
      })
      .finally(() => {
        if (conversationIdRef.current === targetConversationId) setCanvasMenuLoading(false)
      })
  }, [])
  // 消息引用点开旧版本时在版本历史里标记该 revision（正文始终展示当前版本）
  const [canvasMarkedRevision, setCanvasMarkedRevision] = useState<number | null>(null)
  const handleOpenCanvasReference = useCallback((data: AgentCanvasRefData) => {
    setCanvasMarkedRevision(data.revision)
    void canvasRef.current.openCanvas(data.canvasId)
  }, [])
  const handleCreateCanvas = useCallback((kind: AgentCanvasKind) => {
    setCanvasMenuOpen(false)
    setCanvasMarkedRevision(null)
    void canvasRef.current.createCanvas(kind)
  }, [])
  const handleOpenCanvasItem = useCallback((canvasId: string) => {
    setCanvasMenuOpen(false)
    setCanvasMarkedRevision(null)
    void canvasRef.current.openCanvas(canvasId)
  }, [])
  const transport = useMemo(
    () => new IpcChatTransport(
      () => submitScopeRef.current ?? activeScopeRef.current,
      () => selectedModelConfigRef.current,
      () => conversationIdRef.current,
      handleAgentProgress,
      () => planModeRef.current,
      () => (codeWorkspaceRef.current ? 'hybrid' : 'chat') as AgentToolProfile,
      () => codeWorkspaceRef.current,
      () => canvasRef.current.getRunContext(),
    ),
    [handleAgentProgress]
  )
  // 流式 chunk 合并到每 50ms 更新一次 UI，避免 token 级高频重渲染拖卡滚动
  const { messages, sendMessage, setMessages, status, stop, addToolApprovalResponse } = useChat({
    transport,
    experimental_throttle: 50,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    // 主进程/子进程侧的请求失败（限流、参数不支持等）此前只进日志，聊天区什么都不显示，用户分不清是没回应还是报错了
    onError: (error) => setAgentNotice(error instanceof Error ? error.message : String(error)),
  })
  const messagesRef = useRef<UIMessage[]>(messages)
  messagesRef.current = messages
  const lastSavedMessagesRef = useRef('')
  const streamingSaveTimerRef = useRef<number | null>(null)
  const lastStreamingSaveAtRef = useRef(0)
  const [modelOpen, setModelOpen] = useState(false)
  const busy = status === 'submitted' || status === 'streaming'
  promptOptimizeContextRef.current = buildPromptOptimizeContext(busy ? messages.slice(0, -1) : messages)
  const awaitingToolApproval = useMemo(() => {
    const lastMessage = messages[messages.length - 1]
    return lastMessage?.role === 'assistant' && lastMessage.parts.some((part) => (
      'state' in part && part.state === 'approval-requested'
    ))
  }, [messages])
  const effectiveBusy = busy || localAgentRunning || agentRunPending || awaitingToolApproval
  const effectiveStatus: ChatStatus = localAgentRunning || agentRunPending || awaitingToolApproval ? 'streaming' : status
  useEffect(() => {
    const lastMessage = messages[messages.length - 1]
    const metadata = lastMessage?.metadata && typeof lastMessage.metadata === 'object'
      ? lastMessage.metadata as Record<string, unknown>
      : null
    const win = window as unknown as {
      __ctAgentUiSmoke?: unknown
    }
    win.__ctAgentUiSmoke = {
      status,
      busy: effectiveBusy,
      selectedLocalAgentId,
      localAgentRunning,
      messageCount: messages.length,
      lastMessage: lastMessage ? {
        id: lastMessage.id,
        role: lastMessage.role,
        metadataKeys: metadata ? Object.keys(metadata) : [],
        planMode: metadata?.planMode === true,
        partCount: lastMessage.parts.length,
        textTotalLength: lastMessage.parts.reduce((sum, part) => (
          sum + ('text' in part && typeof part.text === 'string' ? part.text.length : 0)
        ), 0),
        textPreview: lastMessage.parts
          .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
          .join('')
          .slice(-500),
        parts: lastMessage.parts.map((part) => ({
          type: part.type,
          textLength: 'text' in part && typeof part.text === 'string' ? part.text.length : undefined,
          textPreview: 'text' in part && typeof part.text === 'string' ? part.text.slice(-300) : undefined,
          state: 'state' in part ? part.state : undefined,
        })),
      } : null,
    }
  }, [effectiveBusy, localAgentRunning, messages, selectedLocalAgentId, status])
  const conversationUpdatedAtRef = useRef(0)
  const pendingConversationReloadRef = useRef<number | null>(null)
  const loadConversationByIdRef = useRef<((id: number, options?: { closeRecords?: boolean }) => Promise<boolean>) | null>(null)
  const busyRef = useRef(false)
  busyRef.current = effectiveBusy
  const [memoryIntroStatus, setMemoryIntroStatus] = useState<AgentMemoryIntroStatus>('checking')
  const markMemoryIntroSatisfied = useCallback(() => {
    setMemoryIntroStatus('hidden')
  }, [])
  useEffect(() => {
    let cancelled = false
    void window.electronAPI.memory.list({
      sourceTypes: ['profile', 'fact', 'relationship'],
      limit: 1,
    })
      .then((res) => {
        if (cancelled) return
        const hasUserMemory = res.success && Array.isArray(res.items) && res.items.length > 0
        setMemoryIntroStatus(hasUserMemory ? 'hidden' : 'needed')
      })
      .catch(() => {
        if (!cancelled) setMemoryIntroStatus('hidden')
      })
    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => {
    if (!busy && !agentRunPending) return
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      for (let index = 0; index < message.parts.length; index += 1) {
        const output = getPersonaControlOutput(message.parts[index])
        if (!output?.success || !output.action || !output.sessionId) continue
        const key = `${message.id}:${index}:${output.action}:${output.sessionId}`
        if (processedPersonaActionsRef.current.has(key)) continue
        processedPersonaActionsRef.current.add(key)

        const displayName = output.displayName || output.sessionId
        if (output.action === 'open_persona_chat') {
          setAgentNotice(`正在打开「${displayName}」的数字分身...`)
          void window.electronAPI.window.openPersonaChatWindow(output.sessionId)
            .then(() => setAgentNotice(`已打开「${displayName}」的数字分身。`))
            .catch((error) => setAgentNotice(error instanceof Error ? error.message : '打开数字分身失败'))
          continue
        }

        if (output.action === 'build_session_vectors') {
          setAgentNotice(`正在为「${displayName}」建立语义索引...`)
          void window.electronAPI.embedding.buildSession(output.sessionId)
            .then((result) => {
              setAgentNotice(result.success
                ? `「${displayName}」的语义索引已建立。`
                : `语义索引建立失败：${result.error || '未知错误'}`)
            })
            .catch((error) => setAgentNotice(error instanceof Error ? error.message : '语义索引建立失败'))
          continue
        }

        if (output.action === 'build_persona') {
          setAgentNotice(`正在克隆「${displayName}」的数字分身...`)
          void window.electronAPI.persona.build({ sessionId: output.sessionId, displayName })
            .then((result) => {
              setAgentNotice(result.success
                ? `「${displayName}」的数字分身已创建成功。请重新说「打开${displayName}数字分身」进入对话。`
                : `数字分身克隆失败：${result.error || '未知错误'}`)
            })
            .catch((error) => setAgentNotice(error instanceof Error ? error.message : '数字分身克隆失败'))
        }
      }
    }
  }, [agentRunPending, busy, messages])
  // 模型空窗期：流已建立（status=streaming）但助手消息还没有任何可见输出（最多只有 step-start），
  // 即"模型首 token 还没到"——这段最长可达十几秒，用轮播文案兜住
  const lastMessageForWait = messages[messages.length - 1]
  const waitingFirstModelOutput = busy && (
    !lastMessageForWait
    || lastMessageForWait.role === 'user'
    || (lastMessageForWait.role === 'assistant' && !lastMessageForWait.parts.some((part) => part.type !== 'step-start'))
  )
  const latestUserMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') return messages[i].id
    }
    return ''
  }, [messages])
  const shouldAnchorLatestUser = effectiveBusy && !!latestUserMessageId
  const lastAssistantMessageHasDelegateTool = useMemo(() => {
    const last = messages[messages.length - 1]
    return !!last && last.role === 'assistant' && last.parts.some((part) => (
      isToolUIPart(part) && part.type.replace(/^tool-/, '') === 'delegate_analysis'
    ))
  }, [messages])
  // 本次会话累计 token 用量（各助手消息 usage 求和），供输入框底部展示
  const conversationUsage = useMemo(() => {
    let input = 0
    let output = 0
    let hasAny = false
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      const usage = parseAgentMessageMetadata(message.metadata)?.usage
      if (!usage) continue
      hasAny = true
      input += finiteNumber(usage.inputTokens) ?? 0
      output += finiteNumber(usage.outputTokens) ?? 0
    }
    return { input, output, total: input + output, hasAny }
  }, [messages])
  const [conversationTitle, setConversationTitle] = useState('新对话')
  const [titleLoading, setTitleLoading] = useState(false)
  const [titleEditing, setTitleEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [titleSaving, setTitleSaving] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const titleCommitInFlightRef = useRef(false)
  const titleIgnoreBlurRef = useRef(false)
  const titleRequestSeqRef = useRef(0)
  const [recordsOpen, setRecordsOpen] = useState(false)
  const [conversationRecords, setConversationRecords] = useState<AgentConversationRecord[]>([])
  const [recordPendingDelete, setRecordPendingDelete] = useState<AgentConversationRecord | null>(null)
  const [recordDeleting, setRecordDeleting] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [shareSearch, setShareSearch] = useState('')
  const [shareSelectedId, setShareSelectedId] = useState<number | null>(null)
  const [sharePreviewData, setSharePreviewData] = useState<AgentSharePreviewData | null>(null)
  const [shareLoading, setShareLoading] = useState(false)
  const [shareSaving, setShareSaving] = useState(false)
  const [shareError, setShareError] = useState('')
  const shareCardRef = useRef<HTMLDivElement | null>(null)
  // Agent 运行状态 → 桌宠动作：跑→run，报错→failed，收尾→done(挥手 2.6s)。
  const petAgentState = effectiveBusy ? 'running' : (agentNotice && !agentNotice.startsWith('状态：') ? 'failed' : 'idle')
  const petPrevBusyRef = useRef(false)
  useEffect(() => {
    if (petAgentState === 'idle' && petPrevBusyRef.current) {
      window.electronAPI.pet?.setAgentState('done')
      const timer = window.setTimeout(() => {
        window.electronAPI.pet?.setAgentState('idle')
      }, 2600)
      petPrevBusyRef.current = false
      return () => window.clearTimeout(timer)
    }
    petPrevBusyRef.current = petAgentState === 'running'
    window.electronAPI.pet?.setAgentState(petAgentState)
  }, [petAgentState])

  const appendMentionTargets = useCallback((items: MentionTarget[]) => {
    if (items.length === 0) return
    setSessions((prev) => {
      const next = [...prev]
      for (const item of items) {
        if (mentionSeenRef.current.has(item.username)) continue
        mentionSeenRef.current.add(item.username)
        next.push(item)
      }
      return next
    })
  }, [])

  const updateMentionHasMore = useCallback((hasMore: boolean) => {
    mentionHasMoreRef.current = hasMore
    setMentionHasMore(hasMore)
  }, [])

  const loadMentionSessions = useCallback(async () => {
    if (mentionLoadingRef.current) {
      console.info('[AgentMention][renderer] load skipped: already loading')
      return
    }
    mentionLoadingRef.current = true
    setMentionLoading(true)
    const chat = (window as any)?.electronAPI?.chat
    const offset = mentionOffsetRef.current

    console.info('[AgentMention][renderer] load start', {
      offset,
      limit: MENTION_SESSION_PAGE_SIZE,
      knownSessions: sessions.length,
      hasMore: mentionHasMoreRef.current,
      connected: mentionConnectedRef.current,
      hasChatApi: !!chat,
      hasGetMentionTargets: !!chat?.getMentionTargets,
    })

    try {
      if (!mentionConnectedRef.current) {
        try {
          const connectResult = await chat?.connect?.()
          console.info('[AgentMention][renderer] chat connect result', {
            success: connectResult?.success,
            error: connectResult?.error,
          })
        } catch (error) {
          console.warn('[AgentMention][renderer] chat connect threw', { error: String(error) })
        }
        mentionConnectedRef.current = true
      }

      const res = await chat?.getMentionTargets?.(offset, MENTION_SESSION_PAGE_SIZE)
      console.info('[AgentMention][renderer] load result', {
        success: res?.success,
        sessions: Array.isArray(res?.sessions) ? res.sessions.length : null,
        hasMore: res?.hasMore,
        error: res?.error,
      })
      if (res?.success && Array.isArray(res.sessions)) {
        appendMentionTargets(
          res.sessions
            .map((s: any) => toMentionTarget(s.username, s.displayName, s.avatarUrl))
        )
        mentionOffsetRef.current = offset + MENTION_SESSION_PAGE_SIZE
        updateMentionHasMore(!!res.hasMore)
        return
      }
      updateMentionHasMore(sessions.length === 0)
    } catch (error) {
      console.warn('[AgentMention][renderer] load threw', { error: String(error) })
      updateMentionHasMore(sessions.length === 0)
    } finally {
      mentionLoadingRef.current = false
      setMentionLoading(false)
    }
  }, [appendMentionTargets, sessions.length, updateMentionHasMore])

  const searchMentionSessions = useCallback(async (query: string) => {
    const keyword = query.trim()
    if (!keyword) return
    const seq = ++mentionSearchSeqRef.current
    const chat = (window as any)?.electronAPI?.chat
    setMentionLoading(true)
    console.info('[AgentMention][renderer] search start', {
      seq,
      keywordLength: keyword.length,
      limit: MENTION_SESSION_PAGE_SIZE,
      connected: mentionConnectedRef.current,
      hasChatApi: !!chat,
      hasGetMentionTargets: !!chat?.getMentionTargets,
    })

    try {
      if (!mentionConnectedRef.current) {
        try {
          const connectResult = await chat?.connect?.()
          console.info('[AgentMention][renderer] search connect result', {
            seq,
            success: connectResult?.success,
            error: connectResult?.error,
          })
        } catch (error) {
          console.warn('[AgentMention][renderer] search connect threw', { seq, error: String(error) })
        }
        mentionConnectedRef.current = true
      }

      const res = await chat?.getMentionTargets?.(0, MENTION_SESSION_PAGE_SIZE, keyword)
      console.info('[AgentMention][renderer] search result', {
        seq,
        latestSeq: mentionSearchSeqRef.current,
        success: res?.success,
        sessions: Array.isArray(res?.sessions) ? res.sessions.length : null,
        hasMore: res?.hasMore,
        error: res?.error,
      })
      if (seq === mentionSearchSeqRef.current && res?.success && Array.isArray(res.sessions)) {
        appendMentionTargets(
          res.sessions.map((s: any) => toMentionTarget(s.username, s.displayName, s.avatarUrl))
        )
      }
    } catch (error) {
      console.warn('[AgentMention][renderer] search threw', { seq, error: String(error) })
    } finally {
      if (seq === mentionSearchSeqRef.current) setMentionLoading(false)
    }
  }, [appendMentionTargets])

  const refreshConversationRecords = useCallback(async () => {
    const result = await window.electronAPI.agent.listConversations()
    if (!result.success || !Array.isArray(result.conversations)) return []
    const records = result.conversations
      .map(normalizeConversationRecord)
      .filter((item): item is AgentConversationRecord => !!item)
    setConversationRecords(records)
    return records
  }, [])

  const handleRecordsOpenChange = useCallback((open: boolean) => {
    setRecordsOpen(open)
    if (open) void refreshConversationRecords()
  }, [refreshConversationRecords])

  const saveConversationMessages = useCallback((
    targetId: number | null,
    nextMessages: UIMessage[],
    nextScope: AgentScope,
  ) => {
    if (!targetId || nextMessages.length === 0) return null
    const config = selectedModelConfigRef.current
    const baseUpdatedAt = conversationUpdatedAtRef.current
    return window.electronAPI.agent.saveConversationMessages({
      id: targetId,
      messages: nextMessages,
      scope: nextScope,
      modelProvider: modelConfigProvider(config),
      modelId: modelConfigId(config),
      baseUpdatedAt,
      mergeIfStale: true,
      originClientId: clientIdRef.current,
    }).then((result) => {
      if (result?.success && result.conversation) {
        const record = normalizeConversationRecord(result.conversation)
        if (record) conversationUpdatedAtRef.current = Number(record.updatedAt || conversationUpdatedAtRef.current)
        if ((result as { staleMerged?: boolean }).staleMerged) {
          void loadConversationByIdRef.current?.(targetId, { closeRecords: false })
        }
      }
      return result
    })
  }, [])

  const persistConversationMessages = useCallback(async (
    targetId: number | null,
    nextMessages: UIMessage[],
    nextScope: AgentScope,
  ) => {
    const result = await saveConversationMessages(targetId, nextMessages, nextScope)
    if (result?.success) void refreshConversationRecords()
  }, [refreshConversationRecords, saveConversationMessages])

  const persistLocalAgentConversationMessages = useCallback(async (
    targetId: number | null,
    nextMessages: UIMessage[],
    nextScope: AgentScope,
    agentId: string,
  ) => {
    if (!targetId || nextMessages.length === 0) return
    const result = await window.electronAPI.agent.saveConversationMessages({
      id: targetId,
      messages: nextMessages,
      scope: nextScope,
      modelProvider: 'local-coding-agent',
      modelId: agentId,
      baseUpdatedAt: conversationUpdatedAtRef.current,
      mergeIfStale: true,
      originClientId: clientIdRef.current,
    })
    if (result?.success) {
      lastSavedMessagesRef.current = signatureAgentMessages(nextMessages)
      const record = normalizeConversationRecord(result.conversation)
      if (record) conversationUpdatedAtRef.current = Number(record.updatedAt || conversationUpdatedAtRef.current)
      void refreshConversationRecords()
    }
  }, [refreshConversationRecords])

  const flushConversationMessagesToStorage = useCallback((options: { refreshRecords?: boolean } = {}) => {
    const targetId = conversationIdRef.current
    const currentMessages = messagesRef.current
    if (!targetId || currentMessages.length === 0) return false

    const messagesToPersist = prepareAgentMessagesForPersist(
      currentMessages,
      subAgentProgressRef.current,
      toolElapsedByKeyRef.current,
    )
    if (messagesToPersist !== currentMessages) {
      setMessages(messagesToPersist)
      messagesRef.current = messagesToPersist
    }

    const signature = signatureAgentMessages(messagesToPersist)
    if (signature === lastSavedMessagesRef.current) return false
    lastSavedMessagesRef.current = signature

    if (options.refreshRecords) {
      void persistConversationMessages(targetId, messagesToPersist, activeScopeRef.current)
    } else {
      void saveConversationMessages(targetId, messagesToPersist, activeScopeRef.current)
    }
    return true
  }, [persistConversationMessages, saveConversationMessages, setMessages])

  const saveCurrentConversationForShare = useCallback(async (): Promise<number | null> => {
    const targetId = conversationIdRef.current
    const currentMessages = messagesRef.current
    if (!targetId || currentMessages.length === 0) return targetId

    const messagesToPersist = prepareAgentMessagesForPersist(
      currentMessages,
      subAgentProgressRef.current,
      toolElapsedByKeyRef.current,
    )
    if (messagesToPersist !== currentMessages) {
      setMessages(messagesToPersist)
      messagesRef.current = messagesToPersist
    }

    const signature = signatureAgentMessages(messagesToPersist)
    if (signature !== lastSavedMessagesRef.current) {
      lastSavedMessagesRef.current = signature
      await persistConversationMessages(targetId, messagesToPersist, activeScopeRef.current)
    }
    return targetId
  }, [persistConversationMessages, setMessages])

  const createConversation = useCallback(async (scope: AgentScope, title: string): Promise<number | null> => {
    const config = selectedModelConfigRef.current
    const result = await window.electronAPI.agent.createConversation({
      scope,
      title,
      modelProvider: modelConfigProvider(config),
      modelId: modelConfigId(config),
      originClientId: clientIdRef.current,
    })
    const record = result.success ? normalizeConversationRecord(result.conversation) : null
    if (!record) return null
    applyConversationId(record.id)
    conversationUpdatedAtRef.current = Number(record.updatedAt || Date.now())
    setConversationTitle(record.title)
    void refreshConversationRecords()
    return record.id
  }, [applyConversationId, refreshConversationRecords])

  const createLocalAgentConversation = useCallback(async (scope: AgentScope, title: string, agentId: string): Promise<number | null> => {
    const result = await window.electronAPI.agent.createConversation({
      scope,
      title,
      modelProvider: 'local-coding-agent',
      modelId: agentId,
      originClientId: clientIdRef.current,
    })
    const record = result.success ? normalizeConversationRecord(result.conversation) : null
    if (!record) return null
    applyConversationId(record.id)
    conversationUpdatedAtRef.current = Number(record.updatedAt || Date.now())
    setConversationTitle(record.title)
    void refreshConversationRecords()
    return record.id
  }, [applyConversationId, refreshConversationRecords])

  // 从 run 的 activityParts + finalText 重建这条助手消息的 parts：折叠链在前，最终回复正文在后。
  const rebuildLocalAgentMessage = useCallback((run: LocalAgentRunState) => {
    const parts = run.finalText
      ? [...run.activityParts, { type: 'text', text: run.finalText } as UIMessage['parts'][number]]
      : [...run.activityParts]
    const nextMessages = messagesRef.current.map((message) =>
      message.id === run.assistantMessageId ? ({ ...message, parts } as UIMessage) : message)
    setMessages(nextMessages)
    messagesRef.current = nextMessages
  }, [setMessages])

  useEffect(() => {
    return window.electronAPI.localCodingAgent.onEvent((event) => {
      const run = localAgentRunRef.current
      if (!run || event.jobId !== run.jobId) return

      if (event.type === 'message') {
        // 只有模型的最终回复进正文；密语的状态提示一律不入气泡。
        run.finalText = normalizeLocalAgentText([run.finalText, event.text].filter(Boolean).join('\n\n'))
        rebuildLocalAgentMessage(run)
      } else if (event.type === 'stdout' && shouldShowLocalAgentStdout(event.text)) {
        // 非 JSON 型 CLI（custom）的纯文本兜底。
        run.finalText = normalizeLocalAgentText(`${run.finalText}${event.text}`)
        rebuildLocalAgentMessage(run)
      } else if (event.type === 'activity') {
        run.activityParts = [...run.activityParts, buildLocalAgentActivityPart(event, run.activityParts.length)]
        rebuildLocalAgentMessage(run)
      }

      if (event.type === 'diff') {
        setLocalAgentPatchRequest(event.changedPaths.length > 0
          ? {
              agentId: run.agentId,
              assistantMessageId: run.assistantMessageId,
              changedPaths: event.changedPaths,
              jobId: event.jobId,
              patch: event.patch,
              scope: run.scope,
              targetConversationId: run.targetConversationId,
            }
          : null)
      }

      if (event.type === 'error') {
        setAgentNotice(event.error)
        setLocalAgentRunning(false)
        const completedRun = localAgentRunRef.current
        localAgentRunRef.current = null
        if (completedRun) {
          void persistLocalAgentConversationMessages(
            completedRun.targetConversationId,
            messagesRef.current,
            completedRun.scope,
            completedRun.agentId,
          )
        }
      }

      if (event.type === 'finished') {
        setLocalAgentRunning(false)
        const completedRun = localAgentRunRef.current
        localAgentRunRef.current = null
        if (completedRun) {
          void persistLocalAgentConversationMessages(
            completedRun.targetConversationId,
            messagesRef.current,
            completedRun.scope,
            completedRun.agentId,
          )
        }
      }
    })
  }, [rebuildLocalAgentMessage, persistLocalAgentConversationMessages])

  const restoreLoadedConversation = useCallback((
    loaded: AgentConversationLoaded,
    options: { closeRecords?: boolean } = {},
  ) => {
    setMessages(loaded.messages)
    messagesRef.current = loaded.messages
    lastSavedMessagesRef.current = signatureAgentMessages(loaded.messages)
    applyConversationId(loaded.id)
    conversationUpdatedAtRef.current = Number(loaded.updatedAt || Date.now())
    pendingConversationReloadRef.current = null
    setConversationTitle(loaded.title)
    setTitleEditing(false)
    setTitleDraft('')
    activeScopeRef.current = loaded.scope || { kind: 'global' }
    setMentions([])
    const restoredToolElapsed: Record<string, number> = {}
    for (const message of loaded.messages) Object.assign(restoredToolElapsed, readToolElapsedFromMessage(message))
    setToolElapsedByKey(restoredToolElapsed)
    setAgentProgress([])
    setAgentRunPending(false)
    setSubAgentProgress([])
    setAgentNotice('')
    setTitleLoading(false)
    titleRequestSeqRef.current += 1
    if (options.closeRecords !== false) setRecordsOpen(false)
  }, [applyConversationId, setMessages])

  const loadConversationById = useCallback(async (
    id: number,
    options: { closeRecords?: boolean } = {},
  ): Promise<boolean> => {
    if (id !== conversationIdRef.current && !await canvasRef.current.flushSave()) return false
    const result = await window.electronAPI.agent.loadConversation(id)
    const loaded = result.success ? normalizeLoadedConversation(result.conversation) : null
    if (!loaded) return false
    restoreLoadedConversation(loaded, options)
    return true
  }, [restoreLoadedConversation])

  loadConversationByIdRef.current = loadConversationById


  useEffect(() => {
    return window.electronAPI.agent.onConversationUpdated((event: AgentConversationUpdatedEvent) => {
      const eventId = Number(event?.id || 0)
      if (!eventId) return

      void refreshConversationRecords()
      if (eventId !== conversationIdRef.current) return

      if (event.changeType === 'deleted') {
        setMessages([])
        messagesRef.current = []
        applyConversationId(null)
        setConversationTitle('新对话')
        setTitleEditing(false)
        setTitleDraft('')
        activeScopeRef.current = { kind: 'global' }
        lastSavedMessagesRef.current = ''
        conversationUpdatedAtRef.current = 0
        pendingConversationReloadRef.current = null
        setToolElapsedByKey({})
        setAgentProgress([])
        setAgentRunPending(false)
        setSubAgentProgress([])
        return
      }

      conversationUpdatedAtRef.current = Number(event.updatedAt || conversationUpdatedAtRef.current)
      if (event.originClientId && event.originClientId === clientIdRef.current) return

      if (busyRef.current) {
        pendingConversationReloadRef.current = eventId
        return
      }
      void loadConversationById(eventId, { closeRecords: false })
    })
  }, [applyConversationId, loadConversationById, refreshConversationRecords, setMessages])

  useEffect(() => {
    if (effectiveBusy) return
    const pendingId = pendingConversationReloadRef.current
    if (!pendingId) return
    pendingConversationReloadRef.current = null
    void loadConversationById(pendingId, { closeRecords: false })
  }, [effectiveBusy, loadConversationById])

  const shareFilteredRecords = useMemo(() => {
    const keyword = shareSearch.trim().toLowerCase()
    if (!keyword) return conversationRecords
    return conversationRecords.filter((record) => record.title.toLowerCase().includes(keyword))
  }, [conversationRecords, shareSearch])

  const loadShareConversation = useCallback(async (record: AgentConversationRecord) => {
    setShareSelectedId(record.id)
    setShareLoading(true)
    setShareError('')
    try {
      const result = await window.electronAPI.agent.loadConversation(record.id)
      const loaded = result.success ? normalizeLoadedConversation(result.conversation) : null
      if (!loaded) {
        setSharePreviewData(null)
        setShareError(result.error || '加载对话失败')
        return
      }
      setSharePreviewData(buildAgentSharePreviewData(loaded))
    } catch (error) {
      setSharePreviewData(null)
      setShareError(error instanceof Error ? error.message : '加载对话失败')
    } finally {
      setShareLoading(false)
    }
  }, [])

  const handleOpenShare = useCallback(async () => {
    if (effectiveBusy) {
      setAgentNotice('当前 Agent 正在输出，等这轮结束后再分享。')
      return
    }
    const currentId = await saveCurrentConversationForShare()
    if (!currentId && messagesRef.current.length > 0) {
      setAgentNotice('当前对话还没有可分享的记录。')
      return
    }
    setShareOpen(true)
    setShareError('')
    setShareSearch('')
    setSharePreviewData(null)
    setShareSelectedId(null)
    void refreshConversationRecords().then((records) => {
      const target = records.find((record) => record.id === currentId) || records[0]
      if (target) void loadShareConversation(target)
    })
  }, [effectiveBusy, loadShareConversation, refreshConversationRecords, saveCurrentConversationForShare])

  const handleSaveShareImage = useCallback(async () => {
    if (!sharePreviewData || !shareCardRef.current) return
    setShareSaving(true)
    setShareError('')
    try {
      const fileName = `CipherTalk-Agent-${sanitizeAgentShareFileName(sharePreviewData.title)}-${formatAgentShareFileDate()}.png`
      const saveResult = await window.electronAPI.dialog.saveFile({
        title: '保存 Agent 分享图',
        defaultPath: fileName,
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
      })
      if (saveResult.canceled || !saveResult.filePath) return

      const dataUrl = await toPng(shareCardRef.current, {
        bgcolor: '#f8fafc',
        cacheBust: true,
        scale: 2,
      })
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')
      const writeResult = await window.electronAPI.file.writeBase64(saveResult.filePath, base64)
      if (!writeResult.success) {
        setShareError(writeResult.error || '保存图片失败')
        return
      }
      toast.success('分享图已保存')
    } catch (error) {
      setShareError(error instanceof Error ? error.message : '生成图片失败')
    } finally {
      setShareSaving(false)
    }
  }, [sharePreviewData])

  const generateTitleFromFirstMessage = useCallback((firstMessage: string) => {
    const fallback = buildFallbackConversationTitle(firstMessage)
    setConversationTitle(fallback)
    setTitleLoading(true)
    const requestSeq = ++titleRequestSeqRef.current
    const targetConversationId = conversationIdRef.current
    void window.electronAPI.agent
      .generateTitle(firstMessage, selectedModelConfigRef.current)
      .then((result) => {
        if (requestSeq !== titleRequestSeqRef.current || targetConversationId !== conversationIdRef.current) return
        if (result.success && result.title?.trim()) {
          const nextTitle = result.title.trim().slice(0, 24)
          setConversationTitle(nextTitle)
          if (targetConversationId) {
            void window.electronAPI.agent.renameConversation(targetConversationId, nextTitle, clientIdRef.current).then(() => refreshConversationRecords())
          }
        }
      })
      .finally(() => {
        if (requestSeq === titleRequestSeqRef.current && targetConversationId === conversationIdRef.current) {
          setTitleLoading(false)
        }
      })
  }, [])

  const submitLocalAgentMessage = useCallback(async (input: {
    agentId: string
    files: PromptInputMessage['files']
    submitScope: AgentScope
    text: string
    titleText: string
  }) => {
    const workspace = codeWorkspaceRef.current
    if (!workspace) {
      setAgentNotice('请先选择代码工作区，再使用本地智能体。')
      return
    }
    if (input.files.length > 0) {
      setAgentNotice('本地智能体暂不处理图片或附件，请改用文本任务和代码工作区文件引用。')
      return
    }

    const config = await loadLocalAgentConfig()
    if (!config.enabled) {
      setAgentNotice('请先在 设置 → AI 接入 → 本地智能体 中启用本地智能体。')
      return
    }
    const agentId = input.agentId
    const agent = config.agents[agentId]
    if (!agent) {
      setAgentNotice('本地智能体配置不完整，请到 设置 → AI 接入 → 本地智能体 检查配置。')
      return
    }

    activeScopeRef.current = input.submitScope
    setAgentNotice('')
    setAgentProgress([])
    setSubAgentProgress([])
    setLocalAgentPatchRequest(null)

    let targetConversationId = conversationIdRef.current
    if (!targetConversationId) {
      const fallback = buildFallbackConversationTitle(input.titleText || input.text)
      setConversationTitle(fallback)
      targetConversationId = await createLocalAgentConversation(input.submitScope, fallback, agentId)
      if (!targetConversationId) {
        setAgentNotice('创建本地智能体对话失败。')
        return
      }
    }

    const userMessage = createAgentTextMessage('user', input.text)
    const assistantMessage = createAgentTextMessage('assistant', '')
    const nextMessages = [...messagesRef.current, userMessage, assistantMessage]
    setMessages(nextMessages)
    messagesRef.current = nextMessages
    lastSavedMessagesRef.current = ''
    setMentions([])
    setWorkspaceFileReferences([])
    setLocalAgentRunning(true)
    localAgentRunRef.current = {
      agentId,
      assistantMessageId: assistantMessage.id,
      jobId: '',
      activityParts: [],
      finalText: '',
      scope: input.submitScope,
      targetConversationId,
    }

    const result = await window.electronAPI.localCodingAgent.run({
      agentId,
      mode: 'propose',
      prompt: input.text,
      workspace,
      model: agent.model,
    })

    if (!result.success || !result.jobId) {
      const errorText = result.error || '本地智能体启动失败'
      setLocalAgentRunning(false)
      setAgentNotice(errorText)
      localAgentRunRef.current = null
      const failedText = `${assistantMessage.parts[0]?.type === 'text' ? assistantMessage.parts[0].text : ''}\n${errorText}`.trim()
      const failedMessages = replaceMessageText(messagesRef.current, assistantMessage.id, failedText)
      setMessages(failedMessages)
      messagesRef.current = failedMessages
      await persistLocalAgentConversationMessages(targetConversationId, failedMessages, input.submitScope, agentId)
      return
    }

    const pendingRun = localAgentRunRef.current
    if (!pendingRun || pendingRun.assistantMessageId !== assistantMessage.id) {
      await window.electronAPI.localCodingAgent.cancel(result.jobId).catch(() => ({ success: false }))
      return
    }
    localAgentRunRef.current = { ...pendingRun, jobId: result.jobId }
  }, [
    createLocalAgentConversation,
    loadLocalAgentConfig,
    persistLocalAgentConversationMessages,
    setMessages,
  ])

  const handleNewConversation = useCallback(async (): Promise<boolean> => {
    if (busy) await stop()
    if (localAgentRunning) await cancelLocalAgentRun()
    if (!await canvasRef.current.flushSave()) return false
    setMessages([])
    messagesRef.current = []
    setMentions([])
    setConversationTitle('新对话')
    setTitleEditing(false)
    setTitleDraft('')
    setTitleLoading(false)
    setToolElapsedByKey({})
    setAgentProgress([])
    setAgentRunPending(false)
    setSubAgentProgress([])
    setAgentNotice('')
    activeScopeRef.current = { kind: 'global' }
    lastSavedMessagesRef.current = ''
    conversationUpdatedAtRef.current = 0
    pendingConversationReloadRef.current = null
    titleRequestSeqRef.current += 1
    applyConversationId(null)
    setRecordsOpen(false)
    return true
  }, [applyConversationId, busy, cancelLocalAgentRun, localAgentRunning, setMessages, stop])

  // 跨窗口自动运行（聊天窗口「AI 摘要」）：经 localStorage 递入 {text, mention}，
  // 消费后新建对话并 @目标会话，实际发送由下方 pendingAutoRun effect 完成；
  // storage 事件覆盖"AI 助手页已挂载"的情况。写入 sessionStorage 的新对话标记
  // 会让恢复上次对话的逻辑短路，不会被旧会话覆盖。
  useEffect(() => {
    const consumeAutoRun = () => {
      const raw = localStorage.getItem('agent:pendingAutoRun')
      if (!raw) return
      localStorage.removeItem('agent:pendingAutoRun')
      try {
        const payload = JSON.parse(raw) as { text?: string; mention?: { username?: string; displayName?: string; avatarUrl?: string } }
        if (!payload.text || !payload.mention?.username) return
        void handleNewConversation().then((created) => {
          if (!created) return
          setMentions([toMentionTarget(payload.mention!.username!, payload.mention!.displayName, payload.mention!.avatarUrl)])
          setPendingAutoRun(payload.text!)
        })
      } catch {
        // 载荷损坏时静默丢弃
      }
    }
    consumeAutoRun()
    window.addEventListener('storage', consumeAutoRun)
    return () => window.removeEventListener('storage', consumeAutoRun)
  }, [handleNewConversation])

  const handleOpenRecord = useCallback((record: AgentConversationRecord) => {
    if (busy) void stop()
    if (localAgentRunning) void cancelLocalAgentRun()
    void loadConversationById(record.id)
  }, [busy, cancelLocalAgentRun, loadConversationById, localAgentRunning, stop])

  const handleDeleteRecord = useCallback(async (record: AgentConversationRecord) => {
    try {
      const result = await window.electronAPI.agent.deleteConversation(record.id)
      if (!result.success) {
        setAgentNotice(result.error || '删除对话失败')
        return false
      }
      setConversationRecords((prev) => prev.filter((item) => item.id !== record.id))
      if (conversationIdRef.current === record.id) {
        setMessages([])
        messagesRef.current = []
        applyConversationId(null)
        setConversationTitle('新对话')
        setTitleEditing(false)
        setTitleDraft('')
        activeScopeRef.current = { kind: 'global' }
        lastSavedMessagesRef.current = ''
        conversationUpdatedAtRef.current = 0
        pendingConversationReloadRef.current = null
        setToolElapsedByKey({})
        setAgentProgress([])
        setAgentRunPending(false)
        setSubAgentProgress([])
      }
      return true
    } catch (error) {
      setAgentNotice(error instanceof Error ? error.message : '删除对话失败')
      return false
    }
  }, [applyConversationId, setMessages])

  const confirmDeleteRecord = useCallback(async () => {
    if (!recordPendingDelete) return
    const target = recordPendingDelete
    setRecordDeleting(true)
    const deleted = await handleDeleteRecord(target)
    setRecordDeleting(false)
    if (deleted) setRecordPendingDelete(null)
  }, [handleDeleteRecord, recordPendingDelete])

  const slashCommands = useMemo<SlashCommandItem[]>(() => [
    {
      id: 'status',
      commands: ['/status'],
      aliases: ['zhuangtai', '状态'],
      label: '查看状态',
      description: '显示模型、工作区、预览和 token 状态',
      icon: CircleInfo,
      action: () => {
        const workspace = codeWorkspaceState?.workspace
        const devServer = codeWorkspaceState?.devServer
        const tokenLine = conversationUsage.hasAny
          ? `Token：输入 ${formatTokenCount(conversationUsage.input)}，输出 ${formatTokenCount(conversationUsage.output)}，共 ${formatTokenCount(conversationUsage.total)}`
          : 'Token：暂无本次会话用量'
        setAgentNotice([
          '状态：',
          `模型：${selectedModelData?.name || '未选择'}`,
          `工作区：${workspace ? displayBasename(workspace.root) : '未选择'}`,
          `开发服务器：${devServer?.running ? (devServer.previewUrl || devServer.command || '运行中') : '未运行'}`,
          `计划模式：${planMode ? '已开启' : '未开启'}`,
          tokenLine,
        ].join('\n'))
      },
    },
    {
      id: 'plan',
      commands: ['/plan'],
      aliases: ['jihua', '计划'],
      label: planMode ? '关闭计划模式' : '开启计划模式',
      description: '切换下一轮是否先生成执行计划',
      icon: ListCheck,
      action: () => setPlanMode((value) => !value),
    },
    {
      id: 'clear',
      commands: ['/clear', '/new'],
      aliases: ['qingkong', 'xin', '清空', '新对话'],
      label: '新对话 / 清空',
      description: '清空当前线程并回到新对话',
      icon: PencilToSquare,
      action: handleNewConversation,
    },
    {
      id: 'workspace',
      commands: ['/workspace'],
      aliases: ['code', 'files', '工作区', '文件'],
      label: '打开工作区',
      description: '打开左侧文件树和工作区选择',
      icon: LayoutSideContentLeft,
      action: () => setWorkspaceSidebarOpen(true),
    },
    {
      id: 'preview',
      commands: ['/preview'],
      aliases: ['yulan', '预览'],
      label: '打开预览',
      description: '打开代码工作区预览面板',
      icon: Display,
      action: () => {
        setCodeWorkspacePanelTab('preview')
        setCodeWorkspacePanelOpen(true)
      },
    },
    {
      id: 'logs',
      commands: ['/logs'],
      aliases: ['rizhi', 'terminal', '日志', '终端'],
      label: '打开日志',
      description: '打开开发服务器日志面板',
      icon: Terminal,
      action: () => {
        setCodeWorkspacePanelTab('logs')
        setCodeWorkspacePanelOpen(true)
      },
    },
    {
      id: 'model',
      commands: ['/model'],
      aliases: ['moxing', '模型'],
      label: '选择模型',
      description: '打开模型和思考强度选择',
      icon: Bulb,
      action: () => setModelOpen(true),
    },
  ], [
    codeWorkspaceState,
    conversationUsage,
    handleNewConversation,
    planMode,
    selectedModelData,
  ])

  const slashCommandByName = useMemo(() => {
    const map = new Map<string, SlashCommandItem>()
    for (const command of slashCommands) {
      for (const name of command.commands) map.set(name.toLowerCase(), command)
    }
    return map
  }, [slashCommands])

  const runSlashCommandText = useCallback(async (value: string) => {
    const match = value.trim().match(/^\/[^\s/]+$/)
    if (!match) return false
    const command = slashCommandByName.get(match[0].toLowerCase())
    if (!command) return false
    await command.action()
    return true
  }, [slashCommandByName])

  const beginTitleEdit = useCallback(() => {
    titleRequestSeqRef.current += 1
    titleIgnoreBlurRef.current = false
    titleCommitInFlightRef.current = false
    setTitleLoading(false)
    setTitleDraft(conversationTitle)
    setTitleEditing(true)
  }, [conversationTitle])

  const cancelTitleEdit = useCallback(() => {
    titleIgnoreBlurRef.current = true
    setTitleEditing(false)
    setTitleDraft('')
  }, [])

  const commitTitleEdit = useCallback(async () => {
    if (titleCommitInFlightRef.current) return
    titleCommitInFlightRef.current = true
    const nextTitle = titleDraft.trim().slice(0, 80) || '新对话'
    const currentTitle = conversationTitle.trim() || '新对话'
    setTitleEditing(false)
    setTitleDraft('')
    if (nextTitle === currentTitle) {
      titleCommitInFlightRef.current = false
      return
    }

    setConversationTitle(nextTitle)
    const targetId = conversationIdRef.current
    if (!targetId) {
      titleCommitInFlightRef.current = false
      return
    }

    setTitleSaving(true)
    try {
      const result = await window.electronAPI.agent.renameConversation(targetId, nextTitle, clientIdRef.current)
      if (result.success) {
        const record = normalizeConversationRecord(result.conversation)
        if (record) {
          setConversationRecords((prev) => prev.map((item) => item.id === record.id ? record : item))
        } else {
          void refreshConversationRecords()
        }
      } else {
        setAgentNotice(result.error || '重命名对话失败')
      }
    } finally {
      setTitleSaving(false)
      titleCommitInFlightRef.current = false
    }
  }, [conversationTitle, refreshConversationRecords, titleDraft])

  useEffect(() => {
    if (!titleEditing) return
    const timer = window.setTimeout(() => {
      titleInputRef.current?.focus()
      titleInputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [titleEditing])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [items, provider, activePresetId] = await Promise.all([
        configService.getAiConfigPresets(),
        configService.getAiProvider(),
        configService.getActiveAiConfigPresetId(),
      ])
      const currentConfig = await configService.getAiProviderConfig(provider)
      if (cancelled) return
      setPresets(items)
      setCurrentProviderId(provider)
      setCurrentModelId(currentConfig?.model || '')
      setCurrentProviderConfig(currentConfig)
      const defaultPresetId = resolveDefaultPresetId(items, provider, currentConfig, activePresetId)
      setSelectedPresetId((current) => {
        if (current !== 'current' && items.some((item) => item.id === current)) return current
        return defaultPresetId
      })
    })()
    void getAIProviders().then((items) => {
      if (!cancelled) setProvidersInfo(items)
    })
    void window.electronAPI.agent.listConversations().then((result) => {
      if (cancelled || !result.success || !Array.isArray(result.conversations)) return
      setConversationRecords(
        result.conversations
          .map(normalizeConversationRecord)
          .filter((item): item is AgentConversationRecord => !!item)
      )
    })
    return () => {
      cancelled = true
    }
  }, [refreshConversationRecords])

  useEffect(() => {
    let cancelled = false

    const loadIfStillEmpty = async (id: number): Promise<boolean> => {
      if (cancelled || conversationIdRef.current || messagesRef.current.length > 0) return false
      const result = await window.electronAPI.agent.loadConversation(id)
      if (cancelled || conversationIdRef.current || messagesRef.current.length > 0) return false
      const loaded = result.success ? normalizeLoadedConversation(result.conversation) : null
      if (!loaded) return false
      restoreLoadedConversation(loaded, { closeRecords: false })
      return true
    }

    void (async () => {
      const stored = readStoredActiveAgentConversation()
      if (stored === NEW_AGENT_CONVERSATION_MARKER) return
      if (typeof stored === 'number' && await loadIfStillEmpty(stored)) return
      if (cancelled || conversationIdRef.current || messagesRef.current.length > 0) return

      const result = await window.electronAPI.agent.getLastConversation()
      const record = result.success ? normalizeConversationRecord(result.conversation) : null
      if (!record) return
      await loadIfStillEmpty(record.id)
    })().catch(() => {
      // 恢复失败时保持空白新对话。
    })

    return () => {
      cancelled = true
    }
  }, [restoreLoadedConversation])

  const handleSubmit = async (message: PromptInputMessage) => {
    if (localAgentRunning) {
      void cancelLocalAgentRun()
      return
    }
    if (busy) {
      void stop()
      setSubAgentProgress([])
      return
    }
    const currentMentions = mentions
    if (message.files.length === 0 && currentMentions.length === 0 && workspaceFileReferences.length === 0 && await runSlashCommandText(message.text)) {
      return
    }
    const isFirstUserMessage = messages.length === 0
    const firstMessageForTitle = message.text.trim()
    let text = message.text.trim()
    const currentWorkspaceFileReferences = workspaceFileReferences
    if (currentMentions.length > 0) {
      const mentionLine = currentMentions.map((m) => `@${m.displayName}[${m.username}]`).join(' ')
      text = text ? `${mentionLine}\n${text}` : mentionLine
    }
    if (currentWorkspaceFileReferences.length > 0) {
      const workspaceFilePrefix = buildWorkspaceFilePrefix(currentWorkspaceFileReferences)
      text = text ? `${workspaceFilePrefix}\n${text}` : workspaceFilePrefix
    }
    if (!text && message.files.length === 0) return

    const computedScope: AgentScope =
      currentMentions.length === 1
        ? { kind: 'session', sessionId: currentMentions[0].username, displayName: currentMentions[0].displayName }
        : { kind: 'global' }
    const submitScope: AgentScope = conversationIdRef.current ? activeScopeRef.current : computedScope

    if (selectedLocalAgentId) {
      await submitLocalAgentMessage({
        agentId: selectedLocalAgentId,
        files: message.files,
        submitScope,
        text,
        titleText: firstMessageForTitle || currentWorkspaceFileReferences.map((ref) => ref.name || displayBasename(ref.path)).join(' '),
      })
      return
    }

    if (!selectedModelSupportsTools) {
      setAgentNotice('当前模型不支持工具调用，无法查询本地聊天记录。请切换到带“工具调用”能力的模型。')
      return
    }

    activeScopeRef.current = submitScope
    submitScopeRef.current = submitScope
    runIsPlanRef.current = planModeRef.current
    setAgentNotice('')
    setAgentProgress([])
    setAgentRunPending(true)
    setSubAgentProgress([])

    try {
      // 发送前先落盘用户对画布的未保存编辑，Agent 本轮读到的才是最新 revision
      if (!await canvasRef.current.flushSave()) {
        submitScopeRef.current = null
        setAgentRunPending(false)
        return
      }
      const titleText = firstMessageForTitle || currentWorkspaceFileReferences.map((ref) => ref.name || displayBasename(ref.path)).join(' ')
      if (!conversationIdRef.current) {
        const fallback = buildFallbackConversationTitle(titleText || text)
        setConversationTitle(fallback)
        await createConversation(submitScope, fallback)
      }

      if (isFirstUserMessage) generateTitleFromFirstMessage(titleText || text)

      const sendPromise = Promise.resolve(sendMessage({ text, files: message.files })).finally(() => {
        submitScopeRef.current = null
        setAgentRunPending(false)
      })
      void sendPromise
      setMentions([])
      setWorkspaceFileReferences([])
    } catch (error) {
      submitScopeRef.current = null
      setAgentRunPending(false)
      throw error
    }
  }

  // 跨窗口自动运行的实际发送：等 @提及状态落地、且没有进行中的运行后走正常提交管线
  useEffect(() => {
    if (!pendingAutoRun) return
    if (busy || localAgentRunning || agentRunPending) return
    if (mentions.length === 0) return
    setPendingAutoRun(null)
    void handleSubmit({ text: pendingAutoRun, files: [] })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleSubmit 每次渲染都重建，纳入依赖会让 effect 每帧空跑
  }, [pendingAutoRun, mentions, busy, localAgentRunning, agentRunPending])

  const handleEditUserMessage = useCallback((messageIndex: number, text: string) => {
    if (effectiveBusy) return
    const currentMessages = messagesRef.current
    const userMessage = currentMessages[messageIndex]
    if (!userMessage || userMessage.role !== 'user') return
    promptInputControllerRef.current?.textInput.setInput(text)
    const nextMessages = currentMessages.slice(0, messageIndex)
    setMessages(nextMessages)
    messagesRef.current = nextMessages
    setAgentNotice('')
    setAgentProgress([])
    setSubAgentProgress([])
  }, [effectiveBusy, setMessages])

  // 计划模式确认：关闭计划模式并让 Agent 按上一条计划开始执行（沿用当前会话 scope）
  const handleExecutePlan = useCallback(() => {
    if (effectiveBusy || !selectedModelSupportsTools) return
    planModeRef.current = false
    runIsPlanRef.current = false
    setPlanMode(false)
    setAgentNotice('')
    setAgentProgress([])
    setAgentRunPending(true)
    setSubAgentProgress([])
    submitScopeRef.current = activeScopeRef.current
    const sendPromise = Promise.resolve(canvasRef.current.flushSave())
      .then((saved) => saved
        ? sendMessage({ text: '请按上面的计划开始执行，按需调用工具或委托子助手，直接给出最终结果，不要再重复计划。', files: [] })
        : undefined)
      .finally(() => {
        submitScopeRef.current = null
        setAgentRunPending(false)
      })
    void sendPromise
  }, [effectiveBusy, selectedModelSupportsTools, sendMessage])

  const handleToolApproval = useCallback((approvalId: string, approved: boolean) => {
    if (!approvalId || localAgentRunning) return
    void (async () => {
      if (busy) return
    setAgentNotice('')
    setAgentProgress([])
    setAgentRunPending(true)
    setSubAgentProgress([])
    runIsPlanRef.current = false
    submitScopeRef.current = activeScopeRef.current
      await addToolApprovalResponse({
        id: approvalId,
        approved,
        reason: approved ? '用户已确认' : '用户拒绝',
      })
    })()
  }, [addToolApprovalResponse, busy, localAgentRunning])

  // 补丁应用/丢弃的结果属于密语状态，走气泡外的提示条，不改动助手消息（否则会抹掉折叠链的思考/工具卡片）。
  const appendLocalAgentPatchActionResult = useCallback((_request: LocalAgentPatchRequest, text: string) => {
    setAgentNotice(text)
  }, [])

  const handleApplyLocalAgentPatch = useCallback(async () => {
    const request = localAgentPatchRequest
    if (!request || localAgentPatchApplying) return
    setLocalAgentPatchApplying(true)
    setAgentNotice('')
    try {
      const result = await window.electronAPI.localCodingAgent.applyPatch(request.jobId)
      if (!result.success) {
        const message = result.error || '本地智能体补丁应用失败'
        setAgentNotice(message)
        await appendLocalAgentPatchActionResult(request, `补丁应用失败：${message}`)
        return
      }
      const changedPaths = result.changedPaths?.length ? result.changedPaths : request.changedPaths
      await appendLocalAgentPatchActionResult(request, `补丁已应用：\n${changedPaths.map((item) => `- ${item}`).join('\n')}`)
      setLocalAgentPatchRequest(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : '本地智能体补丁应用失败'
      setAgentNotice(message)
      await appendLocalAgentPatchActionResult(request, `补丁应用失败：${message}`)
    } finally {
      setLocalAgentPatchApplying(false)
    }
  }, [appendLocalAgentPatchActionResult, localAgentPatchApplying, localAgentPatchRequest])

  const handleDiscardLocalAgentPatch = useCallback(async () => {
    const request = localAgentPatchRequest
    if (!request || localAgentPatchApplying) return
    setLocalAgentPatchApplying(true)
    setAgentNotice('')
    try {
      await window.electronAPI.localCodingAgent.discardPatch(request.jobId)
      await appendLocalAgentPatchActionResult(request, '本地智能体补丁已丢弃。')
      setLocalAgentPatchRequest(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : '本地智能体补丁丢弃失败'
      setAgentNotice(message)
    } finally {
      setLocalAgentPatchApplying(false)
    }
  }, [appendLocalAgentPatchActionResult, localAgentPatchApplying, localAgentPatchRequest])

  // 只有最后一条消息里可能挂着待确认的工具调用（见 toolApproval.ts：本轮结束即暂停等待用户响应）
  const pendingToolApprovals = useMemo<ToolApprovalBarItem[]>(() => {
    const lastMessage = messages[messages.length - 1]
    if (!lastMessage || lastMessage.role !== 'assistant') return []
    const items: ToolApprovalBarItem[] = []
    for (const part of lastMessage.parts) {
      if (!('state' in part) || part.state !== 'approval-requested') continue
      const approvalId = (part as { approval?: { id?: unknown } }).approval?.id
      if (typeof approvalId !== 'string' || !approvalId) continue
      const toolName = part.type.replace(/^tool-/, '')
      items.push({
        approvalId,
        toolName,
        description: describeToolApprovalRequest(toolName, (part as { input?: unknown }).input),
      })
    }
    return items
  }, [messages])

  const handleModelSelect = useCallback((id: string) => {
    const model = models.find((item) => item.id === id)
    if (!model || model.disabled) return
    setSelectedPresetId(id)
    setModelOverride(null)
    setModelOpen(false)
  }, [models])

  // 二级菜单选模型：切到该提供商（预设）并覆盖模型；选回预设自带模型时清覆盖
  const handlePresetModelSelect = useCallback((presetId: string, modelId: string) => {
    setSelectedPresetId(presetId)
    const preset = presets.find((item) => item.id === presetId)
    const baseModel = preset ? preset.model : currentModelId
    setModelOverride(baseModel === modelId ? null : modelId)
    setModelOpen(false)
  }, [presets, currentModelId])

  // 拉取某提供商条目的模型列表（'current' 条目用当前配置的凭据）
  const fetchEntryModels = useCallback(async (entryId: string) => {
    const preset = presets.find((item) => item.id === entryId)
    const options = preset
      ? { provider: preset.provider, apiKey: preset.apiKey, baseURL: preset.baseURL, protocol: preset.protocol }
      : { provider: currentProviderId, apiKey: currentProviderConfig?.apiKey, baseURL: currentProviderConfig?.baseURL, protocol: currentProviderConfig?.protocol }
    if (!options.provider || presetModelsInFlightRef.current.has(entryId)) return
    presetModelsInFlightRef.current.add(entryId)
    setPresetModelsLoading((state) => ({ ...state, [entryId]: true }))
    try {
      const res = await window.electronAPI.ai.listModels(options)
      if (res.success) {
        // 只回模型 id 时先去 models.dev 目录对（中转站常用 "vendor/model-id" 前缀，剥掉再试），
        // 命中就借用目录的能力元数据/显示名，id 保留中转站原始值（实际请求要用它）
        const matchCatalogDetail = (id: string): AIModelInfo | undefined => {
          const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
          return modelInfoByKey.get(id) || modelInfoByKey.get(bare)
            || modelInfoByKey.get(id.toLowerCase()) || modelInfoByKey.get(bare.toLowerCase())
        }
        const details = res.modelDetails?.length
          ? res.modelDetails
          : (res.models || []).map((id) => {
              const matched = matchCatalogDetail(id)
              return matched ? { ...matched, id, providerId: options.provider } : toBasicModelDetail(id, options.provider)
            })
        setPresetModels((state) => ({ ...state, [entryId]: details }))
      }
    } catch {
      // 拉取失败保留旧列表，用户可点刷新重试
    } finally {
      presetModelsInFlightRef.current.delete(entryId)
      setPresetModelsLoading((state) => ({ ...state, [entryId]: false }))
    }
  }, [presets, currentProviderId, currentProviderConfig, modelInfoByKey])

  // 条目的模型列表：实拉的优先，否则用 models.dev 目录
  const entryModelDetails = useCallback((entry: AgentModelItem): AIModelInfo[] => {
    return presetModels[entry.id] ?? (providersInfo.find((provider) => provider.id === entry.chefSlug)?.modelDetails || [])
  }, [presetModels, providersInfo])

  // 只在用户悬停、准备展开某个提供商时拉取；打开一级菜单本身不会发模型列表请求。
  const ensureEntryModels = useCallback((entry: AgentModelItem) => {
    if (entry.kind === 'local-agent') return
    if (presetModels[entry.id] || presetModelsLoading[entry.id]) return
    const catalog = providersInfo.find((provider) => provider.id === entry.chefSlug)?.modelDetails || []
    if (catalog.length > 0) return
    void fetchEntryModels(entry.id)
  }, [fetchEntryModels, presetModels, presetModelsLoading, providersInfo])

  useEffect(() => {
    if (!conversationId || messages.length === 0) return

    if (busy) {
      if (streamingSaveTimerRef.current !== null) return
      const elapsedMs = Date.now() - lastStreamingSaveAtRef.current
      const delayMs = Math.max(0, STREAMING_AGENT_SAVE_INTERVAL_MS - elapsedMs)
      streamingSaveTimerRef.current = window.setTimeout(() => {
        streamingSaveTimerRef.current = null
        lastStreamingSaveAtRef.current = Date.now()
        flushConversationMessagesToStorage()
      }, delayMs)
      return
    }

    if (streamingSaveTimerRef.current !== null) {
      window.clearTimeout(streamingSaveTimerRef.current)
      streamingSaveTimerRef.current = null
    }
    lastStreamingSaveAtRef.current = Date.now()
    flushConversationMessagesToStorage({ refreshRecords: true })
  }, [busy, conversationId, flushConversationMessagesToStorage, messages, subAgentProgress, toolElapsedByKey])

  useEffect(() => {
    return () => {
      if (streamingSaveTimerRef.current !== null) {
        window.clearTimeout(streamingSaveTimerRef.current)
        streamingSaveTimerRef.current = null
      }
      flushConversationMessagesToStorage()
    }
  }, [flushConversationMessagesToStorage])

  // 出处：会话名解析
  const sessionNameMap = useMemo(() => new Map(sessions.map((s) => [s.username, s.displayName])), [sessions])
  const sourceSessionIdKey = useMemo(() => {
    const ids = new Set<string>()
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      for (const source of extractSources(message.parts)) ids.add(source.sessionId)
    }
    return Array.from(ids).sort().join('\n')
  }, [messages])
  useEffect(() => {
    const ids = sourceSessionIdKey.split('\n').filter(Boolean)
    const missing = ids.filter((id) => !sessionNameMap.has(id) && !sourceNameById[id])
    if (missing.length === 0) return

    let cancelled = false
    void (async () => {
      try {
        await window.electronAPI.chat.connect?.()
      } catch {
        // 未连接时仍尝试走头像/联系人查询兜底。
      }
      return Promise.all(
        missing.map(async (id) => {
          try {
            const result = await window.electronAPI.chat.getContactAvatar(id)
            return [id, result?.displayName || id] as const
          } catch {
            return [id, id] as const
          }
        })
      )
    })().then((entries) => {
      if (cancelled) return
      setSourceNameById((prev) => {
        const next = { ...prev }
        for (const [id, displayName] of entries) next[id] = displayName
        return next
      })
    })

    return () => {
      cancelled = true
    }
  }, [sessionNameMap, sourceNameById, sourceSessionIdKey])
  const sessionNameOf = useCallback((sessionId: string) => (
    sessionNameMap.get(sessionId) || sourceNameById[sessionId] || sessionId
  ), [sessionNameMap, sourceNameById])
  let latestAssistantMessageId = ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'assistant') {
      latestAssistantMessageId = messages[index].id
      break
    }
  }
  // 新对话（还没有任何消息）时输入框居中展示，发出首条消息后回到底部
  const promptCentered = messages.length === 0
  // 居中态输入框上方的欢迎 Lottie：进入对话后隐藏并暂停，回到新对话再续播
  const welcomeLottieInstanceRef = useRef<DotLottie | null>(null)
  const handleWelcomeLottieRef = useCallback((instance: DotLottie | null) => {
    welcomeLottieInstanceRef.current = instance
  }, [])
  useEffect(() => {
    const instance = welcomeLottieInstanceRef.current
    if (!instance) return
    if (promptCentered) instance.play()
    else instance.pause()
  }, [promptCentered])

  return (
    <Surface
      className={`relative flex h-full min-h-0 flex-col overflow-hidden${agentGlassReady ? ' agent-glass-ready' : ''}`}
      style={{ '--agent-radius': '12px' } as CSSProperties}
      variant="transparent"
    >
      <AgentGlassDefs onReady={handleAgentGlassReady} />
      <div className="relative flex h-14 shrink-0 items-center justify-center border-b border-border/60 px-3">
        <div className="absolute left-3 top-1/2 flex -translate-y-1/2 items-center">
          <Tooltip delay={0}>
            <HeroButton
              aria-label="工作区文件树"
              className="size-9 p-0"
              isIconOnly
              onPress={() => setWorkspaceSidebarOpen((open) => !open)}
              size="md"
              variant={workspaceSidebarOpen ? 'secondary' : 'tertiary'}
            >
              <LayoutSideContentLeft className="size-4.5" />
            </HeroButton>
            <Tooltip.Content placement="bottom">{workspaceSidebarOpen ? '隐藏工作区文件树' : '显示工作区文件树'}</Tooltip.Content>
          </Tooltip>
        </div>
        <div className="absolute left-1/2 top-1/2 min-w-0 max-w-[min(36rem,calc(100%-14rem))] -translate-x-1/2 -translate-y-1/2">
          {titleEditing ? (
            <input
              aria-label="编辑对话名称"
              className="h-9 w-90 max-w-[calc(100vw-14rem)] rounded-(--agent-radius,12px) border border-border bg-background px-3 text-center font-medium text-foreground text-sm outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/30"
              disabled={titleSaving}
              onBlur={() => {
                if (titleIgnoreBlurRef.current) {
                  titleIgnoreBlurRef.current = false
                  return
                }
                void commitTitleEdit()
              }}
              onChange={(event) => setTitleDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void commitTitleEdit()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelTitleEdit()
                }
              }}
              ref={titleInputRef}
              value={titleDraft}
            />
          ) : (
            <Tooltip delay={0}>
              <button
                className="group inline-flex h-9 min-w-0 max-w-full items-center justify-center gap-1.5 rounded-(--agent-radius,12px) px-3 text-center hover:bg-accent/40"
                onClick={beginTitleEdit}
                type="button"
              >
                <span className="truncate font-medium text-sm text-foreground">
                  {titleSaving ? '保存中...' : titleLoading ? '生成标题中...' : conversationTitle}
                </span>
                <PencilToLine className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
              <Tooltip.Content placement="bottom">
                {titleLoading ? '正在生成标题' : `编辑对话名称：${conversationTitle}`}
              </Tooltip.Content>
            </Tooltip>
          )}
        </div>
        <div className="absolute right-3 top-1/2 -translate-y-1/2">
          <Toolbar aria-label="对话操作" className="gap-1.5 p-0">
            <CodeWorkspacePanelPopover
              activeTab={codeWorkspacePanelTab}
              isOpen={codeWorkspacePanelOpen}
              logs={codeWorkspaceLogs}
              onActiveTabChange={setCodeWorkspacePanelTab}
              onOpenChange={setCodeWorkspacePanelOpen}
              onStopDevServer={handleStopCodeDevServer}
              state={codeWorkspaceState}
            />
            <div className="flex items-center gap-1.5">
              <Tooltip delay={0}>
                <Tooltip.Trigger>
                  <Dropdown isOpen={canvasMenuOpen} onOpenChange={handleCanvasMenuOpenChange}>
                    <HeroButton
                      aria-label="画布"
                      className="size-9 p-0"
                      isDisabled={!conversationId}
                      isIconOnly
                      size="md"
                      variant={canvas.open ? 'secondary' : 'tertiary'}
                    >
                      <FileText className="size-4.5" />
                    </HeroButton>
                    <Dropdown.Popover className="min-w-72" placement="bottom end">
                      <Dropdown.Menu
                        className="ct-agent-scrollbar max-h-[min(26rem,65vh)] overflow-y-auto"
                        disabledKeys={new Set(['canvas-status'])}
                        onAction={(key) => {
                          const action = String(key)
                          if (action === 'canvas-new-document') handleCreateCanvas('document')
                          else if (action === 'canvas-new-code') handleCreateCanvas('code')
                          else if (action.startsWith('canvas-open:')) handleOpenCanvasItem(action.slice('canvas-open:'.length))
                        }}
                      >
                        <Dropdown.Section>
                          <Header>新建</Header>
                          <Dropdown.Item id="canvas-new-document" textValue="新建文档画布">
                            <FileText className="size-4 shrink-0 text-muted" />
                            <Label>文档画布</Label>
                          </Dropdown.Item>
                          <Dropdown.Item id="canvas-new-code" textValue="新建代码画布">
                            <Code className="size-4 shrink-0 text-muted" />
                            <Label>代码画布</Label>
                          </Dropdown.Item>
                        </Dropdown.Section>
                        <Separator />
                        <Dropdown.Section>
                          <Header>当前会话</Header>
                          {canvasMenuLoading ? (
                            <Dropdown.Item id="canvas-status" textValue="正在加载画布">
                              <Spinner size="sm" />
                              <Label>正在加载...</Label>
                            </Dropdown.Item>
                          ) : canvasItems.length > 0 ? (
                            canvasItems.map((item) => (
                              <Dropdown.Item
                                id={`canvas-open:${item.id}`}
                                key={item.id}
                                textValue={item.title}
                              >
                                {item.kind === 'code'
                                  ? <Code className="size-4 shrink-0 text-muted" />
                                  : <FileText className="size-4 shrink-0 text-muted" />}
                                <Label className="min-w-0 flex-1 truncate">{item.title}</Label>
                                <span className="ml-auto shrink-0 text-muted-foreground text-xs">
                                  {item.status === 'archived' ? '已归档' : `v${item.revision}`}
                                </span>
                              </Dropdown.Item>
                            ))
                          ) : (
                            <Dropdown.Item id="canvas-status" textValue="暂无画布">
                              <Label className="text-muted-foreground">暂无画布</Label>
                            </Dropdown.Item>
                          )}
                        </Dropdown.Section>
                      </Dropdown.Menu>
                    </Dropdown.Popover>
                  </Dropdown>
                </Tooltip.Trigger>
                <Tooltip.Content placement="bottom">{conversationId ? '画布' : '发送消息后可使用画布'}</Tooltip.Content>
              </Tooltip>
              <AgentRecordsMenu
                isOpen={recordsOpen}
                onOpenChange={handleRecordsOpenChange}
                records={conversationRecords}
                selectedId={conversationId}
                onOpenRecord={handleOpenRecord}
                onDeleteRecord={(record) => {
                  setRecordPendingDelete(record)
                  setRecordsOpen(false)
                }}
              />
              <Tooltip delay={0}>
                <HeroButton
                  aria-label="分享对话"
                  className="size-9 p-0"
                  isDisabled={effectiveBusy}
                  isIconOnly
                  onPress={handleOpenShare}
                  size="md"
                  variant="tertiary"
                >
                  <ArrowUpRightFromSquare className="size-4.5" />
                </HeroButton>
                <Tooltip.Content placement="bottom">{effectiveBusy ? '输出结束后可分享' : '分享对话'}</Tooltip.Content>
              </Tooltip>
              <Tooltip delay={0}>
                <HeroButton
                  aria-label="新建对话"
                  className="size-9 p-0"
                  isIconOnly
                  onPress={handleNewConversation}
                  size="md"
                  variant="tertiary"
                >
                  <PencilToSquare className="size-4.5" />
                </HeroButton>
                <Tooltip.Content placement="bottom">新建对话</Tooltip.Content>
              </Tooltip>
            </div>
          </Toolbar>
        </div>
      </div>
      {memoryIntroStatus === 'checking' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground text-sm">
          <Loader />
        </div>
      ) : memoryIntroStatus === 'needed' ? (
        <AgentMemoryIntro onMemoryCreated={markMemoryIntroSatisfied} />
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {workspaceSidebarOpen && (
            <CodeWorkspaceSidebar
              onSelect={handleSelectCodeWorkspace}
              state={codeWorkspaceState}
            />
          )}
          <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      <Conversation className="min-h-0 flex-1">
        <ConversationAutoScroll enabled={shouldAnchorLatestUser} trigger={latestUserMessageId} />
        <ConversationContent className="mx-auto w-full min-w-80 max-w-[82%] pt-4 pb-48">
          {messages.length === 0 ? null : (
            messages.map((message, messageIndex) => (
              <AgentMessageItem
                busy={effectiveBusy}
                copied={copiedMessageId === message.id}
                isLastMessage={messageIndex === messages.length - 1}
                isLatestAssistant={message.id === latestAssistantMessageId}
                key={message.id}
                message={message}
                messageIndex={messageIndex}
                onCopyAssistant={handleCopyAssistantMessage}
                onCopyUser={handleCopyUserMessage}
                onEdit={handleEditUserMessage}
                onExecutePlan={handleExecutePlan}
                onOpenCanvas={handleOpenCanvasReference}
                onPreviewGeneratedImage={setGeneratedImagePreview}
                onSpeak={handleSpeakAssistantMessage}
                runIsPlan={runIsPlanRef.current}
                selectedModelSupportsTools={selectedModelSupportsTools}
                sessionNameOf={sessionNameOf}
                speaking={speakingMessageId === message.id}
                status={effectiveStatus}
                subAgentProgress={subAgentProgress}
                toolElapsedByKey={toolElapsedByKey}
              />
            ))
          )}
          {waitingFirstModelOutput && (
            <Message from="assistant">
              <MessageContent>
                <ModelWaitingLine />
              </MessageContent>
            </Message>
          )}
          {agentNotice && (
            <div
              className={`mt-3 whitespace-pre-line rounded-(--agent-radius,12px) border px-3 py-2 text-xs ${
                agentNotice.startsWith('状态：')
                  ? 'border-border bg-muted/35 text-muted-foreground'
                  : 'border-destructive/30 bg-destructive/5 text-destructive'
              }`}
            >
              {agentNotice}
            </div>
          )}
         {busy && subAgentProgress.length > 0 && !lastAssistantMessageHasDelegateTool && <SubAgentProgressPanel events={subAgentProgress} />}
        </ConversationContent>
        <ConversationScrollButton className="bottom-36 z-30 agent-scroll-glass" />
      </Conversation>

      {/* 新对话时输入框居中变窄并带标题；首条消息发出后平滑下移到底部恢复全宽 */}
      <div className="pointer-events-none absolute inset-0">
        <div
          className={`absolute right-0 left-0 grid place-items-center px-5 transition-all duration-500 ease-in-out ${
            promptCentered ? 'bottom-1/2 translate-y-1/2' : 'bottom-3 translate-y-0'
          }`}
        >
          <div className={`pointer-events-auto w-full transition-[max-width] duration-500 ease-in-out ${promptCentered ? 'max-w-2xl' : 'max-w-4xl'}`}>
        <div
          aria-hidden={!promptCentered}
          className={`overflow-hidden transition-all duration-500 ease-in-out ${
            promptCentered ? 'mb-4 max-h-64 opacity-100' : 'mb-0 max-h-0 opacity-0'
          }`}
        >
          <LottieView
            autoplay
            className="mx-auto h-56 w-56"
            dotLottieRefCallback={handleWelcomeLottieRef}
            loop
            src={welcomeLottieUrl}
          />
        </div>
        {localAgentPatchRequest && (
          <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2 rounded-(--agent-radius,12px) border border-border bg-surface/90 px-3 py-2 text-xs shadow-lg">
            <Terminal className="size-4 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-foreground">本地智能体生成了补丁</div>
              <div className="truncate text-muted-foreground">
                {localAgentPatchRequest.changedPaths.slice(0, 4).join('、')}
                {localAgentPatchRequest.changedPaths.length > 4 ? ` 等 ${localAgentPatchRequest.changedPaths.length} 个文件` : ''}
              </div>
            </div>
            <HeroButton
              isDisabled={localAgentPatchApplying}
              onPress={handleApplyLocalAgentPatch}
              size="sm"
              variant="primary"
            >
              {localAgentPatchApplying ? <Spinner size="sm" /> : <Check className="size-3.5" />}
              应用
            </HeroButton>
            <HeroButton
              isDisabled={localAgentPatchApplying}
              onPress={handleDiscardLocalAgentPatch}
              size="sm"
              variant="tertiary"
            >
              丢弃
            </HeroButton>
          </div>
        )}
        <AgentApprovalBar
          codeWorkspaceApproval={codeWorkspaceApproval}
          onCodeWorkspaceApprove={handleApproveCodeWorkspace}
          onCodeWorkspaceReject={handleRejectCodeWorkspace}
          onExpandCodeWorkspaceApproval={() => setCodeWorkspaceApprovalExpanded(true)}
          onToolApprove={handleToolApproval}
          toolApprovals={pendingToolApprovals}
        />
        <PromptInputProvider>
          <PromptInputControllerBridge controllerRef={promptInputControllerRef} />
          <PromptInput
            accept="image/*,.txt,.md,.json,.csv,.pdf,application/pdf"
            aria-busy={promptOptimizing}
            className={`agent-prompt-input w-full **:data-[slot=input-group]:relative **:data-[slot=input-group]:overflow-visible **:data-[slot=input-group]:border-border **:data-[slot=input-group]:bg-surface/55 **:data-[slot=input-group]:shadow-lg ${promptOptimizing ? 'agent-prompt-input--optimizing' : ''} ${workspaceFileDragOver ? '**:data-[slot=input-group]:ring-2 **:data-[slot=input-group]:ring-primary/45' : ''}`}
            maxFiles={6}
            maxFileSize={8 * 1024 * 1024}
            multiple
            onDragLeave={handleWorkspaceFileDragLeave}
            onDragOver={handleWorkspaceFileDragOver}
            onDrop={handleWorkspaceFileDrop}
            onSubmit={handleSubmit}
          >
            <AgentPromptAssetHeader
              onRemoveWorkspaceFileReference={removeWorkspaceFileReference}
              workspaceFileReferences={workspaceFileReferences}
            />

            <PromptInputBody>
              <MentionField
                hasMore={mentionHasMore}
                isLoading={mentionLoading}
                mentions={mentions}
                onAdd={addMention}
                onLoadMore={loadMentionSessions}
                onRemove={removeMention}
                onSearch={searchMentionSessions}
                sessions={sessions}
              />
              <PromptInputTextarea
                className="min-h-10 max-h-40 py-2 pr-10 text-sm leading-5"
                placeholder={selectedLocalAgentId ? '让本地智能体处理当前代码工作区，Enter 发送，Shift + Enter 换行…' : '问问你的聊天记录，Enter 发送，Shift + Enter 换行…'}
              />
              <AgentPromptOptimizeButton onOptimize={handleOptimizePrompt} optimizing={promptOptimizing} />
            </PromptInputBody>

            <PromptInputFooter className="items-center gap-1.5 px-2.5 pt-1 pb-2">
              <PromptInputTools className="flex-wrap gap-1.5">
                <ButtonGroup size="sm" variant="tertiary">
                  <PromptInputActionMenu>
                    <PromptInputActionMenuTrigger aria-label="更多输入操作" variant="tertiary" />
                    <PromptInputActionMenuContent>
                      <PromptInputActionAddAttachments label="添加图片或文件" />
                      <Dropdown.Item
                        id="plan-mode"
                        textValue="计划模式"
                        onAction={() => setPlanMode((value) => !value)}
                      >
                        <ListCheck className="size-4 shrink-0 text-muted" />
                        <Label>计划模式</Label>
                        <span className="ml-auto inline-flex pointer-events-none">
                          <Switch aria-label="计划模式" isSelected={planMode}>
                            <Switch.Control>
                              <Switch.Thumb />
                            </Switch.Control>
                          </Switch>
                        </span>
                      </Dropdown.Item>
                    </PromptInputActionMenuContent>
                  </PromptInputActionMenu>
                  <PromptPresetButton showGroupSeparator />
                  <SlashCommandButton
                    commands={slashCommands}
                    showGroupSeparator
                  />
                  <MentionTriggerButton showGroupSeparator />
                </ButtonGroup>

                {planMode && (
                  <HeroButton
                    aria-label="关闭计划模式"
                    className="gap-1"
                    onPress={() => setPlanMode(false)}
                    size="sm"
                    variant="secondary"
                  >
                    <ListCheck className="size-3.5" />
                    计划模式
                    <Xmark className="size-3" />
                  </HeroButton>
                )}

                <AgentToolApprovalPolicyDropdown
                  policy={agentToolApprovalPolicy}
                  onChange={handleAgentToolApprovalPolicyChange}
                />
              </PromptInputTools>

              <div className="flex items-center gap-2">
                <div className="flex items-center gap-0.5">
                  {/* 模型选择：一级列表是提供商（预设），二级列表是该提供商的模型；按钮只显示当前模型名 */}
                  <Dropdown isOpen={modelOpen} onOpenChange={setModelOpen}>
                  <HeroButton
                    aria-label="选择模型"
                    className="ct-agent-trigger-button max-w-56 pr-1.5"
                    size="sm"
                    variant="ghost"
                  >
                    {selectedLocalAgentId ? (
                      <Terminal className="size-4 shrink-0 text-muted" />
                    ) : selectedModelData?.chefSlug && (
                      <AIProviderLogo providerId={selectedModelData.chefSlug} alt={selectedModelData.chef} className="shrink-0" size={18} />
                    )}
                    <span className="min-w-0 flex-1 truncate text-left">
                      {selectedLocalAgentId
                        ? selectedModelData?.name
                        : effectiveModelDetail?.name || effectiveModelId || selectedModelData?.name || '选择模型'}
                    </span>
                    <ChevronDown className="size-3.5 shrink-0" />
                  </HeroButton>
                  <Dropdown.Popover className="min-w-72 overflow-hidden" placement="top end">
                    {/* 高度限制加在 Menu 上（Popover 层不吃约束，同 PromptPresetButton 的做法），列表再长也不会顶到标题栏 */}
                    <Dropdown.Menu
                      className="ct-agent-scrollbar max-h-[min(24rem,60vh)] overflow-y-auto"
                      selectedKeys={selectedModelKeys}
                      selectionMode="single"
                      onAction={(key) => handleModelSelect(String(key))}
                    >
                      {chefs.map((chef) => (
                        <Dropdown.Section key={chef}>
                          <Header>{chef}</Header>
                          {models
                            .filter((model) => model.chef === chef)
                            .map((model) => {
                              if (model.kind === 'local-agent') {
                                return <ModelItem key={model.id} model={model} />
                              }
                              const details = entryModelDetails(model)
                              const loading = !!presetModelsLoading[model.id]
                              return (
                                <Dropdown.SubmenuTrigger key={model.id}>
                                  <Dropdown.Item
                                    className="group data-selected:bg-muted/70 data-selected:text-foreground"
                                    id={model.id}
                                    onHoverStart={() => ensureEntryModels(model)}
                                    textValue={model.name}
                                  >
                                    <span
                                      aria-hidden="true"
                                      className="h-5 w-0.5 shrink-0 rounded-full bg-transparent transition-colors group-data-selected:bg-accent"
                                    />
                                    {model.chefSlug && <AIProviderLogo providerId={model.chefSlug} alt={model.chef} className="shrink-0" size={20} />}
                                    <Label className="min-w-0 flex-1 truncate text-left">{model.name}</Label>
                                    <Dropdown.SubmenuIndicator />
                                  </Dropdown.Item>
                                  <Dropdown.Popover className="min-w-64 overflow-hidden" placement="right top">
                                    <div className="flex items-center justify-between gap-2 border-border/70 border-b py-1 pr-1 pl-3">
                                      <Label className="text-muted-foreground text-xs">
                                        {loading ? '正在获取模型…' : `${details.length} 个模型`}
                                      </Label>
                                      <HeroButton
                                        aria-label="刷新模型列表"
                                        isDisabled={loading}
                                        isIconOnly
                                        size="sm"
                                        variant="ghost"
                                        onPress={() => void fetchEntryModels(model.id)}
                                      >
                                        <ArrowsRotateLeft className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
                                      </HeroButton>
                                    </div>
                                    {details.length > 0 ? (
                                      <Dropdown.Menu
                                        className="ct-agent-scrollbar max-h-[min(20rem,55vh)] overflow-y-auto"
                                        disabledKeys={details.filter((detail) => !detail.capabilities.toolCall).map((detail) => detail.id)}
                                        selectedKeys={model.id === selectedPresetId ? new Set([effectiveModelId]) : new Set<string>()}
                                        selectionMode="single"
                                        onAction={(key) => handlePresetModelSelect(model.id, String(key))}
                                      >
                                        {details.map((detail) => (
                                          <Dropdown.Item id={detail.id} key={detail.id} textValue={detail.name || detail.id}>
                                            <Dropdown.ItemIndicator />
                                            <Label className="min-w-0 flex-1 truncate text-left">{detail.name || detail.id}</Label>
                                            <span className="ml-auto flex shrink-0 items-center gap-1.5">
                                              <ModelCapabilityIcons detail={detail} />
                                              {!detail.capabilities.toolCall && <span className="text-[10px] text-muted-foreground">无工具</span>}
                                            </span>
                                          </Dropdown.Item>
                                        ))}
                                      </Dropdown.Menu>
                                    ) : (
                                      <div className="px-3 py-4 text-center text-muted-foreground text-xs">
                                        {loading ? '正在获取模型…' : '暂无模型，点右上角刷新获取'}
                                      </div>
                                    )}
                                  </Dropdown.Popover>
                                </Dropdown.SubmenuTrigger>
                              )
                            })}
                        </Dropdown.Section>
                      ))}
                    </Dropdown.Menu>
                  </Dropdown.Popover>
                  </Dropdown>

                  {/* 思考强度：六档离散滑杆，GPT-5.6 的 max 档在最右侧。 */}
                  {!selectedLocalAgentId && (
                    <AgentReasoningEffortControl value={reasoningEffort} onChange={setReasoningEffort} />
                  )}
                </div>
                <ButtonGroup size="sm">
                  <AgentPromptPrimaryAction busy={effectiveBusy} status={effectiveStatus} workspaceReferenceCount={workspaceFileReferences.length} />
                </ButtonGroup>
              </div>
            </PromptInputFooter>
          </PromptInput>
        </PromptInputProvider>
        {/* 居中态不展示输入框下方这行（工作区面板 + Token 用量），仅渐隐渐显 */}
        <div className={`mt-2 flex w-full items-center justify-between gap-3 px-2 transition-opacity duration-500 ease-in-out ${promptCentered ? 'pointer-events-none opacity-0' : 'opacity-100'}`}>
          <CodeWorkspacePanel
            approval={codeWorkspaceApproval}
            className="min-w-0 flex-1"
            expanded={codeWorkspaceApprovalExpanded}
            onApprove={handleApproveCodeWorkspace}
            onExpandedChange={setCodeWorkspaceApprovalExpanded}
            onReject={handleRejectCodeWorkspace}
            onSelect={handleSelectCodeWorkspace}
            onStopDevServer={handleStopCodeDevServer}
            state={codeWorkspaceState}
          />
          {conversationUsage.hasAny && (
            <div className="ml-auto flex shrink-0 items-center justify-end gap-3 whitespace-nowrap text-[11px] text-muted-foreground">
              <span>本次会话Token用量</span>
              <span>输入 {formatTokenCount(conversationUsage.input)}</span>
              <span>输出 {formatTokenCount(conversationUsage.output)}</span>
              <span className="font-medium text-foreground/80">共 {formatTokenCount(conversationUsage.total)}</span>
            </div>
          )}
        </div>
          </div>
        </div>
      </div>
          </div>
          {canvas.open && (
            <AgentCanvasPanel canvas={canvas} markedRevision={canvasMarkedRevision} />
          )}
        </div>
      )}
      <AlertDialog.Backdrop
        isOpen={recordPendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !recordDeleting) setRecordPendingDelete(null)
        }}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-100">
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger">
                <TrashBin className="size-5" />
              </AlertDialog.Icon>
              <AlertDialog.Heading>删除这条对话记录？</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>删除后无法恢复。</p>
              {recordPendingDelete && (
                <p className="mt-2 truncate font-medium text-foreground">{recordPendingDelete.title}</p>
              )}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <HeroButton
                isDisabled={recordDeleting}
                variant="tertiary"
                onPress={() => setRecordPendingDelete(null)}
              >
                取消
              </HeroButton>
              <HeroButton isDisabled={recordDeleting} variant="danger" onPress={confirmDeleteRecord}>
                {recordDeleting ? '删除中...' : '删除'}
              </HeroButton>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
      <Modal.Backdrop
        isOpen={shareOpen}
        onOpenChange={(open) => {
          if (shareSaving) return
          setShareOpen(open)
        }}
      >
        <Modal.Container placement="center" size="cover">
          <Modal.Dialog className="max-h-[calc(100vh-5rem)]">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Icon className="bg-accent-soft text-accent-soft-foreground">
                <ArrowUpRightFromSquare className="size-5" />
              </Modal.Icon>
              <Modal.Heading>分享 Agent 对话</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <div className="grid min-h-136 gap-5 lg:grid-cols-[20rem_minmax(0,1fr)]">
                <div className="min-h-0 rounded-(--agent-radius,12px) border border-border bg-muted/20 p-3">
                  <SearchField
                    aria-label="搜索对话"
                    className="mb-3"
                    value={shareSearch}
                    onChange={setShareSearch}
                  >
                    <SearchField.Group>
                      <SearchField.SearchIcon />
                      <SearchField.Input placeholder="搜索对话标题" />
                      <SearchField.ClearButton />
                    </SearchField.Group>
                  </SearchField>
                  <div className="ct-agent-scrollbar max-h-120 space-y-1 overflow-y-auto pr-1">
                    {conversationRecords.length === 0 ? (
                      <div className="flex min-h-40 items-center justify-center rounded-(--agent-radius,12px) border border-dashed border-border text-muted-foreground text-sm">
                        暂无对话记录
                      </div>
                    ) : shareFilteredRecords.length === 0 ? (
                      <div className="flex min-h-40 items-center justify-center rounded-(--agent-radius,12px) border border-dashed border-border text-muted-foreground text-sm">
                        没有匹配的对话
                      </div>
                    ) : shareFilteredRecords.map((record) => {
                      const selected = shareSelectedId === record.id
                      return (
                        <button
                          className={`flex w-full items-center gap-3 rounded-(--agent-radius,12px) border px-3 py-2.5 text-left transition ${
                            selected
                              ? 'border-primary/40 bg-primary/10 text-primary'
                              : 'border-transparent hover:border-border hover:bg-background'
                          }`}
                          key={record.id}
                          onClick={() => { void loadShareConversation(record) }}
                          type="button"
                        >
                          <Clock className="size-4 shrink-0 opacity-70" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium text-sm">{record.title}</span>
                            <span className="block truncate text-muted-foreground text-xs">
                              {new Date(record.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </span>
                          {selected && <Check className="size-4 shrink-0" />}
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="min-h-0 overflow-hidden rounded-(--agent-radius,12px) border border-border bg-muted/30">
                  <div className="flex items-center justify-between gap-3 border-border border-b bg-background/80 px-4 py-3">
                    <div className="min-w-0">
                      <Label className="block truncate">分享图预览</Label>
                      <p className="truncate text-muted-foreground text-xs">仅包含用户与 Agent 的文本问答</p>
                    </div>
                    {sharePreviewData?.truncated && (
                      <span className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-700 text-xs dark:text-amber-300">
                        已截取
                      </span>
                    )}
                  </div>
                  <div className="ct-agent-scrollbar max-h-124 overflow-auto p-5">
                    {shareLoading ? (
                      <div className="flex min-h-80 items-center justify-center gap-2 text-muted-foreground text-sm">
                        <Spinner size="sm" />
                        正在加载预览
                      </div>
                    ) : sharePreviewData ? (
                      <div className="flex justify-center">
                        <div className="origin-top scale-[0.72] md:scale-[0.78] lg:scale-[0.82]">
                          <AgentShareCard data={sharePreviewData} />
                        </div>
                        <div
                          aria-hidden
                          className="pointer-events-none fixed -left-2500 top-0"
                        >
                          <AgentShareCard captureRef={shareCardRef} data={sharePreviewData} />
                        </div>
                      </div>
                    ) : (
                      <div className="flex min-h-80 items-center justify-center text-muted-foreground text-sm">
                        选择一个对话生成预览
                      </div>
                    )}
                  </div>
                </div>
              </div>
              {shareError && (
                <div className="mt-3 rounded-(--agent-radius,12px) border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-sm">
                  {shareError}
                </div>
              )}
            </Modal.Body>
            <Modal.Footer>
              <HeroButton
                isDisabled={shareSaving}
                variant="tertiary"
                onPress={() => setShareOpen(false)}
              >
                取消
              </HeroButton>
              <HeroButton
                isDisabled={!sharePreviewData || sharePreviewData.messages.length === 0 || shareLoading}
                isPending={shareSaving}
                variant="primary"
                onPress={handleSaveShareImage}
              >
                {({ isPending }) => (
                  <>
                    {isPending ? <Spinner color="current" size="sm" /> : <ArrowDownToLine className="size-4" />}
                    保存图片
                  </>
                )}
              </HeroButton>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
      {generatedImagePreview && (
        <ImagePreview
          src={generatedImagePreview.src}
          originRect={generatedImagePreview.originRect}
          onClose={() => setGeneratedImagePreview(null)}
        />
      )}
    </Surface>
  )
}
