import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { configMissing, dbError } from '../errors.js'
import { getNativeRoot } from '../runtimePaths.js'
import { dbAdapter } from './db/dbAdapter.js'
import { wcdbService } from './db/wcdbService.js'
import type { ContactRow, DataService, MessageRow, SessionRow, StatusData } from './types.js'
import type { RuntimeConfig } from '../types.js'

function scanDbFiles(root: string | undefined, depth = 0): number {
  if (!root || !existsSync(root) || depth > 5) return 0
  let count = 0
  for (const entry of readdirSync(root)) {
    const fullPath = join(root, entry)
    try {
      const stat = statSync(fullPath)
      if (stat.isDirectory()) count += scanDbFiles(fullPath, depth + 1)
      else if (/\.(db|sqlite)$/i.test(entry) || /^(MSG|MicroMsg|Session|Contact).*$/i.test(entry)) count += 1
    } catch {
      // Ignore unreadable files while scanning status.
    }
  }
  return count
}

function requireConnectionConfig(config: RuntimeConfig): { dbPath: string; keyHex: string; wxid: string } {
  if (!config.dbPath) throw configMissing('dbPath', '使用 --db-path、MIYU_DB_PATH 或 miyu init 写入配置')
  if (!config.keyHex) throw configMissing('keyHex', '使用 --key、MIYU_KEY_HEX 或 miyu key set 写入配置')
  return { dbPath: config.dbPath, keyHex: config.keyHex, wxid: config.wxid || '' }
}

async function connect(config: RuntimeConfig): Promise<void> {
  const { dbPath, keyHex, wxid } = requireConnectionConfig(config)
  const ok = await wcdbService.open(dbPath, keyHex, wxid)
  if (!ok) throw dbError('数据库连接失败，请检查 dbPath/keyHex/wxid')
}

function sessionType(username: string): SessionRow['type'] {
  if (username.includes('@chatroom')) return 'group'
  if (username.startsWith('gh_')) return 'mp'
  if (username) return 'private'
  return 'other'
}

function contactType(username: string, localType?: number, quanPin?: string): ContactRow['type'] {
  if (username.includes('@chatroom')) return 'group'
  if (username.startsWith('gh_')) return 'mp'
  if (localType === 1) return 'friend'
  if (localType === 0 && quanPin) return 'former_friend'
  return 'other'
}

function pickContent(row: Record<string, any>): string {
  return String(row.summary || row.digest || row.content || row.str_content || row.strContent || row.message || '')
}

export class WcdbDataService implements DataService {
  async getStatus(config: RuntimeConfig): Promise<StatusData> {
    const databaseFiles = scanDbFiles(config.dbPath)
    const status: StatusData = {
      configured: Boolean(config.dbPath && config.keyHex),
      configPath: config.configPath,
      dbPath: config.dbPath,
      wxid: config.wxid,
      nativeRoot: getNativeRoot(),
      databaseFiles
    }

    if (config.dbPath && config.keyHex) {
      const result = await wcdbService.testConnection(config.dbPath, config.keyHex, config.wxid || '')
      status.connection = {
        attempted: true,
        ok: result.success,
        sessionCount: result.sessionCount,
        error: result.error
      }
    }

    return status
  }

  async listSessions(config: RuntimeConfig, options: { type?: string; limit: number; offset?: number }): Promise<{ sessions: SessionRow[]; hasMore: boolean }> {
    await connect(config)
    const tables = await dbAdapter.all<{ name: string }>('session', '', "SELECT name FROM sqlite_master WHERE type='table'")
    const tableName = ['SessionTable', 'Session', 'session'].find((candidate) => tables.some((table) => table.name === candidate))
    if (!tableName) throw dbError('未找到会话表')

    const limit = Math.max(1, Math.min(options.limit, 1000))
    const rows = await dbAdapter.all<Record<string, any>>(
      'session',
      '',
      `SELECT * FROM ${tableName} ORDER BY sort_timestamp DESC LIMIT ? OFFSET ?`,
      [limit + 1, options.offset || 0]
    )

    const sessions = rows.slice(0, limit)
      .map((row): SessionRow => {
        const sessionId = row.username || row.user_name || row.userName || ''
        const type = sessionType(sessionId)
        return {
          sessionId,
          displayName: sessionId,
          type,
          lastMessage: pickContent(row),
          lastTime: Number(row.last_timestamp || row.lastTimestamp || row.sort_timestamp || row.sortTimestamp || 0)
        }
      })
      .filter((session) => session.sessionId && (!options.type || session.type === options.type))

    return { sessions, hasMore: rows.length > limit }
  }

  async getMessages(config: RuntimeConfig, session: string, options: { limit: number; offset?: number; from?: string; to?: string; type?: string; direction?: string; cursor?: string }): Promise<{ messages: MessageRow[]; cursor: string | null }> {
    await connect(config)
    const offset = options.cursor ? Number(options.cursor) || 0 : options.offset || 0
    const result = await wcdbService.getNativeMessages(session, options.limit, offset)
    if (!result.success) throw dbError(result.error || '消息查询失败')

    let messages = (result.rows || []).map((row: Record<string, any>): MessageRow => ({
      localId: row.local_id || row.localId,
      serverId: row.server_id || row.serverId,
      createTime: row.create_time || row.createTime,
      sortSeq: row.sort_seq || row.sortSeq,
      direction: row.is_send === 1 || row.isSend === 1 ? 'out' : row.is_send === 0 || row.isSend === 0 ? 'in' : 'unknown',
      senderUsername: row.sender_username || row.senderUsername,
      type: row.type || row.local_type || row.localType,
      content: String(row.parsedContent || row.parsed_content || row.content || row.str_content || ''),
      raw: row
    }))

    if (options.direction) messages = messages.filter((message) => message.direction === options.direction)
    if (options.type) messages = messages.filter((message) => String(message.type) === options.type)

    return {
      messages,
      cursor: messages.length >= options.limit ? String(offset + messages.length) : null
    }
  }

  async listContacts(config: RuntimeConfig, options: { type?: string; limit: number }): Promise<{ contacts: ContactRow[] }> {
    await connect(config)
    const columns = await dbAdapter.all<{ name: string }>('contact', '', 'PRAGMA table_info(contact)')
    const columnNames = new Set(columns.map((column) => column.name))
    const selectCols = ['username', 'remark', 'nick_name', 'alias', 'quan_pin', 'flag']
    if (columnNames.has('big_head_url')) selectCols.push('big_head_url')
    if (columnNames.has('small_head_url')) selectCols.push('small_head_url')
    if (columnNames.has('local_type')) selectCols.push('local_type')

    const rows = await dbAdapter.all<Record<string, any>>('contact', '', `SELECT ${selectCols.join(', ')} FROM contact`)
    const contacts = rows
      .map((row): ContactRow => {
        const wxid = row.username || ''
        return {
          wxid,
          displayName: row.remark || row.nick_name || row.alias || wxid,
          type: contactType(wxid, row.local_type, row.quan_pin),
          remark: row.remark || undefined,
          nickname: row.nick_name || undefined,
          avatarUrl: row.big_head_url || row.small_head_url || undefined
        }
      })
      .filter((contact) => contact.wxid && contact.type !== 'other' && (!options.type || contact.type === options.type))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN'))
      .slice(0, options.limit)

    return { contacts }
  }

  async getContactInfo(config: RuntimeConfig, contact: string): Promise<ContactRow | null> {
    const { contacts } = await this.listContacts(config, { limit: 10000 })
    return contacts.find((item) => item.wxid === contact || item.displayName.includes(contact) || item.remark?.includes(contact) || item.nickname?.includes(contact)) || null
  }
}

export const dataService = new WcdbDataService()
