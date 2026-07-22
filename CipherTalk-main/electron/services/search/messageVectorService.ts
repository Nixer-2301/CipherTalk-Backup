/**
 * 消息向量存储与检索（纯 AI SDK：embedMany 建向量 + cosineSimilarity 算 KNN，无原生扩展）。
 *
 * 嵌入单位是「会话片段」而非单条消息：微信消息又碎又短，单条嵌入语义稀薄、跨多轮的话题召不回，
 * 故把连续消息按「字符预算 + 最大条数 + 时间间隔」切成片段，对每个片段嵌一个向量。
 *
 * - 文本来源：复用 chatSearchIndexService 已建的 message_index（listSessionMemoryMessages）。
 * - 存储：片段向量当 Float32 blob 存进独立的 chat_vectors.db（better-sqlite3，cachePath）。
 * - 检索：embedQuery(query) → 取候选片段向量 → cosineSimilarity 排序取 top-K（跳过维度不符的旧向量）。
 * - 懒构建 + 增量 + 上限：首次对某会话语义检索时切最近 N 条成片段，之后只补新增（按高水位定位）。
 */
import Database from 'better-sqlite3'
import crypto from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { cosineSimilarity } from 'ai'
import { ConfigService } from '../config'
import { chatSearchIndexService } from './chatSearchIndexService'
import { embedTexts, embedQuery, embedImage, getEmbeddingConfig, type EmbeddingConfig } from '../ai/embeddingService'
import { voiceTranscribeService } from '../voiceTranscribeService'
import {
  chatMediaContext,
  collectMomentMediaHits,
  decodeMediaId,
  detectImageMime,
  mediaLabel,
  resolveMediaIdToFile,
  stripFileProtocol,
  type MomentMediaHit,
} from '../media/mediaResolver'

const VECTOR_DB_NAME = 'chat_vectors.db'
const DEFAULT_SESSION_CAP = 1500 // 每个会话首次最多纳入的（最近）消息条数，控制成本/时延
const EMBED_BATCH = 64           // 每批嵌入的片段数
const MEDIA_EMBED_BATCH = 8      // 图片向量化走 HTTP，批量太大容易触发服务商限制
const CHUNK_MAX_CHARS = 600      // 单个片段的合并文本字符预算（多轮上下文，又不至于稀释向量）
const CHUNK_MAX_MSGS = 15        // 单个片段最多容纳的消息条数
const CHUNK_GAP_SECONDS = 20 * 60 // 相邻消息间隔超过此值视为新一段对话，断开
const EMBED_TEXT_CAP = 1000      // 喂给嵌入模型的片段文本硬上限（防超长消息撑爆）
const DEFAULT_MEDIA_CAP = 200
const MAX_MEDIA_IMAGE_BYTES = 20 * 1024 * 1024
const EMBEDDING_IMAGE_MAX_EDGE = 1024
const EMBEDDING_IMAGE_JPEG_QUALITY = 85
const MEDIA_INDEX_BOOTSTRAP_MESSAGE_CAP = 1500

export interface VectorHit {
  sessionId: string
  time: number // create_time（秒）
  isSend: number | null
  senderUsername: string | null
  excerpt: string
  score: number
  startSortSeq: number // 片段覆盖的 sort_seq 区间，供混合检索按区间去重
  endSortSeq: number
  anchor: { sessionId: string; localId: number; sortSeq: number; createTime: number }
}

export interface MediaVectorHit {
  mediaId: string
  source: 'chat' | 'moment'
  mediaKind: 'image' | 'emoji'
  score: number
  time: number
  timeText: string | null
  from: string
  sender?: string
  context?: string
  sessionId?: string
  postId?: string
  filePath?: string
}

interface SessionMessage {
  localId: number
  sortSeq: number
  createTime: number
  localType: number
  isSend: number | null
  senderUsername: string | null
  parsedContent: string
}

interface BuiltChunk {
  startLocalId: number
  endLocalId: number
  startSortSeq: number
  endSortSeq: number
  createTime: number       // 片段末条 create_time（秒），展示/衰减用
  anchorLocalId: number    // get_context 锚点：取片段中点，±radius 可对称覆盖
  anchorSortSeq: number
  anchorCreateTime: number
  anchorIsSend: number | null
  anchorSender: string | null
  msgCount: number
  embedText: string
  excerpt: string
}

export type VectorBuildStage = 'loading' | 'chunking' | 'embedding' | 'done'

export interface VectorBuildProgress {
  sessionId: string
  stage: VectorBuildStage
  current: number
  total: number
  indexed: number
  message: string
}

export interface VectorStoreInfo {
  dbPath: string
  exists: boolean
  sizeBytes: number
  updatedAtMs: number | null
  count: number
  mediaCount?: number
  dimensions: number[]
  mediaDimensions?: number[]
}

interface MediaIndexItem {
  mediaId: string
  source: 'chat' | 'moment'
  mediaKind: 'image' | 'emoji'
  sessionId?: string
  username?: string
  postId?: string
  time: number
  from: string
  sender?: string
  context?: string
}

interface MediaVectorWriteStats {
  total: number
  cached: number
  embedded: number
  normalized: number
  normalizeFailed: number
  resolveFailed: number
  missingFile: number
  invalidSize: number
  unsupportedMime: number
  embedFailed: number
  dimensions: Record<string, number>
  inputModes: Record<string, number>
}

function mediaIdForLog(mediaId: string): string {
  return `${mediaId.slice(0, 12)}...${mediaId.slice(-6)}`
}

function hostForLog(baseURL: string): string {
  try {
    return new URL(baseURL).host || ''
  } catch {
    return ''
  }
}

function embeddingConfigForLog(cfg: EmbeddingConfig): Record<string, unknown> {
  return {
    enabled: cfg.enabled,
    imageEnabled: cfg.imageEnabled === true,
    imageInputMode: cfg.imageInputMode || 'auto',
    protocol: cfg.protocol,
    provider: cfg.provider || undefined,
    model: cfg.model,
    dimension: cfg.dimension || 0,
    baseURLHost: hostForLog(cfg.baseURL),
    hasApiKey: Boolean(cfg.apiKey),
  }
}

function mediaItemsScopeForLog(items: MediaIndexItem[]): Record<string, unknown> {
  const sources = new Set(items.map((item) => item.source))
  const kinds = new Set(items.map((item) => item.mediaKind))
  const sessions = new Set(items.map((item) => item.sessionId).filter(Boolean))
  const usernames = new Set(items.map((item) => item.username).filter(Boolean))
  return {
    total: items.length,
    sources: Array.from(sources),
    kinds: Array.from(kinds),
    sessionCount: sessions.size,
    sessions: Array.from(sessions).slice(0, 5),
    usernameCount: usernames.size,
    usernames: Array.from(usernames).slice(0, 5),
  }
}

function emptyMediaVectorStats(total: number): MediaVectorWriteStats {
  return {
    total,
    cached: 0,
    embedded: 0,
    normalized: 0,
    normalizeFailed: 0,
    resolveFailed: 0,
    missingFile: 0,
    invalidSize: 0,
    unsupportedMime: 0,
    embedFailed: 0,
    dimensions: {},
    inputModes: {},
  }
}

function bumpStat(bucket: Record<string, number>, key: string | number): void {
  const normalized = String(key || 'unknown')
  bucket[normalized] = (bucket[normalized] || 0) + 1
}

function skippedMediaCount(stats: MediaVectorWriteStats): number {
  return stats.resolveFailed + stats.missingFile + stats.invalidSize + stats.unsupportedMime + stats.embedFailed
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

type NormalizedEmbeddingImage = {
  data: Buffer
  mediaType: string
  changed: boolean
  originalSize: number
  normalizedSize: number
  width?: number
  height?: number
  normalizedWidth?: number
  normalizedHeight?: number
  note?: string
}

let sharpLoader: Promise<any | null> | null = null

async function loadSharp(): Promise<any | null> {
  if (!sharpLoader) {
    sharpLoader = import('sharp')
      .then((mod) => mod.default || mod)
      .catch(() => null)
  }
  return sharpLoader
}

async function normalizeImageForEmbedding(buffer: Buffer, mediaType: string): Promise<NormalizedEmbeddingImage> {
  const sharp = await loadSharp()
  if (!sharp) {
    return {
      data: buffer,
      mediaType,
      changed: false,
      originalSize: buffer.length,
      normalizedSize: buffer.length,
      note: 'sharp_not_available',
    }
  }

  const input = sharp(buffer, { animated: false })
  const metadata = await input.metadata().catch(() => null)
  const width = Number(metadata?.width || 0) || undefined
  const height = Number(metadata?.height || 0) || undefined
  const output = await sharp(buffer, { animated: false })
    .rotate()
    .resize({
      width: EMBEDDING_IMAGE_MAX_EDGE,
      height: EMBEDDING_IMAGE_MAX_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: EMBEDDING_IMAGE_JPEG_QUALITY, mozjpeg: true })
    .toBuffer({ resolveWithObject: true })
  return {
    data: output.data,
    mediaType: 'image/jpeg',
    changed: true,
    originalSize: buffer.length,
    normalizedSize: output.data.length,
    width,
    height,
    normalizedWidth: output.info.width,
    normalizedHeight: output.info.height,
    note: mediaType === 'image/jpeg'
      ? 'jpeg_normalized'
      : `${mediaType}_converted_to_jpeg`,
  }
}

type VectorBuildProgressReporter = (progress: VectorBuildProgress) => void

/** 把连续消息切成会话片段（字符预算 / 最大条数 / 时间间隔三者任一触发即断开）。 */
function buildChunks(messages: SessionMessage[]): BuiltChunk[] {
  const chunks: BuiltChunk[] = []
  let group: SessionMessage[] = []
  let chars = 0

  const flush = () => {
    if (group.length === 0) return
    const first = group[0]
    const last = group[group.length - 1]
    const mid = group[Math.floor(group.length / 2)]
    const joined = group.map((m) => m.parsedContent.trim()).filter(Boolean).join('\n')
    chunks.push({
      startLocalId: first.localId,
      endLocalId: last.localId,
      startSortSeq: first.sortSeq,
      endSortSeq: last.sortSeq,
      createTime: last.createTime,
      anchorLocalId: mid.localId,
      anchorSortSeq: mid.sortSeq,
      anchorCreateTime: mid.createTime,
      anchorIsSend: mid.isSend ?? null,
      anchorSender: mid.senderUsername ?? null,
      msgCount: group.length,
      embedText: joined.slice(0, EMBED_TEXT_CAP),
      excerpt: joined.replace(/\s+/g, ' ').trim().slice(0, 240),
    })
    group = []
    chars = 0
  }

  for (const m of messages) {
    const text = m.parsedContent.trim()
    if (!text) continue
    if (group.length > 0) {
      const gap = m.createTime - group[group.length - 1].createTime
      if (chars + text.length > CHUNK_MAX_CHARS || group.length >= CHUNK_MAX_MSGS || gap > CHUNK_GAP_SECONDS) {
        flush()
      }
    }
    group.push(m)
    chars += text.length
  }
  flush()
  return chunks
}

class MessageVectorService {
  private db: Database.Database | null = null
  private dbPath: string | null = null

  private getCacheBasePath(): string {
    const cs = new ConfigService()
    try {
      return cs.getCacheBasePath()
    } finally {
      cs.close()
    }
  }

  private getDb(): Database.Database {
    const base = this.getCacheBasePath()
    if (!existsSync(base)) mkdirSync(base, { recursive: true })
    const next = join(base, VECTOR_DB_NAME)
    if (this.db && this.dbPath === next) return this.db
    if (this.db) {
      try { this.db.close() } catch { /* ignore */ }
    }
    let db = new Database(next)
    try {
      this.initializeDb(db)
    } catch (e) {
      try { db.close() } catch { /* ignore */ }
      if (!this.isMissingVec0ModuleError(e)) throw e

      // 旧版本曾用 sqlite-vec 的 vec0 虚表。新版本不再依赖原生扩展，遇到旧 schema
      // 无法加载时直接删除可重建的向量缓存库，避免发布包缺 sqlite-vec 时向量化卡死。
      this.removeSqliteFileSet(next)
      db = new Database(next)
      this.initializeDb(db)
    }
    this.db = db
    this.dbPath = next
    return db
  }

  private initializeDb(db: Database.Database): void {
    db.pragma('journal_mode = WAL')
    db.exec(`
      DROP TABLE IF EXISTS message_vectors;  -- 旧的 per-message 表已废弃（粒度改为片段）
      CREATE TABLE IF NOT EXISTS message_chunks (
        session_id         TEXT NOT NULL,
        start_local_id     INTEGER NOT NULL,
        end_local_id       INTEGER NOT NULL,
        start_sort_seq     INTEGER NOT NULL,
        end_sort_seq       INTEGER NOT NULL,
        create_time        INTEGER NOT NULL,
        anchor_local_id    INTEGER NOT NULL,
        anchor_sort_seq    INTEGER NOT NULL,
        anchor_create_time INTEGER NOT NULL,
        is_send            INTEGER,
        sender_username    TEXT,
        msg_count          INTEGER NOT NULL,
        excerpt            TEXT,
        dim                INTEGER NOT NULL,
        embedding          BLOB NOT NULL,
        PRIMARY KEY (session_id, end_local_id)
      );
      CREATE INDEX IF NOT EXISTS idx_mc_session ON message_chunks(session_id);

      CREATE TABLE IF NOT EXISTS media_vectors (
        media_id       TEXT PRIMARY KEY,
        source         TEXT NOT NULL,
        media_kind     TEXT NOT NULL,
        session_id     TEXT,
        username       TEXT,
        post_id        TEXT,
        create_time    INTEGER NOT NULL DEFAULT 0,
        from_name      TEXT,
        sender_name    TEXT,
        context_text   TEXT,
        file_hash      TEXT,
        file_path      TEXT,
        dim            INTEGER NOT NULL,
        embedding      BLOB NOT NULL,
        indexed_at     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mv_source_time ON media_vectors(source, create_time DESC);
      CREATE INDEX IF NOT EXISTS idx_mv_session ON media_vectors(session_id, create_time DESC);
      CREATE INDEX IF NOT EXISTS idx_mv_username ON media_vectors(username, create_time DESC);
    `)
  }

  private isMissingVec0ModuleError(e: unknown): boolean {
    return /no such module:\s*vec0/i.test(e instanceof Error ? e.message : String(e))
  }

  private removeSqliteFileSet(dbPath: string): void {
    for (const filePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
      try {
        if (existsSync(filePath)) rmSync(filePath, { force: true })
      } catch {
        // ignore best-effort cleanup
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

  /** 已启用且配置完整才可用。 */
  isReady(cfg?: EmbeddingConfig): boolean {
    const c = cfg || getEmbeddingConfig()
    return !!(c.enabled && c.apiKey && c.model)
  }

  isMediaReady(cfg?: EmbeddingConfig): boolean {
    const c = cfg || getEmbeddingConfig()
    return !!(c.enabled && c.imageEnabled && c.apiKey && c.model)
  }

  private countChunks(db: Database.Database, sessionId: string): number {
    return (db.prepare('SELECT COUNT(*) AS c FROM message_chunks WHERE session_id = ?').get(sessionId) as { c: number }).c
  }

  /** 某会话已建的片段向量数（0 = 未建）。供 UI 显示向量化状态。 */
  getSessionChunkCount(sessionId: string): number {
    return this.countChunks(this.getDb(), sessionId)
  }

  /** 当前向量库的落盘位置与某会话的存储证据。 */
  getSessionVectorStoreInfo(sessionId: string): VectorStoreInfo {
    const db = this.getDb()
    const dbPath = this.dbPath || join(this.getCacheBasePath(), VECTOR_DB_NAME)
    const stat = existsSync(dbPath) ? statSync(dbPath) : null
    const rows = db.prepare(
      'SELECT dim, COUNT(*) AS c FROM message_chunks WHERE session_id = ? GROUP BY dim ORDER BY dim'
    ).all(sessionId) as Array<{ dim: number; c: number }>
    const mediaRows = db.prepare(
      "SELECT dim, COUNT(*) AS c FROM media_vectors WHERE session_id = ? AND media_kind = 'image' GROUP BY dim ORDER BY dim"
    ).all(sessionId) as Array<{ dim: number; c: number }>

    return {
      dbPath,
      exists: !!stat,
      sizeBytes: stat?.size || 0,
      updatedAtMs: stat?.mtimeMs || null,
      count: rows.reduce((sum, row) => sum + row.c, 0),
      mediaCount: mediaRows.reduce((sum, row) => sum + row.c, 0),
      dimensions: rows.map((row) => row.dim),
      mediaDimensions: mediaRows.map((row) => row.dim),
    }
  }

  private countMediaVectors(db: Database.Database, filter?: { sessionId?: string; usernames?: string[] }): number {
    if (filter?.sessionId) {
      return (db.prepare("SELECT COUNT(*) AS c FROM media_vectors WHERE session_id = ? AND media_kind = 'image'").get(filter.sessionId) as { c: number }).c
    }
    if (filter?.usernames?.length) {
      const marks = filter.usernames.map((_, index) => `@u${index}`).join(', ')
      const params = Object.fromEntries(filter.usernames.map((username, index) => [`u${index}`, username]))
      return (db.prepare(`SELECT COUNT(*) AS c FROM media_vectors WHERE username IN (${marks}) AND media_kind = 'image'`).get(params) as { c: number }).c
    }
    return (db.prepare("SELECT COUNT(*) AS c FROM media_vectors WHERE media_kind = 'image'").get() as { c: number }).c
  }

  private hasMediaVector(db: Database.Database, mediaId: string): boolean {
    const row = db.prepare('SELECT 1 AS ok FROM media_vectors WHERE media_id = ? LIMIT 1').get(mediaId) as { ok?: number } | undefined
    return Number(row?.ok || 0) === 1
  }

  private async writeMediaVectors(
    items: MediaIndexItem[],
    cfg: EmbeddingConfig,
    onProgress?: VectorBuildProgressReporter,
  ): Promise<number> {
    const stats = emptyMediaVectorStats(items.length)
    console.info('[MediaVector] 开始写入媒体向量', {
      scope: mediaItemsScopeForLog(items),
      embedding: embeddingConfigForLog(cfg),
      maxImageBytes: MAX_MEDIA_IMAGE_BYTES,
    })
    const db = this.getDb()
    const insert = db.prepare(
      `INSERT OR REPLACE INTO media_vectors
       (media_id, source, media_kind, session_id, username, post_id, create_time, from_name,
        sender_name, context_text, file_hash, file_path, dim, embedding, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    let indexed = 0
    for (let i = 0; i < items.length; i += MEDIA_EMBED_BATCH) {
      const batch = items.slice(i, i + MEDIA_EMBED_BATCH)
      for (const item of batch) {
        await yieldToEventLoop()
        if (item.mediaKind !== 'image') {
          console.info('[MediaVector] 跳过媒体：表情包不参与图片向量化', {
            mediaId: mediaIdForLog(item.mediaId),
            source: item.source,
            mediaKind: item.mediaKind,
            sessionId: item.sessionId,
            username: item.username,
            postId: item.postId,
          })
          continue
        }
        if (this.hasMediaVector(db, item.mediaId)) {
          stats.cached += 1
          indexed += 1
          continue
        }
        const resolved = await resolveMediaIdToFile(item.mediaId)
        if (!resolved.success) {
          stats.resolveFailed += 1
          console.warn('[MediaVector] 跳过媒体：下载或解密失败', {
            mediaId: mediaIdForLog(item.mediaId),
            source: item.source,
            mediaKind: item.mediaKind,
            sessionId: item.sessionId,
            username: item.username,
            postId: item.postId,
            error: resolved.error,
          })
          continue
        }
        const filePath = stripFileProtocol(resolved.filePath)
        if (!existsSync(filePath)) {
          stats.missingFile += 1
          console.warn('[MediaVector] 跳过媒体：解密后文件不存在', {
            mediaId: mediaIdForLog(item.mediaId),
            source: item.source,
            mediaKind: item.mediaKind,
            filePath,
          })
          continue
        }
        const stat = statSync(filePath)
        if (stat.size <= 0 || stat.size > MAX_MEDIA_IMAGE_BYTES) {
          stats.invalidSize += 1
          console.warn('[MediaVector] 跳过媒体：图片大小不合规', {
            mediaId: mediaIdForLog(item.mediaId),
            source: item.source,
            mediaKind: item.mediaKind,
            fileSize: stat.size,
            maxImageBytes: MAX_MEDIA_IMAGE_BYTES,
            filePath,
          })
          continue
        }
        const buffer = readFileSync(filePath)
        const mediaType = detectImageMime(buffer)
        if (!mediaType) {
          stats.unsupportedMime += 1
          console.warn('[MediaVector] 跳过媒体：不支持的图片格式', {
            mediaId: mediaIdForLog(item.mediaId),
            source: item.source,
            mediaKind: item.mediaKind,
            fileSize: stat.size,
            filePath,
          })
          continue
        }
        let embeddingInput = { data: buffer, mediaType }
        try {
          const normalized = await normalizeImageForEmbedding(buffer, mediaType)
          embeddingInput = { data: normalized.data, mediaType: normalized.mediaType }
          if (normalized.changed) {
            stats.normalized += 1
            console.info('[MediaVector] 图片已预处理为 embedding 输入', {
              mediaId: mediaIdForLog(item.mediaId),
              source: item.source,
              originalMediaType: mediaType,
              originalSize: normalized.originalSize,
              normalizedMediaType: normalized.mediaType,
              normalizedSize: normalized.normalizedSize,
              width: normalized.width,
              height: normalized.height,
              normalizedWidth: normalized.normalizedWidth,
              normalizedHeight: normalized.normalizedHeight,
              note: normalized.note,
            })
          }
        } catch (error) {
          stats.normalizeFailed += 1
          console.warn('[MediaVector] 图片预处理失败，回退原图 embedding', {
            mediaId: mediaIdForLog(item.mediaId),
            source: item.source,
            mediaKind: item.mediaKind,
            mediaType,
            fileSize: stat.size,
            filePath,
            error: error instanceof Error ? error.message : String(error),
          })
        }

        let image: Awaited<ReturnType<typeof embedImage>>
        try {
          image = await embedImage(embeddingInput, cfg, { timeoutMs: 45000 })
        } catch (error) {
          stats.embedFailed += 1
          console.warn('[MediaVector] 跳过媒体：图片 embedding 失败', {
            mediaId: mediaIdForLog(item.mediaId),
            source: item.source,
            mediaKind: item.mediaKind,
            mediaType: embeddingInput.mediaType,
            fileSize: stat.size,
            embeddingInputSize: embeddingInput.data.length,
            filePath,
            error: error instanceof Error ? error.message : String(error),
          })
          continue
        }
        const hash = crypto.createHash('sha256').update(buffer).digest('hex')
        const vector = image.embedding
        stats.embedded += 1
        bumpStat(stats.dimensions, vector.length)
        bumpStat(stats.inputModes, image.imageInputMode)
        const write = db.transaction(() => {
          insert.run(
            item.mediaId,
            item.source,
            item.mediaKind,
            item.sessionId || null,
            item.username || null,
            item.postId || null,
            item.time || 0,
            item.from || resolved.from || null,
            item.sender || resolved.sender || null,
            item.context || resolved.content || null,
            hash,
            filePath,
            vector.length,
            Buffer.from(Float32Array.from(vector).buffer),
            Date.now(),
          )
        })
        write()
        console.info('[MediaVector] 已写入图片向量', {
          mediaId: mediaIdForLog(item.mediaId),
          source: item.source,
          mediaKind: item.mediaKind,
          sessionId: item.sessionId,
          username: item.username,
          postId: item.postId,
          mediaType: embeddingInput.mediaType,
          fileSize: stat.size,
          embeddingInputSize: embeddingInput.data.length,
          dim: vector.length,
          imageInputMode: image.imageInputMode,
          filePath,
        })
        indexed += 1
      }
      const current = Math.min(i + batch.length, items.length)
      const skipped = skippedMediaCount(stats)
      onProgress?.({
        sessionId: items[0]?.sessionId || items[0]?.username || '',
        stage: current >= items.length ? 'done' : 'embedding',
        current,
        total: items.length,
        indexed,
        message: current >= items.length
          ? `媒体向量索引已完成（新增 ${stats.embedded}，已存在 ${stats.cached}，跳过 ${skipped}）`
          : `生成媒体向量（新增 ${stats.embedded}，已存在 ${stats.cached}，跳过 ${skipped}）`,
      })
      await yieldToEventLoop()
      console.info('[MediaVector] 媒体向量批次进度', {
        current,
        total: items.length,
        indexed,
        stats,
      })
    }
    console.info('[MediaVector] 媒体向量写入完成', {
      indexed,
      stats,
      scope: mediaItemsScopeForLog(items),
    })
    return indexed
  }

  async ensureSessionMediaVectors(
    sessionId: string,
    cfg: EmbeddingConfig,
    cap = DEFAULT_MEDIA_CAP,
    onProgress?: VectorBuildProgressReporter,
  ): Promise<number> {
    if (!this.isMediaReady(cfg)) {
      console.info('[MediaVector] 跳过会话媒体向量：图片向量化未就绪', {
        sessionId,
        embedding: embeddingConfigForLog(cfg),
      })
      onProgress?.({ sessionId, stage: 'done', current: 0, total: 0, indexed: 0, message: '图片向量化未开启，跳过媒体向量' })
      return 0
    }
    console.info('[MediaVector] 开始会话媒体向量化', {
      sessionId,
      cap,
      embedding: embeddingConfigForLog(cfg),
    })
    const startedAt = Date.now()
    onProgress?.({ sessionId, stage: 'loading', current: 0, total: 0, indexed: 0, message: '读取会话媒体' })
    const listStartedAt = Date.now()
    let rows = chatSearchIndexService.listMediaMessageRows({
      sessionId,
      kinds: ['image'],
      limit: Math.min(cap, DEFAULT_MEDIA_CAP),
    })
    console.info('[MediaVector] 已查询现有媒体索引', {
      sessionId,
      rowCount: rows.length,
      elapsedMs: Date.now() - listStartedAt,
    })
    if (rows.length === 0) {
      console.info('[MediaVector] 当前搜索索引没有图片候选，补建最近消息索引', {
        sessionId,
        maxIndexMessages: MEDIA_INDEX_BOOTSTRAP_MESSAGE_CAP,
      })
      onProgress?.({ sessionId, stage: 'loading', current: 0, total: MEDIA_INDEX_BOOTSTRAP_MESSAGE_CAP, indexed: 0, message: '补建会话搜索索引' })
      await yieldToEventLoop()
      const indexStartedAt = Date.now()
      await chatSearchIndexService.ensureSessionIndexed(sessionId, (progress) => {
        onProgress?.({
          sessionId,
          stage: 'loading',
          current: progress.messagesScanned || 0,
          total: MEDIA_INDEX_BOOTSTRAP_MESSAGE_CAP,
          indexed: progress.indexedCount || 0,
          message: progress.message || '补建会话搜索索引',
        })
      }, {
        maxMessages: MEDIA_INDEX_BOOTSTRAP_MESSAGE_CAP,
        reusePartial: true,
      })
      console.info('[MediaVector] 会话搜索索引补建完成', {
        sessionId,
        elapsedMs: Date.now() - indexStartedAt,
      })
      rows = chatSearchIndexService.listMediaMessageRows({
        sessionId,
        kinds: ['image'],
        limit: Math.min(cap, DEFAULT_MEDIA_CAP),
      })
    }
    console.info('[MediaVector] 会话媒体候选已读取', {
      sessionId,
      rowCount: rows.length,
      imageCount: rows.filter((row) => Number(row.localType) === 3).length,
      emojiCount: rows.filter((row) => Number(row.localType) === 47).length,
      elapsedMs: Date.now() - startedAt,
    })
    const contextStartedAt = Date.now()
    const precedingTextMap = chatSearchIndexService.getPrecedingTextMap(
      sessionId,
      rows.map((row) => row.sortSeq),
    )
    const items: MediaIndexItem[] = rows.map((row) => {
      const ctx = chatMediaContext(row, precedingTextMap.get(row.sortSeq) || '')
      return {
        mediaId: ctx.mediaId,
        source: 'chat',
        mediaKind: ctx.mediaKind,
        sessionId: row.sessionId,
        time: row.createTime,
        from: row.sessionId,
        sender: row.senderUsername || undefined,
        context: ctx.context || ctx.label,
      }
    })
    console.info('[MediaVector] 会话媒体语境构建完成', {
      sessionId,
      itemCount: items.length,
      elapsedMs: Date.now() - contextStartedAt,
    })
    if (items.length === 0) {
      const count = this.countMediaVectors(this.getDb(), { sessionId })
      console.info('[MediaVector] 会话没有可向量化的媒体', { sessionId, persistedMediaVectors: count })
      onProgress?.({ sessionId, stage: 'done', current: 0, total: 0, indexed: count, message: '没有可向量化的媒体' })
      return count
    }
    onProgress?.({ sessionId, stage: 'embedding', current: 0, total: items.length, indexed: 0, message: '生成媒体向量' })
    await this.writeMediaVectors(items, cfg, onProgress)
    const count = this.countMediaVectors(this.getDb(), { sessionId })
    console.info('[MediaVector] 会话媒体向量化完成', { sessionId, persistedMediaVectors: count })
    return count
  }

  async ensureMomentMediaVectors(
    options: {
      usernames?: string[]
      keyword?: string
      startTimeMs?: number
      endTimeMs?: number
      order?: 'latest' | 'oldest'
      target?: 'post' | 'comment' | 'all'
      limit?: number
    },
    cfg: EmbeddingConfig,
    onProgress?: VectorBuildProgressReporter,
  ): Promise<number> {
    if (!this.isMediaReady(cfg)) {
      console.info('[MediaVector] 跳过朋友圈媒体向量：图片向量化未就绪', {
        usernames: options.usernames,
        keyword: options.keyword,
        embedding: embeddingConfigForLog(cfg),
      })
      onProgress?.({ sessionId: options.usernames?.join(',') || 'moments', stage: 'done', current: 0, total: 0, indexed: 0, message: '图片向量化未开启，跳过朋友圈媒体向量' })
      return 0
    }
    const { snsService, isVideoUrl } = await import('../snsService')
    const { msToSeconds } = await import('../agent/tools/shared')
    const fetchLimit = Math.min(200, Math.max((options.limit || 20) * 10, 80))
    console.info('[MediaVector] 开始朋友圈媒体向量化', {
      options,
      fetchLimit,
      embedding: embeddingConfigForLog(cfg),
    })
    onProgress?.({ sessionId: options.usernames?.join(',') || 'moments', stage: 'loading', current: 0, total: 0, indexed: 0, message: '读取朋友圈媒体' })
    const result = await snsService.getTimeline(
      fetchLimit,
      0,
      options.usernames,
      options.keyword,
      msToSeconds(options.startTimeMs),
      msToSeconds(options.endTimeMs),
    )
    if (!result.success) throw new Error(result.error || '查询朋友圈失败')
    const collected = collectMomentMediaHits(result.timeline || [], {
      keyword: options.keyword,
      order: options.order || 'latest',
      target: options.target || 'all',
      limit: Math.min(200, Math.max(1, options.limit || DEFAULT_MEDIA_CAP)),
      skipVideo: isVideoUrl,
    })
    console.info('[MediaVector] 朋友圈媒体候选已读取', {
      postCount: result.timeline?.length || 0,
      mediaHitCount: collected.hits.length,
      skippedVideos: collected.skippedVideos,
      options,
    })
    const imageHits = collected.hits.filter((hit) => hit.mediaKind === 'image')
    console.info('[MediaVector] 朋友圈媒体候选已过滤', {
      before: collected.hits.length,
      imageCount: imageHits.length,
      excludedEmojiCount: collected.hits.length - imageHits.length,
    })
    const items: MediaIndexItem[] = imageHits.map((hit) => {
      const payload = decodeMediaId(hit.mediaId)
      return {
        mediaId: hit.mediaId,
        source: 'moment',
        mediaKind: hit.mediaKind,
        username: payload?.source === 'moment' ? payload.username : undefined,
        postId: hit.postId,
        time: payload?.source === 'moment' ? payload.createTime : 0,
        from: hit.from,
        sender: hit.sender,
        context: hit.content || mediaLabel(hit.mediaKind),
      }
    })
    if (items.length === 0) {
      console.info('[MediaVector] 朋友圈没有可向量化的媒体', {
        usernames: options.usernames,
        keyword: options.keyword,
        skippedVideos: collected.skippedVideos,
      })
      return 0
    }
    await this.writeMediaVectors(items, cfg, onProgress)
    const count = this.countMediaVectors(this.getDb(), { usernames: options.usernames })
    console.info('[MediaVector] 朋友圈媒体向量化完成', {
      usernames: options.usernames,
      persistedMediaVectors: count,
    })
    return count
  }

  /**
   * 确保某会话的片段向量已就绪（懒构建 + 增量）。返回该会话已存片段数。
   */
  async ensureSessionVectors(
    sessionId: string,
    cfg: EmbeddingConfig,
    cap = DEFAULT_SESSION_CAP,
    onProgress?: VectorBuildProgressReporter,
  ): Promise<number> {
    onProgress?.({ sessionId, stage: 'loading', current: 0, total: 0, indexed: 0, message: '读取会话消息' })
    const rawMessages = await chatSearchIndexService.listSessionMemoryMessages(sessionId, (progress) => {
      onProgress?.({
        sessionId,
        stage: 'loading',
        current: progress.messagesScanned || 0,
        total: cap,
        indexed: progress.indexedCount || 0,
        message: progress.message
      })
    }, cap)
    if (rawMessages.length === 0) {
      onProgress?.({ sessionId, stage: 'done', current: 0, total: 0, indexed: 0, message: '没有可向量化的消息' })
      return 0
    }
    const messages: SessionMessage[] = rawMessages.map((m) => {
      const transcript = Number(m.localType) === 34
        ? voiceTranscribeService.getCachedTranscript(sessionId, m.createTime, m.localId) || undefined
        : undefined
      return {
        localId: m.localId,
        sortSeq: m.sortSeq,
        createTime: m.createTime,
        localType: m.localType,
        isSend: m.isSend,
        senderUsername: m.senderUsername,
        parsedContent: transcript || m.parsedContent,
      }
    })
    const db = this.getDb()
    const existingCount = this.countChunks(db, sessionId)

    // 高水位：上次已嵌入到的片段末尾位置（按 sort_seq + local_id 定位，兼容 sort_seq 并列）
    const last = db.prepare(
      'SELECT end_sort_seq AS s, end_local_id AS l FROM message_chunks WHERE session_id = ? ORDER BY end_sort_seq DESC, end_local_id DESC LIMIT 1'
    ).get(sessionId) as { s: number; l: number } | undefined

    const pending: SessionMessage[] = last
      ? messages.filter((m) => m.sortSeq > last.s || (m.sortSeq === last.s && m.localId > last.l))
      : messages.slice(-cap)
    if (pending.length === 0) {
      onProgress?.({ sessionId, stage: 'done', current: 0, total: 0, indexed: existingCount, message: '语义索引已是最新' })
      return existingCount
    }

    onProgress?.({ sessionId, stage: 'chunking', current: 0, total: pending.length, indexed: existingCount, message: '切分会话片段' })
    const chunks = buildChunks(pending)
    if (chunks.length === 0) {
      onProgress?.({ sessionId, stage: 'done', current: 0, total: 0, indexed: existingCount, message: '没有可向量化的文本片段' })
      return existingCount
    }
    onProgress?.({ sessionId, stage: 'embedding', current: 0, total: chunks.length, indexed: existingCount, message: '生成向量' })

    const insert = db.prepare(
      `INSERT OR REPLACE INTO message_chunks
       (session_id, start_local_id, end_local_id, start_sort_seq, end_sort_seq, create_time,
        anchor_local_id, anchor_sort_seq, anchor_create_time, is_send, sender_username,
        msg_count, excerpt, dim, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH)
      await yieldToEventLoop()
      const vectors = await embedTexts(batch.map((c) => c.embedText), cfg)
      const write = db.transaction(() => {
        batch.forEach((c, idx) => {
          const vec = vectors[idx]
          if (!vec || vec.length === 0) return
          const buf = Buffer.from(Float32Array.from(vec).buffer)
          insert.run(
            sessionId, c.startLocalId, c.endLocalId, c.startSortSeq, c.endSortSeq, c.createTime,
            c.anchorLocalId, c.anchorSortSeq, c.anchorCreateTime, c.anchorIsSend, c.anchorSender,
            c.msgCount, c.excerpt, vec.length, buf
          )
        })
      })
      write()
      await yieldToEventLoop()
      const current = Math.min(i + batch.length, chunks.length)
      onProgress?.({
        sessionId,
        stage: current >= chunks.length ? 'done' : 'embedding',
        current,
        total: chunks.length,
        indexed: this.countChunks(db, sessionId),
        message: current >= chunks.length ? '语义索引已完成' : '生成向量',
      })
    }
    return this.countChunks(db, sessionId)
  }

  /** 在某会话已存片段里做 KNN（cosineSimilarity 排序，跳过维度不符的旧向量）。 */
  searchSession(sessionId: string, queryVec: number[], limit: number): VectorHit[] {
    const db = this.getDb()
    const rows = db.prepare(
      `SELECT anchor_local_id, anchor_sort_seq, anchor_create_time, create_time,
              start_sort_seq, end_sort_seq, is_send, sender_username, excerpt, dim, embedding
       FROM message_chunks WHERE session_id = ?`
    ).all(sessionId) as Array<{
      anchor_local_id: number; anchor_sort_seq: number; anchor_create_time: number; create_time: number
      start_sort_seq: number; end_sort_seq: number
      is_send: number | null; sender_username: string | null; excerpt: string; dim: number; embedding: Buffer
    }>

    const scored: Array<{ r: (typeof rows)[number]; score: number }> = []
    for (const r of rows) {
      if (r.dim !== queryVec.length) continue // 换过嵌入模型/维度的旧向量直接跳过，避免静默 0 分污染
      const ab = r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.embedding.byteLength)
      const vec = Array.from(new Float32Array(ab))
      let score = 0
      try {
        score = cosineSimilarity(queryVec, vec)
      } catch {
        continue
      }
      scored.push({ r, score })
    }
    scored.sort((a, b) => b.score - a.score)

    return scored.slice(0, limit).map(({ r, score }) => ({
      sessionId,
      time: r.create_time,
      isSend: r.is_send,
      senderUsername: r.sender_username,
      excerpt: r.excerpt,
      score,
      startSortSeq: r.start_sort_seq,
      endSortSeq: r.end_sort_seq,
      anchor: { sessionId, localId: r.anchor_local_id, sortSeq: r.anchor_sort_seq, createTime: r.anchor_create_time },
    }))
  }

  searchMediaVectors(
    queryVec: number[],
    options: {
      source?: 'chat' | 'moment' | 'all'
      sessionId?: string
      usernames?: string[]
      limit: number
    },
  ): MediaVectorHit[] {
    const db = this.getDb()
    console.info('[MediaVector] 开始搜索媒体向量', {
      queryDim: queryVec.length,
      options,
    })
    const filters = ["media_kind = 'image'"]
    const params: Record<string, unknown> = {}
    if (options.source && options.source !== 'all') {
      filters.push('source = @source')
      params.source = options.source
    }
    if (options.sessionId) {
      filters.push('session_id = @sessionId')
      params.sessionId = options.sessionId
    }
    if (options.usernames?.length) {
      const unique = Array.from(new Set(options.usernames.filter(Boolean)))
      if (unique.length > 0) {
        filters.push(`username IN (${unique.map((_, index) => `@u${index}`).join(', ')})`)
        unique.forEach((username, index) => {
          params[`u${index}`] = username
        })
      }
    }
    const rows = db.prepare(`
      SELECT media_id, source, media_kind, session_id, username, post_id, create_time,
             from_name, sender_name, context_text, file_path, dim, embedding
      FROM media_vectors
      WHERE ${filters.join(' AND ')}
      ORDER BY create_time DESC
      LIMIT 5000
    `).all(params) as Array<{
      media_id: string
      source: 'chat' | 'moment'
      media_kind: 'image' | 'emoji'
      session_id: string | null
      username: string | null
      post_id: string | null
      create_time: number
      from_name: string | null
      sender_name: string | null
      context_text: string | null
      file_path: string | null
      dim: number
      embedding: Buffer
    }>
    console.info('[MediaVector] 媒体向量候选加载完成', {
      candidateRows: rows.length,
      queryDim: queryVec.length,
      matchingDimRows: rows.filter((row) => row.dim === queryVec.length).length,
      dimensions: rows.reduce<Record<string, number>>((acc, row) => {
        acc[String(row.dim)] = (acc[String(row.dim)] || 0) + 1
        return acc
      }, {}),
      options,
    })

    const scored: Array<{ row: (typeof rows)[number]; score: number }> = []
    for (const row of rows) {
      if (row.dim !== queryVec.length) continue
      const ab = row.embedding.buffer.slice(row.embedding.byteOffset, row.embedding.byteOffset + row.embedding.byteLength)
      const vec = Array.from(new Float32Array(ab))
      try {
        scored.push({ row, score: cosineSimilarity(queryVec, vec) })
      } catch {
        continue
      }
    }
    scored.sort((a, b) => b.score - a.score)
    const hits = scored.slice(0, options.limit).map(({ row, score }) => ({
      mediaId: row.media_id,
      source: row.source,
      mediaKind: row.media_kind,
      score,
      time: row.create_time,
      timeText: row.create_time ? new Date(row.create_time * 1000).toLocaleString('zh-CN', { hour12: false }) : null,
      from: row.from_name || row.session_id || row.username || '',
      sender: row.sender_name || undefined,
      context: row.context_text || undefined,
      sessionId: row.session_id || undefined,
      postId: row.post_id || undefined,
      filePath: row.file_path || undefined,
    }))
    console.info('[MediaVector] 媒体向量搜索完成', {
      scored: scored.length,
      returned: hits.length,
      topScore: hits[0]?.score,
      options,
    })
    return hits
  }
}

export const messageVectorService = new MessageVectorService()

/** 供查询侧复用：嵌入查询文本。 */
export { embedQuery }
