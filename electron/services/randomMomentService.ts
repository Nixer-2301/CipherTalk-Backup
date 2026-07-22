/**
 * 「回忆一刻」三级随机抽取：
 *   1. 会话随机  — 各私聊等概率被选中，避免消息多的联系人独占出场
 *   2. 时间点随机 — 在该会话完整时间轴上随机取一个点，老消息与新消息机会均等
 *   3. 消息随机  — 取时间点附近若干条，再随机返回其中一条
 *
 * 时间点查询走 createTime 范围索引，远快于 ORDER BY RANDOM() 全表扫描。
 * 文本消息至少 5 字符（过滤"嗯"/"好的"类），图/语音/表情不限。
 * 兜底：原有穷举扫描，仍排除低价值自动提示，保证一定能返回有效回忆。
 */
import { dbAdapter } from './dbAdapter'
import { quoteIdent } from './statsSqlHelpers'
import { chatService, type Message } from './chatService'

const MOMENT_LOCAL_TYPES = [1, 3, 34, 47] as const
const MIN_TEXT_CHARS = 2
/** 时间点附近取多少条候选消息 */
const TIME_BUCKET_SIZE = 5
/** 最多尝试多少个会话 */
const MAX_SESSION_TRIES = 30
/** 每个会话最多尝试几次时间点（时间点附近无合格消息时重试） */
const TIME_RETRIES_PER_SESSION = 3
const SCAN_BATCH = 600
const MAX_ROWS_SCAN_PER_TABLE = 250_000

// ─── 表元数据缓存（一次 PRAGMA 同时检测类型列和时间列）────────────────────────

interface TableMeta {
  typeWhere: string | null
  timeCol: string | null
}

const tableMetaCache = new Map<string, TableMeta>()

async function getTableMeta(dbPath: string, tableName: string): Promise<TableMeta> {
  const key = `${dbPath}\0${tableName}`
  if (tableMetaCache.has(key)) return tableMetaCache.get(key)!

  const safeTable = String(tableName).replace(/'/g, "''")
  let rows: Array<{ name: string }>
  try {
    rows = await dbAdapter.all<{ name: string }>('message', dbPath, `PRAGMA table_info('${safeTable}')`)
  } catch {
    const meta: TableMeta = { typeWhere: null, timeCol: null }
    tableMetaCache.set(key, meta)
    return meta
  }

  const cols = rows.map(r => r.name)
  const findCol = (...needles: string[]) =>
    needles.reduce<string | undefined>((f, n) => f ?? cols.find(c => c.toLowerCase() === n.toLowerCase()), undefined)

  const lt = findCol('local_type')
  const ty = findCol('type')
  const wcdb = findCol('WCDB_CT_local_type')
  const types = MOMENT_LOCAL_TYPES.join(',')
  let typeWhere: string | null = null
  if (lt && ty) typeWhere = `(${quoteIdent(lt)} IN (${types}) OR ${quoteIdent(ty)} IN (${types}))`
  else if (lt) typeWhere = `${quoteIdent(lt)} IN (${types})`
  else if (ty) typeWhere = `${quoteIdent(ty)} IN (${types})`
  else if (wcdb) typeWhere = `${quoteIdent(wcdb)} IN (${types})`

  const rawTimeCol = findCol('create_time', 'createTime', 'CreateTime') ?? null
  const timeCol = rawTimeCol ? quoteIdent(rawTimeCol) : null

  const meta: TableMeta = { typeWhere, timeCol }
  tableMetaCache.set(key, meta)
  return meta
}

// ─── 基础工具 ────────────────────────────────────────────────────────────────

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
}

function isIncomingMoment(msg: Message | null | undefined): boolean {
  if (!msg) return false
  if (msg.isSend === 1) return false
  return (MOMENT_LOCAL_TYPES as readonly number[]).includes(msg.localType)
}

function normalizeNoticeText(text: string): string {
  return text.replace(/\s+/g, '').replace(/[，,。.!！?？:：；;]/g, '')
}

function isFriendVerificationNotice(msg: Message | null | undefined): boolean {
  if (!msg || msg.localType !== 1) return false
  const text = normalizeNoticeText(msg.parsedContent || msg.rawContent || '')
  if (!text) return false

  return (
    (text.includes('通过了你的朋友验证请求') && text.includes('现在我们可以开始聊天了')) ||
    (text.includes('你已添加了') && text.includes('现在可以开始聊天了'))
  )
}

function isMomentCandidate(msg: Message | null | undefined): boolean {
  return isIncomingMoment(msg) && !isFriendVerificationNotice(msg)
}

function isQualityMessage(msg: Message | null | undefined): boolean {
  if (!isMomentCandidate(msg)) return false
  if (msg!.localType === 1) return (msg!.parsedContent || '').trim().length >= MIN_TEXT_CHARS
  return true
}

async function getMessageFromSampledTable(
  sessionId: string,
  localId: number,
  tableName: string,
  dbPath: string
): Promise<Message | null> {
  const got = await chatService.getMessageByLocalIdFromTable(sessionId, localId, tableName, dbPath)
  return got.success && got.message ? got.message : null
}

// ─── 三级随机：单会话一次抽取 ─────────────────────────────────────────────────

async function pickOneFromSession(sessionId: string): Promise<Message | null> {
  const pairs = await chatService.getSessionMessageTables(sessionId)
  if (!pairs.length) return null

  // 随机打乱表顺序，多张表时不总是从第一张拿
  const shuffledPairs = [...pairs]
  shuffleInPlace(shuffledPairs)

  for (const { tableName, dbPath } of shuffledPairs) {
    const { typeWhere, timeCol } = await getTableMeta(dbPath, tableName)
    if (!typeWhere) continue
    const qTable = quoteIdent(tableName)

    try {
      if (timeCol) {
        // 获取时间轴范围
        const bounds = await dbAdapter.get<{ minT: number; maxT: number }>(
          'message',
          dbPath,
          `SELECT MIN(${timeCol}) AS minT, MAX(${timeCol}) AS maxT FROM ${qTable} WHERE ${typeWhere}`
        )
        if (!bounds?.minT || !bounds?.maxT || bounds.minT === bounds.maxT) continue

        // 在时间轴上多次随机取点，遇到合格消息立即返回
        for (let i = 0; i < TIME_RETRIES_PER_SESSION; i++) {
          const t = Math.floor(bounds.minT + Math.random() * (bounds.maxT - bounds.minT))
          const rows = await dbAdapter.all<{ local_id: number | string }>(
            'message',
            dbPath,
            `SELECT local_id FROM ${qTable} WHERE ${typeWhere} AND ${timeCol} >= ? ORDER BY ${timeCol} ASC LIMIT ?`,
            [t, TIME_BUCKET_SIZE]
          )
          if (!rows.length) continue

          shuffleInPlace(rows)
          for (const r of rows) {
            const localId = Number(r.local_id)
            if (!Number.isFinite(localId)) continue
            const msg = await getMessageFromSampledTable(sessionId, localId, tableName, dbPath)
            if (isQualityMessage(msg)) return msg
          }
        }
      } else {
        // 无时间列兜底：ORDER BY RANDOM()
        const row = await dbAdapter.get<{ local_id: number | string }>(
          'message',
          dbPath,
          `SELECT local_id FROM ${qTable} WHERE ${typeWhere} ORDER BY RANDOM() LIMIT 1`
        )
        if (row?.local_id == null) continue
        const localId = Number(row.local_id)
        if (!Number.isFinite(localId)) continue
        const msg = await getMessageFromSampledTable(sessionId, localId, tableName, dbPath)
        if (isQualityMessage(msg)) return msg
      }
    } catch { /* 跳过该表，尝试下一张 */ }
  }

  return null
}

// ─── 穷举兜底（无质量限制）────────────────────────────────────────────────────

async function scanTableByRowid(sessionId: string, tableName: string, dbPath: string): Promise<Message | null> {
  const { typeWhere } = await getTableMeta(dbPath, tableName)
  if (!typeWhere) return null

  const qTable = quoteIdent(tableName)
  let lastRowid = 0
  let scanned = 0

  for (;;) {
    let rows: Array<{ rowid: number; local_id: number | string }>
    try {
      rows = await dbAdapter.all<{ rowid: number; local_id: number | string }>(
        'message',
        dbPath,
        `SELECT rowid, local_id FROM ${qTable} WHERE ${typeWhere} AND rowid > ? ORDER BY rowid ASC LIMIT ?`,
        [lastRowid, SCAN_BATCH]
      )
    } catch {
      return scanTableByOffset(sessionId, tableName, dbPath)
    }
    if (!rows.length) break
    lastRowid = rows[rows.length - 1].rowid
    scanned += rows.length

    const batch = [...rows]
    shuffleInPlace(batch)
    for (const r of batch) {
      const localId = Number(r.local_id)
      if (!Number.isFinite(localId)) continue
      const msg = await getMessageFromSampledTable(sessionId, localId, tableName, dbPath)
      if (isMomentCandidate(msg)) return msg
    }
    if (scanned >= MAX_ROWS_SCAN_PER_TABLE) break
  }
  return null
}

async function scanTableByOffset(sessionId: string, tableName: string, dbPath: string): Promise<Message | null> {
  const { typeWhere } = await getTableMeta(dbPath, tableName)
  if (!typeWhere) return null

  const qTable = quoteIdent(tableName)
  let offset = 0
  let scanned = 0

  for (;;) {
    let rows: Array<{ local_id: number | string }>
    try {
      rows = await dbAdapter.all<{ local_id: number | string }>(
        'message',
        dbPath,
        `SELECT local_id FROM ${qTable} WHERE ${typeWhere} LIMIT ? OFFSET ?`,
        [SCAN_BATCH, offset]
      )
    } catch {
      return null
    }
    if (!rows.length) break
    offset += rows.length
    scanned += rows.length

    const batch = [...rows]
    shuffleInPlace(batch)
    for (const r of batch) {
      const localId = Number(r.local_id)
      if (!Number.isFinite(localId)) continue
      const msg = await getMessageFromSampledTable(sessionId, localId, tableName, dbPath)
      if (isMomentCandidate(msg)) return msg
    }
    if (scanned >= MAX_ROWS_SCAN_PER_TABLE) break
  }
  return null
}

async function exhaustSession(sessionId: string): Promise<Message | null> {
  const pairs = await chatService.getSessionMessageTables(sessionId)
  for (const { tableName, dbPath } of pairs) {
    const msg = await scanTableByRowid(sessionId, tableName, dbPath)
    if (msg) return msg
  }
  return null
}

// ─── 私聊会话列表 ─────────────────────────────────────────────────────────────

async function loadPrivateSessionIds(): Promise<string[]> {
  const ids: string[] = []
  let offset = 0
  const pageSize = 1000
  for (;;) {
    const r = await chatService.getSessions(offset, pageSize)
    if (!r.success || !r.sessions?.length) break
    for (const s of r.sessions) {
      const u = (s.username || '').trim()
      if (u && !u.includes('@chatroom')) ids.push(u)
    }
    if (!r.hasMore) break
    offset += pageSize
    if (offset > 200_000) break
  }
  return ids
}

// ─── 主入口 ───────────────────────────────────────────────────────────────────

/**
 * 私聊中对方发来的文本/图/语音/表情（local_type 1/3/34/47）。
 * 三级随机：会话随机 → 时间点随机 → 消息随机；失败则穷举兜底。
 */
export async function pickRandomPrivateIncomingMoment(): Promise<{
  success: boolean
  sessionId?: string
  message?: Message
  error?: string
  hint?: string
}> {
  try {
    const privateIds = await loadPrivateSessionIds()
    if (privateIds.length === 0) {
      return { success: false, error: 'NO_PRIVATE_SESSION', hint: '暂无私聊会话，无法抽取回忆一刻。' }
    }

    // 会话随机：打乱后依次尝试，每个会话等概率被轮到
    const pool = [...privateIds]
    shuffleInPlace(pool)

    for (const sessionId of pool.slice(0, MAX_SESSION_TRIES)) {
      const msg = await pickOneFromSession(sessionId)
      if (msg) return { success: true, sessionId, message: msg }
    }

    // 穷举兜底：无质量限制，保证一定能找到结果
    for (const sessionId of pool) {
      const msg = await exhaustSession(sessionId)
      if (msg) return { success: true, sessionId, message: msg }
    }

    return { success: false, error: 'NO_INCOMING_MOMENT', hint: '未找到对方发来的文本、图片、语音或表情消息。' }
  } catch (e) {
    const err = String(e)
    return { success: false, error: err, hint: `随机回忆失败：${err}` }
  }
}
