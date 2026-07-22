import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { dbAdapter } from './dbAdapter.js'

export interface MessageTableColumns {
  names: Set<string>
  lower: Map<string, string>
  contentColumn: string | null
  senderColumn: string | null
  hasRealSenderId: boolean
  hasIsSend: boolean
  hasLocalType: boolean
  hasType: boolean
}

export interface MessageTablePair {
  dbPath: string
  tableName: string
  tableHash: string
}

const tableCache = new Map<string, string[]>()
const columnCache = new Map<string, MessageTableColumns>()
const name2IdCache = new Map<string, boolean>()
const myRowIdCache = new Map<string, number | null>()

export function clearMessageDbScannerCache(): void {
  tableCache.clear()
  columnCache.clear()
  name2IdCache.clear()
  myRowIdCache.clear()
}

/**
 * 解析 db_storage 实际路径，兼容 `<root>/db_storage`、`<root>/<wxid>/db_storage` 与 `<root>/<wxid>_xxxx/db_storage` 等。
 */
export function resolveDbStoragePath(dbPath: string, wxid: string): string | null {
  if (!dbPath) return null
  const normalized = dbPath.replace(/[\\/]+$/, '')
  if (basename(normalized).toLowerCase() === 'db_storage' && existsSync(normalized)) return normalized
  const direct = join(normalized, 'db_storage')
  if (existsSync(direct)) return direct
  if (wxid) {
    const viaWxid = join(normalized, wxid, 'db_storage')
    if (existsSync(viaWxid)) return viaWxid
    try {
      const lowerWxid = wxid.toLowerCase()
      for (const entry of readdirSync(normalized)) {
        const entryPath = join(normalized, entry)
        try { if (!statSync(entryPath).isDirectory()) continue } catch { continue }
        const lowerEntry = entry.toLowerCase()
        if (lowerEntry !== lowerWxid && !lowerEntry.startsWith(`${lowerWxid}_`)) continue
        const candidate = join(entryPath, 'db_storage')
        if (existsSync(candidate)) return candidate
      }
    } catch { /* ignore */ }
  }
  return null
}

/**
 * 扫描 db_storage 下的所有 msg_*.db / message_*.db 文件。
 */
export function findMessageDbPaths(dbStoragePath: string): string[] {
  const results: string[] = []
  function scan(dir: string, depth = 0): void {
    if (depth > 4) return
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry)
      let st: ReturnType<typeof statSync>
      try { st = statSync(full) } catch { continue }
      if (st.isFile()) {
        const lower = entry.toLowerCase()
        if ((lower.startsWith('msg_') || lower.startsWith('message_')) && lower.endsWith('.db')) {
          if (!results.includes(full)) results.push(full)
        }
      } else if (st.isDirectory()) {
        scan(full, depth + 1)
      }
    }
  }
  scan(dbStoragePath)
  return results
}

export function getMessageTableHash(sessionId: string): string {
  return createHash('md5').update(sessionId).digest('hex').toLowerCase()
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

export async function listAllMessageTables(dbPath: string): Promise<string[]> {
  const rows = await dbAdapter.all<{ name: string }>(
    'message',
    dbPath,
    "SELECT name FROM sqlite_master WHERE type='table' AND lower(name) LIKE 'msg_%'"
  )
  return rows.map(r => r.name)
}

export async function findSessionMessageTables(
  dbPaths: string[],
  sessionId: string
): Promise<MessageTablePair[]> {
  const targetHash = getMessageTableHash(sessionId)
  const pairs: MessageTablePair[] = []
  for (const dbPath of dbPaths) {
    let tables: string[] = []
    try { tables = await listExactMessageTables(dbPath) } catch { continue }
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
  let result = false
  try {
    const row = await dbAdapter.get<{ name: string }>(
      'message',
      dbPath,
      "SELECT name FROM sqlite_master WHERE type='table' AND name = 'Name2Id'"
    )
    result = !!row
  } catch { result = false }
  name2IdCache.set(dbPath, result)
  return result
}

export async function getMyRowId(dbPath: string, candidates: string[]): Promise<number | null> {
  const key = `${dbPath}:${candidates.join('|')}`
  const cached = myRowIdCache.get(key)
  if (cached !== undefined) return cached
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const row = await dbAdapter.get<{ rowid: number }>(
        'message',
        dbPath,
        'SELECT rowid FROM Name2Id WHERE user_name = ?',
        [candidate]
      )
      if (row?.rowid !== undefined && row.rowid !== null) {
        myRowIdCache.set(key, row.rowid)
        return row.rowid
      }
    } catch { /* ignore single-candidate failure */ }
  }
  myRowIdCache.set(key, null)
  return null
}

export async function getMessageTableColumns(dbPath: string, tableName: string): Promise<MessageTableColumns> {
  const cacheKey = `${dbPath}:${tableName}`
  const cached = columnCache.get(cacheKey)
  if (cached) return cached
  const rows = await dbAdapter.all<{ name: string }>(
    'message',
    dbPath,
    `PRAGMA table_info("${tableName}")`
  )
  const names = new Set(rows.map(r => r.name))
  const lower = new Map(rows.map(r => [r.name.toLowerCase(), r.name]))
  const find = (candidates: string[]): string | null => {
    for (const candidate of candidates) {
      const actual = lower.get(candidate.toLowerCase())
      if (actual) return actual
    }
    return null
  }
  const result: MessageTableColumns = {
    names,
    lower,
    contentColumn: find(['message_content', 'display_content', 'content', 'msg_content', 'str_content', 'strContent']),
    senderColumn: find(['real_sender', 'wxid_sender', 'sender', 'sender_username', 'talker', 'talker_id', 'src']),
    hasRealSenderId: names.has('real_sender_id'),
    hasIsSend: names.has('is_send') || lower.has('issend'),
    hasLocalType: names.has('local_type') || lower.has('localtype'),
    hasType: names.has('type'),
  }
  columnCache.set(cacheKey, result)
  return result
}

/**
 * 清除指定账号名称尾缀（例如 `wxid_abcd_efgh` -> `wxid_abcd`），用于 Name2Id 查找。
 */
export function cleanAccountDirName(name: string): string {
  const trimmed = (name || '').trim()
  if (!trimmed) return trimmed
  if (trimmed.toLowerCase().startsWith('wxid_')) {
    const match = trimmed.match(/^(wxid_[a-zA-Z0-9]+)/i)
    if (match) return match[1]
    return trimmed
  }
  const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
  if (suffixMatch) return suffixMatch[1]
  return trimmed
}
