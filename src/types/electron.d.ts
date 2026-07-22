import type {
  ChatSession,
  Message,
  Contact,
  ContactInfo,
} from './models'
import type { AccountProfile, AccountProfileInput, AccountProfilePatch } from './account'
import type { AIModelInfo, AIProviderInfo } from './ai'
import type { AgentReasoningEffort } from '../features/aiagent/transport/ipcChatTransport'

export interface EmbeddingConfig {
  enabled: boolean
  provider: string
  protocol: 'openai-compatible' | 'openai'
  apiKey: string
  baseURL: string
  model: string
  dimension: number
  imageEnabled?: boolean
  imageInputMode?: 'auto' | 'image_base64' | 'content_part' | 'data_url'
}

export interface RerankConfig {
  enabled: boolean
  provider: string
  protocol: 'openai-compatible'
  apiKey: string
  baseURL: string
  model: string
  timeoutMs: number
}


export type AgentConversationChangeType =
  | 'created'
  | 'messages-appended'
  | 'messages-replaced'
  | 'renamed'
  | 'metadata-updated'
  | 'deleted'

export interface AgentConversationUpdatedEvent {
  id: number
  accountId?: string
  scope?: unknown
  title?: string
  modelProvider?: string
  modelId?: string
  source?: string
  externalId?: string | null
  createdAt?: number
  updatedAt?: number
  changeType: AgentConversationChangeType
  originClientId?: string | null
}

export interface AgentPromptOptimizeContextMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface CodexSubscriptionStatus {
  available: boolean
  authenticated: boolean
  email?: string
  planType?: string
  requiresOpenaiAuth?: boolean
  error?: string
}

export interface CodexSubscriptionModel {
  id: string
  displayName: string
  description: string
  isDefault: boolean
  hidden: boolean
  defaultReasoningEffort?: string
}

export interface CodexAccount {
  id: string
  email?: string
  planType?: string
  active: boolean
  addedAt: number
}

export interface CodexSubscriptionUsageWindow {
  usedPercent: number
  remainingPercent: number
  windowDurationMins?: number
  resetsAt?: number
}

export interface CodexSubscriptionRateLimit {
  limitId: string
  limitName?: string
  primary?: CodexSubscriptionUsageWindow
  secondary?: CodexSubscriptionUsageWindow
}

export interface CodexSubscriptionUsage {
  rateLimits: CodexSubscriptionRateLimit[]
  planType?: string
  credits?: {
    hasCredits?: boolean
    unlimited?: boolean
    balance?: string
  }
  resetCreditsAvailable?: number
  fetchedAt: number
}

// ========= Agent Canvas（对话内可编辑产物） =========
export type AgentCanvasKind = 'document' | 'code'
export type AgentCanvasStatus = 'active' | 'archived'
export type AgentCanvasSource = 'user' | 'agent' | 'restore'
export type AgentCanvasAction = 'created' | 'updated' | 'renamed' | 'archived' | 'restored'

export interface AgentCanvasRecord {
  id: string
  conversationId: number
  kind: AgentCanvasKind
  title: string
  language?: string
  content: string
  revision: number
  status: AgentCanvasStatus
  createdBy: 'user' | 'agent'
  createdAt: number
  updatedAt: number
}

export interface AgentCanvasListItem extends Omit<AgentCanvasRecord, 'content'> {
  contentLength: number
}

export interface AgentCanvasRevisionMeta {
  canvasId: string
  revision: number
  source: AgentCanvasSource
  contentLength: number
  createdAt: number
}

export interface AgentCanvasRevisionInfo extends AgentCanvasRevisionMeta {
  content: string
}

export interface AgentCanvasConflictInfo {
  code: 'REVISION_CONFLICT'
  canvasId: string
  expectedRevision: number
  actualRevision: number
  current: AgentCanvasRecord
}

export interface AgentCanvasUpdatedEvent {
  canvasId: string
  conversationId: number
  revision: number
  action: AgentCanvasAction
  originClientId?: string | null
  updatedAt: number
}

export interface AgentCanvasRefData {
  canvasId: string
  conversationId: number
  kind: AgentCanvasKind
  title: string
  revision: number
  action: 'created' | 'updated' | 'renamed' | 'restored'
}

export type TtsProviderId = 'xiaomi' | 'volcengine' | 'aliyun-qwen'
export type TtsProtocol = 'xiaomi-mimo-tts' | 'volcengine-bidirectional' | 'aliyun-qwen-realtime'

export interface TtsProviderConfig {
  protocol: TtsProtocol
  apiKey: string
  /** 豆包端到端 Realtime 专用，其他 TTS provider 留空。 */
  realtimeAppId?: string
  /** 豆包 Realtime 的 X-Api-Access-Key，不等同于 V3 TTS 的 X-Api-Key。 */
  realtimeAccessKey?: string
  baseURL: string
  model: string
  voice: string
  instructions: string
  speed: number
}

export interface TtsConfig extends TtsProviderConfig {
  enabled: boolean
  activeProvider: TtsProviderId
  providers: Record<TtsProviderId, TtsProviderConfig>
}

export interface TtsSpeakResult {
  success: boolean
  audioBase64?: string
  mimeType?: string
  cached?: boolean
  error?: string
  errorCode?: 'NOT_CONFIGURED' | 'SYNTHESIS_FAILED'
}

export interface TtsStreamEvent {
  streamId: string
  type: 'start' | 'chunk' | 'complete' | 'end' | 'error'
  success?: boolean
  audioBase64?: string
  mimeType?: string
  cached?: boolean
  streamed?: boolean
  format?: 'pcm16'
  sampleRate?: number
  channels?: number
  error?: string
  errorCode?: 'NOT_CONFIGURED' | 'SYNTHESIS_FAILED'
}

export interface TtsStreamResult extends TtsSpeakResult {
  streamed?: boolean
  streamFormat?: 'pcm16'
  sampleRate?: number
  channels?: number
}

export type VoiceRealtimeEvent =
  | { type: 'connected'; dialogId?: string }
  | { type: 'speech-started'; questionId?: string }
  | { type: 'asr'; text: string; interim: boolean }
  | { type: 'asr-ended' }
  | { type: 'chat'; text: string; questionId?: string; replyId?: string }
  | { type: 'chat-ended'; questionId?: string; replyId?: string }
  | { type: 'tts-start'; text?: string; questionId?: string; replyId?: string }
  | { type: 'audio'; audioBase64: string; sampleRate: 24000; channels: 1 }
  | { type: 'tts-ended'; questionId?: string; replyId?: string; statusCode?: string }
  | { type: 'ended' }
  | { type: 'error'; error: string; errorCode?: number }

export interface TtsSpeakOptions {
  config?: Partial<TtsConfig>
  personaVoice?: PersonaTtsVoiceBindingInfo | null
}

export interface ImageGenConfig {
  enabled: boolean
  protocol: 'openai-compatible' | 'openai' | 'google' | 'custom'
  apiKey: string
  baseURL: string
  model: string
  size: string
  timeoutMs: number
}

export interface EmbeddingBuildProgress {
  sessionId: string
  stage: 'loading' | 'chunking' | 'embedding' | 'done'
  current: number
  total: number
  indexed: number
  message: string
}

export type EmbeddingBuildTarget = 'all' | 'text' | 'image'

export interface EmbeddingVectorStoreInfo {
  dbPath: string
  exists: boolean
  sizeBytes: number
  updatedAtMs: number | null
  count: number
  mediaCount?: number
  dimensions: number[]
  mediaDimensions?: number[]
}

export interface ImageListItem {
  imagePath: string
  liveVideoPath?: string
}

export interface ImageViewerOpenOptions {
  sessionId?: string
  imageMd5?: string
  imageDatName?: string
}

export interface UpdateDownloadProgressPayload {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

/**
 * Direct DB 迁移后的 WAL 变更广播 payload，
 * 通过 `wcdb:change` channel 从主进程推送到渲染端。
 */
export interface WcdbChangePayload {
  table: 'Session' | 'Message' | 'Contact' | 'Sns' | 'Unknown'
  dbPath: string
  walPath: string
}

export type AgentToolProfile = 'chat' | 'code' | 'hybrid'
export type CodeWorkspaceApprovalKind = 'write' | 'delete' | 'command' | 'dev-server' | 'sensitive-read'
export type CodeWorkspaceApprovalRisk = 'low' | 'medium' | 'high'
export type CodeWorkspaceApprovalDecision = 'approved' | 'rejected'
export type CodeWorkspaceApprovalPolicy = 'on-request' | 'risk-based' | 'full-access'
export type AgentToolApprovalPolicy = 'on-request' | 'risk-based' | 'full-access'

export interface CodeWorkspaceRef {
  id: string
  root: string
  approvalPolicy: CodeWorkspaceApprovalPolicy
}

export interface CodeWorkspaceDevServerState {
  running: boolean
  command?: string
  pid?: number
  startedAt?: number
  previewUrl?: string
}

export interface CodeWorkspaceState {
  workspace: CodeWorkspaceRef | null
  devServer: CodeWorkspaceDevServerState
  recentLogs: string[]
}

export interface CodeWorkspaceFileItem {
  path: string
  type: 'file' | 'dir'
  sizeBytes?: number
}

export interface CodeWorkspaceListFilesResult {
  success: boolean
  root?: string
  items?: CodeWorkspaceFileItem[]
  truncated?: boolean
  error?: string
}

export type CodeWorkspaceBrowserDiagnosticKind =
  | 'console'
  | 'page-error'
  | 'load-failed'
  | 'render-process-gone'
  | 'navigation'

export interface CodeWorkspaceBrowserDiagnostic {
  kind: CodeWorkspaceBrowserDiagnosticKind
  level?: 'debug' | 'info' | 'warning' | 'error'
  message: string
  source?: string
  line?: number
  url?: string
  at: number
}

export interface CodeWorkspaceBrowserDiagnosticsResult {
  success: boolean
  url?: string
  diagnostics?: CodeWorkspaceBrowserDiagnostic[]
  hasErrors?: boolean
  error?: string
}

export interface SkillFileItem {
  path: string
  name: string
  type: 'file' | 'dir'
  size?: number
  children?: SkillFileItem[]
}

export interface CodeWorkspaceApprovalRequest {
  requestId: string
  kind: CodeWorkspaceApprovalKind
  workspaceRoot: string
  targetPath?: string
  command?: string
  diffPreview?: string
  risk: CodeWorkspaceApprovalRisk
  summary: string
  createdAt: number
}

export interface CodeWorkspaceEvent {
  type: 'state' | 'log' | 'preview-url' | 'approval-resolved' | 'files-changed'
  state?: CodeWorkspaceState
  log?: string
  previewUrl?: string
  requestId?: string
  decision?: CodeWorkspaceApprovalDecision
  changedPaths?: string[]
  at: number
}

export type LocalCodingAgentKind = 'codex' | 'claude-cli' | 'opencode' | 'custom'
export type LocalCodingAgentRunMode = 'inspect' | 'propose' | 'direct'

export interface LocalCodingAgentDefinition {
  kind: LocalCodingAgentKind
  name: string
  executablePath: string
  argsTemplate?: string[]
  env?: Record<string, string>
  timeoutMs: number
  model?: string
}

export interface LocalCodingAgentConfig {
  enabled: boolean
  activeAgent: string
  agents: Record<string, LocalCodingAgentDefinition>
}

export type LocalCodingAgentEvent =
  | { type: 'started'; jobId: string; agentId: string; mode: LocalCodingAgentRunMode; cwd: string; at: number }
  | { type: 'stdout'; jobId: string; text: string; at: number }
  | { type: 'stderr'; jobId: string; text: string; at: number }
  | { type: 'message'; jobId: string; role: 'assistant' | 'tool' | 'system'; text: string; at: number }
  | { type: 'activity'; jobId: string; activity: 'reasoning' | 'tool'; toolName?: string; input?: unknown; output?: unknown; text?: string; at: number }
  | { type: 'diff'; jobId: string; patch: string; changedPaths: string[]; at: number }
  | { type: 'finished'; jobId: string; exitCode: number | null; durationMs: number; at: number }
  | { type: 'error'; jobId: string; error: string; at: number }

export interface LocalCodingAgentDetectResult {
  id: string
  kind: LocalCodingAgentKind
  name: string
  executablePath: string
  found: boolean
  version?: string
  error?: string
}

export interface StatsPartialError {
  dbName?: string
  dbPath?: string
  tableName?: string
  message: string
}

export type AgentMemorySourceType =
  | 'message'
  | 'conversation_block'
  | 'fact'
  | 'relationship'
  | 'profile'
  | 'timeline_summary'
  | 'media'

export interface AgentMemoryItem {
  id: number
  memoryUid: string
  sourceType: AgentMemorySourceType
  sessionId: string | null
  contactId: string | null
  groupId?: string | null
  title: string
  content: string
  contentHash?: string
  entities?: string[]
  importance: number
  confidence: number
  tags: string[]
  timeStart?: number | null
  timeEnd?: number | null
  sourceRefs?: Array<{ sessionId: string; localId: number; createTime: number; sortSeq: number; senderUsername?: string; excerpt?: string }>
  createdAt: number
  updatedAt: number
}

export interface MemoryMigrationStatusInfo {
  needed: boolean
  legacyDbPath: string
  memoryBankPath: string
  itemCount: number
  migratedItemCount: number
  error?: string
}

export interface MemoryMigrationResultInfo extends MemoryMigrationStatusInfo {
  success: boolean
  deletedFiles: string[]
  deleteErrors?: string[]
  skippedItemCount?: number
}

export interface MemoryDiaryEntryInfo {
  date: string
  title: string
  excerpt: string
  content?: string
  updatedAt: number
}

export type MemoryBankNoteKind = 'tasks' | 'notes'

export interface MemoryBankNoteInfo {
  kind: MemoryBankNoteKind
  fileName: string
  title: string
  excerpt: string
  content?: string
  status?: string
  tags: string[]
  updatedAt: number
}

// 克隆好友（数字分身）：画像卡 + few-shot + 风格统计（与 electron/services/agent/persona/personaTypes.ts 对应）
export interface PersonaCardInfo {
  tone: string
  personalityTraits: string[]
  catchphrases: string[]
  punctuationStyle: string
  addressing: string
  topics: string[]
  ttsInstructions: string
}

export interface PersonaProfileInfo {
  facts: string[]
  relationship: string
  reactionPatterns: string[]
  boundaries: string[]
  sharedEvents: string[]
}

export interface PersonaTtsVoiceBindingInfo {
  provider: 'volcengine' | 'xiaomi' | 'aliyun-qwen'
  protocol: 'volcengine-bidirectional' | 'xiaomi-mimo-tts' | 'aliyun-qwen-realtime'
  source: 'volcengine-voice-clone' | 'xiaomi-mimo-voice-clone' | 'aliyun-qwen-voice-clone'
  baseURL: string
  model: string
  voice: string
  realtimeAppId?: string
  realtimeResourceId?: string
  displayName?: string
  sampleCount?: number
  sampleSeconds?: number
  sampleBytes?: number
  sampleMimeType?: string
  sampleHash?: string
  modelType?: number
  fallbackMode?: boolean
  fallbackReason?: string
  createdAt: number
  updatedAt: number
}

export interface PersonaRecordInfo {
  id: number
  accountId: string
  sessionId: string
  displayName: string
  card: PersonaCardInfo
  fewShots: Array<{ user: string; replies: string[] }>
  stats: {
    sourceMessageCount: number
    friendMessageCount: number
    avgFriendMsgChars: number
    avgFriendBurst: number
    voiceRatio?: number
    groupMessageCount?: number
    groupSessionCount?: number
  }
  profile: PersonaProfileInfo | null
  stickers?: Array<{
    md5: string
    cdnUrl: string
    productId?: string
    encryptUrl?: string
    aesKey?: string
    count: number
    contexts: string[]
  }>
  ttsVoice: PersonaTtsVoiceBindingInfo | null
  corpusUntil: number
  modelProvider: string
  modelId: string
  createdAt: number
  updatedAt: number
}

export interface PersonaBuildProgressInfo {
  sessionId: string
  stage: 'indexing' | 'corpus' | 'extracting' | 'saving' | 'done' | 'error'
  title: string
  percent: number
  detail?: string
}

export interface PluginContributes {
  sidebarMenus?: Array<{ id: string; label: string; icon?: string; view: string }>
  settingsTabs?: Array<{ id: string; label: string; view: string }>
  chatToolbarButtons?: Array<{ id: string; label: string; icon?: string; view: string }>
  views?: Record<string, { entry: string; presentation?: 'page' | 'drawer' }>
}

export interface PluginInfo {
  id: string
  name: string
  version: string
  description?: string
  author: { name: string; email?: string; url?: string }
  permissions: string[]
  contributes: PluginContributes
  isDev: boolean
  enabled: boolean
  grantedPermissions: string[]
  error?: string
}

export interface ElectronAPI {
  window: {
    minimize: () => void
    maximize: () => void
    close: () => void
    splashReady: () => void
    onSplashFadeOut?: (callback: () => void) => () => void
    openChatWindow: () => Promise<boolean>
    focusMainWindow: (route?: string) => Promise<boolean>
    openMomentsWindow: (filterUsername?: string) => Promise<boolean>
    openPersonaChatWindow: (sessionId: string) => Promise<boolean>
    openPosterStyleWindow: () => Promise<boolean>
    onMomentsFilterUser: (callback: (username: string) => void) => () => void
    onNavigate: (callback: (route: string) => void) => () => void
    openAgreementWindow: () => Promise<boolean>
    openPurchaseWindow: () => Promise<boolean>
    openWelcomeWindow: (mode?: 'default' | 'add-account') => Promise<boolean>
    completeWelcome: () => Promise<boolean>
    isChatWindowOpen: () => Promise<boolean>
    closeChatWindow: () => Promise<boolean>
    setTitleBarOverlay: (options: { hidden?: boolean; symbolColor?: string }) => void
    openImageViewerWindow: (
      imagePath: string,
      liveVideoPath?: string,
      imageList?: ImageListItem[],
      options?: ImageViewerOpenOptions
    ) => Promise<void>
    openVideoPlayerWindow: (videoPath: string, videoWidth?: number, videoHeight?: number) => Promise<void>
    openBrowserWindow: (url: string, title?: string) => Promise<void>
    openSkillPreviewWindow: (skillName: string) => Promise<boolean>
    resizeToFitVideo: (videoWidth: number, videoHeight: number) => Promise<void>
    openChatHistoryWindow: (sessionId: string, messageId: number) => Promise<boolean>
    onImageListUpdate: (callback: (data: { imageList: ImageListItem[], currentIndex: number }) => void) => () => void
    setReplyTileEnabled: (enabled: boolean) => Promise<boolean>
    getReplyTileEnabled: () => Promise<boolean>
    replyTileReady: () => void
    replyTileRefresh: () => void
    replyTile: {
      push: (entry: { sessionId: string; sessionName: string; avatarUrl?: string; state: 'pending' | 'loading' | 'error' | 'ready' | 'gone'; suggestions?: string[]; batches?: Array<{ id: string; targetKey: string; quote: string; suggestions: string[] }>; pendingContinue?: boolean; error?: string }) => void
      continue: (sessionId: string) => void
      skip: (sessionId: string) => void
      retry: (payload: { sessionId: string; batchId: string; suggestionIndex: number }) => void
      onUpdate: (callback: (entry: { sessionId: string; sessionName: string; avatarUrl?: string; state: 'pending' | 'loading' | 'error' | 'ready' | 'gone'; suggestions?: string[]; batches?: Array<{ id: string; targetKey: string; quote: string; suggestions: string[] }>; pendingContinue?: boolean; error?: string }) => void) => () => void
      onContinue: (callback: (sessionId: string) => void) => () => void
      onSkip: (callback: (sessionId: string) => void) => () => void
      onRetry: (callback: (payload: { sessionId: string; batchId: string; suggestionIndex: number }) => void) => () => void
    }
  }
  config: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
    getTldCache: () => Promise<{ tlds: string[]; updatedAt: number } | null>
    setTldCache: (tlds: string[]) => Promise<void>
    onChanged: (callback: (payload: { key: string; value: unknown }) => void) => () => void
  }
  plugin: {
    list: () => Promise<{ plugins: PluginInfo[]; devModeEnabled: boolean }>
    enable: (id: string) => Promise<{ success: boolean; error?: string }>
    disable: (id: string) => Promise<{ success: boolean; error?: string }>
    uninstall: (id: string) => Promise<{ success: boolean; error?: string }>
    rescan: () => Promise<{ success: boolean }>
    setDevMode: (enabled: boolean) => Promise<{ success: boolean }>
    addDevPlugin: (dir: string) => Promise<{ success: boolean; error?: string }>
    installFromFile: () => Promise<{ success: boolean; canceled?: boolean; pluginId?: string; name?: string; error?: string }>
    getViewUrl: (pluginId: string, viewId: string) => Promise<string | null>
    invoke: (pluginId: string, method: string, args?: Record<string, unknown>) => Promise<{ success: boolean; data?: unknown; error?: string }>
    onChanged: (callback: () => void) => () => void
    onEvent: (callback: (payload: { pluginId: string | null; requiredPermission?: string; event: string; payload: unknown }) => void) => () => void
  }
  pet: {
    listInstalled: () => Promise<{ success: boolean; pets?: Array<{ slug: string; displayName: string; description: string; builtin?: boolean }>; error?: string }>
    manifest: (force?: boolean) => Promise<{ success: boolean; pets?: Array<{ slug: string; displayName: string; kind?: string; submittedBy?: string; spritesheetUrl: string; petJsonUrl: string }>; error?: string }>
    install: (slug: string) => Promise<{ success: boolean; pet?: { slug: string; displayName: string; description: string; builtin?: boolean }; error?: string }>
    remove: (slug: string) => Promise<{ success: boolean; error?: string }>
    importZip: () => Promise<{ success: boolean; canceled?: boolean; pet?: { slug: string; displayName: string; description: string; builtin?: boolean }; error?: string }>
    getSprite: (slug: string) => Promise<{ success: boolean; dataUrl?: string; error?: string }>
    setAgentState: (state: string) => void
    sendAgentProgress: (progress: { stage: string; title: string; detail?: string }) => void
    getDailySummary: () => Promise<{ success: boolean; text?: string; error?: string }>
    toggleDesktopWindow: (enabled: boolean) => Promise<{ success: boolean }>
    setBubble: (expanded: boolean) => void
    showContextMenu: () => void
    dragStart: () => void
    dragMove: (dx: number, dy: number) => void
    dragEnd: () => void
    onAgentState: (callback: (state: string) => void) => () => void
    onWindowMove: (callback: (x: number) => void) => () => void
    onBubbleFrame: (callback: (frame: { expanded: boolean; baseLeft: number; baseTop: number; baseWidth: number; baseHeight: number }) => void) => () => void
    onContextMenuOpened: (callback: () => void) => () => void
    onNotify: (callback: (payload: { username: string; displayName: string; avatarUrl?: string; preview: string; timestamp: number }) => void) => () => void
    onAgentProgress: (callback: (progress: { stage: string; title: string; detail?: string }) => void) => () => void
    onBubble: (callback: (payload: { kind: string; title: string; text: string; id?: string }) => void) => () => void
  }
  notify: {
    getEnabledSessions: () => Promise<string[]>
    setSessionEnabled: (username: string, enabled: boolean) => Promise<{ success: boolean }>
    setActiveSession: (sessionId: string | null) => void
    activate: () => void
  }
  deviceConnect: {
    wechat: {
      getStatus: () => Promise<{ status: 'disconnected' | 'connecting' | 'connected' | 'error'; botId: string | null; userId: string | null; error: string | null }>
      connect: () => Promise<{ success: boolean; qrcodeImage?: string; error?: string }>
      cancel: () => Promise<{ success: boolean }>
      disconnect: () => Promise<{ success: boolean }>
      onStatus: (callback: (payload: { status: 'disconnected' | 'connecting' | 'connected' | 'error'; botId: string | null; userId: string | null; error: string | null }) => void) => () => void
      onQrcode: (callback: (payload: { qrcodeImage: string }) => void) => () => void
      onScanState: (callback: (payload: { state: 'scaned' | 'failed'; error?: string }) => void) => () => void
    }
  }
  accounts: {
    list: () => Promise<AccountProfile[]>
    getActive: () => Promise<AccountProfile | null>
    setActive: (accountId: string) => Promise<AccountProfile | null>
    save: (profile: AccountProfileInput) => Promise<AccountProfile | null>
    update: (accountId: string, patch: AccountProfilePatch) => Promise<AccountProfile | null>
    delete: (accountId: string, deleteLocalData?: boolean) => Promise<{ success: boolean; error?: string; deleted?: AccountProfile | null; nextActiveAccountId?: string }>
  }
  skillManager: {
    list: () => Promise<Array<{ name: string; version: string; description: string; builtin: boolean }>>
    readContent: (skillName: string) => Promise<{ success: boolean; content?: string; error?: string }>
    listFiles: (skillName: string) => Promise<{ success: boolean; files?: SkillFileItem[]; truncated?: boolean; error?: string }>
    readFile: (skillName: string, filePath: string) => Promise<{ success: boolean; path?: string; content?: string; size?: number; binary?: boolean; error?: string }>
    updateContent: (skillName: string, content: string) => Promise<{ success: boolean; error?: string }>
    exportZip: (skillName: string) => Promise<{ success: boolean; outputPath?: string; fileName?: string; version?: string; error?: string }>
    importZip: (zipPath: string) => Promise<{ success: boolean; skillName?: string; error?: string }>
    delete: (skillName: string) => Promise<{ success: boolean; error?: string }>
    create: (skillName: string, content: string) => Promise<{ success: boolean; error?: string }>
  }
  mcpClient: {
    listConfigs: () => Promise<Record<string, { type: string; command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; url?: string; headers?: Record<string, string>; timeoutMs?: number; autoConnect?: boolean }>>
    saveConfig: (name: string, config: { type: string; command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; url?: string; headers?: Record<string, string>; timeoutMs?: number; autoConnect?: boolean }, overwrite?: boolean) => Promise<{ success: boolean; error?: string }>
    deleteConfig: (name: string) => Promise<{ success: boolean; error?: string }>
    connect: (name: string) => Promise<{ success: boolean; tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>; error?: string }>
    disconnect: (name: string) => Promise<{ success: boolean; error?: string }>
    listTools: (name: string) => Promise<{ success: boolean; tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>; error?: string }>
    callTool: (name: string, toolName: string, args: Record<string, unknown>) => Promise<{ success: boolean; result?: unknown; error?: string }>
    listStatuses: () => Promise<Array<{ name: string; config: { type: string; command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; url?: string; headers?: Record<string, string>; timeoutMs?: number; autoConnect?: boolean }; status: string; toolCount: number; error?: string }>>
  }
  db: {
    open: (dbPath: string, key?: string) => Promise<boolean>
    query: <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>
    close: () => Promise<void>
  }
  dialog: {
    openFile: (options?: Electron.OpenDialogOptions) => Promise<Electron.OpenDialogReturnValue>
    saveFile: (options?: Electron.SaveDialogOptions) => Promise<Electron.SaveDialogReturnValue>
  }
  file: {
    delete: (filePath: string) => Promise<{ success: boolean; error?: string }>
    copy: (sourcePath: string, destPath: string) => Promise<{ success: boolean; error?: string }>
    importHomeBackground: (sourcePath: string) => Promise<{
      success: boolean
      path?: string
      url?: string
      mediaType?: 'image' | 'video'
      error?: string
    }>
    writeBase64: (filePath: string, base64Data: string) => Promise<{ success: boolean; error?: string }>
  }
  shell: {
    openPath: (path: string) => Promise<string>
    openExternal: (url: string) => Promise<void>
    showItemInFolder: (fullPath: string) => Promise<void>
  }
  app: {
    getDownloadsPath: () => Promise<string>
    getVersion: () => Promise<string>
    getPlatformInfo: () => Promise<{ platform: string; arch: string }>
    getMcpLaunchConfig: () => Promise<{
      command: string
      args: string[]
      cwd: string
      mode: 'dev' | 'packaged'
    } | null>
    getUpdateState: () => Promise<{
      hasUpdate: boolean
      forceUpdate: boolean
      currentVersion: string
      version?: string
      releaseNotes?: string
      title?: string
      message?: string
      minimumSupportedVersion?: string
      reason?: 'minimum-version' | 'blocked-version'
      checkedAt: number
      updateSource: 'r2' | 'github' | 'custom' | 'none'
      policySource: 'r2' | 'github' | 'custom' | 'none'
      diagnostics?: {
        phase: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'failed'
        strategy: 'unknown' | 'differential' | 'full'
        fallbackToFull: boolean
        lastError?: string
        lastEvent?: string
        progressPercent?: number
        downloadedBytes?: number
        totalBytes?: number
        targetVersion?: string
        lastUpdatedAt: number
      }
    } | null>
    getUpdateSourceInfo: () => Promise<{
      primaryUpdateSource: 'r2'
      r2UpdateBaseUrl: string
      githubRepository: {
        owner: string
        repo: string
      }
      policySources: Array<'r2' | 'github'>
      policyPrecedence: 'r2'
    }>
    getMcpLaunchConfig: () => Promise<{
      command: string
      args: string[]
      cwd: string
      mode: 'dev' | 'packaged'
    } | null>
    getUpdateState: () => Promise<{
      hasUpdate: boolean
      forceUpdate: boolean
      currentVersion: string
      version?: string
      releaseNotes?: string
      title?: string
      message?: string
      minimumSupportedVersion?: string
      reason?: 'minimum-version' | 'blocked-version'
      checkedAt: number
      updateSource: 'r2' | 'github' | 'custom' | 'none'
      policySource: 'r2' | 'github' | 'custom' | 'none'
      diagnostics?: {
        phase: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'failed'
        strategy: 'unknown' | 'differential' | 'full'
        fallbackToFull: boolean
        lastError?: string
        lastEvent?: string
        progressPercent?: number
        downloadedBytes?: number
        totalBytes?: number
        targetVersion?: string
        lastUpdatedAt: number
      }
    } | null>
    getUpdateSourceInfo: () => Promise<{
      primaryUpdateSource: 'r2'
      r2UpdateBaseUrl: string
      githubRepository: {
        owner: string
        repo: string
      }
      policySources: Array<'r2' | 'github'>
      policyPrecedence: 'r2'
    }>
    checkForUpdates: () => Promise<{
      hasUpdate: boolean
      forceUpdate: boolean
      currentVersion: string
      version?: string
      releaseNotes?: string
      title?: string
      message?: string
      minimumSupportedVersion?: string
      reason?: 'minimum-version' | 'blocked-version'
      checkedAt: number
      updateSource: 'r2' | 'github' | 'custom' | 'none'
      policySource: 'r2' | 'github' | 'custom' | 'none'
      diagnostics?: {
        phase: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'failed'
        strategy: 'unknown' | 'differential' | 'full'
        fallbackToFull: boolean
        lastError?: string
        lastEvent?: string
        progressPercent?: number
        downloadedBytes?: number
        totalBytes?: number
        targetVersion?: string
        lastUpdatedAt: number
      }
    }>
    downloadAndInstall: () => Promise<void>
    getStartupDbConnected?: () => Promise<boolean>
    onDownloadProgress: (callback: (progress: UpdateDownloadProgressPayload) => void) => () => void
    onUpdateAvailable: (callback: (info: {
      hasUpdate: boolean
      forceUpdate: boolean
      currentVersion: string
      version?: string
      releaseNotes?: string
      title?: string
      message?: string
      minimumSupportedVersion?: string
      reason?: 'minimum-version' | 'blocked-version'
      checkedAt: number
      updateSource: 'r2' | 'github' | 'custom' | 'none'
      policySource: 'r2' | 'github' | 'custom' | 'none'
      diagnostics?: {
        phase: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'failed'
        strategy: 'unknown' | 'differential' | 'full'
        fallbackToFull: boolean
        lastError?: string
        lastEvent?: string
        progressPercent?: number
        downloadedBytes?: number
        totalBytes?: number
        targetVersion?: string
        lastUpdatedAt: number
      }
    }) => void) => () => void
  }
  systemAuth: {
    getStatus: () => Promise<{
      platform: string
      available: boolean
      method: 'windows-hello' | 'touch-id' | 'none'
      displayName: string
      error?: string
    }>
    verify: (reason?: string) => Promise<{
      success: boolean
      method: 'windows-hello' | 'touch-id' | 'none'
      error?: string
    }>
  }
  wxKey: {
    isWeChatRunning: () => Promise<boolean>
    getWeChatPid: () => Promise<number | null>
    killWeChat: () => Promise<boolean>
    launchWeChat: () => Promise<boolean>
    waitForWindow: (maxWaitSeconds?: number) => Promise<boolean>
    startGetKey: (customWechatPath?: string, dbPath?: string) => Promise<{ success: boolean; key?: string; error?: string; needManualPath?: boolean; needAdmin?: boolean; validatedWxid?: string; account?: { dbKey: string | null; wxid: string; name: string; number: string; phone: string; seed: number } | null }>
    cancel: () => Promise<boolean>
    detectCurrentAccount: (dbPath?: string, maxTimeDiffMinutes?: number) => Promise<{ wxid: string; dbPath: string } | null>
    onStatus: (callback: (data: { status: string; level: number }) => void) => () => void
  }
  dbPath: {
    autoDetect: () => Promise<{ success: boolean; path?: string; error?: string }>
    scanWxids: (rootPath: string) => Promise<string[]>
    getDefault: () => Promise<string>
    getBestCachePath: () => Promise<{ success: boolean; path: string; drive: string }>
  }
  wcdb: {
    testConnection: (dbPath: string, hexKey: string, wxid: string, isAutoConnect?: boolean) => Promise<{ success: boolean; error?: string; sessionCount?: number }>
    resolveValidWxid: (dbPath: string, hexKey: string) => Promise<{ success: boolean; wxid?: string; error?: string }>
    open: (dbPath: string, hexKey: string, wxid: string) => Promise<boolean>
    close: () => Promise<boolean>
    decryptDatabase: (dbPath: string, hexKey: string, wxid: string) => Promise<{ success: boolean; error?: string; totalFiles?: number; successCount?: number; failCount?: number; skipped?: boolean }>
    onDecryptProgress: (callback: (data: { current: number; total: number; currentFile?: string; status: string; pageProgress?: { current: number; total: number } }) => void) => () => void
    onChange: (callback: (payload: WcdbChangePayload) => void) => () => void
  }
  dataManagement: {
    scanDatabases: () => Promise<{
      success: boolean
      databases?: DatabaseFileInfo[]
      error?: string
    }>
    /** @deprecated Direct DB 模式下已无操作，返回 skipped=true。 */
    decryptAll: () => Promise<{
      success: boolean
      successCount?: number
      failCount?: number
      error?: string
      skipped?: boolean
    }>
    /** @deprecated Direct DB 模式下已无操作，返回 skipped=true。 */
    decryptSingleDatabase: (filePath: string) => Promise<{
      success: boolean
      error?: string
      skipped?: boolean
    }>
    /** @deprecated Direct DB 模式下已无操作，返回 skipped=true。 */
    incrementalUpdate: () => Promise<{
      success: boolean
      successCount?: number
      failCount?: number
      error?: string
      skipped?: boolean
    }>
    getCurrentCachePath: () => Promise<string>
    getDefaultCachePath: () => Promise<string>
    /** @deprecated Direct DB 模式下已无操作，返回 skipped=true。 */
    migrateCache: (newCachePath: string) => Promise<{
      success: boolean
      movedCount?: number
      error?: string
      skipped?: boolean
    }>
    scanImages: (dirPath: string) => Promise<{
      success: boolean
      images?: ImageFileInfo[]
      error?: string
    }>
    decryptImages: (dirPath: string) => Promise<{
      success: boolean
      successCount?: number
      failCount?: number
      error?: string
    }>
    onProgress: (callback: (data: any) => void) => () => void
    getImageDirectories: () => Promise<{
      success: boolean
      directories?: { wxid: string; path: string }[]
      error?: string
    }>
    decryptSingleImage: (filePath: string) => Promise<{
      success: boolean
      outputPath?: string
      error?: string
    }>
    /** @deprecated Direct DB 模式下已无操作，返回 skipped=true。 */
    checkForUpdates: () => Promise<{
      hasUpdate: boolean
      updateCount?: number
      error?: string
      skipped?: boolean
    }>
    /** @deprecated Direct DB 模式下已无操作。 */
    enableAutoUpdate: (intervalSeconds?: number) => Promise<{ success: boolean; skipped?: boolean }>
    /** @deprecated Direct DB 模式下已无操作。 */
    disableAutoUpdate: () => Promise<{ success: boolean; skipped?: boolean }>
    /** @deprecated Direct DB 模式下已无操作，返回 skipped=true。 */
    autoIncrementalUpdate: (silent?: boolean) => Promise<{
      success: boolean
      updated: boolean
      error?: string
      skipped?: boolean
    }>
    onProgress: (callback: (data: DecryptProgress) => void) => () => void
    onUpdateAvailable: (callback: (hasUpdate: boolean) => void) => () => void
  }
  imageDecrypt: {
    batchDetectXorKey: (dirPath: string) => Promise<{ success: boolean; key?: number | null; error?: string }>
    decryptImage: (inputPath: string, outputPath: string, xorKey: number, aesKey?: string) => Promise<{ success: boolean; error?: string }>
  }
  image: {
    decrypt: (payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number; force?: boolean; quick?: boolean }) => Promise<{ success: boolean; localPath?: string; error?: string }>
    resolveCache: (payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number }) => Promise<{ success: boolean; localPath?: string; hasUpdate?: boolean; error?: string }>
    prewarm: (payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number }>) => Promise<{ success: boolean; requested: number; enqueued: number; cacheHits: number; decrypted: number; failed: number; skipped: number; error?: string }>
    batchDecrypt: (payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number }>) => Promise<{ success: boolean; requested: number; current: number; total: number; successCount: number; failCount: number; cacheHits: number; decrypted: number; skipped: number; error?: string }>
    onBatchDecryptProgress: (callback: (data: { current: number; total: number; successCount: number; failCount: number; cacheHits: number; decrypted: number; skipped: number }) => void) => () => void
    onUpdateAvailable: (callback: (data: { cacheKey: string; imageMd5?: string; imageDatName?: string }) => void) => () => void
    onCacheResolved: (callback: (data: { cacheKey: string; imageMd5?: string; imageDatName?: string; localPath: string }) => void) => () => void
    deleteThumbnails: () => Promise<{ success: boolean; deleted: number; error?: string }>
    countThumbnails: () => Promise<{ success: boolean; count: number; error?: string }>
  }
  video: {
    getVideoInfo: (videoMd5: string, rawContent?: string) => Promise<{
      success: boolean
      error?: string
      exists: boolean
      videoUrl?: string
      coverUrl?: string
      thumbUrl?: string
      diagnostics?: {
        requestedMd5?: string
        candidateMd5s?: string[]
        searchedFileKeys?: string[]
        matchedMd5?: string
        hardlinkMatchedMd5?: string
        hardlinkDbPath?: string
        accountDir?: string
        videoBaseDir?: string
        reason?: 'missing_input' | 'missing_config' | 'account_dir_not_found' | 'video_dir_missing' | 'local_file_missing'
        summary?: string
      }
    }>
    readFile: (videoPath: string) => Promise<{
      success: boolean
      error?: string
      data?: string
    }>
    parseVideoMd5: (content: string) => Promise<{
      success: boolean
      error?: string
      md5?: string
    }>
    parseChannelVideo: (content: string) => Promise<{
      success: boolean
      error?: string
      videoInfo?: {
        objectId: string
        title: string
        author: string
        avatar?: string
        videoUrl: string
        thumbUrl?: string
        coverUrl?: string
        duration?: number
        width?: number
        height?: number
      }
    }>
    downloadChannelVideo: (videoInfo: any, key?: string) => Promise<{
      success: boolean
      filePath?: string
      error?: string
      needsKey?: boolean
    }>
    onDownloadProgress: (callback: (progress: {
      objectId: string
      downloaded: number
      total: number
      percentage: number
    }) => void) => () => void
  }
  imageKey: {
    getImageKeys: (userDir: string) => Promise<{ success: boolean; xorKey?: number; aesKey?: string; error?: string }>
    onProgress: (callback: (msg: string) => void) => () => void
  }
  chat: {
    connect: () => Promise<{ success: boolean; error?: string }>
    getSessions: (offset?: number, limit?: number) => Promise<{ success: boolean; sessions?: ChatSession[]; hasMore?: boolean; error?: string }>
    searchSessions: (keyword: string) => Promise<{ success: boolean; sessions?: ChatSession[]; error?: string }>
    getMentionTargets: (offset?: number, limit?: number, keyword?: string) => Promise<{ success: boolean; sessions?: ChatSession[]; hasMore?: boolean; error?: string }>
    getContacts: () => Promise<{ success: boolean; contacts?: ContactInfo[]; error?: string }>
    getMessages: (sessionId: string, offset?: number, limit?: number) => Promise<{
      success: boolean;
      messages?: Message[];
      hasMore?: boolean;
      error?: string
    }>
    getMessagesBefore: (
      sessionId: string,
      cursorSortSeq: number,
      limit?: number,
      cursorCreateTime?: number,
      cursorLocalId?: number
    ) => Promise<{
      success: boolean;
      messages?: Message[];
      hasMore?: boolean;
      error?: string
    }>
    getMessagesAfter: (
      sessionId: string,
      cursorSortSeq: number,
      limit?: number,
      cursorCreateTime?: number,
      cursorLocalId?: number
    ) => Promise<{
      success: boolean;
      messages?: Message[];
      hasMore?: boolean;
      error?: string
    }>
    getNewMessages: (sessionId: string, minTime: number, limit?: number) => Promise<{
      success: boolean;
      messages?: Message[];
      error?: string
    }>
    getAllVoiceMessages: (sessionId: string) => Promise<{
      success: boolean;
      messages?: Message[];
      error?: string
    }>
    getAllImageMessages: (sessionId: string) => Promise<{
      success: boolean;
      images?: { imageMd5?: string; imageDatName?: string; createTime?: number }[];
      error?: string
    }>
    getImageData: (sessionId: string, msgId: string, createTime?: number) => Promise<{
      success: boolean
      data?: string
      error?: string
    }>
    getContact: (username: string) => Promise<Contact | null>
    getContactAvatar: (username: string) => Promise<{ avatarUrl?: string; displayName?: string; weComCorp?: string } | null>
    resolveTransferDisplayNames: (chatroomId: string, payerUsername: string, receiverUsername: string) => Promise<{ payerName: string; receiverName: string }>
    getMyAvatarUrl: () => Promise<{ success: boolean; avatarUrl?: string; error?: string }>
    getMyUserInfo: () => Promise<{
      success: boolean
      userInfo?: {
        wxid: string
        nickName: string
        alias: string
        avatarUrl: string
      }
      error?: string
    }>
    downloadEmoji: (cdnUrl: string, md5?: string, productId?: string, createTime?: number, encryptUrl?: string, aesKey?: string) => Promise<{ success: boolean; localPath?: string; error?: string }>
    close: () => Promise<boolean>
    refreshCache: () => Promise<boolean>
    setCurrentSession: (sessionId: string | null) => Promise<boolean>
    onNewMessages: (callback: (data: { sessionId: string; messages: Message[] }) => void) => () => void
    getSessionDetail: (sessionId: string) => Promise<{
      success: boolean
      detail?: {
        wxid: string
        displayName: string
        remark?: string
        nickName?: string
        alias?: string
        avatarUrl?: string
        messageCount: number
        firstMessageTime?: number
        latestMessageTime?: number
        messageTables: { dbName: string; tableName: string; count: number }[]
      }
      error?: string
    }>
    getVoiceData: (sessionId: string, msgId: string, createTime?: number, serverId?: number) => Promise<{
      success: boolean
      data?: string  // base64 encoded WAV
      error?: string
    }>
    getMessagesByDate: (sessionId: string, targetTimestamp: number, limit?: number) => Promise<{
      success: boolean
      messages?: Message[]
      targetIndex?: number
      targetIndex?: number
      error?: string
    }>
    getMessage: (sessionId: string, localId: number) => Promise<{ success: boolean; message?: Message; error?: string }>
    /** 回忆一刻：从 chat_search_index.db 随机索引行再还原消息（方案 A） */
    pickRandomMomentFromIndex: () => Promise<{
      success: boolean
      sessionId?: string
      message?: Message
      error?: string
      hint?: string
    }>
    getDatesWithMessages: (sessionId: string, year: number, month: number) => Promise<{
      success: boolean
      dates?: string[]
      error?: string
    }>
    onSessionsUpdated: (callback: (sessions: ChatSession[]) => void) => () => void
  }
  // 朋友圈相关
  sns: {
    getTimeline: (limit?: number, offset?: number, usernames?: string[], keyword?: string, startTime?: number, endTime?: number) => Promise<{
      success: boolean
      timeline?: Array<{
        id: string
        username: string
        nickname: string
        avatarUrl?: string
        createTime: number
        contentDesc: string
        type?: number
        media: Array<{
          url: string
          thumb: string
          md5?: string
          token?: string
          key?: string
          encIdx?: string
          livePhoto?: {
            url: string
            thumb: string
            token?: string
            key?: string
            encIdx?: string
          }
        }>
        likes: string[]
        comments: Array<{
          id: string
          nickname: string
          content: string
          refCommentId: string
          refNickname?: string
          emojis?: Array<{
            url: string
            md5: string
            width: number
            height: number
            encryptUrl?: string
            aesKey?: string
          }>
          images?: Array<{
            url: string
            token?: string
            key?: string
            encIdx?: string
            thumbUrl?: string
            thumbUrlToken?: string
            thumbKey?: string
            thumbEncIdx?: string
            width?: number
            height?: number
            heightPercentage?: number
            fileSize?: number
            minArea?: number
            mediaId?: string
            md5?: string
          }>
        }>
        rawXml?: string
      }>
      error?: string
    }>
    proxyImage: (params: { url: string; key?: string | number }) => Promise<{
      success: boolean
      dataUrl?: string
      videoPath?: string
      localPath?: string
      error?: string
    }>
    downloadImage: (params: { url: string; key?: string | number }) => Promise<{
      success: boolean
      error?: string
    }>
    downloadEmoji: (params: { url: string; encryptUrl?: string; aesKey?: string }) => Promise<{
      success: boolean
      localPath?: string
      error?: string
    }>
    writeExportFile: (filePath: string, content: string) => Promise<{ success: boolean; error?: string }>
    saveMediaToDir: (params: { url: string; key?: string | number; outputDir: string; index: number; md5?: string; isAvatar?: boolean; username?: string; isEmoji?: boolean; encryptUrl?: string; aesKey?: string }) => Promise<{ success: boolean; fileName?: string; error?: string }>
  }
  export: {
    exportSessions: (sessionIds: string[], outputDir: string, options: ExportOptions) => Promise<{
      success: boolean
      successCount?: number
      failCount?: number
      outputPaths?: string[]
      error?: string
    }>
    exportSession: (sessionId: string, outputPath: string, options: ExportOptions) => Promise<{
      success: boolean
      error?: string
    }>
    exportContacts: (outputDir: string, options: ContactExportOptions) => Promise<{
      success: boolean
      successCount?: number
      error?: string
    }>
    exportMoments: (outputDir: string, options: MomentsExportOptions) => Promise<{
      success: boolean
      successCount?: number
      failCount?: number
      error?: string
    }>
    scanDatabases: () => Promise<{
      success: boolean
      root?: string
      databases?: Array<{
        path: string
        name: string
        relativePath: string
        folder: string
        size: number
      }>
      error?: string
    }>
    exportDatabases: (selectedPaths: string[], outputDir: string) => Promise<{
      success: boolean
      successCount?: number
      failCount?: number
      error?: string
      outputDir?: string
      tableErrors?: Array<{ db: string; table: string; error: string }>
    }>
    onProgress: (callback: (data: {
      current?: number
      total?: number
      currentSession?: string
      phase?: string
      detail?: string
    }) => void) => () => void
  }
  activation: {
    getDeviceId: () => Promise<string>
    verifyCode: (code: string) => Promise<{ success: boolean; message: string }>
    activate: (code: string) => Promise<ActivationResult>
    checkStatus: () => Promise<ActivationStatus>
    getTypeDisplayName: (type: string | null) => Promise<string>
    clearCache: () => Promise<boolean>
  }
  cache: {
    clearImages: () => Promise<{ success: boolean; error?: string }>
    clearEmojis: () => Promise<{ success: boolean; error?: string }>
    clearDatabases: () => Promise<{ success: boolean; error?: string }>
    clearAIData: () => Promise<{ success: boolean; error?: string; deletedFiles?: string[]; failedFiles?: Array<{ path: string; error: string }> }>
    clearAll: () => Promise<{ success: boolean; error?: string }>
    clearConfig: () => Promise<{ success: boolean; error?: string }>
    clearCurrentAccount: (deleteLocalData?: boolean) => Promise<{ success: boolean; error?: string }>
    clearAllAccountConfigs: () => Promise<{ success: boolean; error?: string }>
    getCacheSize: () => Promise<{
      success: boolean;
      error?: string;
      size?: {
        images: number
        emojis: number
        databases: number
        aiData: number
        logs: number
        total: number
      }
    }>
  }
  log: {
    getLogFiles: () => Promise<{
      success: boolean;
      error?: string;
      files?: Array<{ name: string; size: number; mtime: Date }>
    }>
    readLogFile: (filename: string) => Promise<{
      success: boolean;
      error?: string;
      content?: string
    }>
    clearLogs: () => Promise<{ success: boolean; error?: string }>
    getLogSize: () => Promise<{
      success: boolean;
      error?: string;
      size?: number
    }>
    getLogDirectory: () => Promise<{
      success: boolean;
      error?: string;
      directory?: string
    }>
    setLogLevel: (level: string) => Promise<{ success: boolean; error?: string }>
    getLogLevel: () => Promise<{
      success: boolean;
      error?: string;
      level?: string
    }>
  }
  // 语音转文字 (STT)
  stt: {
    getModelStatus: () => Promise<{
      success: boolean
      exists?: boolean
      modelPath?: string
      tokensPath?: string
      sizeBytes?: number
      error?: string
    }>
    downloadModel: () => Promise<{
      success: boolean
      modelPath?: string
      tokensPath?: string
      error?: string
    }>
    cancelDownloadModel: () => Promise<{
      success: boolean
      cancelled: boolean
      error?: string
    }>
    transcribe: (wavBase64: string, sessionId: string, createTime: number, force?: boolean, localId?: number) => Promise<{
      success: boolean
      transcript?: string
      cached?: boolean
      sttMode?: 'cpu' | 'gpu' | 'online'
      errorCode?: 'BAD_REQUEST' | 'STT_NOT_READY' | 'INTERNAL_ERROR'
      error?: string
    }>
    transcribeBuffer: (wavBase64: string) => Promise<{
      success: boolean
      transcript?: string
      sttMode?: 'cpu' | 'gpu' | 'online'
      errorCode?: 'BAD_REQUEST' | 'STT_NOT_READY' | 'INTERNAL_ERROR'
      error?: string
    }>
    testOnlineConfig: (overrides?: {
      provider?: 'openai-compatible' | 'aliyun-qwen-asr' | 'qianwen-cloud' | 'volcano-doubao' | 'custom'
      apiKey?: string
      baseURL?: string
      model?: string
      language?: string
      timeoutMs?: number
    }) => Promise<{
      success: boolean
      error?: string
    }>
    onDownloadProgress: (callback: (progress: {
      modelName: string
      downloadedBytes: number
      totalBytes?: number
      percent?: number
    }) => void) => () => void
    onPartialResult: (callback: (text: string) => void) => () => void
    getCachedTranscript: (sessionId: string, createTime: number, localId?: number) => Promise<{
      success: boolean
      transcript?: string
    }>
    updateTranscript: (sessionId: string, createTime: number, transcript: string, localId?: number) => Promise<{
      success: boolean
      error?: string
    }>
    clearModel: () => Promise<{ success: boolean; error?: string }>
  }
  // 语音转文字 - Whisper GPU 加速
  sttWhisper: {
    detectGPU: () => Promise<{
      available: boolean
      provider: string
      info: string
    }>
    checkModel: (modelType: string) => Promise<{
      exists: boolean
      modelPath?: string
      sizeBytes?: number
      error?: string
    }>
    downloadModel: (modelType: string) => Promise<{
      success: boolean
      error?: string
    }>
    cancelDownloadModel: (modelType: string) => Promise<{
      success: boolean
      cancelled: boolean
      error?: string
    }>
    clearModel: (modelType: string) => Promise<{
      success: boolean
      error?: string
    }>
    transcribe: (wavData: Buffer | ArrayBuffer | Uint8Array, options: { modelType?: string; language?: string }) => Promise<{
      success: boolean
      transcript?: string
      error?: string
    }>
    onDownloadProgress: (callback: (progress: {
      downloadedBytes: number
      totalBytes?: number
      percent?: number
    }) => void) => () => void
    downloadGPUComponents: () => Promise<{
      success: boolean
      error?: string
    }>
    cancelDownloadGPUComponents: () => Promise<{
      success: boolean
      cancelled: boolean
      error?: string
    }>
    checkGPUComponents: () => Promise<{
      installed: boolean
      missingFiles?: string[]
      gpuDir?: string
      reason?: string
      error?: string
    }>
    onGPUDownloadProgress: (callback: (progress: {
      currentFile: string
      fileProgress: number
      overallProgress: number
      completedFiles: number
      totalFiles: number
    }) => void) => () => void
  }
  agent: {
    run: (
      runId: string,
      messages: unknown[],
      scope?: unknown,
      modelConfig?: unknown,
      conversationId?: number | null,
      planMode?: boolean,
      toolProfile?: AgentToolProfile,
      codeWorkspace?: CodeWorkspaceRef | null,
      canvasContext?: { activeCanvasId?: string; activeRevision?: number } | null
    ) => Promise<{ success: boolean; error?: string }>
    abort: (runId: string) => Promise<{ success: boolean }>
    generateTitle: (firstMessage: string, modelConfig?: unknown) => Promise<{ success: boolean; title?: string; error?: string }>
    optimizePrompt: (
      prompt: string,
      modelConfig?: unknown,
      context?: AgentPromptOptimizeContextMessage[]
    ) => Promise<{ success: boolean; text?: string; error?: string }>
    replySuggest: (
      input: {
        contactName: string
        /** 会话 username：深度模式的历史检索、likeme 的真实问答对检索需要 */
        sessionId?: string
        context: Array<{ fromMe: boolean; text: string }>
        style: string
        count: number
        /** 深度模式：子进程内跑带会话检索工具的小步 Agent 循环 */
        deep?: boolean
        myRecentTexts?: string[]
        /** likeme 模式下由自画像画像卡渲染成的提示文本，优先于 myRecentTexts */
        myPersonaContext?: string
        /** 自画像统计（我平均一轮连发几条/每条字数），用于连发自适应 */
        myStats?: { avgBurst?: number; avgChars?: number }
        /** 深度模式时对方的画像提示文本（克隆过 TA 才有） */
        friendPersonaContext?: string
        /** 对方刚发来待回复的图片（base64，时间正序）；模型标记不支持图像输入时引擎侧忽略 */
        images?: Array<{ base64: string }>
      },
      modelConfig?: unknown
    ) => Promise<{
      success: boolean
      suggestions?: string[]
      /** 实际附进模型请求的图片张数（0=没附） */
      imagesAttached?: number
      /** 模型图像输入能力：true/false=目录明确标记，undefined=目录查不到 */
      visionSupport?: boolean
      error?: string
    }>
    onChunk: (runId: string, callback: (chunk: unknown) => void) => () => void
    onProgress: (runId: string, callback: (progress: unknown) => void) => () => void
    listConversations: (scope?: unknown) => Promise<{ success: boolean; conversations?: unknown[]; error?: string }>
    loadConversation: (id: number) => Promise<{ success: boolean; conversation?: unknown; error?: string }>
    createConversation: (payload: unknown) => Promise<{ success: boolean; conversation?: unknown; error?: string }>
    deleteConversation: (idOrPayload: number | { id?: number; originClientId?: string | null }) => Promise<{ success: boolean; error?: string }>
    deleteConversationsByScope: (scope: unknown) => Promise<{ success: boolean; deleted?: number; error?: string }>
    renameConversation: (id: number, title: string, originClientId?: string | null) => Promise<{ success: boolean; conversation?: unknown; error?: string }>
    saveConversationMessages: (payload: unknown) => Promise<{ success: boolean; conversation?: unknown; staleMerged?: boolean; error?: string }>
    getLastConversation: (scope?: unknown) => Promise<{ success: boolean; conversation?: unknown; error?: string }>
    sendConversationReplyToWechat: (payload: { conversationId: number; messageId: string; bubbles: string[] }) => Promise<{ success: boolean; sent?: boolean; skipped?: boolean; error?: string }>
    onConversationUpdated: (callback: (event: AgentConversationUpdatedEvent) => void) => () => void
  }
  agentCanvas: {
    create: (input: { conversationId: number; kind: AgentCanvasKind; title: string; language?: string; content: string; originClientId?: string | null }) => Promise<{ success: boolean; canvas?: AgentCanvasRecord; error?: string }>
    get: (canvasId: string) => Promise<{ success: boolean; canvas?: AgentCanvasRecord; error?: string }>
    list: (conversationId: number) => Promise<{ success: boolean; canvases?: AgentCanvasListItem[]; error?: string }>
    update: (input: { canvasId: string; baseRevision: number; content: string; originClientId?: string | null }) => Promise<{ success: boolean; canvas?: AgentCanvasRecord; conflict?: AgentCanvasConflictInfo; error?: string }>
    rename: (input: { canvasId: string; baseRevision: number; title: string; originClientId?: string | null }) => Promise<{ success: boolean; canvas?: AgentCanvasRecord; conflict?: AgentCanvasConflictInfo; error?: string }>
    archive: (input: { canvasId: string; baseRevision: number; originClientId?: string | null }) => Promise<{ success: boolean; canvas?: AgentCanvasRecord; conflict?: AgentCanvasConflictInfo; error?: string }>
    listRevisions: (canvasId: string) => Promise<{ success: boolean; revisions?: AgentCanvasRevisionMeta[]; error?: string }>
    getRevision: (canvasId: string, revision: number) => Promise<{ success: boolean; revision?: AgentCanvasRevisionInfo; error?: string }>
    restore: (input: { canvasId: string; baseRevision: number; revision: number; originClientId?: string | null }) => Promise<{ success: boolean; canvas?: AgentCanvasRecord; conflict?: AgentCanvasConflictInfo; error?: string }>
    onUpdated: (callback: (event: AgentCanvasUpdatedEvent) => void) => () => void
  }
  agentWorkspace: {
    selectWorkspace: () => Promise<{ success: boolean; canceled?: boolean; state?: CodeWorkspaceState; error?: string }>
    clearWorkspace: () => Promise<{ success: boolean; state?: CodeWorkspaceState; error?: string }>
    stopDevServer: () => Promise<{ success: boolean; state?: CodeWorkspaceState; result?: unknown; error?: string }>
    getState: () => Promise<{ success: boolean; state?: CodeWorkspaceState; error?: string }>
    setApprovalPolicy: (policy: CodeWorkspaceApprovalPolicy) => Promise<{ success: boolean; state?: CodeWorkspaceState; error?: string }>
    listFiles: (payload: { path?: string; maxDepth?: number; limit?: number }) => Promise<CodeWorkspaceListFilesResult>
    approve: (requestId: string) => Promise<{ success: boolean; error?: string }>
    reject: (requestId: string, reason?: string) => Promise<{ success: boolean; error?: string }>
    onApprovalRequest: (callback: (request: CodeWorkspaceApprovalRequest) => void) => () => void
    onWorkspaceEvent: (callback: (event: CodeWorkspaceEvent) => void) => () => void
  }
  localCodingAgent: {
    getConfig: () => Promise<{ success: boolean; config?: LocalCodingAgentConfig; error?: string }>
    setConfig: (config: LocalCodingAgentConfig) => Promise<{ success: boolean; config?: LocalCodingAgentConfig; error?: string }>
    detect: () => Promise<{ success: boolean; results?: LocalCodingAgentDetectResult[]; error?: string }>
    run: (payload: { agentId: string; mode: LocalCodingAgentRunMode; prompt: string; workspace: CodeWorkspaceRef; model?: string }) => Promise<{ success: boolean; jobId?: string; error?: string }>
    cancel: (jobId: string) => Promise<{ success: boolean; error?: string }>
    applyPatch: (jobId: string) => Promise<{ success: boolean; changedPaths?: string[]; error?: string }>
    discardPatch: (jobId: string) => Promise<{ success: boolean; changedPaths?: string[]; error?: string }>
    onEvent: (callback: (event: LocalCodingAgentEvent) => void) => () => void
  }
  persona: {
    get: (sessionId: string) => Promise<{ success: boolean; persona?: PersonaRecordInfo | null; error?: string }>
    list: () => Promise<{ success: boolean; personas?: PersonaRecordInfo[]; error?: string }>
    build: (payload: { sessionId: string; displayName?: string }) => Promise<{ success: boolean; persona?: PersonaRecordInfo; error?: string }>
    /** 克隆我自己：用与克隆好友一致的 AI 管线提炼"我"对此联系人的说话风格自画像，按 self: 前缀存储 */
    buildSelf: (payload: { sessionId: string; displayName?: string }) => Promise<{ success: boolean; persona?: PersonaRecordInfo; error?: string }>
    updateSpeakingStyle: (payload: { sessionId: string; card: Partial<PersonaCardInfo> }) => Promise<{ success: boolean; persona?: PersonaRecordInfo; error?: string }>
    cloneVoice: (payload: { sessionId: string; displayName?: string }) => Promise<{ success: boolean; persona?: PersonaRecordInfo; voice?: PersonaTtsVoiceBindingInfo; warning?: string; error?: string }>
    exportVoiceSample: (payload: { sessionId: string; displayName?: string; outputPath: string }) => Promise<{ success: boolean; outputPath?: string; sampleCount?: number; sampleSeconds?: number; audioBytes?: number; error?: string }>
    delete: (sessionId: string) => Promise<{ success: boolean; error?: string }>
    refreshIfStale: (sessionId: string) => Promise<{ success: boolean; refreshed?: boolean; persona?: PersonaRecordInfo | null; error?: string }>
    reflect: (payload: { sessionId: string; conversationId: number }) => Promise<{ success: boolean; reflected?: boolean; error?: string }>
    onBuildProgress: (callback: (progress: PersonaBuildProgressInfo) => void) => () => void
    chat: (runId: string, sessionId: string, messages: unknown[], reasoningEffort?: AgentReasoningEffort) => Promise<{ success: boolean; error?: string }>
    abort: (runId: string) => Promise<{ success: boolean }>
    onChunk: (runId: string, callback: (chunk: unknown) => void) => () => void
    onProgress: (runId: string, callback: (progress: unknown) => void) => () => void
  }
  memory: {
    migrationStatus: () => Promise<{ success: boolean; status?: MemoryMigrationStatusInfo; error?: string }>
    migrateLegacy: () => Promise<{ success: boolean; result?: MemoryMigrationResultInfo; error?: string }>
    list: (opts?: { sourceType?: AgentMemorySourceType; sourceTypes?: AgentMemorySourceType[]; sessionId?: string; tags?: string[]; withoutTags?: string[]; minConfidence?: number; limit?: number }) => Promise<{ success: boolean; items?: AgentMemoryItem[]; stats?: { itemCount: number }; error?: string }>
    listDiaries: (limit?: number) => Promise<{ success: boolean; diaries?: MemoryDiaryEntryInfo[]; error?: string }>
    listBankNotes: (kind: MemoryBankNoteKind, limit?: number) => Promise<{ success: boolean; notes?: MemoryBankNoteInfo[]; error?: string }>
    readBankNote: (kind: MemoryBankNoteKind, fileName: string) => Promise<{ success: boolean; note?: MemoryBankNoteInfo; error?: string }>
    deleteBankNote: (kind: MemoryBankNoteKind, fileName: string) => Promise<{ success: boolean; error?: string }>
    readDiary: (date: string) => Promise<{ success: boolean; diary?: MemoryDiaryEntryInfo; error?: string }>
    deleteDiary: (date: string) => Promise<{ success: boolean; error?: string }>
    summarizeTodayDiary: () => Promise<{ success: boolean; alreadyExists?: boolean; diary?: MemoryDiaryEntryInfo; error?: string }>
    create: (payload: { memoryUid?: string; sourceType?: AgentMemorySourceType; content?: string; title?: string; importance?: number; confidence?: number; tags?: string[] }) => Promise<{ success: boolean; item?: AgentMemoryItem; error?: string }>
    delete: (id: number) => Promise<{ success: boolean; error?: string }>
    update: (payload: { id: number; sourceType?: AgentMemorySourceType; content?: string; importance?: number; confidence?: number; tags?: string[] }) => Promise<{ success: boolean; item?: AgentMemoryItem; error?: string }>
    consolidate: () => Promise<{ success: boolean; result?: { removed: number; groups: number; scanned: number; profileBuilt?: boolean; profileBuildError?: string }; error?: string }>
    exportMarkdown: (outputDir: string) => Promise<{ success: boolean; result?: { files: string[]; itemCount: number }; error?: string }>
  }
  embedding: {
    getConfig: () => Promise<{ success: boolean; config?: EmbeddingConfig; error?: string }>
    setConfig: (patch: Partial<EmbeddingConfig>) => Promise<{ success: boolean; config?: EmbeddingConfig; error?: string }>
    test: (cfg: EmbeddingConfig) => Promise<{ success: boolean; dimension?: number; imageDimension?: number; imageInputMode?: 'image_base64' | 'content_part' | 'data_url'; error?: string; dimensionMismatch?: string }>
    sessionStatus: (sessionId: string) => Promise<{ success: boolean; enabled?: boolean; mediaEnabled?: boolean; count?: number; mediaCount?: number; store?: EmbeddingVectorStoreInfo; error?: string }>
    buildSession: (sessionId: string, options?: { target?: EmbeddingBuildTarget }) => Promise<{ success: boolean; indexed?: number; mediaIndexed?: number; error?: string }>
    onBuildProgress: (callback: (progress: EmbeddingBuildProgress) => void) => () => void
  }
  rerank: {
    getConfig: () => Promise<{ success: boolean; config?: RerankConfig; error?: string }>
    setConfig: (patch: Partial<RerankConfig>) => Promise<{ success: boolean; config?: RerankConfig; error?: string }>
    test: (cfg: RerankConfig) => Promise<{ success: boolean; error?: string }>
  }
  tts: {
    getConfig: () => Promise<{ success: boolean; config?: TtsConfig; available?: boolean; error?: string }>
    setConfig: (patch: Partial<TtsConfig>) => Promise<{ success: boolean; config?: TtsConfig; error?: string }>
    test: (cfg: Partial<TtsConfig>) => Promise<TtsSpeakResult>
    speak: (text: string, options?: TtsSpeakOptions) => Promise<TtsSpeakResult>
    stream?: (streamId: string, text: string, options: TtsSpeakOptions | undefined, callback: (event: TtsStreamEvent) => void) => Promise<TtsStreamResult>
    cancelStream?: (streamId: string) => Promise<{ success: boolean }>
  }
  voiceRealtime: {
    start: (payload: {
      callId: string
      sessionId: string
      dialogContext?: Array<{ role: 'user' | 'assistant'; text: string; timestamp?: number }>
    }) => Promise<{ success: boolean; callId?: string; error?: string }>
    sendAudio: (callId: string, audio: Uint8Array) => void
    truncate: (callId: string, replyId: string, audioEndMs: number) => Promise<{ success: boolean; error?: string }>
    stop: (callId: string) => Promise<{ success: boolean; error?: string }>
    onEvent: (callId: string, callback: (event: VoiceRealtimeEvent) => void) => () => void
  }
  imageGen: {
    getConfig: () => Promise<{ success: boolean; config?: ImageGenConfig; available?: boolean; error?: string }>
    setConfig: (patch: Partial<ImageGenConfig>) => Promise<{ success: boolean; config?: ImageGenConfig; error?: string }>
    test: (cfg: Partial<ImageGenConfig>) => Promise<{ success: boolean; filePath?: string; mimeType?: string; error?: string }>
  }
  // AI 接入
  ai: {
    getProviders: () => Promise<AIProviderInfo[]>
    getProxyStatus: () => Promise<{
      success: boolean
      hasProxy?: boolean
      proxyUrl?: string | null
      error?: string
    }>
    refreshProxy: () => Promise<{
      success: boolean
      hasProxy?: boolean
      proxyUrl?: string | null
      message?: string
      error?: string
    }>
    testProxy: (proxyUrl: string, testUrl?: string) => Promise<{
      success: boolean
      message?: string
      error?: string
    }>
    testConnection: (provider: string, apiKey: string, baseURL?: string, protocol?: 'openai-responses' | 'openai-compatible' | 'anthropic' | 'google' | 'codex-subscription', model?: string) => Promise<{
      success: boolean
      error?: string
      needsProxy?: boolean
    }>
    listModels: (options: { provider: string; apiKey?: string; baseURL?: string; protocol?: 'openai-responses' | 'openai-compatible' | 'anthropic' | 'google' | 'codex-subscription' }) => Promise<{
      success: boolean
      models?: string[]
      modelDetails?: AIModelInfo[]
      error?: string
    }>
    estimateCost: (messageCount: number, provider: string) => Promise<{
      success: boolean
      tokens?: number
      cost?: number
      error?: string
    }>
    readGuide: (guideName: string) => Promise<{
      success: boolean
      content?: string
      error?: string
    }>
  }
  codexSubscription: {
    getStatus: () => Promise<CodexSubscriptionStatus>
    getUsage: (forceRefresh?: boolean) => Promise<{ success: boolean; usage?: CodexSubscriptionUsage; error?: string }>
    login: () => Promise<{ success: boolean; loginId?: string; error?: string }>
    importFromCodexCli: () => Promise<{ success: boolean; error?: string }>
    listAccounts: () => Promise<{ success: boolean; accounts?: CodexAccount[]; error?: string }>
    setActiveAccount: (id: string) => Promise<{ success: boolean; error?: string }>
    removeAccount: (id: string) => Promise<{ success: boolean; error?: string }>
    logout: () => Promise<{ success: boolean; error?: string }>
    listModels: () => Promise<{ success: boolean; models?: CodexSubscriptionModel[]; error?: string }>
    onStatusChanged: (callback: (status: CodexSubscriptionStatus) => void) => () => void
  }
}
export interface ExportOptions {
  format: 'chatlab' | 'chatlab-jsonl' | 'json' | 'html' | 'txt' | 'excel' | 'sql'
  dateRange?: { start: number; end: number } | null
  exportMedia?: boolean
  exportAvatars?: boolean
}

export interface ContactExportOptions {
  format: 'json' | 'csv' | 'vcf'
  exportAvatars: boolean
  contactTypes: {
    friends: boolean
    groups: boolean
    officials: boolean
  }
  selectedUsernames?: string[]
}

export interface MomentsExportOptions {
  format: 'json' | 'html' | 'excel'
  dateRange?: { start: number; end: number } | null
  usernames?: string[]
}

export interface DatabaseFileInfo {
  fileName: string
  filePath: string
  fileSize: number
  wxid: string
  isDecrypted: boolean
  decryptedPath?: string
  needsUpdate?: boolean
}

export interface ImageFileInfo {
  fileName: string
  filePath: string
  fileSize: number
  isDecrypted: boolean
  decryptedPath?: string
  version: number  // 0=V3, 1=V4-V1, 2=V4-V2
}

export interface DecryptProgress {
  type: 'decrypt' | 'update' | 'migrate' | 'image' | 'imageBatch' | 'imageScanComplete' | 'complete' | 'error'
  current?: number
  total?: number
  fileName?: string
  fileProgress?: number
  error?: string
  images?: ImageFileInfo[]
}

export interface ActivationStatus {
  isActivated: boolean
  type: string | null
  expiresAt: string | null
  activatedAt: string | null
  daysRemaining: number | null
  deviceId: string
}

export interface ActivationResult {
  success: boolean
  message: string
  data?: {
    type: string
    expires_at: string | null
    activated_at: string
  }
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        allowpopups?: boolean;
        webpreferences?: string;
        style?: React.CSSProperties;
        ref?: any;
      }
    }
  }

  // Electron 类型声明
  namespace Electron {
    interface OpenDialogOptions {
      title?: string
      defaultPath?: string
      filters?: { name: string; extensions: string[] }[]
      properties?: ('openFile' | 'openDirectory' | 'multiSelections')[]
    }
    interface OpenDialogReturnValue {
      canceled: boolean
      filePaths: string[]
    }
    interface SaveDialogOptions {
      title?: string
      defaultPath?: string
      filters?: { name: string; extensions: string[] }[]
    }
    interface SaveDialogReturnValue {
      canceled: boolean
      filePath?: string
    }
  }
}

export { }
