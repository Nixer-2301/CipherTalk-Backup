/**
 * 检索式 few-shot 的问答对索引 —— 与画像同库（agent_personas.db），独立连接。
 * 「我的一轮 → TA 的下一轮」按 user_text 嵌入向量；聊天时按当前输入检索最相似的
 * 真实回复范例注入 prompt（向量优先，未配嵌入/失败时用字符二元组重合度兜底）。
 * 主进程负责写入与嵌入（构建/增量进化），AI 子进程只读检索（WAL 多连接安全）。
 */
import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { cosineSimilarity } from 'ai'
import { ConfigService } from '../../config'
import type { PersonaPair } from './personaTypes'

const DB_NAME = 'agent_personas.db'
const PAIRS_CAP = 3000   // 每个分身最多保留的问答对（裁掉最旧的）
const EMBED_BATCH = 64

export interface PersonaPairHit extends PersonaPair {
  score: number
}

/** 中文友好的轻量相似度：字符二元组重合数 / 查询二元组数。 */
function bigramScore(queryGrams: Set<string>, text: string): number {
  if (queryGrams.size === 0) return 0
  let matched = 0
  for (const gram of queryGrams) {
    if (text.includes(gram)) matched += 1
  }
  return matched / queryGrams.size
}

function toBigrams(text: string): Set<string> {
  const chars = Array.from(text.replace(/\s+/g, ''))
  const grams = new Set<string>()
  for (let i = 0; i < chars.length - 1; i += 1) grams.add(chars[i] + chars[i + 1])
  if (grams.size === 0 && chars.length > 0) grams.add(chars.join(''))
  return grams
}

export class PersonaPairStore {
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
      CREATE TABLE IF NOT EXISTS persona_pairs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        pair_time INTEGER NOT NULL,
        user_text TEXT NOT NULL,
        replies_json TEXT NOT NULL,
        context_text TEXT,
        dim INTEGER NOT NULL DEFAULT 0,
        embedding BLOB
      );
      CREATE INDEX IF NOT EXISTS idx_pp_session ON persona_pairs(account_id, session_id, pair_time);
    `)
    try { db.exec('ALTER TABLE persona_pairs ADD COLUMN context_text TEXT') } catch { /* 列已存在 */ }
    this.db = db
    this.dbPath = nextDbPath
    return db
  }

  /** 全量重建（首次克隆/重建画像）。 */
  replaceAll(sessionId: string, pairs: PersonaPair[]): void {
    const db = this.getDb()
    const accountId = this.getAccountId()
    const insert = db.prepare(
      'INSERT INTO persona_pairs (account_id, session_id, pair_time, user_text, replies_json, context_text) VALUES (?, ?, ?, ?, ?, ?)'
    )
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM persona_pairs WHERE account_id = ? AND session_id = ?').run(accountId, sessionId)
      for (const p of pairs.slice(-PAIRS_CAP)) {
        insert.run(accountId, sessionId, p.time, p.user, JSON.stringify(p.replies), p.context ?? null)
      }
    })
    tx()
  }

  /** 增量追加（自动进化），超过上限裁掉最旧的。 */
  append(sessionId: string, pairs: PersonaPair[]): void {
    if (pairs.length === 0) return
    const db = this.getDb()
    const accountId = this.getAccountId()
    const insert = db.prepare(
      'INSERT INTO persona_pairs (account_id, session_id, pair_time, user_text, replies_json, context_text) VALUES (?, ?, ?, ?, ?, ?)'
    )
    const tx = db.transaction(() => {
      for (const p of pairs) insert.run(accountId, sessionId, p.time, p.user, JSON.stringify(p.replies), p.context ?? null)
      db.prepare(`
        DELETE FROM persona_pairs
        WHERE account_id = @accountId AND session_id = @sessionId AND id NOT IN (
          SELECT id FROM persona_pairs
          WHERE account_id = @accountId AND session_id = @sessionId
          ORDER BY pair_time DESC, id DESC LIMIT @cap
        )
      `).run({ accountId, sessionId, cap: PAIRS_CAP })
    })
    tx()
  }

  /** 已索引到的最新问答对时间（秒），0 = 没有。 */
  maxPairTime(sessionId: string): number {
    const row = this.getDb()
      .prepare('SELECT MAX(pair_time) AS t FROM persona_pairs WHERE account_id = ? AND session_id = ?')
      .get(this.getAccountId(), sessionId) as { t: number | null }
    return Number(row?.t || 0)
  }

  remove(sessionId: string): void {
    this.getDb()
      .prepare('DELETE FROM persona_pairs WHERE account_id = ? AND session_id = ?')
      .run(this.getAccountId(), sessionId)
  }

  /**
   * 给未嵌入的问答对补向量（按 user_text 嵌入）。嵌入未配置时静默跳过。
   * 返回本次嵌入的条数。
   */
  async embedPending(sessionId: string, onProgress?: (current: number, total: number) => void): Promise<number> {
    const { getEmbeddingConfig } = await import('../../ai/embeddingService')
    const cfg = getEmbeddingConfig()
    if (!cfg?.enabled || !cfg.apiKey || !cfg.model) return 0
    const { embedTexts } = await import('../../ai/embeddingService')

    const db = this.getDb()
    const accountId = this.getAccountId()
    const rows = db.prepare(
      'SELECT id, user_text FROM persona_pairs WHERE account_id = ? AND session_id = ? AND embedding IS NULL ORDER BY id'
    ).all(accountId, sessionId) as Array<{ id: number; user_text: string }>
    if (rows.length === 0) return 0

    const update = db.prepare('UPDATE persona_pairs SET dim = ?, embedding = ? WHERE id = ?')
    let done = 0
    for (let i = 0; i < rows.length; i += EMBED_BATCH) {
      const batch = rows.slice(i, i + EMBED_BATCH)
      const vectors = await embedTexts(batch.map((r) => r.user_text), cfg)
      const write = db.transaction(() => {
        batch.forEach((r, idx) => {
          const vec = vectors[idx]
          if (!vec || vec.length === 0) return
          update.run(vec.length, Buffer.from(Float32Array.from(vec).buffer), r.id)
        })
      })
      write()
      done += batch.length
      onProgress?.(done, rows.length)
    }
    return done
  }

  /**
   * 按当前用户输入检索最相似的真实问答对。
   * 嵌入就绪走向量 KNN，否则/失败用二元组重合度兜底；都没有命中返回 []。
   * contextQuery（近几轮拼接）只用于向量路径；二元组兜底仍用单句 query，长文本会稀释重合度得分。
   */
  async search(sessionId: string, query: string, limit: number, contextQuery?: string): Promise<PersonaPairHit[]> {
    const q = query.trim()
    if (!q) return []
    const db = this.getDb()
    const rows = db.prepare(
      'SELECT pair_time, user_text, replies_json, context_text, dim, embedding FROM persona_pairs WHERE account_id = ? AND session_id = ?'
    ).all(this.getAccountId(), sessionId) as Array<{
      pair_time: number; user_text: string; replies_json: string; context_text: string | null; dim: number; embedding: Buffer | null
    }>
    if (rows.length === 0) return []

    const toHit = (r: (typeof rows)[number], score: number): PersonaPairHit => ({
      time: r.pair_time,
      user: r.user_text,
      replies: JSON.parse(r.replies_json) as string[],
      ...(r.context_text ? { context: r.context_text } : {}),
      score,
    })

    try {
      const { getEmbeddingConfig, embedQuery } = await import('../../ai/embeddingService')
      const cfg = getEmbeddingConfig()
      if (cfg?.enabled && cfg.apiKey && cfg.model) {
        const queryVec = await embedQuery(contextQuery?.trim() || q, cfg)
        const scored: Array<{ r: (typeof rows)[number]; score: number }> = []
        for (const r of rows) {
          if (!r.embedding || r.dim !== queryVec.length) continue
          const ab = r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.embedding.byteLength)
          try {
            scored.push({ r, score: cosineSimilarity(queryVec, Array.from(new Float32Array(ab))) })
          } catch { /* 跳过坏向量 */ }
        }
        if (scored.length > 0) {
          scored.sort((a, b) => b.score - a.score)
          return scored.slice(0, limit).map(({ r, score }) => toHit(r, score))
        }
      }
    } catch { /* 向量失败 → 关键词兜底 */ }

    const grams = toBigrams(q)
    const scored = rows
      .map((r) => ({ r, score: bigramScore(grams, r.user_text) }))
      .filter((s) => s.score > 0.15)
    scored.sort((a, b) => b.score - a.score || b.r.pair_time - a.r.pair_time)
    return scored.slice(0, limit).map(({ r, score }) => toHit(r, score))
  }

  close(): void {
    if (!this.db) return
    try { this.db.close() } catch { /* ignore */ }
    this.db = null
    this.dbPath = null
  }
}

export const personaPairStore = new PersonaPairStore()
