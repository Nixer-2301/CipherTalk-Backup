import * as path from 'path'
import { dbAdapter } from '../dbAdapter'
import { getMessageTableColumns } from '../messageDbScanner'
import { buildMessageStatsWhere, quoteIdent, recordStatsError } from '../statsSqlHelpers'
import type { StatsPartialError } from '../statsConstants'
import { findSessionTables } from './tableResolver'
import { getAvatarFromHeadImageDb } from './contactQueries'
import type { ChatServiceState } from './state'

/**
 * 获取会话详情信息
 */
export async function getSessionDetail(state: ChatServiceState, sessionId: string): Promise<{
  success: boolean
  detail?: {
    wxid: string
    displayName: string
    remark?: string
    nickName?: string
    alias?: string
    avatarUrl?: string
    messageCount: number
    firstMessageTime?: number
    latestMessageTime?: number
    messageTables: { dbName: string; tableName: string; count: number }[]
    errors?: StatsPartialError[]
    partialFailureCount?: number
  }
  error?: string
}> {
  try {
    // 获取联系人信息
    let displayName = sessionId
    let remark: string | undefined
    let nickName: string | undefined
    let alias: string | undefined
    let avatarUrl: string | undefined

    try {
      if (!state.contactColumnsCache) {
        const columns = await dbAdapter.all<any>('contact', '', "PRAGMA table_info(contact)")
        const columnNames = columns.map((c: any) => c.name)

        const hasBigHeadUrl = columnNames.includes('big_head_url')
        const hasSmallHeadUrl = columnNames.includes('small_head_url')
        const hasExtraBuffer = columnNames.includes('extra_buffer')

        const selectCols = ['username', 'remark', 'nick_name', 'alias']
        if (hasBigHeadUrl) selectCols.push('big_head_url')
        if (hasSmallHeadUrl) selectCols.push('small_head_url')
        if (hasExtraBuffer) selectCols.push('extra_buffer')
        if (columnNames.includes('flag')) selectCols.push('flag')

        state.contactColumnsCache = { hasBigHeadUrl, hasSmallHeadUrl, hasExtraBuffer, selectCols }
      }

      const { hasBigHeadUrl, hasSmallHeadUrl, selectCols } = state.contactColumnsCache

      const contact = await dbAdapter.get<any>(
        'contact',
        '',
        `SELECT ${selectCols.join(', ')} FROM contact WHERE username = ?`,
        [sessionId]
      )

      if (contact) {
        remark = contact.remark || undefined
        nickName = contact.nick_name || undefined
        alias = contact.alias || undefined
        displayName = remark || nickName || alias || sessionId

        if (hasBigHeadUrl && contact.big_head_url) {
          avatarUrl = contact.big_head_url
        } else if (hasSmallHeadUrl && contact.small_head_url) {
          avatarUrl = contact.small_head_url
        }

        if (!avatarUrl) {
          avatarUrl = await getAvatarFromHeadImageDb(state, sessionId)
        }
      }
    } catch { }

    if (!avatarUrl) {
      avatarUrl = await getAvatarFromHeadImageDb(state, sessionId)
    }

    // 查找所有包含该会话消息的数据库和表
    const dbTablePairs = await findSessionTables(state, sessionId)
    const messageTables: { dbName: string; tableName: string; count: number }[] = []
    let totalMessageCount = 0
    let firstMessageTime: number | undefined
    let latestMessageTime: number | undefined
    const errors: StatsPartialError[] = []

    for (const { tableName, dbPath } of dbTablePairs) {
      try {
        const columns = await getMessageTableColumns(dbPath, tableName)
        const where = buildMessageStatsWhere({ contentColumn: columns.contentColumn || undefined })
        const safeTable = quoteIdent(tableName)

        // 获取消息数量（排除系统消息 / 撤回 / 拍一拍 / 空内容）
        const countResult = await dbAdapter.get<any>(
          'message',
          dbPath,
          `SELECT COUNT(*) as count FROM ${safeTable} ${where.sql}`,
          where.params
        )
        const count = Number(countResult?.count ?? 0)
        totalMessageCount += count

        // 获取时间范围
        const timeResult = await dbAdapter.get<any>(
          'message',
          dbPath,
          `SELECT MIN(create_time) as first_time, MAX(create_time) as last_time
           FROM ${safeTable} ${where.sql}`,
          where.params
        )

        if (timeResult) {
          if (timeResult.first_time !== null && timeResult.first_time !== undefined && timeResult.first_time > 0) {
            if (firstMessageTime === undefined || timeResult.first_time < firstMessageTime) {
              firstMessageTime = timeResult.first_time
            }
          }
          if (timeResult.last_time !== null && timeResult.last_time !== undefined && timeResult.last_time > 0) {
            if (latestMessageTime === undefined || timeResult.last_time > latestMessageTime) {
              latestMessageTime = timeResult.last_time
            }
          }
        }

        messageTables.push({
          dbName: path.basename(dbPath),
          tableName,
          count
        })
      } catch (e) {
        recordStatsError(errors, e, { dbPath, tableName, prefix: '[ChatService][SessionDetail]' })
      }
    }

    const extra = errors.length > 0
      ? { errors, partialFailureCount: errors.length }
      : {}

    return {
      success: true,
      detail: {
        wxid: sessionId,
        displayName,
        remark,
        nickName,
        alias,
        avatarUrl,
        messageCount: totalMessageCount,
        firstMessageTime,
        latestMessageTime,
        messageTables,
        ...extra,
      }
    }
  } catch (e) {
    console.error('ChatService: 获取会话详情失败:', e)
    return { success: false, error: String(e) }
  }
}
