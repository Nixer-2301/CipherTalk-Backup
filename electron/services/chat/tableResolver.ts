import { dbAdapter } from '../dbAdapter'
import { findMessageDbPaths } from '../dbStoragePaths'
import { clearMessageDbScannerCache } from '../messageDbScanner'
import { SESSION_TABLE_CACHE_DURATION } from './constants'
import type { ChatServiceState } from './state'

/**
 * 查找消息数据库（增量扫描：返回所有数据库，包括新发现的）
 */
export function findMessageDbs(state: ChatServiceState): { allDbs: string[]; newDbs: string[] } {
  const allDbs: string[] = []
  const newDbs: string[] = []

  try {
    for (const fullPath of findMessageDbPaths()) {
      allDbs.push(fullPath)
      if (!state.knownMessageDbFiles.has(fullPath)) {
        newDbs.push(fullPath)
        state.knownMessageDbFiles.add(fullPath)
      }
    }
  } catch { }

  return { allDbs, newDbs }
}

/**
 * 刷新消息数据库缓存（解密后调用）
 */
export function refreshMessageDbCache(state: ChatServiceState): void {
  state.knownMessageDbFiles.clear()
  state.sessionTableCache.clear()
  state.sessionTableCacheTime = 0
  state.myRowIdCache.clear()
  state.hasName2IdCache.clear()
  state.contactColumnsCache = null
  state.weComCorpNameCache.clear()
  state.hasOpenImWordingTable = null
  clearMessageDbScannerCache()
}

/**
 * 计算消息表名 hash
 */
export function getTableNameHash(sessionId: string): string {
  const crypto = require('crypto')
  const hash = crypto.createHash('md5').update(sessionId).digest('hex')
  return hash
}

/**
 * 从消息表名中提取会话 hash（兼容大小写与后缀）
 */
export function extractTableHash(tableName: string): string | null {
  const match = tableName.match(/msg_([0-9a-f]{32})/i)
  if (match?.[1]) return match[1].toLowerCase()
  return null
}

/**
 * 在消息数据库中查找会话的消息表（带缓存）
 */
export async function findMessageTable(dbPath: string, sessionId: string): Promise<string | null> {
  try {
    const tables = await dbAdapter.all<any>(
      'message',
      dbPath,
      "SELECT name FROM sqlite_master WHERE type='table' AND lower(name) LIKE 'msg_%'"
    )

    const hash = getTableNameHash(sessionId).toLowerCase()

    for (const table of tables) {
      const name = table.name as string

      // 优先精确提取 hash 匹配
      const tableHash = extractTableHash(name)
      if (tableHash && tableHash === hash) {
        return name
      }

    }

    if (tables.length > 0 && process.env.CIPHERTALK_CHAT_DEBUG === '1') {
      const sample = tables.slice(0, 8).map(t => t.name).join(', ')
      console.warn(`[ChatService] 未匹配到消息表: session=${sessionId}, hash=${hash}, tables=${tables.length}, sample=[${sample}]`)
    }
  } catch { }

  return null
}

/**
 * 查找会话对应的所有数据库和表（带缓存过期）
 *
 * 缓存策略：
 * 1. 缓存60秒后自动过期，重新扫描
 * 2. 如果有新数据库文件，在新数据库中查找并追加到缓存
 * 3. 如果会话未缓存，全量扫描所有数据库
 */
export async function findSessionTables(state: ChatServiceState, sessionId: string): Promise<{ tableName: string; dbPath: string }[]> {
  const now = Date.now()
  const { allDbs, newDbs } = findMessageDbs(state)
  if (allDbs.length === 0) return []

  // 检查缓存是否过期
  const cacheExpired = (now - state.sessionTableCacheTime) > SESSION_TABLE_CACHE_DURATION
  if (cacheExpired) {
    state.sessionTableCache.clear()
    state.sessionTableCacheTime = now
  }

  // 获取已缓存的结果
  let cached = state.sessionTableCache.get(sessionId)

  // 情况1：有缓存，且有新数据库 -> 只在新数据库中查找
  if (cached && cached.length > 0 && newDbs.length > 0) {
    const newPairs: { dbPath: string; tableName: string }[] = []

    for (const dbPath of newDbs) {
      const tableName = await findMessageTable(dbPath, sessionId)
      if (tableName) {
        newPairs.push({ dbPath, tableName })
      }
    }

    // 合并到缓存
    if (newPairs.length > 0) {
      cached = [...cached, ...newPairs]
      state.sessionTableCache.set(sessionId, cached)
    }
  }

  // 情况2：有缓存，没有新数据库 -> 直接使用缓存
  if (cached && cached.length > 0) {
    return cached.map(item => ({ tableName: item.tableName, dbPath: item.dbPath }))
  }

  // 情况3：没有缓存 -> 全量扫描所有数据库
  const dbTablePairs: { tableName: string; dbPath: string }[] = []

  for (const dbPath of allDbs) {
    const tableName = await findMessageTable(dbPath, sessionId)
    if (tableName) {
      dbTablePairs.push({ tableName, dbPath })
    }
  }

  // 存入缓存
  if (dbTablePairs.length > 0) {
    state.sessionTableCache.set(sessionId, dbTablePairs.map(p => ({ dbPath: p.dbPath, tableName: p.tableName })))
  }

  return dbTablePairs
}

/**
 * 检查表是否存在（带缓存）
 */
export async function checkTableExists(state: ChatServiceState, dbPath: string, tableName: string): Promise<boolean> {
  const cacheKey = `${dbPath}:${tableName}`
  const cached = state.hasName2IdCache.get(cacheKey)
  if (cached !== undefined) return cached

  try {
    const result = await dbAdapter.get<any>(
      'message',
      dbPath,
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
      [tableName]
    )
    const exists = !!result
    state.hasName2IdCache.set(cacheKey, exists)
    return exists
  } catch {
    state.hasName2IdCache.set(cacheKey, false)
    return false
  }
}

/**
 * 解析当前用户在 Name2Id 表中的 rowid（带缓存）。
 * 行为与原各个 query 方法中内联的逻辑完全一致：
 *   - 优先按原始 myWxid 查
 *   - 否则按清理后的 cleanedMyWxid 查
 *   - 以 dbPath:<key> 作为缓存 key
 */
export async function resolveMyRowId(state: ChatServiceState, dbPath: string, myWxid: string, cleanedMyWxid: string, hasName2IdTable: boolean): Promise<number | null> {
  if (!myWxid || !hasName2IdTable) return null

  const cacheKeyOriginal = `${dbPath}:${myWxid}`
  const cachedRowIdOriginal = state.myRowIdCache.get(cacheKeyOriginal)
  if (cachedRowIdOriginal !== undefined) return cachedRowIdOriginal

  const row = await dbAdapter.get<any>(
    'message',
    dbPath,
    'SELECT rowid FROM Name2Id WHERE user_name = ?',
    [myWxid]
  )
  if (row?.rowid) {
    const rid = row.rowid as number
    state.myRowIdCache.set(cacheKeyOriginal, rid)
    return rid
  }

  if (cleanedMyWxid && cleanedMyWxid !== myWxid) {
    const cacheKeyCleaned = `${dbPath}:${cleanedMyWxid}`
    const cachedRowIdCleaned = state.myRowIdCache.get(cacheKeyCleaned)
    if (cachedRowIdCleaned !== undefined) return cachedRowIdCleaned

    const row2 = await dbAdapter.get<any>(
      'message',
      dbPath,
      'SELECT rowid FROM Name2Id WHERE user_name = ?',
      [cleanedMyWxid]
    )
    const rid = row2?.rowid ?? null
    state.myRowIdCache.set(cacheKeyCleaned, rid)
    return rid
  }

  state.myRowIdCache.set(cacheKeyOriginal, null)
  return null
}
