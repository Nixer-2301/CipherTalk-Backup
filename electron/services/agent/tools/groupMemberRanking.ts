/**
 * group_member_ranking —— 群内成员发言排行（按消息数）。读原微信库（经 wcdb 代理）。
 * 群消息发送者经每个 message 库的 Name2Id 把 real_sender_id 映射回 user_name；
 * 旧版无 Name2Id 时回退按 senderColumn 分组。复用 messageDbScanner / statsSqlHelpers。
 */
import { tool } from 'ai'
import { z } from 'zod'
import type { TimeRangeSec } from '../../statsSqlHelpers'

/** 单张群消息表的逐发送者计数（照搬被删 groupAnalyticsService.getSenderCounts 范式）。 */
async function senderCounts(dbPath: string, tableName: string, range: TimeRangeSec): Promise<Array<{ sender: string; count: number }>> {
  const { getMessageTableColumns, hasName2IdTable } = await import('../../messageDbScanner')
  const { buildMessageStatsWhere } = await import('../../statsSqlHelpers')
  const { dbAdapter } = await import('../../dbAdapter')

  const columns = await getMessageTableColumns(dbPath, tableName)
  const hasName2Id = await hasName2IdTable(dbPath)

  if (hasName2Id && columns.hasRealSenderId) {
    const where = buildMessageStatsWhere({ alias: 'm', range, contentColumn: columns.contentColumn || undefined })
    return dbAdapter.all<{ sender: string; count: number }>(
      'message',
      dbPath,
      `SELECT n.user_name as sender, COUNT(*) as count
       FROM "${tableName}" m JOIN Name2Id n ON m.real_sender_id = n.rowid
       ${where.sql} GROUP BY m.real_sender_id`,
      where.params,
    )
  }

  if (columns.senderColumn) {
    const where = buildMessageStatsWhere({ range, contentColumn: columns.contentColumn || undefined })
    const prefix = where.sql ? `${where.sql} AND` : 'WHERE'
    return dbAdapter.all<{ sender: string; count: number }>(
      'message',
      dbPath,
      `SELECT "${columns.senderColumn}" as sender, COUNT(*) as count
       FROM "${tableName}"
       ${prefix} "${columns.senderColumn}" IS NOT NULL AND "${columns.senderColumn}" != ''
       GROUP BY "${columns.senderColumn}"`,
      where.params,
    )
  }

  return []
}

export const groupMemberRanking = tool({
  description:
    '群内成员发言排行（按消息条数），回答"群里谁最活跃 / 谁发言最多 / 潜水的有谁"。' +
    'chatroomId 是群的 username（以 @chatroom 结尾，可用 list_groups / list_contacts 拿到）。可加时间范围。' +
    '注意：这是"群内逐成员"统计；跨会话/私聊排行用 chat_stats 的 ranking。',
  inputSchema: z.object({
    chatroomId: z.string().describe('群 username，以 @chatroom 结尾'),
    startTimeMs: z.number().optional().describe('起始时间，毫秒时间戳'),
    endTimeMs: z.number().optional().describe('结束时间，毫秒时间戳'),
    limit: z.number().int().min(1).max(50).default(20).describe('返回排行条数'),
  }),
  execute: async ({ chatroomId, startTimeMs, endTimeMs, limit }) => {
    try {
      const { findSessionMessageTables } = await import('../../messageDbScanner')
      const { normalizeTimeRange } = await import('../../statsSqlHelpers')
      const { resolveContactNames } = await import('../../contactNameResolver')

      const range = normalizeTimeRange(startTimeMs, endTimeMs)
      const counts = new Map<string, number>()
      let partialFailures = 0

      for (const pair of await findSessionMessageTables(chatroomId)) {
        try {
          for (const { sender, count } of await senderCounts(pair.dbPath, pair.tableName, range)) {
            const n = Number(count || 0)
            if (sender && n > 0) counts.set(sender, (counts.get(sender) || 0) + n)
          }
        } catch {
          partialFailures += 1
        }
      }

      if (counts.size === 0) {
        return { chatroomId, rankings: [], note: '没统计到发言（群可能未加载，或 chatroomId 不是群）', ...(partialFailures ? { partialFailures } : {}) }
      }

      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
      const names = await resolveContactNames(top.map(([u]) => u))
      return {
        chatroomId,
        rankings: top.map(([username, messageCount]) => ({
          username,
          displayName: names.get(username)?.displayName || username,
          messageCount,
        })),
        ...(partialFailures ? { partialFailures } : {}),
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
})
