/**
 * 导演笔记与对话反思水位 —— 与画像同库（agent_personas.db），独立连接。
 * corrections：用户在克隆对话里对扮演的纠正/指示（注入 prompt 必须遵守）；
 * episodes：历次克隆对话的摘要（分身自己的 episodic memory）。
 * persona_reflect_state 记录每个对话已反思到的消息数，避免重复反思。
 */
import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { ConfigService } from '../../config'
import type { PersonaNotes } from './personaTypes'

const DB_NAME = 'agent_personas.db'
const MAX_CORRECTIONS = 20
const MAX_EPISODES = 8

export class PersonaNotesStore {
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

  private getAccountId(): string {
    const config = new ConfigService()
    try {
      const active = config.getActiveAccount()
      const wxid = String(config.get('myWxid') || '').trim()
      return active?.id || wxid || 'default'
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
    db.exec(`
      CREATE TABLE IF NOT EXISTS persona_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pn_session ON persona_notes(account_id, session_id, kind, created_at);
      CREATE TABLE IF NOT EXISTS persona_reflect_state (
        account_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        conversation_id INTEGER NOT NULL,
        reflected_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, session_id, conversation_id)
      );
    `)
    this.db = db
    this.dbPath = nextDbPath
    return db
  }

  /** 追加笔记并按 kind 裁掉最旧的（corrections 留 20、episodes 留 8）。 */
  add(sessionId: string, kind: 'correction' | 'episode', contents: string[]): void {
    const items = contents.map((c) => c.trim()).filter(Boolean)
    if (items.length === 0) return
    const db = this.getDb()
    const accountId = this.getAccountId()
    const insert = db.prepare(
      'INSERT INTO persona_notes (account_id, session_id, kind, content, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    const cap = kind === 'correction' ? MAX_CORRECTIONS : MAX_EPISODES
    const tx = db.transaction(() => {
      const now = Date.now()
      items.forEach((content, index) => insert.run(accountId, sessionId, kind, content, now + index))
      db.prepare(`
        DELETE FROM persona_notes
        WHERE account_id = @accountId AND session_id = @sessionId AND kind = @kind AND id NOT IN (
          SELECT id FROM persona_notes
          WHERE account_id = @accountId AND session_id = @sessionId AND kind = @kind
          ORDER BY created_at DESC, id DESC LIMIT @cap
        )
      `).run({ accountId, sessionId, kind, cap })
    })
    tx()
  }

  /** 读取注入 prompt 用的全部笔记（时间正序，旧的在前）。 */
  getNotes(sessionId: string): PersonaNotes {
    const rows = this.getDb()
      .prepare(
        'SELECT kind, content FROM persona_notes WHERE account_id = ? AND session_id = ? ORDER BY created_at ASC, id ASC'
      )
      .all(this.getAccountId(), sessionId) as Array<{ kind: string; content: string }>
    return {
      corrections: rows.filter((r) => r.kind === 'correction').map((r) => r.content),
      episodes: rows.filter((r) => r.kind === 'episode').map((r) => r.content),
    }
  }

  getReflectedCount(sessionId: string, conversationId: number): number {
    const row = this.getDb()
      .prepare(
        'SELECT reflected_count FROM persona_reflect_state WHERE account_id = ? AND session_id = ? AND conversation_id = ?'
      )
      .get(this.getAccountId(), sessionId, conversationId) as { reflected_count: number } | undefined
    return Number(row?.reflected_count || 0)
  }

  setReflectedCount(sessionId: string, conversationId: number, count: number): void {
    this.getDb()
      .prepare(`
        INSERT INTO persona_reflect_state (account_id, session_id, conversation_id, reflected_count)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id, session_id, conversation_id) DO UPDATE SET reflected_count = excluded.reflected_count
      `)
      .run(this.getAccountId(), sessionId, conversationId, count)
  }

  /** 删除分身时清掉全部笔记与反思水位。 */
  remove(sessionId: string): void {
    const db = this.getDb()
    const accountId = this.getAccountId()
    db.prepare('DELETE FROM persona_notes WHERE account_id = ? AND session_id = ?').run(accountId, sessionId)
    db.prepare('DELETE FROM persona_reflect_state WHERE account_id = ? AND session_id = ?').run(accountId, sessionId)
  }

  close(): void {
    if (!this.db) return
    try { this.db.close() } catch { /* ignore */ }
    this.db = null
    this.dbPath = null
  }
}

export const personaNotesStore = new PersonaNotesStore()
