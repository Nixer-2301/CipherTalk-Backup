/**
 * Agent Canvas 存储 —— 主进程单写者（见 Docs/Agent-Canvas画布对接开发文档.md §6）。
 * 与 Agent 会话共用 agent_conversations.db，事务与备份边界一致。
 * 所有写操作走 SQLite transaction + baseRevision 乐观锁；冲突抛 AgentCanvasConflictError，
 * 不允许 last-write-wins。会话删除时的级联清理见 conversationStore.remove/removeByScope。
 */
import Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { ConfigService } from '../config'
import {
  AgentCanvasConflictError,
  CANVAS_KEEP_REVISIONS,
  CANVAS_MAX_CONTENT_CHARS,
  CANVAS_MAX_TITLE_CHARS,
  type AgentCanvasAction,
  type AgentCanvasRecord,
  type AgentCanvasRevision,
  type AgentCanvasRevisionMeta,
  type AgentCanvasSource,
  type AgentCanvasUpdatedEvent,
  type ArchiveCanvasInput,
  type CreateCanvasInput,
  type RenameCanvasInput,
  type RestoreCanvasInput,
  type UpdateCanvasInput,
} from './canvasTypes'

const DB_NAME = 'agent_conversations.db'

type AgentCanvasChangeBroadcaster = (event: AgentCanvasUpdatedEvent) => void

let agentCanvasChangeBroadcaster: AgentCanvasChangeBroadcaster | null = null

export function setAgentCanvasChangeBroadcaster(broadcaster: AgentCanvasChangeBroadcaster | null): void {
  agentCanvasChangeBroadcaster = broadcaster
}

function normalizeTitle(value: unknown): string {
  return String(value ?? '').trim().slice(0, CANVAS_MAX_TITLE_CHARS)
}

function normalizeContent(value: unknown): string {
  const content = String(value ?? '')
  if (content.length > CANVAS_MAX_CONTENT_CHARS) {
    throw new Error(`Canvas 正文超过上限（${CANVAS_MAX_CONTENT_CHARS} 字符）`)
  }
  return content
}

export class AgentCanvasStore {
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
    db.pragma('foreign_keys = ON')
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
      CREATE TABLE IF NOT EXISTS agent_canvases (
        id TEXT PRIMARY KEY,
        conversation_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        language TEXT,
        content TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(conversation_id)
          REFERENCES agent_conversations(id)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_canvas_revisions (
        canvas_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(canvas_id, revision),
        FOREIGN KEY(canvas_id)
          REFERENCES agent_canvases(id)
          ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_agent_canvas_conversation
        ON agent_canvases(conversation_id, updated_at DESC);
    `)
  }

  private mapRecord(row: any): AgentCanvasRecord {
    return {
      id: String(row.id),
      conversationId: Number(row.conversation_id),
      kind: row.kind === 'code' ? 'code' : 'document',
      title: String(row.title || ''),
      language: row.language ? String(row.language) : undefined,
      content: String(row.content ?? ''),
      revision: Number(row.revision || 1),
      status: row.status === 'archived' ? 'archived' : 'active',
      createdBy: row.created_by === 'agent' ? 'agent' : 'user',
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
    }
  }

  private emitChange(action: AgentCanvasAction, record: AgentCanvasRecord, originClientId?: string | null): void {
    if (!agentCanvasChangeBroadcaster) return
    try {
      agentCanvasChangeBroadcaster({
        canvasId: record.id,
        conversationId: record.conversationId,
        revision: record.revision,
        action,
        originClientId: originClientId ?? null,
        updatedAt: record.updatedAt,
      })
    } catch {
      // 广播失败不影响本地写入
    }
  }

  private loadRow(db: Database.Database, canvasId: string): any {
    return db.prepare('SELECT * FROM agent_canvases WHERE id = ?').get(canvasId)
  }

  private requireRow(db: Database.Database, canvasId: string): any {
    const row = this.loadRow(db, canvasId)
    if (!row) throw new Error(`Canvas 不存在: ${canvasId}`)
    return row
  }

  private assertBaseRevision(row: any, baseRevision: number): void {
    const actual = Number(row.revision || 1)
    if (actual !== baseRevision) {
      throw new AgentCanvasConflictError({
        code: 'REVISION_CONFLICT',
        canvasId: String(row.id),
        expectedRevision: baseRevision,
        actualRevision: actual,
        current: this.mapRecord(row),
      })
    }
  }

  private assertActive(row: any): void {
    if (row.status === 'archived') throw new Error('Canvas 已归档，不能继续修改')
  }

  /** revision 快照写入 + 主记录推进 + 旧快照清理（须在事务内调用）。 */
  private writeRevision(
    db: Database.Database,
    canvasId: string,
    revision: number,
    content: string,
    source: AgentCanvasSource,
    now: number,
  ): void {
    db.prepare(`
      INSERT INTO agent_canvas_revisions (canvas_id, revision, content, source, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(canvasId, revision, content, source, now)
    db.prepare(`
      DELETE FROM agent_canvas_revisions
      WHERE canvas_id = ? AND revision <= ?
    `).run(canvasId, revision - CANVAS_KEEP_REVISIONS)
  }

  create(input: CreateCanvasInput): AgentCanvasRecord {
    const db = this.getDb()
    const conversationId = Number(input.conversationId)
    const exists = db.prepare('SELECT 1 FROM agent_conversations WHERE id = ?').get(conversationId)
    if (!exists) throw new Error(`Canvas 所属会话不存在: ${conversationId}`)

    const title = normalizeTitle(input.title) || '未命名画布'
    const content = normalizeContent(input.content)
    const id = `canvas-${Date.now()}-${randomBytes(4).toString('hex')}`
    const now = Date.now()
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO agent_canvases (
          id, conversation_id, kind, title, language, content,
          revision, status, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?)
      `).run(
        id,
        conversationId,
        input.kind === 'code' ? 'code' : 'document',
        title,
        input.language ? String(input.language).slice(0, 40) : null,
        content,
        input.createdBy === 'agent' ? 'agent' : 'user',
        now,
        now,
      )
      this.writeRevision(db, id, 1, content, input.createdBy === 'agent' ? 'agent' : 'user', now)
    })
    tx()
    const record = this.mapRecord(this.requireRow(db, id))
    this.emitChange('created', record, input.originClientId)
    return record
  }

  get(canvasId: string): AgentCanvasRecord | null {
    const row = this.loadRow(this.getDb(), String(canvasId))
    return row ? this.mapRecord(row) : null
  }

  /** 列表不返回正文（正文只走 get），避免长文档在列表接口反复搬运。 */
  list(conversationId: number): Array<Omit<AgentCanvasRecord, 'content'> & { contentLength: number }> {
    const rows = this.getDb().prepare(`
      SELECT id, conversation_id, kind, title, language, length(content) AS content_length,
             revision, status, created_by, created_at, updated_at
      FROM agent_canvases
      WHERE conversation_id = ?
      ORDER BY updated_at DESC
    `).all(Number(conversationId)) as any[]
    return rows.map((row) => {
      const { content: _content, ...rest } = this.mapRecord({ ...row, content: '' })
      return { ...rest, contentLength: Number(row.content_length || 0) }
    })
  }

  update(input: UpdateCanvasInput): AgentCanvasRecord {
    const db = this.getDb()
    const content = normalizeContent(input.content)
    const now = Date.now()
    const tx = db.transaction(() => {
      const row = this.requireRow(db, input.canvasId)
      this.assertActive(row)
      this.assertBaseRevision(row, input.baseRevision)
      const nextRevision = Number(row.revision) + 1
      this.writeRevision(db, String(row.id), nextRevision, content, input.source, now)
      db.prepare('UPDATE agent_canvases SET content = ?, revision = ?, updated_at = ? WHERE id = ?')
        .run(content, nextRevision, now, row.id)
    })
    tx()
    const record = this.mapRecord(this.requireRow(db, input.canvasId))
    this.emitChange('updated', record, input.originClientId)
    return record
  }

  rename(input: RenameCanvasInput): AgentCanvasRecord {
    const db = this.getDb()
    const title = normalizeTitle(input.title)
    if (!title) throw new Error('Canvas 标题不能为空')
    const now = Date.now()
    const tx = db.transaction(() => {
      const row = this.requireRow(db, input.canvasId)
      this.assertActive(row)
      this.assertBaseRevision(row, input.baseRevision)
      const nextRevision = Number(row.revision) + 1
      this.writeRevision(db, String(row.id), nextRevision, String(row.content ?? ''), input.source, now)
      db.prepare('UPDATE agent_canvases SET title = ?, revision = ?, updated_at = ? WHERE id = ?')
        .run(title, nextRevision, now, row.id)
    })
    tx()
    const record = this.mapRecord(this.requireRow(db, input.canvasId))
    this.emitChange('renamed', record, input.originClientId)
    return record
  }

  /** 归档只改状态不物理删除；校验 revision，但不推进 revision。 */
  archive(input: ArchiveCanvasInput): AgentCanvasRecord {
    const db = this.getDb()
    const now = Date.now()
    const tx = db.transaction(() => {
      const row = this.requireRow(db, input.canvasId)
      this.assertActive(row)
      this.assertBaseRevision(row, input.baseRevision)
      db.prepare("UPDATE agent_canvases SET status = 'archived', updated_at = ? WHERE id = ?")
        .run(now, input.canvasId)
    })
    tx()
    const record = this.mapRecord(this.requireRow(db, input.canvasId))
    this.emitChange('archived', record, input.originClientId)
    return record
  }

  listRevisions(canvasId: string): AgentCanvasRevisionMeta[] {
    const rows = this.getDb().prepare(`
      SELECT canvas_id, revision, source, length(content) AS content_length, created_at
      FROM agent_canvas_revisions
      WHERE canvas_id = ?
      ORDER BY revision DESC
    `).all(String(canvasId)) as any[]
    return rows.map((row) => ({
      canvasId: String(row.canvas_id),
      revision: Number(row.revision),
      source: (row.source === 'agent' || row.source === 'restore' ? row.source : 'user') as AgentCanvasSource,
      contentLength: Number(row.content_length || 0),
      createdAt: Number(row.created_at || 0),
    }))
  }

  getRevision(canvasId: string, revision: number): AgentCanvasRevision | null {
    const row = this.getDb().prepare(`
      SELECT canvas_id, revision, content, source, created_at
      FROM agent_canvas_revisions
      WHERE canvas_id = ? AND revision = ?
    `).get(String(canvasId), Number(revision)) as any
    if (!row) return null
    return {
      canvasId: String(row.canvas_id),
      revision: Number(row.revision),
      content: String(row.content ?? ''),
      source: (row.source === 'agent' || row.source === 'restore' ? row.source : 'user') as AgentCanvasSource,
      contentLength: String(row.content ?? '').length,
      createdAt: Number(row.created_at || 0),
    }
  }

  /** 恢复历史版本 = 用该版本内容生成一个新 revision（不回退计数）。 */
  restore(input: RestoreCanvasInput): AgentCanvasRecord {
    const db = this.getDb()
    const snapshot = this.getRevision(input.canvasId, input.revision)
    if (!snapshot) throw new Error(`Canvas 历史版本不存在: v${input.revision}`)
    const now = Date.now()
    const tx = db.transaction(() => {
      const row = this.requireRow(db, input.canvasId)
      this.assertActive(row)
      this.assertBaseRevision(row, input.baseRevision)
      const nextRevision = Number(row.revision) + 1
      this.writeRevision(db, String(row.id), nextRevision, snapshot.content, 'restore', now)
      db.prepare('UPDATE agent_canvases SET content = ?, revision = ?, updated_at = ? WHERE id = ?')
        .run(snapshot.content, nextRevision, now, row.id)
    })
    tx()
    const record = this.mapRecord(this.requireRow(db, input.canvasId))
    this.emitChange('restored', record, input.originClientId)
    return record
  }
}

export const agentCanvasStore = new AgentCanvasStore()
