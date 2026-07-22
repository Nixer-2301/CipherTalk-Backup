export const MCP_TOOL_NAMES = [
  'health_check',
  'get_status',
  'get_moments_timeline',
  'resolve_session',
  'export_chat',
  'list_sessions',
  'get_messages',
  'list_contacts',
  'search_messages',
  'search_memory',
  'transcribe_voice_message',
  'get_session_context'
] as const

export const MCP_CONTACT_KINDS = [
  'friend',
  'group',
  'official',
  'former_friend',
  'other'
] as const

export const MCP_MESSAGE_KINDS = [
  'text',
  'image',
  'voice',
  'contact_card',
  'video',
  'emoji',
  'location',
  'voip',
  'system',
  'quote',
  'app_music',
  'app_link',
  'app_file',
  'app_chat_record',
  'app_mini_program',
  'app_quote',
  'app_pat',
  'app_announcement',
  'app_gift',
  'app_transfer',
  'app_red_packet',
  'app',
  'unknown'
] as const

export const MCP_MEMORY_SOURCE_TYPES = [
  'message',
  'conversation_block',
  'fact',
  'relationship',
  'profile',
  'timeline_summary',
  'media'
] as const

export type McpToolName = (typeof MCP_TOOL_NAMES)[number]
export type McpContactKind = (typeof MCP_CONTACT_KINDS)[number]
export type McpMessageKind = (typeof MCP_MESSAGE_KINDS)[number]
export type McpMemorySourceType = (typeof MCP_MEMORY_SOURCE_TYPES)[number]
export type McpSearchMatchMode = 'substring' | 'exact'
export type McpStreamEventType = 'meta' | 'progress' | 'partial' | 'complete' | 'error'
export type McpStreamProgressStage =
  | 'resolving_input'
  | 'searching_contacts'
  | 'searching_sessions'
  | 'resolving_candidates'
  | 'validating_export_request'
  | 'preparing_export'
  | 'scanning_messages'
  | 'exporting'
  | 'writing'
  | 'streaming_hits'
  | 'completed'
  | 'failed'

export type McpLaunchMode = 'dev' | 'packaged'
export type McpLauncherMode = 'dev-runner' | 'packaged-launcher' | 'direct'
export type McpSessionKind = 'friend' | 'group' | 'official' | 'other'
export type McpMessageMatchField = 'text' | 'raw'
export type McpSessionContextMode = 'latest' | 'around'

export interface McpLaunchConfig {
  command: string
  args: string[]
  cwd: string
  mode: McpLaunchMode
}

export type McpErrorCode =
  | 'BAD_REQUEST'
  | 'APP_NOT_RUNNING'
  | 'DB_NOT_READY'
  | 'SESSION_NOT_FOUND'
  | 'STT_NOT_READY'
  | 'INTERNAL_ERROR'

export interface McpErrorShape {
  code: McpErrorCode
  message: string
  hint?: string
}

export interface McpHealthPayload {
  ok: boolean
  service: string
  version: string
  warnings: string[]
}

export interface McpStatusPayload {
  runtime: {
    pid: number
    platform: NodeJS.Platform
    appMode: McpLaunchMode
    launcherMode: McpLauncherMode
  }
  config: {
    mcpEnabled: boolean
    mcpExposeMediaPaths: boolean
    dbReady: boolean
  }
  capabilities: {
    tools: McpToolName[]
  }
  warnings: string[]
}

export interface McpMomentLivePhoto {
  url: string
  thumb: string
  md5?: string
  token?: string
  key?: string
  encIdx?: string
}

export interface McpMomentMedia {
  url: string
  thumb: string
  md5?: string
  token?: string
  key?: string
  thumbKey?: string
  encIdx?: string
  livePhoto?: McpMomentLivePhoto
  width?: number
  height?: number
}

export interface McpMomentShareInfo {
  title: string
  description: string
  contentUrl: string
  thumbUrl: string
  thumbKey?: string
  thumbToken?: string
  appName?: string
  type?: number
}

export interface McpMomentCommentEmoji {
  url: string
  md5: string
  width: number
  height: number
  encryptUrl?: string
  aesKey?: string
}

export interface McpMomentCommentImage {
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
}

export interface McpMomentComment {
  id: string
  nickname: string
  content: string
  refCommentId: string
  refNickname?: string
  emojis?: McpMomentCommentEmoji[]
  images?: McpMomentCommentImage[]
}

export interface McpMomentItem {
  id: string
  username: string
  nickname: string
  avatarUrl?: string
  createTime: number
  createTimeMs: number
  contentDesc: string
  type?: number
  media: McpMomentMedia[]
  shareInfo?: McpMomentShareInfo
  likes: string[]
  comments: McpMomentComment[]
  rawXml?: string
}

export interface McpMomentsTimelinePayload {
  items: McpMomentItem[]
  offset: number
  limit: number
  hasMore: boolean
}

export interface McpSessionRef {
  sessionId: string
  displayName: string
  kind: McpSessionKind
}

export interface McpSessionItem extends McpSessionRef {
  lastMessagePreview: string
  unreadCount: number
  lastTimestamp: number
  lastTimestampMs: number
  isPinned?: boolean
  isCollapsed?: boolean
  isFoldGroup?: boolean
}

export interface McpSessionsPayload {
  items: McpSessionItem[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
}

export interface McpResolvedSessionCandidate extends McpSessionRef {
  score: number
  confidence: 'high' | 'medium' | 'low'
  aliases: string[]
  evidence: string[]
}

export interface McpResolveSessionPayload {
  query: string
  resolved: boolean
  exact: boolean
  recommended?: McpResolvedSessionCandidate
  candidates: McpResolvedSessionCandidate[]
  suggestedNextAction: 'get_messages' | 'get_session_context' | 'search_messages' | 'list_contacts' | 'list_sessions'
  message: string
}

export type McpExportFormat = 'chatlab' | 'chatlab-jsonl' | 'json' | 'excel' | 'html'

export interface McpExportMediaOptions {
  exportAvatars: boolean
  exportImages: boolean
  exportVideos: boolean
  exportEmojis: boolean
  exportVoices: boolean
}

export type McpExportMissingField =
  | 'session'
  | 'dateRange'
  | 'format'
  | 'mediaOptions'
  | 'outputDir'

export interface McpExportDateRange {
  start: number
  end: number
}

export interface McpExportChatPayload {
  canExport: boolean
  validateOnly: boolean
  missingFields: McpExportMissingField[]
  nextQuestion?: string
  followUpQuestions?: Array<{
    field: McpExportMissingField
    question: string
  }>
  resolvedSession?: McpResolvedSessionCandidate
  candidates?: McpResolvedSessionCandidate[]
  outputDir?: string
  outputPath?: string
  format?: McpExportFormat
  dateRange?: McpExportDateRange
  mediaOptions?: McpExportMediaOptions
  success?: boolean
  successCount?: number
  failCount?: number
  error?: string
  message: string
}

export interface McpContactItem {
  contactId: string
  sessionId?: string
  hasSession?: boolean
  displayName: string
  remark?: string
  nickname?: string
  kind: McpContactKind
  lastContactTimestamp: number
  lastContactTimestampMs: number
}

export interface McpContactsPayload {
  items: McpContactItem[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
}

export interface McpCursor {
  sortSeq: number
  createTime: number
  localId: number
}

export interface McpMessageMedia {
  type: string
  localPath?: string | null
  md5?: string | null
  durationSeconds?: number | null
  transcript?: string | null
  fileName?: string | null
  fileSize?: number | null
  exists?: boolean | null
  isLivePhoto?: boolean | null
}

export interface McpMessageItem {
  messageId: number
  timestamp: number
  timestampMs: number
  direction: 'in' | 'out'
  kind: McpMessageKind
  text: string
  sender: {
    username: string | null
    displayName?: string | null
    isSelf: boolean
  }
  cursor: McpCursor
  media?: McpMessageMedia
  raw?: string
}

export interface McpMessagesPayload {
  items: McpMessageItem[]
  offset: number
  limit: number
  hasMore: boolean
}

export interface McpVoiceTranscriptionPayload {
  source: 'voice_message'
  sessionId: string
  localId: number
  createTime: number
  transcript: string
  cached: boolean
  sttMode: 'cpu' | 'gpu' | 'online'
}

export interface McpAudioFileTranscriptionPayload {
  source: 'audio_file'
  filePath: string
  transcript: string
  sttMode: 'cpu' | 'gpu' | 'online'
}

export interface McpSearchHit {
  session: McpSessionRef
  message: McpMessageItem
  excerpt: string
  matchedField: McpMessageMatchField
  score: number
  retrievalSource?: McpSearchRetrievalSource
}

export type McpSearchRetrievalSource = 'keyword_index' | 'scan'

export interface McpSearchVectorStatus {
  requested: boolean
  attempted: boolean
  providerAvailable: boolean
  indexComplete: boolean
  hitCount: number
  indexedMessages: number
  vectorizedMessages: number
  model?: string
  skippedReason?: string
  error?: string
}

export interface McpSearchRerankStatus {
  requested: boolean
  attempted: boolean
  enabled: boolean
  modelAvailable: boolean
  candidateCount: number
  rerankedCount: number
  model?: string
  skippedReason?: string
  error?: string
}

export interface McpSearchMessagesPayload {
  hits: McpSearchHit[]
  limit: number
  sessionsScanned: number
  messagesScanned: number
  truncated: boolean
  source?: 'index' | 'scan'
  indexStatus?: {
    ready: boolean
    indexedSessions: number
    indexedMessages: number
    error?: string
  }
  vectorSearch?: McpSearchVectorStatus
  rerank?: McpSearchRerankStatus
  sessionSummaries?: Array<{
    session: McpSessionRef
    hitCount: number
    topScore: number
    sampleExcerpts: string[]
  }>
}

export interface McpMemoryEvidenceRef {
  sessionId: string
  localId: number
  createTime: number
  sortSeq: number
  senderUsername?: string
  excerpt?: string
}

export interface McpMemoryItem {
  id: number
  memoryUid: string
  sourceType: McpMemorySourceType
  sessionId: string | null
  contactId: string | null
  groupId: string | null
  title: string
  content: string
  entities: string[]
  tags: string[]
  importance: number
  confidence: number
  timeStart: number | null
  timeStartMs: number | null
  timeEnd: number | null
  timeEndMs: number | null
  sourceRefs: McpMemoryEvidenceRef[]
  updatedAt: number
}

export interface McpMemoryExpandedEvidence {
  ref: McpMemoryEvidenceRef
  before: McpMessageItem[]
  anchor: McpMessageItem | null
  after: McpMessageItem[]
}

export interface McpMemorySearchHit {
  rank: number
  score: number
  rerankScore?: number
  sources: string[]
  sourceRanks: Record<string, number>
  sourceScores: Record<string, number>
  memory: McpMemoryItem
  evidence: McpMemoryExpandedEvidence[]
}

export interface McpMemorySearchPayload {
  query: string
  hits: McpMemorySearchHit[]
  limit: number
  truncated: boolean
  sourceStats: Array<{
    name: string
    attempted: boolean
    hitCount: number
    skippedReason?: string
    error?: string
  }>
  rerank: {
    attempted: boolean
    applied: boolean
    skippedReason?: string
    error?: string
  }
  latencyMs: number
}

export interface McpSessionContextPayload {
  session: McpSessionRef
  mode: McpSessionContextMode
  anchor?: McpMessageItem
  items: McpMessageItem[]
  hasMoreBefore: boolean
  hasMoreAfter: boolean
}

export interface McpStreamMetaPayload {
  toolName: McpToolName
  requestId?: string
  startedAt: number
}

export interface McpStreamProgressPayload {
  stage: McpStreamProgressStage
  message?: string
  sessionsScanned?: number
  messagesScanned?: number
  candidates?: Array<Pick<McpSessionRef, 'sessionId' | 'displayName' | 'kind'>>
  candidateCount?: number
  truncated?: boolean
}

export interface McpStreamPartialPayloadMap {
  resolve_session: Partial<McpResolveSessionPayload>
  export_chat: Partial<McpExportChatPayload>
  list_sessions: Partial<McpSessionsPayload>
  list_contacts: Partial<McpContactsPayload>
  get_messages: Partial<McpMessagesPayload>
  search_messages: Partial<McpSearchMessagesPayload>
  search_memory: Partial<McpMemorySearchPayload>
  get_session_context: Partial<McpSessionContextPayload>
}

export type McpStreamPartialPayload =
  | McpStreamPartialPayloadMap['export_chat']
  | McpStreamPartialPayloadMap['list_sessions']
  | McpStreamPartialPayloadMap['list_contacts']
  | McpStreamPartialPayloadMap['get_messages']
  | McpStreamPartialPayloadMap['search_messages']
  | McpStreamPartialPayloadMap['search_memory']
  | McpStreamPartialPayloadMap['get_session_context']

export interface McpStreamMetaEvent {
  event: 'meta'
  data: McpStreamMetaPayload
}

export interface McpStreamProgressEvent {
  event: 'progress'
  data: McpStreamProgressPayload
}

export interface McpStreamPartialEvent {
  event: 'partial'
  data: {
    toolName: McpToolName
    chunkIndex: number
    payload: McpStreamPartialPayload
  }
}

export interface McpStreamCompleteEvent {
  event: 'complete'
  data: {
    toolName: McpToolName
    summary: string
    payload: unknown
    completedAt: number
  }
}

export interface McpStreamErrorEvent {
  event: 'error'
  data: McpErrorShape & {
    toolName: McpToolName
    failedAt: number
  }
}

export type McpStreamEvent =
  | McpStreamMetaEvent
  | McpStreamProgressEvent
  | McpStreamPartialEvent
  | McpStreamCompleteEvent
  | McpStreamErrorEvent

// ─── 工具名 → Payload 类型映射（用于 executeMcpTool 泛型） ──

/** 每个 MCP 工具对应的 payload 类型 */
export interface McpToolPayloadMap {
  health_check: McpHealthPayload
  get_status: McpStatusPayload
  get_moments_timeline: McpMomentsTimelinePayload
  resolve_session: McpResolveSessionPayload
  export_chat: McpExportChatPayload
  list_sessions: McpSessionsPayload
  get_messages: McpMessagesPayload
  list_contacts: McpContactsPayload
  search_messages: McpSearchMessagesPayload
  search_memory: McpMemorySearchPayload
  transcribe_voice_message: McpVoiceTranscriptionPayload
  transcribe_audio_file: McpAudioFileTranscriptionPayload
  get_session_context: McpSessionContextPayload
}

/** executeMcpTool 的类型安全返回值 */
export interface McpToolResult<T extends McpToolName = McpToolName> {
  summary: string
  payload: McpToolPayloadMap[T]
}
