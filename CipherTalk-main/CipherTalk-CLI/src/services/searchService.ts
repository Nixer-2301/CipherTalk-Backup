import { statSync } from 'node:fs'
import { dbError } from '../errors.js'
import { dbAdapter } from './db/dbAdapter.js'
import { wcdbService } from './db/wcdbService.js'
import { findMessageDbPaths, resolveDbStoragePath } from './db/messageDbScanner.js'
import type { MessageRow, SearchResult } from './types.js'
import type { RuntimeConfig } from '../types.js'

async function buildSessionNameMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  try {
    const rows = await dbAdapter.all<{ username: string; nickname?: string; remark?: string }>(
      'session', '',
      'SELECT username, nickname, remark FROM SessionTable'
    )
    for (const row of rows) {
      const username = row.username || ''
      const name = row.remark || row.nickname || username
      if (username) map.set(username, name)
    }
  } catch { /* 非关键 */ }
  return map
}

async function ensureConnected(config: RuntimeConfig): Promise<string> {
  if (!config.dbPath) throw new Error('使用 --db-path 或 miyu init 设置微信数据目录')
  if (!config.keyHex) throw new Error('使用 --key 或 miyu key set 设置数据库密钥')

  const storagePath = resolveDbStoragePath(config.dbPath, config.wxid || '')
  if (!storagePath) throw dbError(`无法定位数据库目录 (db_storage): ${config.dbPath}`)

  const ok = await wcdbService.open(config.dbPath, config.keyHex, config.wxid || '')
  if (!ok) throw dbError('数据库连接失败，请检查 dbPath / keyHex / wxid')

  return storagePath
}

/**
 * 全文搜索微信消息。
 * 扫描 msg_*.db / message_*.db 中含有关键词的聊天记录。
 */
export async function searchMessages(
  config: RuntimeConfig,
  keyword: string,
  options: { session?: string; limit?: number; from?: string; to?: string } = {}
): Promise<SearchResult> {
  const limit = options.limit || 50

  try {
    const storagePath = await ensureConnected(config)
    const msgDbs = findMessageDbPaths(storagePath)
    if (msgDbs.length === 0) throw dbError(`未找到消息数据库 (msg_*.db): ${storagePath}`)
    if (msgDbs.length > 20) {
      // 消息库太多时只查最近的 20 个（按修改时间排序）
      msgDbs.sort((a, b) => {
        try { return statSync(b).mtimeMs - statSync(a).mtimeMs } catch { return 0 }
      })
    }

    const sessionNames = options.session ? new Map<string, string>() : await buildSessionNameMap()
    const allMessages: MessageRow[] = []

    // 关键词 LIKE 模式
    const pattern = `%${keyword}%`

    for (const dbPath of msgDbs) {
      if (allMessages.length >= limit) break
      try {
        const tables = await dbAdapter.all<{ name: string }>(
          'message', dbPath,
          "SELECT name FROM sqlite_master WHERE type='table' AND lower(name) LIKE 'msg_%'"
        )

        for (const { name: tableName } of tables) {
          if (allMessages.length >= limit) break

          const cols = await dbAdapter.all<{ name: string }>(
            'message', dbPath,
            `PRAGMA table_info("${tableName}")`
          )
          const colNames = cols.map(c => c.name.toLowerCase())
          const contentCol = colNames.includes('str_content') ? 'str_content'
            : colNames.includes('content') ? 'content'
            : colNames.includes('strcontent') ? 'strContent'
            : null
          if (!contentCol) continue

          // 若指定了会话 ID，按 talker/str_talker 过滤
          if (options.session) {
            const talkerCol = colNames.find(c => c === 'talker_id' || c === 'str_talker' || c === 'session_id')
            if (talkerCol) {
              const hashCheck = await dbAdapter.get<{ cnt: number }>(
                'message', dbPath,
                `SELECT COUNT(*) as cnt FROM "${tableName}" WHERE "${talkerCol}" LIKE ? LIMIT 1`,
                [`%${options.session}%`]
              )
              if (!hashCheck || hashCheck.cnt === 0) continue
            }
          }

          // 构建查询
          const timeClauses: string[] = []
          const timeParams: any[] = []
          if (options.from) { timeClauses.push('create_time >= ?'); timeParams.push(options.from) }
          if (options.to) { timeClauses.push('create_time < ?'); timeParams.push(options.to) }

          const condition = timeClauses.length > 0
            ? ` AND ${timeClauses.join(' AND ')}`
            : ''

          const sql = `SELECT * FROM "${tableName}" WHERE "${contentCol}" LIKE ?${condition} ORDER BY create_time DESC LIMIT ?`
          const params = [pattern, ...timeParams, limit - allMessages.length + 10]

          const result = await dbAdapter.all<Record<string, any>>('message', dbPath, sql, params)

          for (const row of result) {
            if (allMessages.length >= limit) break
            allMessages.push({
              localId: row.local_id || row.localId,
              createTime: row.create_time || row.createTime,
              sortSeq: row.sort_seq || row.sortSeq,
              direction: row.is_send === 1 || row.isSend === 1 ? 'out'
                : row.is_send === 0 || row.isSend === 0 ? 'in' : 'unknown',
              senderUsername: row.sender_username || row.senderUsername || row.talker_id || '',
              type: row.type || row.local_type || row.localType,
              content: String(row[contentCol] || row.str_content || row.strContent || row.content || ''),
              raw: row
            })
          }
        }
      } catch {
        // 单个 msg db 查询失败不终止
      }
    }

    const sessionId = options.session || ''
    return {
      sessionId,
      sessionName: options.session || '全部会话',
      messages: allMessages.slice(0, limit),
      total: allMessages.length
    }
  } catch (e) {
    throw dbError(`搜索失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}
