import { ConfigService } from '../config'
import type { ChatSession, ContactInfo, Message } from './types'

export class ChatServiceState {
  configService = new ConfigService()

  // 缓存：会话ID -> 所有包含该会话消息的数据库和表名（增量更新）
  sessionTableCache: Map<string, { dbPath: string; tableName: string }[]> = new Map()
  // 缓存时间戳
  sessionTableCacheTime: number = 0
  // 缓存：已知的消息数据库文件列表
  knownMessageDbFiles: Set<string> = new Set()
  // 缓存：当前用户在 Name2Id 表中的 rowid（按数据库路径）- 这个是稳定的
  myRowIdCache: Map<string, number | null> = new Map()
  // 缓存：数据库是否有 Name2Id 表 - 表结构不会变
  hasName2IdCache: Map<string, boolean> = new Map()
  // 缓存：联系人表结构信息 - 表结构不会变
  contactColumnsCache: { hasBigHeadUrl: boolean; hasSmallHeadUrl: boolean; hasExtraBuffer: boolean; selectCols: string[] } | null = null
  // 缓存：企业微信企业 ID -> 企业名
  weComCorpNameCache: Map<string, string | undefined> = new Map()
  hasOpenImWordingTable: boolean | null = null
  // 缓存：头像 base64 数据
  avatarBase64Cache: Map<string, string> = new Map()
  // 标记：head_image.db 是否损坏
  headImageDbCorrupted: boolean = false

  // 增量同步相关
  currentSessionId: string | null = null
  // 记录每个会话已读取的最大 sortSeq (用于此后的增量查询)
  sessionCursor: Map<string, number> = new Map()

  // 启动屏预加载缓存（DB 连接后预热，首次访问时消费）
  preloadCache: {
    sessions: { success: boolean; sessions?: ChatSession[]; hasMore?: boolean } | null
    contacts: { success: boolean; contacts?: ContactInfo[]; error?: string } | null
    messages: Map<string, { success: boolean; messages?: Message[]; hasMore?: boolean }>
    builtAt: number
  } = { sessions: null, contacts: null, messages: new Map(), builtAt: 0 }
  readonly PRELOAD_CACHE_TTL = 5 * 60 * 1000
}
