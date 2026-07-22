/**
 * AI Agent 编排层 —— 类型与子进程通信协议。
 * 编排全程跑在独立的 AI utilityProcess 子进程（见 Docs/密语AI-Agent开发文档（AI-SDK版）.md §3.1）。
 */
import type { JSONSchema7, ModelMessage, UIMessageChunk } from 'ai'
import type { CodeWorkspaceRef } from './codeWorkspaceTypes'
import type { AgentCanvasRunContext } from './canvasTypes'

/** AI SDK provider 协议种类（对齐 ai/providers/base.ts 的 ProviderKind）。 */
export type ProviderKind = 'openai-responses' | 'openai-compatible' | 'anthropic' | 'google' | 'codex-subscription'

/** 由主进程注入子进程的 provider 配置（子进程不依赖 ConfigService/Electron app）。 */
export interface AgentProviderConfig {
  providerKind: ProviderKind
  name: string
  apiKey: string
  baseURL: string
  model: string
  /** 密语自己的 ChatGPT OAuth 文件绝对路径；不读取 ~/.codex/auth.json。 */
  authFilePath?: string
  headers?: Record<string, string>
  reasoningEffort?: AgentReasoningEffort
  /** 主进程注入的系统代理 URL（子进程无 session 探测不了）；空/无则直连。 */
  proxyUrl?: string
  /** 模型上下文窗口（token 数，来自 catalog limits.context）；用于 >90% 自动压缩的分母。未知则引擎用默认值。 */
  contextWindow?: number
  /** Anthropic prompt cache 断点 TTL（config key anthropicCacheTtl），默认 5m；1h 档写入计价 2×。 */
  anthropicCacheTtl?: '5m' | '1h'
}

export type AgentReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AgentProviderConfigOverride {
  provider?: string
  apiKey?: string
  model?: string
  baseURL?: string
  protocol?: ProviderKind
  reasoningEffort?: AgentReasoningEffort
}

export interface AgentPromptOptimizeContextMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface AgentPromptOptimizeInput {
  prompt: string
  context?: AgentPromptOptimizeContextMessage[]
  providerConfig: AgentProviderConfig
}

/** 提问范围：全局 / 限定单个会话（@ 某联系人或群时收窄）。 */
export type AgentScope =
  | { kind: 'global' }
  | { kind: 'session'; sessionId: string; displayName?: string }
  /** 克隆好友对话（personaChatEngine），sessionId 为被克隆好友的会话 */
  | { kind: 'persona'; sessionId: string; displayName?: string }

export interface AgentMcpToolDescriptor {
  name: string
  serverName: string
  toolName: string
  description?: string
  inputSchema?: JSONSchema7
}

export type AgentToolProfile = 'chat' | 'code' | 'hybrid'

export interface AgentSkillContextItem {
  name: string
  version: string
  description: string
  content: string
}

export type AgentProgressStage =
  | 'run_started'
  | 'tool_started'
  | 'tool_finished'
  | 'indexing'
  | 'searching'
  | 'run_finished'
  | 'error'

export interface AgentProgressEvent {
  stage: AgentProgressStage
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
  /** 进度深度：0=主 Agent，≥1=子 Agent（委托）；前端据此区分展示。 */
  depth?: number
  at: number
}

export type AgentProgressReporter = (event: AgentProgressEvent) => void

export interface AgentTraceStep {
  stepNumber: number
  callId?: string
  provider?: string
  modelId?: string
  finishReason?: string
  usage?: unknown
  elapsedMs?: number
  responseMs?: number
  timeToFirstOutputMs?: number
  outputTokensPerSecond?: number
  effectiveOutputTokensPerSecond?: number
}

export interface AgentTraceTool {
  toolCallId: string
  toolName: string
  elapsedMs: number
  error?: string
}

export interface AgentTraceMetadata {
  startedAt: number
  finishedAt?: number
  totalElapsedMs?: number
  firstStreamEventMs?: number
  firstOutputMs?: number
  stepCount: number
  toolCount: number
  steps: AgentTraceStep[]
  tools: AgentTraceTool[]
}

/** 一次 agent 运行的输入。 */
export interface AgentRunInput {
  messages: ModelMessage[]
  providerConfig: AgentProviderConfig
  scope: AgentScope
  uploadedMediaContext?: AgentUploadedMediaContext
  mcpTools?: AgentMcpToolDescriptor[]
  skills?: AgentSkillContextItem[]
  /** 禁用工具装配：用于微信机器人这类只需要纯文本回复的外部入口。 */
  toolMode?: 'default' | 'disabled'
  /** 输出场景：微信入口会追加微信发送约定，软件内聊天保持默认。 */
  outputMode?: 'default' | 'wechat'
  /**
   * 仅用于微信官方机器人入口：允许工具返回图片/文件作为"当前触发会话的回复附件"。
   * 不允许模型指定联系人、群、toUserId 或跨会话发送。
   */
  allowWechatReplyMedia?: boolean
  /** 计划模式：开启后本轮只制定执行计划、不给最终结论（见 prompts.ts PLAN_MODE_PROMPT）。 */
  planMode?: boolean
  /** 工具画像：chat=聊天/记忆工具，code=代码工作区工具，hybrid=两者同时挂载。 */
  toolProfile?: AgentToolProfile
  /** 用户选择的代码工作区；真正的文件/命令操作仍由主进程 CodeWorkspaceService 代理并审批。 */
  codeWorkspace?: CodeWorkspaceRef | null
  /** DeepSeek 这类前缀 KV cache provider：本轮动态上下文已作为隐藏 system 历史消息插入。 */
  turnContextMode?: 'tail' | 'history'
  /** 会话 Canvas 上下文（主进程校验归属后注入）；存在时挂载 canvas_* 工具。 */
  canvasContext?: AgentCanvasRunContext
}

export interface AgentUploadedMediaItem {
  id: string
  mediaType: string
  filename?: string
  dataUrl: string
  sizeBytes?: number
}

export interface AgentUploadedMediaContext {
  images: AgentUploadedMediaItem[]
}

// ========= 主进程 ↔ AI 子进程 postMessage 协议 =========
// 约定：id===0 && type==='ready' 为启动就绪信号；id===-1 && type==='chunk' 为流式 UI 消息块。

export type AgentRequest =
  | { id: number; type: 'ping' }
  | { id: number; type: 'run'; payload: { runId: string } & AgentRunInput }
  | { id: number; type: 'abort'; payload: { runId: string } }
  | { id: number; type: 'extractPersona'; payload: import('./persona/personaTypes').PersonaExtractInput }
  | { id: number; type: 'personaChat'; payload: { runId: string } & import('./persona/personaTypes').PersonaChatInput }

export type AgentResponse =
  | { id: number; result?: unknown; error?: string }
  | { id: 0; type: 'ready' }
  | { id: -1; type: 'chunk'; payload: { runId: string; chunk: UIMessageChunk } }
  | { id: -2; type: 'progress'; payload: { runId: string; progress: AgentProgressEvent } }
