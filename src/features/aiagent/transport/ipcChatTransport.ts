/**
 * IpcChatTransport —— 让 @ai-sdk/react 的 useChat 走 Electron IPC 而非 HTTP。
 * sendMessages 把 UIMessage 发给主进程（→ AI 子进程），把回推的 UIMessageChunk 拼成 ReadableStream。
 * 见 Docs/密语AI-Agent开发文档（AI-SDK版）.md §5.5。
 */
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'

export type AgentScope = { kind: 'global' } | { kind: 'session'; sessionId: string; displayName?: string }
export type AgentReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type AgentToolProfile = 'chat' | 'code' | 'hybrid'
export type CodeWorkspaceApprovalPolicy = 'on-request' | 'risk-based' | 'full-access'
export type CodeWorkspaceRef = {
  id: string
  root: string
  approvalPolicy: CodeWorkspaceApprovalPolicy
}
export type AgentCanvasRunContextInput = {
  activeCanvasId?: string
  activeRevision?: number
}
export type AgentModelConfig = {
  provider?: string
  apiKey?: string
  model?: string
  baseURL?: string
  protocol?: 'openai-responses' | 'openai-compatible' | 'anthropic' | 'google' | 'codex-subscription'
  reasoningEffort?: AgentReasoningEffort
}

export type AgentProgressEvent = {
  stage: 'run_started' | 'tool_started' | 'tool_finished' | 'indexing' | 'searching' | 'run_finished' | 'error'
  title: string
  detail?: string
  visible?: boolean
  category?: 'prep' | 'tool' | 'memory' | 'search' | 'system'
  toolName?: string
  toolCallId?: string
  parentToolCallId?: string
  subTaskId?: string
  subTaskTitle?: string
  sessionId?: string
  elapsedMs?: number
  messagesScanned?: number
  indexedCount?: number
  sessionsScanned?: number
  coverage?: string
  depth?: number
  at: number
}

interface AgentBridge {
  run: (
    runId: string,
    messages: unknown[],
    scope?: unknown,
    modelConfig?: AgentModelConfig | null,
    conversationId?: number | null,
    planMode?: boolean,
    toolProfile?: AgentToolProfile,
    codeWorkspace?: CodeWorkspaceRef | null,
    canvasContext?: AgentCanvasRunContextInput | null
  ) => Promise<{ success: boolean; error?: string }>
  abort: (runId: string) => Promise<{ success: boolean }>
  onChunk: (runId: string, callback: (chunk: unknown) => void) => () => void
  onProgress: (runId: string, callback: (progress: unknown) => void) => () => void
}

function getAgentBridge(): AgentBridge {
  const bridge = (window as any)?.electronAPI?.agent as AgentBridge | undefined
  if (!bridge) throw new Error('electronAPI.agent 未就绪（preload 未加载？）')
  return bridge
}

function randomRunId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `run-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
}


type AgentStreamSmokeRun = {
  runId: string
  startedAt: number
  updatedAt: number
  scope: AgentScope
  planMode: boolean
  toolProfile: AgentToolProfile
  chunkCount: number
  progressCount: number
  chunkTypes: Record<string, number>
  progressStages: Record<string, number>
  firstChunkMs?: number
  firstOutputMs?: number
  finishChunkMs?: number
  doneMs?: number
  finishReason?: string
  hasUsage: boolean
  usage?: unknown
  metadataKeys: string[]
  textPreview: string
  sampleChunks: unknown[]
  lastChunks: unknown[]
  errorText?: string
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

type AgentStreamSmokeStore = {
  last: AgentStreamSmokeRun | null
  runs: AgentStreamSmokeRun[]
  clear: () => void
}

function ensureSmokeStore(): AgentStreamSmokeStore | null {
  if (typeof window === 'undefined') return null
  const win = window as unknown as {
    __ctAgentStreamSmoke?: AgentStreamSmokeStore
  }
  if (!win.__ctAgentStreamSmoke) {
    win.__ctAgentStreamSmoke = {
      last: null,
      runs: [],
      clear: () => {
        if (!win.__ctAgentStreamSmoke) return
        win.__ctAgentStreamSmoke.last = null
        win.__ctAgentStreamSmoke.runs = []
      },
    }
  }
  return win.__ctAgentStreamSmoke
}

ensureSmokeStore()

function publishSmoke(run: AgentStreamSmokeRun): void {
  const store = ensureSmokeStore()
  if (!store || typeof window === 'undefined') return
  store.runs = [...store.runs.filter((item) => item.runId !== run.runId), run].slice(-20)
  store.last = run
  try {
    window.dispatchEvent(new CustomEvent('ct-agent-stream-smoke', { detail: run }))
  } catch {
    /* CustomEvent may be unavailable in tests. */
  }
}

function startSmokeRun(input: {
  runId: string
  scope: AgentScope
  planMode: boolean
  toolProfile: AgentToolProfile
}): AgentStreamSmokeRun | null {
  const startedAt = nowMs()
  const run: AgentStreamSmokeRun = {
    ...input,
    startedAt,
    updatedAt: Date.now(),
    chunkCount: 0,
    progressCount: 0,
    chunkTypes: {},
    progressStages: {},
    hasUsage: false,
    metadataKeys: [],
    textPreview: '',
    sampleChunks: [],
    lastChunks: [],
  }
  publishSmoke(run)
  return run
}

function updateSmoke(run: AgentStreamSmokeRun | null, updater: (run: AgentStreamSmokeRun) => void): void {
  if (!run) return
  updater(run)
  run.updatedAt = Date.now()
  publishSmoke(run)
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function observeSmokeChunk(run: AgentStreamSmokeRun | null, chunk: unknown): void {
  updateSmoke(run, (item) => {
    item.chunkCount += 1
    const elapsed = nowMs() - item.startedAt
    if (item.firstChunkMs === undefined) item.firstChunkMs = elapsed
    const object = readObject(chunk)
    const type = String(object?.type || 'unknown')
    item.chunkTypes[type] = (item.chunkTypes[type] || 0) + 1
    if (item.sampleChunks.length < 12) item.sampleChunks.push(chunk)
    item.lastChunks = [...item.lastChunks, chunk].slice(-12)
    if (item.firstOutputMs === undefined && ['text-delta', 'reasoning-delta', 'tool-input-start'].includes(type)) {
      item.firstOutputMs = elapsed
    }
    if (type === 'text-delta' && typeof object?.delta === 'string') {
      item.textPreview = `${item.textPreview}${object.delta}`.slice(-1000)
    }
    if (type === 'finish') {
      item.finishChunkMs = elapsed
      const metadata = readObject(object?.messageMetadata)
      item.metadataKeys = metadata ? Object.keys(metadata) : []
      item.finishReason = String(object?.finishReason || metadata?.finishReason || '') || undefined
      item.usage = metadata?.usage
      item.hasUsage = Boolean(metadata?.usage)
    }
    if (type === 'error') item.errorText = String(object?.errorText || object?.error || '') || 'stream error'
  })
}

function observeSmokeProgress(run: AgentStreamSmokeRun | null, progress: unknown): void {
  updateSmoke(run, (item) => {
    item.progressCount += 1
    const object = readObject(progress)
    const stage = String(object?.stage || 'unknown')
    item.progressStages[stage] = (item.progressStages[stage] || 0) + 1
  })
}
export class IpcChatTransport<UI_MESSAGE extends UIMessage = UIMessage> implements ChatTransport<UI_MESSAGE> {
  constructor(
    private readonly getScope?: () => AgentScope,
    private readonly getModelConfig?: () => AgentModelConfig | null,
    private readonly getConversationId?: () => number | null,
    private readonly onProgress?: (progress: AgentProgressEvent) => void,
    private readonly getPlanMode?: () => boolean,
    private readonly getToolProfile?: () => AgentToolProfile,
    private readonly getCodeWorkspace?: () => CodeWorkspaceRef | null,
    private readonly getCanvasContext?: () => AgentCanvasRunContextInput | null
  ) {}

  async sendMessages(options: {
    messages: UI_MESSAGE[]
    abortSignal: AbortSignal | undefined
  }): Promise<ReadableStream<UIMessageChunk>> {
    const bridge = getAgentBridge()
    const runId = randomRunId()
    const scope = this.getScope?.() ?? { kind: 'global' }
    const messages = options.messages as unknown[]
    const modelConfig = this.getModelConfig?.() ?? null
    const conversationId = this.getConversationId?.() ?? null
    const planMode = this.getPlanMode?.() ?? false
    const toolProfile = this.getToolProfile?.() ?? 'chat'
    const codeWorkspace = this.getCodeWorkspace?.() ?? null
    const canvasContext = this.getCanvasContext?.() ?? null
    const progressHandler = this.onProgress
    const smokeRun = startSmokeRun({ runId, scope, planMode, toolProfile })

    options.abortSignal?.addEventListener('abort', () => {
      updateSmoke(smokeRun, (item) => { item.errorText = 'aborted' })
      void bridge.abort(runId)
    })

    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        const off = bridge.onChunk(runId, (chunk) => {
          if (chunk === '[DONE]') {
            updateSmoke(smokeRun, (item) => { item.doneMs = nowMs() - item.startedAt })
            controller.close()
            off()
            return
          }
          observeSmokeChunk(smokeRun, chunk)
          controller.enqueue(chunk as UIMessageChunk)
        })
        const offProgress = bridge.onProgress(runId, (progress) => {
          if (progress && typeof progress === 'object') {
            observeSmokeProgress(smokeRun, progress)
            progressHandler?.(progress as AgentProgressEvent)
          }
        })
        // 触发主进程运行；run resolve 即代表本次结束（chunk 已通过 onChunk 推完，[DONE] 关流）
        void bridge.run(runId, messages, scope, modelConfig, conversationId, planMode, toolProfile, codeWorkspace, canvasContext).catch((error: unknown) => {
          try {
            const errorChunk = { type: 'error', errorText: error instanceof Error ? error.message : String(error) } as UIMessageChunk
            observeSmokeChunk(smokeRun, errorChunk)
            controller.enqueue(errorChunk)
            controller.close()
          } catch { /* 已关闭 */ }
          off()
          offProgress()
        }).finally(() => {
          offProgress()
        })
      },
    })
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    // 本地进程，无断线重连场景
    return null
  }
}
