import type { RuntimeConfig } from '../types.js'

export interface StatusData {
  configured: boolean
  configPath: string
  dbPath?: string
  wxid?: string
  nativeRoot: string
  databaseFiles: number
  connection?: {
    attempted: boolean
    ok: boolean
    sessionCount?: number
    error?: string
  }
}

export interface SessionRow {
  sessionId: string
  displayName: string
  type: 'private' | 'group' | 'mp' | 'other'
  lastMessage: string
  lastTime: number
  messageCount?: number
}

export interface MessageRow {
  localId?: number
  serverId?: number
  createTime?: number
  sortSeq?: number
  direction: 'in' | 'out' | 'unknown'
  senderUsername?: string
  type?: number | string
  content: string
  raw?: unknown
}

export interface ContactRow {
  wxid: string
  displayName: string
  type: 'friend' | 'group' | 'mp' | 'former_friend' | 'other'
  remark?: string
  nickname?: string
  avatarUrl?: string
  lastContactTime?: number
}

export interface DataService {
  getStatus(config: RuntimeConfig): Promise<StatusData>
  listSessions(config: RuntimeConfig, options: { type?: string; limit: number; offset?: number }): Promise<{ sessions: SessionRow[]; hasMore: boolean }>
  getMessages(config: RuntimeConfig, session: string, options: { limit: number; offset?: number; from?: string; to?: string; type?: string; direction?: string; cursor?: string }): Promise<{ messages: MessageRow[]; cursor: string | null }>
  listContacts(config: RuntimeConfig, options: { type?: string; limit: number }): Promise<{ contacts: ContactRow[] }>
  getContactInfo(config: RuntimeConfig, contact: string): Promise<ContactRow | null>
}

export interface KeyService {
  setKey(hex: string): Promise<{ saved: boolean; keyHex: string }>
  testKey(config: RuntimeConfig): Promise<{ validFormat: boolean; connection?: StatusData['connection'] }>
  getKey(config: RuntimeConfig, options?: { save?: boolean }): Promise<{ keyHex: string; saved: boolean }>
}

export interface SearchResult {
  sessionId: string
  sessionName: string
  messages: MessageRow[]
  total: number
}

export interface ExportOptions {
  session?: string
  all?: boolean
  output?: string
  from?: string
  to?: string
  withMedia?: boolean
}

export interface MomentsOptions {
  limit?: number
  user?: string
  from?: string
  to?: string
}

export interface MomentsEntry {
  id: string
  author: { wxid: string; displayName: string }
  createTime: number
  contentText: string
  mediaUrls: string[]
  likes: number
  comments: number
  raw: unknown
}

export interface MomentsResult {
  entries: MomentsEntry[]
  total: number
  limit: number
  meta?: {
    nativeSupported: boolean
    note?: string
  }
}

export interface AdvancedService {
  search(config: RuntimeConfig, keyword: string, options?: { session?: string; limit?: number; from?: string; to?: string }): Promise<SearchResult>
  exportChat(config: RuntimeConfig, options: ExportOptions): Promise<{ path: string; count: number }>
  moments(config: RuntimeConfig, options?: MomentsOptions): Promise<MomentsResult>
  mcpServe(): Promise<never>
}

export interface ServiceRegistry {
  data: DataService
  key: KeyService
  advanced: AdvancedService
}
