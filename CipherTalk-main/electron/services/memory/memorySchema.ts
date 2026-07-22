export const MEMORY_DB_NAME = 'agent_memory.db'
export const MEMORY_SCHEMA_VERSION = '4'

export const MEMORY_SOURCE_TYPES = [
  'message',
  'conversation_block',
  'fact',
  'relationship',
  'profile',
  'timeline_summary',
  'media'
] as const

export type MemorySourceType = (typeof MEMORY_SOURCE_TYPES)[number]

export type MemoryEvidenceRef = {
  sessionId: string
  localId: number
  createTime: number
  sortSeq: number
  senderUsername?: string
  excerpt?: string
}

export type MemoryItem = {
  id: number
  memoryUid: string
  sourceType: MemorySourceType
  sessionId: string | null
  contactId: string | null
  groupId: string | null
  title: string
  content: string
  contentHash: string
  entities: string[]
  tags: string[]
  importance: number
  confidence: number
  timeStart: number | null
  timeEnd: number | null
  sourceRefs: MemoryEvidenceRef[]
  createdAt: number
  updatedAt: number
}

export type MemoryItemInput = {
  memoryUid: string
  sourceType: MemorySourceType
  sessionId?: string | null
  contactId?: string | null
  groupId?: string | null
  title?: string
  content: string
  contentHash?: string
  entities?: string[]
  tags?: string[]
  importance?: number
  confidence?: number
  timeStart?: number | null
  timeEnd?: number | null
  sourceRefs?: MemoryEvidenceRef[]
}

export type MemoryItemRow = {
  id: number
  memory_uid: string
  source_type: string
  session_id: string | null
  contact_id: string | null
  group_id: string | null
  title: string
  content: string
  content_hash: string
  entities_json: string
  tags_json: string
  importance: number
  confidence: number
  time_start: number | null
  time_end: number | null
  source_refs_json: string
  created_at: number
  updated_at: number
}

export type MemoryDatabaseStats = {
  itemCount: number
}

export type SessionMemoryBuildProgressStage =
  | 'preparing'
  | 'indexing_messages'
  | 'building_messages'
  | 'building_blocks'
  | 'building_facts'
  | 'completed'

export type SessionMemoryBuildProgressStatus =
  | 'running'
  | 'completed'
  | 'failed'

export type SessionMemoryBuildState = {
  sessionId: string
  messageCount: number
  blockCount: number
  factCount: number
  totalCount: number
  processedCount: number
  isRunning: boolean
  updatedAt: number
  completedAt?: number
  lastError?: string
}

export type SessionMemoryBuildProgressEvent = {
  sessionId: string
  stage: SessionMemoryBuildProgressStage
  status: SessionMemoryBuildProgressStatus
  processedCount: number
  totalCount: number
  message: string
  messageCount: number
  blockCount: number
  factCount: number
}

export type SessionMemoryBuildResult = SessionMemoryBuildState & {
  success: boolean
}
