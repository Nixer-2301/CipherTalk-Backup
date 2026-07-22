import Database from 'better-sqlite3'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { chatService, type Message } from '../chatService'
import { ConfigService } from '../config'
import { voiceTranscribeService } from '../voiceTranscribeService'

export type ChatSearchIndexProgressStage =
  | 'preparing_index'
  | 'indexing_messages'
  | 'searching_index'
  | 'completed'

export interface ChatSearchIndexProgress {
  stage: ChatSearchIndexProgressStage
  message: string
  sessionId: string
  messagesScanned?: number
  indexedCount?: number
}

export interface ChatSearchIndexState {
  sessionId: string
  indexedCount: number
  newestSortSeq: number
  newestCreateTime: number
  newestLocalId: number
  updatedAt: number
  isComplete: boolean
}

export interface ChatSearchIndexHit {
  sessionId: string
  message: Message
  excerpt: string
  matchedField: 'text' | 'raw'
  score: number
}

export interface ChatSearchSessionOptions {
  sessionId: string
  query: string
  limit: number
  matchMode?: 'substring' | 'exact'
  startTimeMs?: number
  endTimeMs?: number
  direction?: 'in' | 'out'
  senderUsername?: string
  maxIndexMessages?: number
  reusePartialIndex?: boolean
  onProgress?: (progress: ChatSearchIndexProgress) => void | Promise<void>
}

export interface ChatSearchSessionResult {
  hits: ChatSearchIndexHit[]
  indexedCount: number
  indexComplete: boolean
  truncated: boolean
}

export interface ChatSearchMemoryMessage {
  id: number
  sessionId: string
  localId: number
  serverId: number
  localType: number
  createTime: number
  sortSeq: number
  isSend: number | null
  senderUsername: string | null
  parsedContent: string
  rawContent: string
  searchText: string
}

export type ChatSearchMediaKind = 'image' | 'emoji'

export interface ChatSearchMediaMessageRow {
  sessionId: string
  localId: number
  sortSeq: number
  createTime: number
  isSend: number | null
  senderUsername: string | null
  localType: number
  parsedContent: string
  rawContent: string
}

type MessageIndexRow = {
  id: number
  session_id: string
  local_id: number
  server_id: number
  local_type: number
  create_time: number
  sort_seq: number
  is_send: number | null
  sender_username: string | null
  parsed_content: string
  raw_content: string
  search_text: string
  token_text: string
  message_json: string
}

const INDEX_DB_NAME = 'chat_search_index.db'
const INDEX_SCHEMA_VERSION = '6'
const INDEX_BATCH_SIZE = 800
const MAX_INDEX_TEXT_CHARS = 8000
const MAX_EXCERPT_RADIUS = 48
const MAX_INDEX_SEARCH_CANDIDATES = 240

function cursorKey(message: Pick<Message, 'localId' | 'createTime' | 'sortSeq'>): string {
  return `${Number(message.localId || 0)}:${Number(message.createTime || 0)}:${Number(message.sortSeq || 0)}`
}

function compareCursorAsc(
  a: Pick<Message, 'sortSeq' | 'createTime' | 'localId'>,
  b: Pick<Message, 'sortSeq' | 'createTime' | 'localId'>
): number {
  return Number(a.sortSeq || 0) - Number(b.sortSeq || 0)
    || Number(a.createTime || 0) - Number(b.createTime || 0)
    || Number(a.localId || 0) - Number(b.localId || 0)
}

function normalizeSearchText(value?: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/[ \t\r\n]+/g, ' ')
    .replace(/[，。！？；：、“”‘’（）()[\]{}<>《》|\\/+=*_~`#$%^&-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function compactSearchText(value: string): string {
  const normalized = normalizeSearchText(value)
  return normalized.length > MAX_INDEX_TEXT_CHARS
    ? normalized.slice(0, MAX_INDEX_TEXT_CHARS)
    : normalized
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const value of values) {
    const normalized = normalizeSearchText(value)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }

  return result
}

function extractMessageSearchText(message: Message, transcript?: string): string {
  const chatRecordText = Array.isArray(message.chatRecordList)
    ? message.chatRecordList
      .flatMap((item) => [
        item.datadesc,
        item.datatitle,
        item.sourcename,
        item.fileext
      ])
      .filter(Boolean)
      .join(' ')
    : ''

  const mediaFallback = (() => {
    switch (Number(message.localType || 0)) {
      case 3:
        return '[图片]'
      case 34:
        return transcript || '[语音]'
      case 43:
        return '[视频]'
      case 47:
        return '[表情]'
      case 49:
        return '[文件]'
      default:
        return ''
    }
  })()

  return [
    transcript || message.parsedContent,
    message.quotedContent,
    message.fileName,
    chatRecordText,
    message.rawContent,
    mediaFallback
  ]
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .join(' ')
}

function buildSearchTokens(value: string): string {
  const normalized = normalizeSearchText(value)
  const tokens: string[] = []

  for (const match of normalized.matchAll(/[\u3400-\u9fff]+/g)) {
    const segment = match[0]
    if (segment.length <= 3) {
      tokens.push(segment)
    }

    for (let size = 2; size <= 3; size += 1) {
      if (segment.length < size) continue
      for (let index = 0; index <= segment.length - size; index += 1) {
        tokens.push(segment.slice(index, index + size))
      }
    }
  }

  for (const match of normalized.matchAll(/[a-z0-9_@.\-]{2,}/g)) {
    tokens.push(match[0])
  }

  return uniqueStrings(tokens).join(' ')
}

function buildQueryTokens(query: string): string[] {
  const normalized = normalizeSearchText(query)
  const tokens: string[] = []

  for (const match of normalized.matchAll(/[\u3400-\u9fff]+/g)) {
    const segment = match[0]
    if (segment.length <= 3) {
      tokens.push(segment)
    }

    const gramSize = segment.length <= 4 ? 2 : 3
    if (segment.length >= gramSize) {
      for (let index = 0; index <= segment.length - gramSize; index += 1) {
        tokens.push(segment.slice(index, index + gramSize))
      }
    }
  }

  for (const match of normalized.matchAll(/[a-z0-9_@.\-]{2,}/g)) {
    tokens.push(match[0])
  }

  return uniqueStrings(tokens).slice(0, 12)
}

function quoteFtsTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`
}

function buildFtsQuery(query: string): string {
  return buildQueryTokens(query).map(quoteFtsTerm).join(' ')
}

function createExcerpt(source: string, matchedIndex: number, queryLength: number): string {
  if (!source) return ''
  const safeIndex = Math.max(0, matchedIndex)
  const start = Math.max(0, safeIndex - MAX_EXCERPT_RADIUS)
  const end = Math.min(source.length, safeIndex + queryLength + MAX_EXCERPT_RADIUS)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < source.length ? '...' : ''
  return `${prefix}${source.slice(start, end)}${suffix}`
}

function findMatchInIndexedText(
  row: Pick<MessageIndexRow, 'parsed_content' | 'raw_content' | 'search_text' | 'token_text'>,
  query: string,
  matchMode: 'substring' | 'exact' = 'substring'
): { matchedField: 'text' | 'raw'; excerpt: string; score: number } {
  const exactQuery = String(query || '').trim()
  const normalizedQuery = normalizeSearchText(query)
  const compactQuery = normalizedQuery.replace(/\s+/g, '')
  const text = String(row.parsed_content || '')
  const raw = String(row.raw_content || '')
  const normalizedText = normalizeSearchText(text)
  const normalizedRaw = normalizeSearchText(raw)
  const normalizedSearchText = String(row.search_text || '')

  const matchIndex = matchMode === 'exact'
    ? text.indexOf(exactQuery)
    : normalizedText.indexOf(normalizedQuery)

  if (matchIndex >= 0) {
    return {
      matchedField: 'text',
      excerpt: createExcerpt(text || normalizedText, matchIndex, normalizedQuery.length),
      score: 1400 - Math.min(matchIndex, 500)
    }
  }

  const compactSearchIndex = compactQuery
    ? normalizedSearchText.replace(/\s+/g, '').indexOf(compactQuery)
    : -1
  if (compactSearchIndex >= 0) {
    return {
      matchedField: 'text',
      excerpt: createExcerpt(text || normalizedSearchText, Math.min(compactSearchIndex, Math.max(0, (text || normalizedSearchText).length - 1)), normalizedQuery.length),
      score: 1180 - Math.min(compactSearchIndex, 500)
    }
  }

  const rawIndex = matchMode === 'exact'
    ? raw.indexOf(exactQuery)
    : normalizedRaw.indexOf(normalizedQuery)
  if (rawIndex >= 0) {
    return {
      matchedField: 'raw',
      excerpt: createExcerpt(raw || normalizedRaw, rawIndex, normalizedQuery.length),
      score: 880 - Math.min(rawIndex, 500)
    }
  }

  const queryTokens = buildQueryTokens(query)
  const tokenText = String(row.token_text || '')
  const matchedTokens = queryTokens.filter((token) => tokenText.includes(token))
  const ratio = queryTokens.length > 0 ? matchedTokens.length / queryTokens.length : 0
  return {
    matchedField: 'text',
    excerpt: createExcerpt(text || normalizedSearchText, 0, Math.max(normalizedQuery.length, 1)),
    score: Number((720 + ratio * 260 + matchedTokens.length * 8).toFixed(2))
  }
}

function hasExactMessageMatch(row: Pick<MessageIndexRow, 'parsed_content' | 'raw_content'>, query: string): boolean {
  const exactQuery = String(query || '').trim()
  if (!exactQuery) return false
  return String(row.parsed_content || '').includes(exactQuery)
    || String(row.raw_content || '').includes(exactQuery)
}

function rowToMessage(row: MessageIndexRow): Message {
  try {
    const parsed = JSON.parse(row.message_json) as Message
    return {
      ...parsed,
      localId: Number(parsed.localId ?? row.local_id ?? 0),
      serverId: Number(parsed.serverId ?? row.server_id ?? 0),
      localType: Number(parsed.localType ?? row.local_type ?? 0),
      createTime: Number(parsed.createTime ?? row.create_time ?? 0),
      sortSeq: Number(parsed.sortSeq ?? row.sort_seq ?? 0),
      isSend: parsed.isSend ?? row.is_send ?? null,
      senderUsername: parsed.senderUsername ?? row.sender_username ?? null,
      parsedContent: String(parsed.parsedContent ?? row.parsed_content ?? ''),
      rawContent: String(parsed.rawContent ?? row.raw_content ?? '')
    }
  } catch {
    return {
      localId: Number(row.local_id || 0),
      serverId: Number(row.server_id || 0),
      localType: Number(row.local_type || 0),
      createTime: Number(row.create_time || 0),
      sortSeq: Number(row.sort_seq || 0),
      isSend: row.is_send ?? null,
      senderUsername: row.sender_username ?? null,
      parsedContent: String(row.parsed_content || ''),
      rawContent: String(row.raw_content || '')
    }
  }
}

function toTimestampSeconds(value?: number): number | undefined {
  if (!value || !Number.isFinite(value)) return undefined
  return value > 1_000_000_000_000 ? Math.floor(value / 1000) : Math.floor(value)
}

export class ChatSearchIndexService {
  private db: Database.Database | null = null
  private dbPath: string | null = null

  private getCacheBasePath(): string {
    const configService = new ConfigService()
    try {
      return configService.getCacheBasePath()
    } finally {
      configService.close()
    }
  }

  private getDb(): Database.Database {
    const basePath = this.getCacheBasePath()
    if (!existsSync(basePath)) {
      mkdirSync(basePath, { recursive: true })
    }

    const nextDbPath = join(basePath, INDEX_DB_NAME)
    if (this.db && this.dbPath === nextDbPath) {
      return this.db
    }

    if (this.db) {
      try {
        this.db.close()
      } catch {
        // ignore
      }
    }

    let db = new Database(nextDbPath)
    try {
      this.ensureSchema(db)
    } catch (e) {
      try { db.close() } catch { /* ignore */ }
      if (!this.isMissingVec0ModuleError(e)) throw e
      // 旧版本曾在本索引库建 sqlite-vec 的 message_embedding_vec(vec0) 虚表。新版不再加载该原生扩展，
      // 而 DROP 这张虚表需调用 vec0 模块析构，模块缺失会抛 "no such module: vec0"，导致整个索引库
      // 打不开（连带依赖它的数字分身构建直接报错）。索引库是可从微信库重建的派生缓存，直接删库重建。
      this.removeSqliteFileSet(nextDbPath)
      db = new Database(nextDbPath)
      this.ensureSchema(db)
    }
    this.db = db
    this.dbPath = nextDbPath
    return db
  }

  private isMissingVec0ModuleError(error: unknown): boolean {
    return /no such module:\s*vec0/i.test(error instanceof Error ? error.message : String(error))
  }

  private removeSqliteFileSet(dbPath: string): void {
    for (const filePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
      try {
        if (existsSync(filePath)) rmSync(filePath, { force: true })
      } catch {
        // best-effort 清理，删不掉也不阻塞重建
      }
    }
  }

  close(): void {
    if (!this.db) return
    try {
      this.db.close()
    } catch {
      // ignore
    } finally {
      this.db = null
      this.dbPath = null
    }
  }

  private ensureSchema(db: Database.Database): void {
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)

    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value?: string } | undefined
    const needsMigration = row?.value && row.value !== INDEX_SCHEMA_VERSION

    if (!needsMigration && row?.value === INDEX_SCHEMA_VERSION && !this.hasHealthySchema(db)) {
      console.warn('[ChatSearchIndex] 检测到搜索索引 schema 不完整，准备重建')
      this.resetSchema(db)
    } else if (needsMigration) {
      try {
        this.resetSchema(db)
      } catch (err) {
        console.warn('[ChatSearchIndex] 迁移清表失败，继续重建:', (err as Error)?.message)
      }
    }

    const runMigrate = db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS message_index (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          local_id INTEGER NOT NULL,
          server_id INTEGER NOT NULL DEFAULT 0,
          local_type INTEGER NOT NULL DEFAULT 0,
          create_time INTEGER NOT NULL DEFAULT 0,
          sort_seq INTEGER NOT NULL DEFAULT 0,
          is_send INTEGER,
          sender_username TEXT,
          parsed_content TEXT NOT NULL DEFAULT '',
          raw_content TEXT NOT NULL DEFAULT '',
          search_text TEXT NOT NULL DEFAULT '',
          token_text TEXT NOT NULL DEFAULT '',
          message_json TEXT NOT NULL DEFAULT '{}',
          indexed_at INTEGER NOT NULL,
          UNIQUE(session_id, local_id, create_time, sort_seq)
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS message_index_fts USING fts5(
          session_id UNINDEXED,
          cursor_key UNINDEXED,
          search_text,
          token_text,
          tokenize = 'unicode61'
        );

        CREATE TABLE IF NOT EXISTS session_index_state (
          session_id TEXT PRIMARY KEY,
          newest_sort_seq INTEGER NOT NULL DEFAULT 0,
          newest_create_time INTEGER NOT NULL DEFAULT 0,
          newest_local_id INTEGER NOT NULL DEFAULT 0,
          indexed_count INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          is_complete INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_message_index_session_time
          ON message_index(session_id, sort_seq DESC, create_time DESC, local_id DESC);
        CREATE INDEX IF NOT EXISTS idx_message_index_session_type_time
          ON message_index(session_id, local_type, sort_seq DESC, create_time DESC, local_id DESC);
        CREATE INDEX IF NOT EXISTS idx_message_index_type_time
          ON message_index(local_type, sort_seq DESC, create_time DESC, local_id DESC);
        CREATE INDEX IF NOT EXISTS idx_message_index_session_sender
          ON message_index(session_id, sender_username);
      `)

      db.exec(`
        DROP TABLE IF EXISTS message_embedding_vec;
        DROP TABLE IF EXISTS message_vector_index;
        DROP TABLE IF EXISTS session_vector_state;
      `)

      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', INDEX_SCHEMA_VERSION)
    })

    try {
      runMigrate()
    } catch (err) {
      console.error('[ChatSearchIndex] schema 迁移失败:', (err as Error)?.message)
      throw err
    }
  }

  private resetSchema(db: Database.Database): void {
    db.exec(`
      DROP TABLE IF EXISTS message_index_fts;
      DROP TABLE IF EXISTS message_embedding_vec;
      DROP TABLE IF EXISTS message_vector_index;
      DROP TABLE IF EXISTS session_vector_state;
      DROP TABLE IF EXISTS message_index;
      DROP TABLE IF EXISTS session_index_state;
      DELETE FROM meta WHERE key = 'schema_version';
    `)
  }

  private rebuildSchema(db: Database.Database): void {
    this.resetSchema(db)
    this.ensureSchema(db)
  }

  private tableExists(db: Database.Database, name: string): boolean {
    const row = db.prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE name = ? AND type IN ('table', 'virtual table') LIMIT 1"
    ).get(name) as { ok?: number } | undefined
    return Number(row?.ok || 0) === 1
  }

  private hasHealthySchema(db: Database.Database): boolean {
    if (!this.tableExists(db, 'message_index') ||
      !this.tableExists(db, 'message_index_fts') ||
      !this.tableExists(db, 'session_index_state')) {
      return false
    }
    try {
      db.prepare('SELECT rowid FROM message_index_fts LIMIT 0')
      return true
    } catch (error) {
      console.warn('[ChatSearchIndex] FTS 虚表不可用，准备重建:', error instanceof Error ? error.message : String(error))
      return false
    }
  }

  private isMissingSearchIndexTableError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error || '')
    return /no such table:\s*(?:main\.)?(message_index_fts(?:_[a-z]+)?|message_index|session_index_state)\b/i.test(message)
  }

  private getSessionState(db: Database.Database, sessionId: string): ChatSearchIndexState | null {
    const row = db.prepare('SELECT * FROM session_index_state WHERE session_id = ?').get(sessionId) as any
    if (!row) return null

    return {
      sessionId,
      indexedCount: Number(row.indexed_count || 0),
      newestSortSeq: Number(row.newest_sort_seq || 0),
      newestCreateTime: Number(row.newest_create_time || 0),
      newestLocalId: Number(row.newest_local_id || 0),
      updatedAt: Number(row.updated_at || 0),
      isComplete: Number(row.is_complete || 0) === 1
    }
  }

  private getIndexedCount(db: Database.Database, sessionId: string): number {
    const row = db.prepare('SELECT COUNT(*) AS count FROM message_index WHERE session_id = ?').get(sessionId) as { count?: number }
    return Number(row?.count || 0)
  }

  getSessionSearchIndexState(sessionId: string): ChatSearchIndexState | null {
    const db = this.getDb()
    return this.getSessionState(db, sessionId)
  }

  ensureSessionIndexedInBackground(sessionId: string): void {
    void this.ensureSessionIndexed(sessionId).catch((error) => {
      console.warn('[ChatSearchIndex] 后台搜索索引准备失败:', error)
    })
  }

  private async yieldToEventLoop(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }

  private async upsertMessages(db: Database.Database, sessionId: string, messages: Message[]): Promise<void> {
    if (messages.length === 0) return

    const upsert = db.prepare(`
      INSERT INTO message_index (
        session_id,
        local_id,
        server_id,
        local_type,
        create_time,
        sort_seq,
        is_send,
        sender_username,
        parsed_content,
        raw_content,
        search_text,
        token_text,
        message_json,
        indexed_at
      ) VALUES (
        @sessionId,
        @localId,
        @serverId,
        @localType,
        @createTime,
        @sortSeq,
        @isSend,
        @senderUsername,
        @parsedContent,
        @rawContent,
        @searchText,
        @tokenText,
        @messageJson,
        @indexedAt
      )
      ON CONFLICT(session_id, local_id, create_time, sort_seq) DO UPDATE SET
        server_id = excluded.server_id,
        local_type = excluded.local_type,
        is_send = excluded.is_send,
        sender_username = excluded.sender_username,
        parsed_content = excluded.parsed_content,
        raw_content = excluded.raw_content,
        search_text = excluded.search_text,
        token_text = excluded.token_text,
        message_json = excluded.message_json,
        indexed_at = excluded.indexed_at
    `)
    const selectId = db.prepare(`
      SELECT id FROM message_index
      WHERE session_id = ? AND local_id = ? AND create_time = ? AND sort_seq = ?
    `)
    const deleteFts = db.prepare('DELETE FROM message_index_fts WHERE rowid = ?')
    const insertFts = db.prepare(`
      INSERT INTO message_index_fts(rowid, session_id, cursor_key, search_text, token_text)
      VALUES (?, ?, ?, ?, ?)
    `)

    const run = db.transaction((items: Message[]) => {
      const indexedAt = Date.now()
      for (const message of items) {
        const transcript = Number(message.localType) === 34
          ? voiceTranscribeService.getCachedTranscript(sessionId, message.createTime, message.localId) || undefined
          : undefined
        const searchText = compactSearchText(extractMessageSearchText(message, transcript))
        const tokenText = buildSearchTokens(searchText)
        const payload = {
          sessionId,
          localId: Number(message.localId || 0),
          serverId: Number(message.serverId || 0),
          localType: Number(message.localType || 0),
          createTime: Number(message.createTime || 0),
          sortSeq: Number(message.sortSeq || 0),
          isSend: message.isSend ?? null,
          senderUsername: message.senderUsername ?? null,
          parsedContent: String(message.parsedContent || ''),
          rawContent: String(message.rawContent || ''),
          searchText,
          tokenText,
          messageJson: JSON.stringify(message),
          indexedAt
        }

        upsert.run(payload)
        const row = selectId.get(sessionId, payload.localId, payload.createTime, payload.sortSeq) as { id?: number } | undefined
        if (!row?.id) continue

        deleteFts.run(row.id)
        insertFts.run(row.id, sessionId, cursorKey(message), searchText, tokenText)
      }
    })

    run(messages)
  }

  private updateSessionState(db: Database.Database, sessionId: string, newest: Message | null, isComplete: boolean): ChatSearchIndexState {
    const indexedCount = this.getIndexedCount(db, sessionId)
    const previous = this.getSessionState(db, sessionId)
    const previousNewest = previous
      ? {
        localId: previous.newestLocalId,
        createTime: previous.newestCreateTime,
        sortSeq: previous.newestSortSeq
      }
      : null
    const selectedNewest = newest && (!previousNewest || compareCursorAsc(previousNewest, newest) <= 0)
      ? newest
      : previousNewest

    const state = {
      sessionId,
      indexedCount,
      newestSortSeq: Number(selectedNewest?.sortSeq || 0),
      newestCreateTime: Number(selectedNewest?.createTime || 0),
      newestLocalId: Number(selectedNewest?.localId || 0),
      updatedAt: Date.now(),
      isComplete
    }

    db.prepare(`
      INSERT INTO session_index_state (
        session_id,
        newest_sort_seq,
        newest_create_time,
        newest_local_id,
        indexed_count,
        updated_at,
        is_complete
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        newest_sort_seq = excluded.newest_sort_seq,
        newest_create_time = excluded.newest_create_time,
        newest_local_id = excluded.newest_local_id,
        indexed_count = excluded.indexed_count,
        updated_at = excluded.updated_at,
        is_complete = excluded.is_complete
    `).run(
      state.sessionId,
      state.newestSortSeq,
      state.newestCreateTime,
      state.newestLocalId,
      state.indexedCount,
      state.updatedAt,
      state.isComplete ? 1 : 0
    )

    return state
  }

  private async report(progress: ChatSearchIndexProgress, onProgress?: ChatSearchSessionOptions['onProgress']): Promise<void> {
    await onProgress?.(progress)
  }

  private canReuseCompleteSearchIndexAfterSourceError(
    state: ChatSearchIndexState | null,
    error?: string
  ): state is ChatSearchIndexState {
    if (!state?.isComplete || state.indexedCount <= 0) return false
    const message = String(error || '')
    return message.includes('未找到该会话的消息表')
      || message.includes('WCDB 未初始化')
      || message.includes('Chat database is not ready')
  }

  async ensureSessionIndexed(
    sessionId: string,
    onProgress?: ChatSearchSessionOptions['onProgress'],
    options: { maxMessages?: number; reusePartial?: boolean } = {}
  ): Promise<ChatSearchIndexState> {
    try {
      return await this.ensureSessionIndexedOnce(sessionId, onProgress, options)
    } catch (error) {
      if (!this.isMissingSearchIndexTableError(error)) throw error
      const db = this.getDb()
      console.warn('[ChatSearchIndex] 搜索索引表缺失，重建缓存后重试:', error instanceof Error ? error.message : String(error))
      this.rebuildSchema(db)
      return await this.ensureSessionIndexedOnce(sessionId, onProgress, options)
    }
  }

  /**
   * 把已有的部分索引向更早的历史续扫（不推倒重建），直到 indexedCount ≥ targetIndexed 或扫完全部。
   * 没有索引时按 targetIndexed 建部分索引；已完整或已够深时直接返回现状。
   * 供搜索命中不足时逐步加深覆盖（Agent 工具用）。
   */
  async deepenSessionIndex(
    sessionId: string,
    targetIndexed: number,
    onProgress?: ChatSearchSessionOptions['onProgress']
  ): Promise<ChatSearchIndexState> {
    const db = this.getDb()
    const state = this.getSessionState(db, sessionId)
    if (!state || state.indexedCount === 0) {
      return this.ensureSessionIndexed(sessionId, onProgress, { maxMessages: targetIndexed, reusePartial: true })
    }
    if (state.isComplete || state.indexedCount >= targetIndexed) return state

    const oldestRow = db.prepare(`
      SELECT sort_seq, create_time, local_id FROM message_index
      WHERE session_id = ?
      ORDER BY sort_seq ASC, create_time ASC, local_id ASC LIMIT 1
    `).get(sessionId) as { sort_seq: number; create_time: number; local_id: number } | undefined
    if (!oldestRow) {
      return this.ensureSessionIndexed(sessionId, onProgress, { maxMessages: targetIndexed })
    }

    let cursor = {
      sortSeq: Number(oldestRow.sort_seq),
      createTime: Number(oldestRow.create_time),
      localId: Number(oldestRow.local_id)
    }
    let indexed = state.indexedCount
    let scanned = 0
    let hasMore = true

    await this.report({
      stage: 'preparing_index',
      sessionId,
      message: '正在向更早的聊天记录扩展搜索索引',
      indexedCount: indexed
    }, onProgress)

    while (hasMore && indexed < targetIndexed) {
      const result = await chatService.getMessagesBefore(
        sessionId,
        cursor.sortSeq,
        INDEX_BATCH_SIZE,
        cursor.createTime,
        cursor.localId
      )
      if (!result.success) {
        throw new Error(result.error || '扩展搜索索引失败')
      }
      const messages = result.messages || []
      if (messages.length === 0) break
      await this.upsertMessages(db, sessionId, messages)
      scanned += messages.length
      indexed = this.getIndexedCount(db, sessionId)
      const oldest = messages[0]
      cursor = { sortSeq: oldest.sortSeq, createTime: oldest.createTime, localId: oldest.localId }
      hasMore = Boolean(result.hasMore)

      await this.report({
        stage: 'indexing_messages',
        sessionId,
        message: `已向更早扩展 ${scanned} 条消息`,
        messagesScanned: scanned,
        indexedCount: indexed
      }, onProgress)
      await this.yieldToEventLoop()
    }

    // newest 传 null：加深只动旧端，新端水位保持不变
    const nextState = this.updateSessionState(db, sessionId, null, !hasMore)
    await this.report({
      stage: 'completed',
      sessionId,
      message: nextState.isComplete
        ? `搜索索引已覆盖全部 ${nextState.indexedCount} 条消息`
        : `搜索索引已扩展到 ${nextState.indexedCount} 条消息`,
      messagesScanned: scanned,
      indexedCount: nextState.indexedCount
    }, onProgress)
    return nextState
  }

  private async ensureSessionIndexedOnce(
    sessionId: string,
    onProgress?: ChatSearchSessionOptions['onProgress'],
    options: { maxMessages?: number; reusePartial?: boolean } = {}
  ): Promise<ChatSearchIndexState> {
    const db = this.getDb()
    const state = this.getSessionState(db, sessionId)
    const maxMessages = options.maxMessages && Number.isFinite(options.maxMessages)
      ? Math.max(1, Math.floor(options.maxMessages))
      : undefined

    if (
      options.reusePartial &&
      state &&
      !state.isComplete &&
      state.indexedCount > 0 &&
      (!maxMessages || state.indexedCount >= maxMessages)
    ) {
      await this.report({
        stage: 'completed',
        sessionId,
        message: `使用已有部分搜索索引，共 ${state.indexedCount} 条消息`,
        messagesScanned: 0,
        indexedCount: state.indexedCount
      }, onProgress)
      return state
    }

    let newest: Message | null = state?.isComplete && state.newestSortSeq > 0
      ? {
        localId: state.newestLocalId,
        serverId: 0,
        localType: 0,
        createTime: state.newestCreateTime,
        sortSeq: state.newestSortSeq,
        isSend: null,
        senderUsername: null,
        parsedContent: '',
        rawContent: ''
      }
      : null
    let scanned = 0

    await this.report({
      stage: 'preparing_index',
      sessionId,
      message: state?.isComplete ? '正在检查会话搜索索引增量' : '正在建立当前会话搜索索引',
      indexedCount: state?.indexedCount || 0
    }, onProgress)

    if (state?.isComplete && state.newestSortSeq > 0) {
      let cursor = {
        sortSeq: state.newestSortSeq,
        createTime: state.newestCreateTime,
        localId: state.newestLocalId
      }
      let hasMore = true

      while (hasMore) {
        const result = await chatService.getMessagesAfter(
          sessionId,
          cursor.sortSeq,
          INDEX_BATCH_SIZE,
          cursor.createTime,
          cursor.localId
        )
        if (!result.success) {
          const errorMessage = result.error || '更新搜索索引失败'
          if (this.canReuseCompleteSearchIndexAfterSourceError(state, errorMessage)) {
            console.warn('[ChatSearchIndex] 源消息表不可用，复用已有搜索索引继续:', { sessionId, error: errorMessage })
            await this.report({
              stage: 'completed',
              sessionId,
              message: `无法检查增量，已使用现有搜索索引继续，共 ${state.indexedCount} 条消息`,
              messagesScanned: scanned,
              indexedCount: state.indexedCount
            }, onProgress)
            return state
          }
          throw new Error(errorMessage)
        }

        const messages = result.messages || []
        if (messages.length === 0) break
        await this.upsertMessages(db, sessionId, messages)
        scanned += messages.length
        newest = messages[messages.length - 1] || newest
        cursor = {
          sortSeq: newest.sortSeq,
          createTime: newest.createTime,
          localId: newest.localId
        }

        await this.report({
          stage: 'indexing_messages',
          sessionId,
          message: `已更新 ${scanned} 条新消息到搜索索引`,
          messagesScanned: scanned,
          indexedCount: this.getIndexedCount(db, sessionId)
        }, onProgress)
        await this.yieldToEventLoop()

        hasMore = Boolean(result.hasMore)
      }

      const nextState = this.updateSessionState(db, sessionId, newest, true)
      await this.report({
        stage: 'completed',
        sessionId,
        message: `搜索索引已就绪，共 ${nextState.indexedCount} 条消息`,
        messagesScanned: scanned,
        indexedCount: nextState.indexedCount
      }, onProgress)
      return nextState
    }

    db.prepare('DELETE FROM message_index_fts WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM message_index WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM session_index_state WHERE session_id = ?').run(sessionId)

    const batchSize = maxMessages ? Math.min(INDEX_BATCH_SIZE, maxMessages) : INDEX_BATCH_SIZE
    const firstPage = await chatService.getMessages(sessionId, 0, batchSize)
    if (!firstPage.success) {
      throw new Error(firstPage.error || '建立搜索索引失败')
    }

    let messages = firstPage.messages || []
    let hasMore = Boolean(firstPage.hasMore)
    if (messages.length > 0) {
      await this.upsertMessages(db, sessionId, messages)
      scanned += messages.length
      newest = messages[messages.length - 1]
      await this.report({
        stage: 'indexing_messages',
        sessionId,
        message: `已索引 ${scanned} 条消息`,
        messagesScanned: scanned,
        indexedCount: this.getIndexedCount(db, sessionId)
      }, onProgress)
      await this.yieldToEventLoop()
    }

    while (hasMore && messages.length > 0 && (!maxMessages || scanned < maxMessages)) {
      const oldest = messages[0]
      const nextLimit = maxMessages ? Math.min(INDEX_BATCH_SIZE, maxMessages - scanned) : INDEX_BATCH_SIZE
      if (nextLimit <= 0) break
      const result = await chatService.getMessagesBefore(
        sessionId,
        oldest.sortSeq,
        nextLimit,
        oldest.createTime,
        oldest.localId
      )
      if (!result.success) {
        throw new Error(result.error || '继续建立搜索索引失败')
      }

      messages = result.messages || []
      if (messages.length === 0) break
      await this.upsertMessages(db, sessionId, messages)
      scanned += messages.length
      hasMore = Boolean(result.hasMore)

      await this.report({
        stage: 'indexing_messages',
        sessionId,
        message: `已索引 ${scanned} 条消息`,
        messagesScanned: scanned,
        indexedCount: this.getIndexedCount(db, sessionId)
      }, onProgress)
      await this.yieldToEventLoop()
    }

    const isComplete = !hasMore || (maxMessages ? scanned < maxMessages : false)
    const nextState = this.updateSessionState(db, sessionId, newest, isComplete)
    await this.report({
      stage: 'completed',
      sessionId,
      message: isComplete
        ? `搜索索引已就绪，共 ${nextState.indexedCount} 条消息`
        : `已建立部分搜索索引，共 ${nextState.indexedCount} 条消息`,
      messagesScanned: scanned,
      indexedCount: nextState.indexedCount
    }, onProgress)
    return nextState
  }

  async searchSession(options: ChatSearchSessionOptions): Promise<ChatSearchSessionResult> {
    const db = this.getDb()
    const state = await this.ensureSessionIndexed(options.sessionId, options.onProgress, {
      maxMessages: options.maxIndexMessages,
      reusePartial: options.reusePartialIndex
    })
    const query = normalizeSearchText(options.query)
    if (!query) {
      return {
        hits: [],
        indexedCount: state.indexedCount,
        indexComplete: state.isComplete,
        truncated: false
      }
    }

    await this.report({
      stage: 'searching_index',
      sessionId: options.sessionId,
      message: `正在搜索本地索引：${options.query}`,
      indexedCount: state.indexedCount
    }, options.onProgress)

    const startTime = toTimestampSeconds(options.startTimeMs)
    const endTime = toTimestampSeconds(options.endTimeMs)
    const senderUsername = normalizeSearchText(options.senderUsername)
    const direction = options.direction
    const candidateLimit = Math.min(MAX_INDEX_SEARCH_CANDIDATES, Math.max(options.limit * 8, options.limit + 20))
    const sqlFilters: string[] = ['m.session_id = @sessionId']
    const params: Record<string, unknown> = {
      sessionId: options.sessionId,
      limit: candidateLimit + 1
    }

    if (startTime) {
      sqlFilters.push('m.create_time >= @startTime')
      params.startTime = startTime
    }
    if (endTime) {
      sqlFilters.push('m.create_time <= @endTime')
      params.endTime = endTime
    }
    if (direction) {
      sqlFilters.push(direction === 'out' ? 'm.is_send = 1' : '(m.is_send IS NULL OR m.is_send != 1)')
    }
    if (senderUsername) {
      sqlFilters.push('lower(COALESCE(m.sender_username, \'\')) = @senderUsername')
      params.senderUsername = senderUsername
    }

    const rowsById = new Map<number, MessageIndexRow>()
    const ftsQuery = buildFtsQuery(query)
    if (ftsQuery) {
      const ftsRows = db.prepare(`
        SELECT m.*, bm25(message_index_fts) AS rank
        FROM message_index_fts
        JOIN message_index m ON m.id = message_index_fts.rowid
        WHERE message_index_fts MATCH @ftsQuery
          AND ${sqlFilters.join(' AND ')}
        ORDER BY rank ASC, m.sort_seq DESC, m.create_time DESC, m.local_id DESC
        LIMIT @limit
      `).all({
        ...params,
        ftsQuery
      }) as MessageIndexRow[]

      for (const row of ftsRows) {
        rowsById.set(row.id, row)
      }
    }

    const likeQuery = `%${query}%`
    const compactQuery = query.replace(/\s+/g, '')
    const likeRows = db.prepare(`
      SELECT m.*
      FROM message_index m
      WHERE ${sqlFilters.join(' AND ')}
        AND (
          m.search_text LIKE @likeQuery
          OR replace(m.search_text, ' ', '') LIKE @compactLikeQuery
        )
      ORDER BY m.sort_seq DESC, m.create_time DESC, m.local_id DESC
      LIMIT @limit
    `).all({
      ...params,
      likeQuery,
      compactLikeQuery: `%${compactQuery || query}%`
    }) as MessageIndexRow[]

    for (const row of likeRows) {
      rowsById.set(row.id, row)
    }

    const rows = Array.from(rowsById.values())
    const filteredRows = options.matchMode === 'exact'
      ? rows.filter((row) => hasExactMessageMatch(row, options.query))
      : rows
    const hits = filteredRows.map((row) => {
      const match = findMatchInIndexedText(row, options.query, options.matchMode)
      return {
        sessionId: options.sessionId,
        message: rowToMessage(row),
        excerpt: match.excerpt,
        matchedField: match.matchedField,
        score: match.score
      } satisfies ChatSearchIndexHit
    })
      .sort((a, b) => b.score - a.score || compareCursorAsc(b.message, a.message))

    return {
      hits: hits.slice(0, options.limit),
      indexedCount: state.indexedCount,
      indexComplete: state.isComplete,
      truncated: rows.length > options.limit || !state.isComplete
    }
  }

  /**
   * 方案 A：在 message_index 上全量均匀随机（仅已索引行）。
   * 条件：私聊、非己发、文本(1) / 图片(3) / 语音(34) / 表情(47)。
   */
  pickRandomIndexedMoment(): { sessionId: string; localId: number } | null {
    try {
      const db = this.getDb()
      const row = db
        .prepare(
          `
        SELECT session_id, local_id
        FROM message_index
        WHERE session_id NOT LIKE '%@chatroom%'
          AND (is_send IS NULL OR is_send != 1)
          AND local_type IN (1, 3, 34, 47)
        ORDER BY RANDOM()
        LIMIT 1
      `
        )
        .get() as { session_id?: string; local_id?: number } | undefined

      if (!row?.session_id || row.local_id == null || Number.isNaN(Number(row.local_id))) {
        return null
      }
      return { sessionId: row.session_id, localId: Number(row.local_id) }
    } catch (e) {
      console.error('[ChatSearchIndex] pickRandomIndexedMoment 失败:', e)
      return null
    }
  }

  /**
   * 列出已索引的表情包消息行（localType=47，按时间倒序），供 AI 助手表情包词典聚合。
   * 只读已建索引的会话，不触发建索引；为空时由调用方决定是否先索引最近会话。
   */
  listStickerMessageRows(limit: number): Array<{
    sessionId: string
    localId: number
    sortSeq: number
    createTime: number
    isSend: number | null
    rawContent: string
  }> {
    try {
      const rows = this.getDb().prepare(`
        SELECT session_id, local_id, sort_seq, create_time, is_send, raw_content
        FROM message_index
        WHERE local_type = 47
        ORDER BY create_time DESC
        LIMIT ?
      `).all(Math.max(1, Math.floor(limit))) as Array<{
        session_id: string
        local_id: number
        sort_seq: number
        create_time: number
        is_send: number | null
        raw_content: string
      }>
      return rows.map((row) => ({
        sessionId: row.session_id,
        localId: Number(row.local_id || 0),
        sortSeq: Number(row.sort_seq || 0),
        createTime: Number(row.create_time || 0),
        isSend: row.is_send ?? null,
        rawContent: String(row.raw_content || '')
      }))
    } catch (e) {
      console.error('[ChatSearchIndex] listStickerMessageRows 失败:', e)
      return []
    }
  }

  /** 取某条消息之前最近的一条文本消息内容（表情包"使用情境"）。 */
  getPrecedingText(sessionId: string, sortSeq: number): string {
    try {
      const row = this.getDb().prepare(`
        SELECT parsed_content
        FROM message_index
        WHERE session_id = ? AND sort_seq < ? AND local_type = 1 AND trim(parsed_content) != ''
        ORDER BY sort_seq DESC
        LIMIT 1
      `).get(sessionId, sortSeq) as { parsed_content?: string } | undefined
      return String(row?.parsed_content || '')
    } catch {
      return ''
    }
  }

  /** 在已索引行里随机抽一条图片消息（localType=3），可限定会话。 */
  pickRandomImageMessage(sessionId?: string): { sessionId: string; localId: number; createTime: number; isSend: number | null; senderUsername: string | null } | null {
    try {
      const db = this.getDb()
      const where = sessionId ? 'local_type = 3 AND session_id = ?' : 'local_type = 3'
      const row = db.prepare(`
        SELECT session_id, local_id, create_time, is_send, sender_username
        FROM message_index
        WHERE ${where}
        ORDER BY RANDOM()
        LIMIT 1
      `).get(...(sessionId ? [sessionId] : [])) as {
        session_id?: string
        local_id?: number
        create_time?: number
        is_send?: number | null
        sender_username?: string | null
      } | undefined
      if (!row?.session_id || row.local_id == null) return null
      return {
        sessionId: row.session_id,
        localId: Number(row.local_id),
        createTime: Number(row.create_time || 0),
        isSend: row.is_send ?? null,
        senderUsername: row.sender_username ?? null
      }
    } catch (e) {
      console.error('[ChatSearchIndex] pickRandomImageMessage 失败:', e)
      return null
    }
  }

  getPrecedingTextMap(sessionId: string, sortSeqs: number[]): Map<number, string> {
    const out = new Map<number, string>()
    const unique = Array.from(new Set(sortSeqs.filter((value) => Number.isFinite(Number(value))).map(Number)))
    if (unique.length === 0) return out
    try {
      const db = this.getDb()
      const stmt = db.prepare(`
        SELECT parsed_content
        FROM message_index
        WHERE session_id = ? AND sort_seq < ? AND local_type = 1 AND trim(parsed_content) != ''
        ORDER BY sort_seq DESC
        LIMIT 1
      `)
      for (const sortSeq of unique) {
        const row = stmt.get(sessionId, sortSeq) as { parsed_content?: string } | undefined
        out.set(sortSeq, String(row?.parsed_content || ''))
      }
    } catch {
      // ignore; callers treat missing context as empty
    }
    return out
  }

  /**
   * 列出已索引的图片/表情消息行。只读 message_index，不触发建索引；
   * 为空时由调用方决定是否先索引最近会话或目标会话。
   */
  listMediaMessageRows(options: {
    sessionId?: string
    kinds?: ChatSearchMediaKind[]
    startTimeMs?: number
    endTimeMs?: number
    direction?: 'in' | 'out'
    limit?: number
    offset?: number
  } = {}): ChatSearchMediaMessageRow[] {
    try {
      const localTypes = Array.from(new Set(
        (options.kinds?.length ? options.kinds : ['image', 'emoji'])
          .map((kind) => kind === 'emoji' ? 47 : 3)
      ))
      const filters = [`local_type IN (${localTypes.map((_, index) => `@type${index}`).join(', ')})`]
      const params: Record<string, unknown> = {
        limit: Math.max(1, Math.min(200, Math.floor(Number(options.limit) || 30))),
        offset: Math.max(0, Math.floor(Number(options.offset) || 0)),
      }
      localTypes.forEach((type, index) => {
        params[`type${index}`] = type
      })

      if (options.sessionId) {
        filters.push('session_id = @sessionId')
        params.sessionId = options.sessionId
      }
      const startTime = toTimestampSeconds(options.startTimeMs)
      const endTime = toTimestampSeconds(options.endTimeMs)
      if (startTime) {
        filters.push('create_time >= @startTime')
        params.startTime = startTime
      }
      if (endTime) {
        filters.push('create_time <= @endTime')
        params.endTime = endTime
      }
      if (options.direction) {
        filters.push(options.direction === 'out' ? 'is_send = 1' : '(is_send IS NULL OR is_send != 1)')
      }

      const rows = this.getDb().prepare(`
        SELECT session_id, local_id, sort_seq, create_time, is_send, sender_username, local_type, parsed_content, raw_content
        FROM message_index
        WHERE ${filters.join(' AND ')}
        ORDER BY sort_seq DESC, create_time DESC, local_id DESC
        LIMIT @limit OFFSET @offset
      `).all(params) as Array<{
        session_id: string
        local_id: number
        sort_seq: number
        create_time: number
        is_send: number | null
        sender_username: string | null
        local_type: number
        parsed_content: string
        raw_content: string
      }>

      return rows.map((row) => ({
        sessionId: row.session_id,
        localId: Number(row.local_id || 0),
        sortSeq: Number(row.sort_seq || 0),
        createTime: Number(row.create_time || 0),
        isSend: row.is_send ?? null,
        senderUsername: row.sender_username ?? null,
        localType: Number(row.local_type || 0),
        parsedContent: String(row.parsed_content || ''),
        rawContent: String(row.raw_content || '')
      }))
    } catch (e) {
      console.error('[ChatSearchIndex] listMediaMessageRows 失败:', e)
      return []
    }
  }

  async listSessionMemoryMessages(
    sessionId: string,
    onProgress?: ChatSearchSessionOptions['onProgress'],
    maxIndexMessages?: number
  ): Promise<ChatSearchMemoryMessage[]> {
    await this.ensureSessionIndexed(sessionId, onProgress, {
      maxMessages: maxIndexMessages,
      reusePartial: !!maxIndexMessages
    })
    const rows = this.getDb().prepare(`
      SELECT
        id,
        session_id,
        local_id,
        server_id,
        local_type,
        create_time,
        sort_seq,
        is_send,
        sender_username,
        parsed_content,
        raw_content,
        search_text
      FROM message_index
      WHERE session_id = ?
        AND trim(search_text) != ''
      ORDER BY sort_seq ASC, create_time ASC, local_id ASC
    `).all(sessionId) as Array<Pick<MessageIndexRow,
      | 'id'
      | 'session_id'
      | 'local_id'
      | 'server_id'
      | 'local_type'
      | 'create_time'
      | 'sort_seq'
      | 'is_send'
      | 'sender_username'
      | 'parsed_content'
      | 'raw_content'
      | 'search_text'
    >>

    return rows.map((row) => ({
      id: Number(row.id || 0),
      sessionId: row.session_id,
      localId: Number(row.local_id || 0),
      serverId: Number(row.server_id || 0),
      localType: Number(row.local_type || 0),
      createTime: Number(row.create_time || 0),
      sortSeq: Number(row.sort_seq || 0),
      isSend: row.is_send ?? null,
      senderUsername: row.sender_username ?? null,
      parsedContent: String(row.parsed_content || ''),
      rawContent: String(row.raw_content || ''),
      searchText: String(row.search_text || '')
    }))
  }
}

export const chatSearchIndexService = new ChatSearchIndexService()
