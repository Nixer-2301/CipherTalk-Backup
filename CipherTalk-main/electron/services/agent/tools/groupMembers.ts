/**
 * group_members —— 列出某群聊的成员（username + 显示名）。读原微信库 contact 库（经 wcdb 代理）。
 * 成员关系：chatroom_member.member_id → name2id.rowid → username，再 LEFT JOIN contact 取名称。
 */
import { tool } from 'ai'
import { z } from 'zod'

export const groupMembers = tool({
  description:
    '列出某个群聊的成员（username + 显示名），用于"这个群有哪些人 / 某人在不在群里 / 群有多少人"。' +
    'chatroomId 是群的 username（以 @chatroom 结尾，可用 list_groups / list_contacts 拿到）。',
  inputSchema: z.object({
    chatroomId: z.string().describe('群 username，以 @chatroom 结尾'),
    limit: z.number().int().min(1).max(1000).default(500).describe('返回成员上限'),
  }),
  execute: async ({ chatroomId, limit }) => {
    try {
      const { dbAdapter } = await import('../../dbAdapter')
      const rows = await dbAdapter.all<{ username: string; nick_name?: string; remark?: string; alias?: string }>(
        'contact',
        '',
        `SELECT n.username, c.nick_name, c.remark, c.alias
         FROM chatroom_member m
         JOIN name2id n ON m.member_id = n.rowid
         LEFT JOIN contact c ON n.username = c.username
         WHERE m.room_id = (SELECT rowid FROM name2id WHERE username = ?)`,
        [chatroomId],
      )
      const members = rows.slice(0, limit).map((r) => ({
        username: r.username,
        displayName: r.remark || r.nick_name || r.alias || r.username,
      }))
      return { chatroomId, memberCount: rows.length, members }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
})
