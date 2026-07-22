import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { UIMessage } from 'ai'
import { ConfigService } from '../config'
import type { AgentScope } from './types'

const DB_NAME = 'agent_conversations.db'

export interface AgentConversationRecord {
  id: number
  accountId: string
  scope: AgentScope
  title: string
  modelProvider: string
  modelId: string
  /** 对话来源：'app'（应用内）| 'wechat'（微信接入）等 */
  source: string
  /** 外部来源的稳定标识（如微信 from_user_id），用于按来源会话归档 */
  externalId: string | null
  createdAt: number
  updatedAt: number
}

export interface AgentConversationMessage {
  id: number
  conversationId: number
  role: string
  message: UIMessage
  createdAt: number
}

export interface AgentConversationLoaded extends AgentConversationRecord {
  messages: UIMessage[]
}

export type AgentConversationChangeType =
  | 'created'
  | 'messages-appended'
  | 'messages-replaced'
  | 'renamed'
  | 'metadata-updated'
  | 'deleted'

export interface AgentConversationUpdatedEvent extends AgentConversationRecord {
  changeType: AgentConversationChangeType
  originClientId?: string | null
}

type AgentConversationChangeBroadcaster = (event: AgentConversationUpdatedEvent) => void

let agentConversationChangeBroadcaster: AgentConversationChangeBroadcaster | null = null

export function setAgentConversationChangeBroadcaster(broadcaster: AgentConversationChangeBroadcaster | null): void {
  agentConversationChangeBroadcaster = broadcaster
}

interface ConversationChangeOptions {
  originClientId?: string | null
  emit?: boolean
}

interface CreateConversationInput {
  scope?: AgentScope
  title?: string
  modelProvider?: string
  modelId?: string
  source?: string
  externalId?: string | null
  originClientId?: string | null
}

interface ListConversationOptions {
  scope?: AgentScope
  limit?: number
}

interface AccountIdentity {
  primary: string
  aliases: string[]
}

function toScope(kind: string, sessionId?: string | null, displayName?: string | null): AgentScope {
  if ((kind === 'session' || kind === 'persona') && sessionId) {
    return { kind, sessionId, displayName: displayName || undefined }
  }
  return { kind: 'global' }
}

function scopeColumns(scope?: AgentScope): { kind: string; sessionId: string | null; displayName: string | null } {
  if (scope?.kind === 'session' || scope?.kind === 'persona') {
    return {
      kind: scope.kind,
      sessionId: scope.sessionId,
      displayName: scope.displayName || null,
    }
  }
  return { kind: 'global', sessionId: null, displayName: null }
}

function safeJsonParseMessage(value: string): UIMessage | null {
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object') return parsed as UIMessage
  } catch {
    // ignore malformed historical rows
  }
  return null
}

export class AgentConversationStore {
  private db: Database.Database | null = null
  private dbPath: string | null = null

  private getCacheBasePath(): string {
    const config = new ConfigService()
    try {
      return config.getCacheBasePath()
    } finally {
      config.close()
    }
  }

  private getAccountIdentity(): AccountIdentity {
    const config = new ConfigService()
    try {
      const active = config.getActiveAccount()
      const wxid = String(config.get('myWxid') || '').trim()
      const primary = active?.id || wxid || 'default'
      const aliases = Array.from(new Set([
        primary,
        active?.wxid,
        wxid,
        'default',
      ].map((item) => String(item || '').trim()).filter(Boolean)))
      return { primary, aliases }
    } finally {
      config.close()
    }
  }

  private getAccountId(): string {
    return this.getAccountIdentity().primary
  }

  private getDb(): Database.Database {
    const basePath = this.getCacheBasePath()
    if (!existsSync(basePath)) mkdirSync(basePath, { recursive: true })

    const nextDbPath = join(basePath, DB_NAME)
    if (this.db && this.dbPath === nextDbPath) return this.db

    if (this.db) {
      try { this.db.close() } catch { /* ignore */ }
    }

    const db = new Database(nextDbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    this.db = db
    this.dbPath = nextDbPath
    this.ensureSchema(db)
    return db
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
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        session_id TEXT,
        display_name TEXT,
        title TEXT NOT NULL,
        model_provider TEXT NOT NULL DEFAULT '',
        model_id TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        ui_message_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES agent_conversations(id) ON DELETE CASCADE
      );

      DROP TABLE IF EXISTS agent_raw_responses;

      CREATE INDEX IF NOT EXISTS idx_agent_conv_account_scope
        ON agent_conversations(account_id, scope_kind, session_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_msg_conv
        ON agent_messages(conversation_id, created_at ASC, id ASC);
    `)

    // 增量迁移：旧库补上来源标志列
    const cols = db.prepare('PRAGMA table_info(agent_conversations)').all() as Array<{ name: string }>
    const names = new Set(cols.map((c) => c.name))
    if (!names.has('source')) {
      db.exec("ALTER TABLE agent_conversations ADD COLUMN source TEXT NOT NULL DEFAULT 'app'")
    }
    if (!names.has('external_id')) {
      db.exec('ALTER TABLE agent_conversations ADD COLUMN external_id TEXT')
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_agent_conv_source ON agent_conversations(account_id, source, external_id)')

    // 一次性迁移：旧的微信分身会话存成 global，按 external_id（from:sessionId）里的 sessionId 归入对应好友的 persona 历史
    db.exec(`
      UPDATE agent_conversations
      SET scope_kind = 'persona',
          session_id = substr(external_id, instr(external_id, ':') + 1)
      WHERE source = 'wechat-persona'
        AND scope_kind = 'global'
        AND external_id LIKE '%:%'
        AND session_id IS NULL
    `)
  }

  private claimCompatibleAccountRows(db: Database.Database, identity: AccountIdentity): void {
    const aliasIds = identity.aliases.filter((id) => id && id !== identity.primary)
    if (aliasIds.length > 0) {
      const params: Record<string, string> = { primary: identity.primary }
      const placeholders = aliasIds.map((id, index) => {
        const key = `alias${index}`
        params[key] = id
        return `@${key}`
      })
      db.prepare(`
        UPDATE agent_conversations
        SET account_id = @primary
        WHERE account_id IN (${placeholders.join(', ')})
      `).run(params)
    }

    const current = db.prepare('SELECT COUNT(*) AS count FROM agent_conversations WHERE account_id = ?')
      .get(identity.primary) as { count?: number } | undefined
    if (Number(current?.count || 0) > 0) return

    const accounts = db.prepare(`
      SELECT account_id AS accountId, COUNT(*) AS count
      FROM agent_conversations
      GROUP BY account_id
    `).all() as Array<{ accountId: string; count: number }>
    if (accounts.length !== 1) return

    const legacyAccountId = String(accounts[0]?.accountId || '').trim()
    if (!legacyAccountId || legacyAccountId === identity.primary) return

    db.prepare('UPDATE agent_conversations SET account_id = ? WHERE account_id = ?')
      .run(identity.primary, legacyAccountId)
  }

  private mapConversation(row: any): AgentConversationRecord {
    return {
      id: Number(row.id),
      accountId: String(row.account_id || ''),
      scope: toScope(String(row.scope_kind || 'global'), row.session_id, row.display_name),
      title: String(row.title || '新对话'),
      modelProvider: String(row.model_provider || ''),
      modelId: String(row.model_id || ''),
      source: String(row.source || 'app'),
      externalId: row.external_id ? String(row.external_id) : null,
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
    }
  }

  private emitChange(
    changeType: AgentConversationChangeType,
    record: AgentConversationRecord | null | undefined,
    options: ConversationChangeOptions = {},
  ): void {
    if (!record || options.emit === false || !agentConversationChangeBroadcaster) return
    try {
      agentConversationChangeBroadcaster({
        ...record,
        changeType,
        originClientId: options.originClientId ?? null,
      })
    } catch {
      // 广播失败不影响本地写入
    }
  }

  list(options: ListConversationOptions = {}): AgentConversationRecord[] {
    const db = this.getDb()
    const identity = this.getAccountIdentity()
    this.claimCompatibleAccountRows(db, identity)
    const accountId = identity.primary
    const limit = Math.max(1, Math.min(100, Number(options.limit || 50)))
    const filters = ['account_id = @accountId']
    const params: Record<string, unknown> = { accountId, limit }

    if (options.scope?.kind === 'session' || options.scope?.kind === 'persona') {
      filters.push('scope_kind = @scopeKind', 'session_id = @sessionId')
      params.scopeKind = options.scope.kind
      params.sessionId = options.scope.sessionId
    } else if (options.scope?.kind === 'global') {
      filters.push('scope_kind = @scopeKind')
      params.scopeKind = 'global'
    } else {
      // 不带 scope = Agent 页历史列表：分身对话只属于分身窗口（persona:chat 引擎），
      // 混进 Agent 页会被当普通 Agent 会话续聊，提示词/工具全走错
      filters.push("scope_kind != 'persona'")
    }

    const rows = db.prepare(`
      SELECT * FROM agent_conversations
      WHERE ${filters.join(' AND ')}
      ORDER BY updated_at DESC, id DESC
      LIMIT @limit
    `).all(params)

    return rows.map((row) => this.mapConversation(row))
  }

  create(input: CreateConversationInput = {}): AgentConversationRecord {
    const db = this.getDb()
    const accountId = this.getAccountId()
    const scope = scopeColumns(input.scope)
    const now = Date.now()
    const result = db.prepare(`
      INSERT INTO agent_conversations (
        account_id, scope_kind, session_id, display_name, title,
        model_provider, model_id, source, external_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      accountId,
      scope.kind,
      scope.sessionId,
      scope.displayName,
      String(input.title || '新对话').slice(0, 80),
      String(input.modelProvider || ''),
      String(input.modelId || ''),
      String(input.source || 'app'),
      input.externalId || null,
      now,
      now,
    )

    const record = this.loadMeta(Number(result.lastInsertRowid))
    this.emitChange('created', record, { originClientId: input.originClientId })
    return record
  }

  /** 按来源+外部标识找会话，没有就新建（用于微信等外部接入按联系人归档）。
   *  传入 scope 时会把会话归入对应作用域（如微信分身→persona），并回填旧的 global 行。 */
  getOrCreateExternal(input: { source: string; externalId: string; title?: string; scope?: AgentScope; originClientId?: string | null }): AgentConversationRecord {
    const db = this.getDb()
    const accountId = this.getAccountId()
    const row = db.prepare(`
      SELECT * FROM agent_conversations
      WHERE account_id = ? AND source = ? AND external_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(accountId, input.source, input.externalId)
    if (row) {
      const record = this.mapConversation(row)
      // 回填 scope：把历史上存成 global 的外部会话归入对应好友的 persona/session 历史
      if (input.scope && (input.scope.kind === 'persona' || input.scope.kind === 'session') && (record.scope.kind !== input.scope.kind || record.scope.sessionId !== input.scope.sessionId)) {
        const cols = scopeColumns(input.scope)
        db.prepare('UPDATE agent_conversations SET scope_kind = ?, session_id = ?, display_name = ?, updated_at = ? WHERE id = ?')
          .run(cols.kind, cols.sessionId, cols.displayName, Date.now(), record.id)
        const updated = this.loadMeta(record.id)
        this.emitChange('metadata-updated', updated, { originClientId: input.originClientId })
        return updated
      }
      return record
    }
    return this.create({ source: input.source, externalId: input.externalId, title: input.title, scope: input.scope, originClientId: input.originClientId })
  }

  /** 显式开启一个新的外部来源会话；旧会话保留，后续 getOrCreateExternal 会取最新这条。 */
  createExternal(input: { source: string; externalId: string; title?: string; scope?: AgentScope; originClientId?: string | null }): AgentConversationRecord {
    return this.create({ source: input.source, externalId: input.externalId, title: input.title, scope: input.scope, originClientId: input.originClientId })
  }

  load(id: number): AgentConversationLoaded | null {
    const meta = this.loadMeta(id, false)
    if (!meta) return null
    const rows = this.getDb().prepare(`
      SELECT * FROM agent_messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(id) as any[]
    const messages = rows
      .map((row) => safeJsonParseMessage(String(row.ui_message_json || '')))
      .filter((message): message is UIMessage => !!message)
    return { ...meta, messages }
  }

  loadMeta(id: number): AgentConversationRecord
  loadMeta(id: number, required: false): AgentConversationRecord | null
  loadMeta(id: number, required = true): AgentConversationRecord | null {
    const row = this.getDb().prepare('SELECT * FROM agent_conversations WHERE id = ?').get(id)
    if (!row) {
      if (required) throw new Error(`AI 对话不存在: ${id}`)
      return null
    }
    return this.mapConversation(row)
  }

  /** Canvas 表由 agentCanvasStore 建；老库可能还没有，删除时按存在与否级联清理。 */
  private deleteCanvasesOf(db: Database.Database, conversationId: number): void {
    try {
      db.prepare(`
        DELETE FROM agent_canvas_revisions
        WHERE canvas_id IN (SELECT id FROM agent_canvases WHERE conversation_id = ?)
      `).run(conversationId)
      db.prepare('DELETE FROM agent_canvases WHERE conversation_id = ?').run(conversationId)
    } catch {
      // 表尚未创建（从未用过 Canvas）时忽略
    }
  }

  remove(id: number, options: ConversationChangeOptions = {}): { success: boolean } {
    const record = this.loadMeta(id, false)
    const db = this.getDb()
    const tx = db.transaction((conversationId: number) => {
      this.deleteCanvasesOf(db, conversationId)
      db.prepare('DELETE FROM agent_messages WHERE conversation_id = ?').run(conversationId)
      db.prepare('DELETE FROM agent_conversations WHERE id = ?').run(conversationId)
    })
    tx(id)
    this.emitChange('deleted', record ? { ...record, updatedAt: Date.now() } : null, options)
    return { success: true }
  }

  removeByScope(scope: AgentScope, options: ConversationChangeOptions = {}): { success: boolean; deleted: number } {
    const db = this.getDb()
    const accountId = this.getAccountId()
    const filters = ['account_id = @accountId', 'scope_kind = @scopeKind']
    const params: Record<string, unknown> = {
      accountId,
      scopeKind: scope.kind,
    }

    if (scope.kind === 'session' || scope.kind === 'persona') {
      filters.push('session_id = @sessionId')
      params.sessionId = scope.sessionId
    } else {
      filters.push('session_id IS NULL')
    }

    const rows = db.prepare(`
      SELECT * FROM agent_conversations
      WHERE ${filters.join(' AND ')}
    `).all(params) as any[]
    const records = rows.map((row) => this.mapConversation(row))
    const ids = records.map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0)
    if (ids.length === 0) return { success: true, deleted: 0 }

    const tx = db.transaction((conversationIds: number[]) => {
      const deleteMessages = db.prepare('DELETE FROM agent_messages WHERE conversation_id = ?')
      const deleteConversation = db.prepare('DELETE FROM agent_conversations WHERE id = ?')
      for (const conversationId of conversationIds) {
        this.deleteCanvasesOf(db, conversationId)
        deleteMessages.run(conversationId)
        deleteConversation.run(conversationId)
      }
    })
    tx(ids)
    const deletedAt = Date.now()
    for (const record of records) this.emitChange('deleted', { ...record, updatedAt: deletedAt }, options)
    return { success: true, deleted: ids.length }
  }

  rename(id: number, title: string, options: ConversationChangeOptions = {}): AgentConversationRecord {
    const nextTitle = String(title || '新对话').trim().slice(0, 80) || '新对话'
    this.getDb().prepare(`
      UPDATE agent_conversations
      SET title = ?, updated_at = ?
      WHERE id = ?
    `).run(nextTitle, Date.now(), id)
    const record = this.loadMeta(id)
    this.emitChange('renamed', record, options)
    return record
  }

  updateMeta(id: number, patch: { scope?: AgentScope; modelProvider?: string; modelId?: string }, options: ConversationChangeOptions = {}): AgentConversationRecord {
    const scope = patch.scope ? scopeColumns(patch.scope) : null
    const db = this.getDb()
    const current = this.loadMeta(id)
    db.prepare(`
      UPDATE agent_conversations
      SET scope_kind = ?, session_id = ?, display_name = ?,
          model_provider = ?, model_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      scope?.kind || current.scope.kind,
      scope ? scope.sessionId : ((current.scope.kind === 'session' || current.scope.kind === 'persona') ? current.scope.sessionId : null),
      scope ? scope.displayName : ((current.scope.kind === 'session' || current.scope.kind === 'persona') ? current.scope.displayName || null : null),
      patch.modelProvider ?? current.modelProvider,
      patch.modelId ?? current.modelId,
      Date.now(),
      id,
    )
    const record = this.loadMeta(id)
    this.emitChange('metadata-updated', record, options)
    return record
  }

  append(id: number, messages: UIMessage[], options: ConversationChangeOptions = {}): AgentConversationRecord {
    const db = this.getDb()
    const insert = db.prepare(`
      INSERT INTO agent_messages (conversation_id, role, ui_message_json, created_at)
      VALUES (?, ?, ?, ?)
    `)
    const tx = db.transaction((items: UIMessage[]) => {
      for (const message of items) {
        insert.run(id, String(message.role || 'unknown'), JSON.stringify(message), Date.now())
      }
      db.prepare('UPDATE agent_conversations SET updated_at = ? WHERE id = ?').run(Date.now(), id)
    })
    tx(messages)
    const record = this.loadMeta(id)
    if (messages.length > 0) this.emitChange('messages-appended', record, options)
    return record
  }

  replaceMessages(id: number, messages: UIMessage[], options: ConversationChangeOptions = {}): AgentConversationRecord {
    const db = this.getDb()
    const insert = db.prepare(`
      INSERT INTO agent_messages (conversation_id, role, ui_message_json, created_at)
      VALUES (?, ?, ?, ?)
    `)
    const tx = db.transaction((items: UIMessage[]) => {
      db.prepare('DELETE FROM agent_messages WHERE conversation_id = ?').run(id)
      const baseTime = Date.now()
      items.forEach((message, index) => {
        insert.run(id, String(message.role || 'unknown'), JSON.stringify(message), baseTime + index)
      })
      db.prepare('UPDATE agent_conversations SET updated_at = ? WHERE id = ?').run(Date.now(), id)
    })
    tx(messages)
    const record = this.loadMeta(id)
    this.emitChange('messages-replaced', record, options)
    return record
  }

  getLast(scope?: AgentScope): AgentConversationRecord | null {
    return this.list({ scope, limit: 1 })[0] || null
  }
}

export const agentConversationStore = new AgentConversationStore()
