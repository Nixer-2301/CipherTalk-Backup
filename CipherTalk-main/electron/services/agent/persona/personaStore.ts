/**
 * 画像持久化 —— agent_personas.db（better-sqlite3，cachePath 下，按账号隔离）。
 * 路径与连接管理照 conversationStore：cachePath 变更时自动换库。
 */
import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { ConfigService } from '../../config'
import type { PersonaCard, PersonaFewShot, PersonaProfile, PersonaRecord, PersonaStats, PersonaSticker, PersonaTtsVoiceBinding } from './personaTypes'

const DB_NAME = 'agent_personas.db'

interface PersonaRow {
  id: number
  account_id: string
  session_id: string
  display_name: string
  card_json: string
  few_shots_json: string
  stats_json: string
  profile_json: string | null
  stickers_json: string | null
  tts_voice_json: string | null
  corpus_until: number
  model_provider: string
  model_id: string
  created_at: number
  updated_at: number
}

export interface PersonaUpsertInput {
  sessionId: string
  displayName: string
  card: PersonaCard
  fewShots: PersonaFewShot[]
  stats: PersonaStats
  profile?: PersonaProfile | null
  /** TA 常用的表情包词典 */
  stickers?: PersonaSticker[]
  /** TA 的专属复刻音色；不传时保留旧值。 */
  ttsVoice?: PersonaTtsVoiceBinding | null
  /** 已蒸馏到的消息时间水位（createTime 秒） */
  corpusUntil?: number
  modelProvider: string
  modelId: string
}

/** 增量进化用的局部更新（只改给到的字段，updated_at 总会刷新）。 */
export interface PersonaPatchInput {
  card?: PersonaCard
  fewShots?: PersonaFewShot[]
  stats?: PersonaStats
  profile?: PersonaProfile | null
  stickers?: PersonaSticker[]
  ttsVoice?: PersonaTtsVoiceBinding | null
  corpusUntil?: number
}

function safeParse<T>(json: string | null): T | null {
  if (!json) return null
  try { return JSON.parse(json) as T } catch { return null }
}

function normalizeCard(card: PersonaCard): PersonaCard {
  return {
    ...card,
    personalityTraits: Array.isArray(card.personalityTraits) ? card.personalityTraits : [],
    catchphrases: Array.isArray(card.catchphrases) ? card.catchphrases : [],
    topics: Array.isArray(card.topics) ? card.topics : [],
    ttsInstructions: String(card.ttsInstructions || ''),
  }
}

function rowToRecord(row: PersonaRow): PersonaRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    sessionId: row.session_id,
    displayName: row.display_name,
    card: normalizeCard(JSON.parse(row.card_json) as PersonaCard),
    fewShots: JSON.parse(row.few_shots_json) as PersonaFewShot[],
    stats: JSON.parse(row.stats_json) as PersonaStats,
    profile: safeParse<PersonaProfile>(row.profile_json),
    stickers: safeParse<PersonaSticker[]>(row.stickers_json) || [],
    ttsVoice: safeParse<PersonaTtsVoiceBinding>(row.tts_voice_json),
    corpusUntil: Number(row.corpus_until || 0),
    modelProvider: row.model_provider,
    modelId: row.model_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class PersonaStore {
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
      CREATE TABLE IF NOT EXISTS personas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        card_json TEXT NOT NULL,
        few_shots_json TEXT NOT NULL,
        stats_json TEXT NOT NULL,
        model_provider TEXT NOT NULL DEFAULT '',
        model_id TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(account_id, session_id)
      )
    `)
    // 旧库迁移：深层画像 + 蒸馏水位（ADD COLUMN 已存在时报错，忽略即可）
    for (const ddl of [
      'ALTER TABLE personas ADD COLUMN profile_json TEXT',
      'ALTER TABLE personas ADD COLUMN corpus_until INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE personas ADD COLUMN stickers_json TEXT',
      'ALTER TABLE personas ADD COLUMN tts_voice_json TEXT',
    ]) {
      try { db.exec(ddl) } catch { /* 列已存在 */ }
    }
    this.db = db
    this.dbPath = nextDbPath
    return db
  }

  get(sessionId: string): PersonaRecord | null {
    const row = this.getDb()
      .prepare('SELECT * FROM personas WHERE account_id = ? AND session_id = ?')
      .get(this.getAccountId(), sessionId) as PersonaRow | undefined
    return row ? rowToRecord(row) : null
  }

  list(): PersonaRecord[] {
    const rows = this.getDb()
      .prepare('SELECT * FROM personas WHERE account_id = ? ORDER BY updated_at DESC')
      .all(this.getAccountId()) as PersonaRow[]
    return rows.map(rowToRecord)
  }

  upsert(input: PersonaUpsertInput): PersonaRecord {
    const now = Date.now()
    this.getDb()
      .prepare(`
        INSERT INTO personas (account_id, session_id, display_name, card_json, few_shots_json, stats_json, profile_json, stickers_json, tts_voice_json, corpus_until, model_provider, model_id, created_at, updated_at)
        VALUES (@accountId, @sessionId, @displayName, @cardJson, @fewShotsJson, @statsJson, @profileJson, @stickersJson, @ttsVoiceJson, @corpusUntil, @modelProvider, @modelId, @now, @now)
        ON CONFLICT(account_id, session_id) DO UPDATE SET
          display_name = excluded.display_name,
          card_json = excluded.card_json,
          few_shots_json = excluded.few_shots_json,
          stats_json = excluded.stats_json,
          profile_json = excluded.profile_json,
          stickers_json = excluded.stickers_json,
          tts_voice_json = COALESCE(excluded.tts_voice_json, personas.tts_voice_json),
          corpus_until = excluded.corpus_until,
          model_provider = excluded.model_provider,
          model_id = excluded.model_id,
          updated_at = excluded.updated_at
      `)
      .run({
        accountId: this.getAccountId(),
        sessionId: input.sessionId,
        displayName: input.displayName,
        cardJson: JSON.stringify(input.card),
        fewShotsJson: JSON.stringify(input.fewShots),
        statsJson: JSON.stringify(input.stats),
        profileJson: input.profile ? JSON.stringify(input.profile) : null,
        stickersJson: input.stickers?.length ? JSON.stringify(input.stickers) : null,
        ttsVoiceJson: input.ttsVoice ? JSON.stringify(input.ttsVoice) : null,
        corpusUntil: input.corpusUntil || 0,
        modelProvider: input.modelProvider,
        modelId: input.modelId,
        now,
      })
    const record = this.get(input.sessionId)
    if (!record) throw new Error('画像写入后读取失败')
    return record
  }

  /** 增量进化：只更新给到的字段。画像不存在时返回 null。 */
  patch(sessionId: string, input: PersonaPatchInput): PersonaRecord | null {
    const current = this.get(sessionId)
    if (!current) return null
    const nextProfile = input.profile !== undefined ? input.profile : current.profile
    const nextTtsVoice = input.ttsVoice !== undefined ? input.ttsVoice : current.ttsVoice
    this.getDb()
      .prepare(`
        UPDATE personas SET
          card_json = @cardJson,
          few_shots_json = @fewShotsJson,
          stats_json = @statsJson,
          profile_json = @profileJson,
          stickers_json = @stickersJson,
          tts_voice_json = @ttsVoiceJson,
          corpus_until = @corpusUntil,
          updated_at = @now
        WHERE account_id = @accountId AND session_id = @sessionId
      `)
      .run({
        accountId: this.getAccountId(),
        sessionId,
        cardJson: JSON.stringify(input.card ?? current.card),
        fewShotsJson: JSON.stringify(input.fewShots ?? current.fewShots),
        statsJson: JSON.stringify(input.stats ?? current.stats),
        profileJson: nextProfile ? JSON.stringify(nextProfile) : null,
        stickersJson: (input.stickers ?? current.stickers)?.length ? JSON.stringify(input.stickers ?? current.stickers) : null,
        ttsVoiceJson: nextTtsVoice ? JSON.stringify(nextTtsVoice) : null,
        corpusUntil: input.corpusUntil ?? current.corpusUntil,
        now: Date.now(),
      })
    return this.get(sessionId)
  }

  remove(sessionId: string): boolean {
    const result = this.getDb()
      .prepare('DELETE FROM personas WHERE account_id = ? AND session_id = ?')
      .run(this.getAccountId(), sessionId)
    return result.changes > 0
  }

  close(): void {
    if (!this.db) return
    try { this.db.close() } catch { /* ignore */ }
    this.db = null
    this.dbPath = null
  }
}

export const personaStore = new PersonaStore()
