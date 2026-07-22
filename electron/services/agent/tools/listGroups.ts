/**
 * list_groups —— 列出群聊（按最近活跃排序），含成员数。读原微信库（经 wcdb 代理）。
 * 群 = SessionTable 里 username 以 @chatroom 结尾的会话；成员数走 chatroom_member。
 */
import { tool } from 'ai'
import { z } from 'zod'

export const listGroups = tool({
  description:
    '列出群聊（按最近活跃排序），含成员数。用于"我有哪些群 / 最近活跃的群 / 人多的群"。' +
    '返回的 username（以 @chatroom 结尾）可填进 group_members / group_member_ranking / get_timeline 的 sessionId。' +
    '要按名字找某个具体的群，也可以用 list_contacts。',
  inputSchema: z.object({
    limit: z.number().int().min(1).max(100).default(30).describe('返回群数量上限'),
  }),
  execute: async ({ limit }) => {
    try {
      const { dbAdapter } = await import('../../dbAdapter')
      const { resolveContactNames } = await import('../../contactNameResolver')
      const sessions = await dbAdapter.all<{ username: string; sort_timestamp?: number; last_timestamp?: number }>(
        'session',
        '',
        `SELECT username, sort_timestamp, last_timestamp FROM SessionTable
         WHERE username LIKE '%@chatroom' AND COALESCE(last_timestamp, sort_timestamp, 0) > 0
         ORDER BY COALESCE(sort_timestamp, last_timestamp, 0) DESC LIMIT ?`,
        [limit],
      )
      if (sessions.length === 0) return { groups: [] }

      const names = await resolveContactNames(sessions.map((s) => s.username))
      const groups = []
      for (const s of sessions) {
        let memberCount = 0
        try {
          const row = await dbAdapter.get<{ count: number }>(
            'contact',
            '',
            `SELECT COUNT(*) count FROM chatroom_member WHERE room_id = (SELECT rowid FROM name2id WHERE username = ?)`,
            [s.username],
          )
          memberCount = row?.count || 0
        } catch {
          /* 成员表缺失则计 0 */
        }
        groups.push({
          username: s.username,
          displayName: names.get(s.username)?.displayName || s.username,
          memberCount,
          lastTime: (s.sort_timestamp || s.last_timestamp || 0) * 1000 || null,
        })
      }
      return { groups }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
})
