import * as crypto from 'crypto'
import { dbAdapter } from './dbAdapter'
import { findMessageDbPaths } from './dbStoragePaths'

export interface MessageTablePair {
  dbPath: string
  tableName: string
  tableHash: string
}

export interface MessageTableColumns {
  names: Set<string>
  contentColumn: string | null
  senderColumn: string | null
  hasRealSenderId: boolean
  hasIsSend: boolean
}

const tableCache = new Map<string, string[]>()
const name2IdCache = new Map<string, boolean>()
const columnCache = new Map<string, MessageTableColumns>()
const myRowIdCache = new Map<string, number | null>()

export function getMessageTableHash(sessionId: string): string {
  return crypto.createHash('md5').update(sessionId).digest('hex').toLowerCase()
}

export function extractExactMessageTableHash(tableName: string): string | null {
  const match = String(tableName).match(/^msg_([0-9a-f]{32})$/i)
  return match?.[1]?.toLowerCase() || null
}

export async function listExactMessageTables(dbPath: string): Promise<string[]> {
  const cached = tableCache.get(dbPath)
  if (cached) return cached
  const rows = await dbAdapter.all<{ name: string }>(
    'message',
    dbPath,
    "SELECT name FROM sqlite_master WHERE type='table' AND lower(name) LIKE 'msg_%'"
  )
  const tables = rows.map(r => r.name).filter(name => !!extractExactMessageTableHash(name))
  tableCache.set(dbPath, tables)
  return tables
}

export async function findSessionMessageTables(sessionId: string): Promise<MessageTablePair[]> {
  const targetHash = getMessageTableHash(sessionId)
  const pairs: MessageTablePair[] = []
  for (const dbPath of findMessageDbPaths()) {
    const tables = await listExactMessageTables(dbPath)
    for (const tableName of tables) {
      const tableHash = extractExactMessageTableHash(tableName)
      if (tableHash === targetHash) pairs.push({ dbPath, tableName, tableHash })
    }
  }
  return pairs
}

export async function hasName2IdTable(dbPath: string): Promise<boolean> {
  const cached = name2IdCache.get(dbPath)
  if (cached !== undefined) return cached
  const row = await dbAdapter.get<{ name: string }>(
    'message',
    dbPath,
    "SELECT name FROM sqlite_master WHERE type='table' AND name = 'Name2Id'"
  ).catch(() => null)
  const result = !!row
  name2IdCache.set(dbPath, result)
  return result
}

export async function getMyRowId(dbPath: string, candidates: string[]): Promise<number | null> {
  const key = `${dbPath}:${candidates.join('|')}`
  const cached = myRowIdCache.get(key)
  if (cached !== undefined) return cached
  for (const candidate of candidates) {
    if (!candidate) continue
    const row = await dbAdapter.get<{ rowid: number }>(
      'message',
      dbPath,
      'SELECT rowid FROM Name2Id WHERE user_name = ?',
      [candidate]
    ).catch(() => null)
    if (row?.rowid !== undefined && row.rowid !== null) {
      myRowIdCache.set(key, row.rowid)
      return row.rowid
    }
  }
  myRowIdCache.set(key, null)
  return null
}

export async function getMessageTableColumns(dbPath: string, tableName: string): Promise<MessageTableColumns> {
  const cacheKey = `${dbPath}:${tableName}`
  const cached = columnCache.get(cacheKey)
  if (cached) return cached
  const rows = await dbAdapter.all<{ name: string }>('message', dbPath, `PRAGMA table_info("${tableName}")`)
  const names = new Set(rows.map(r => r.name))
  const lowerToActual = new Map(rows.map(r => [r.name.toLowerCase(), r.name]))
  const find = (candidates: string[]) => {
    for (const candidate of candidates) {
      const actual = lowerToActual.get(candidate.toLowerCase())
      if (actual) return actual
    }
    return null
  }
  const result: MessageTableColumns = {
    names,
    contentColumn: find(['message_content', 'display_content', 'content', 'msg_content', 'WCDB_CT_message_content']),
    senderColumn: find(['real_sender', 'wxid_sender', 'sender', 'talker', 'src']),
    hasRealSenderId: names.has('real_sender_id'),
    hasIsSend: names.has('is_send'),
  }
  columnCache.set(cacheKey, result)
  return result
}

export function clearMessageDbScannerCache(): void {
  tableCache.clear()
  name2IdCache.clear()
  columnCache.clear()
  myRowIdCache.clear()
}
