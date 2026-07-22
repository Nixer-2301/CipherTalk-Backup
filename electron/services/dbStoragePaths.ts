import { existsSync, readdirSync, statSync } from 'fs'
import { basename, join } from 'path'
import { ConfigService } from './config'

let configService: ConfigService | null = null

function getConfigService(): ConfigService {
  if (!configService) configService = new ConfigService()
  return configService
}

/**
 * 把 configService 里保存的 dbPath 解析为 WeChat 原始 db_storage 根目录。
 * 逻辑与 wcdbCore.resolveDbStoragePath 一致：dbPath 可能是
 *   - 已经是 db_storage 本身
 *   - 账户根（下面有 db_storage）
 *   - 再上一层（需要拼 wxid/db_storage 或 <wxid_prefix>/db_storage）
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

/** 从配置直接取 db_storage；未配置或不存在返回 null */
export function getDbStoragePath(): string | null {
  const config = getConfigService()
  const dbPath = config.get('dbPath') as string | undefined
  const wxid = config.get('myWxid') as string | undefined
  if (!dbPath) return null
  return resolveDbStoragePath(dbPath, wxid || '')
}

function collectByName(root: string, matcher: (name: string) => boolean, depth = 0, acc: string[] = []): string[] {
  if (depth > 5) return acc
  let entries: string[]
  try { entries = readdirSync(root) } catch { return acc }
  for (const entry of entries) {
    const full = join(root, entry)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isFile()) {
      if (matcher(entry.toLowerCase()) && !acc.includes(full)) acc.push(full)
    } else if (st.isDirectory()) {
      collectByName(full, matcher, depth + 1, acc)
    }
  }
  return acc
}

function isMessageDbName(name: string): boolean {
  return /^(?:msg|message)_\d+\.db$/i.test(name)
}

function collectDirectFiles(root: string, matcher: (name: string) => boolean): string[] {
  const results: string[] = []
  let entries: string[]
  try { entries = readdirSync(root) } catch { return results }
  for (const entry of entries) {
    const full = join(root, entry)
    try {
      if (statSync(full).isFile() && matcher(entry.toLowerCase()) && !results.includes(full)) {
        results.push(full)
      }
    } catch { /* ignore */ }
  }
  return results
}

/** 返回所有消息库绝对路径（msg_*.db / message_*.db），过滤 -wal/-shm/-journal 等旁路文件 */
export function findMessageDbPaths(): string[] {
  const root = getDbStoragePath()
  if (!root) return []
  const fixedMessageDir = join(root, 'message')
  if (existsSync(fixedMessageDir)) {
    const direct = collectDirectFiles(fixedMessageDir, isMessageDbName)
    if (direct.length > 0) return direct
  }
  return collectByName(root, isMessageDbName)
}

/** 返回主 session.db 的绝对路径（若有多个按 db_storage 语义挑一个）。 */
export function findSessionDbPath(): string | null {
  const root = getDbStoragePath()
  if (!root) return null
  const candidates = collectByName(root, (name) => name === 'session.db')
  if (candidates.length === 0) return null
  candidates.sort((a, b) => scoreSession(b) - scoreSession(a) || a.localeCompare(b))
  return candidates[0]
}

function scoreSession(p: string): number {
  const n = p.replace(/\\/g, '/').toLowerCase()
  let s = 0
  if (n.endsWith('/session/session.db')) s += 40
  if (n.includes('/db_storage/session/')) s += 20
  if (n.includes('/db_storage/')) s += 10
  return s
}

/** 返回指定名称的数据库绝对路径（例如 contact.db / head_image.db / sns.db / emoticon.db / hardlink.db） */
export function findDbByName(dbName: string): string | null {
  const root = getDbStoragePath()
  if (!root) return null
  const lower = dbName.toLowerCase()
  const list = collectByName(root, (name) => name === lower)
  if (list.length === 0) return null
  list.sort((a, b) => a.length - b.length)
  return list[0]
}
