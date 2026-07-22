import { dbAdapter } from './dbAdapter'

export interface GroupMemberMetadata {
  username: string
  displayName: string
  avatarUrl?: string
}

class GroupMetadataService {
  private async hasGroupMemberTables(): Promise<boolean> {
    const tables = await dbAdapter.all<{ name: string }>(
      'contact',
      '',
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('chatroom_member', 'name2id')"
    )
    const names = new Set(tables.map((table) => table.name))
    return names.has('chatroom_member') && names.has('name2id')
  }

  async getMemberCountMap(chatroomIds: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>()
    const uniqueIds = Array.from(new Set(chatroomIds.filter(Boolean)))
    if (uniqueIds.length === 0) return result

    try {
      if (!await this.hasGroupMemberTables()) return result

      for (const chatroomId of uniqueIds) {
        try {
          const row = await dbAdapter.get<{ count: number }>(
            'contact',
            '',
            `SELECT COUNT(*) as count FROM chatroom_member
             WHERE room_id = (SELECT rowid FROM name2id WHERE username = ?)`,
            [chatroomId]
          )
          result.set(chatroomId, row?.count || 0)
        } catch (error) {
          console.warn('[GroupMetadataService] Failed to read group member count:', chatroomId, error)
        }
      }
    } catch (error) {
      console.warn('[GroupMetadataService] Failed to inspect group member tables:', error)
    }

    return result
  }

  async getGroupMembers(chatroomId: string): Promise<GroupMemberMetadata[]> {
    if (!chatroomId) return []

    try {
      if (!await this.hasGroupMemberTables()) return []

      const rows = await dbAdapter.all<{
        username: string
        nick_name?: string
        remark?: string
        alias?: string
        small_head_url?: string
        big_head_url?: string
      }>(
        'contact',
        '',
        `SELECT n.username, c.nick_name, c.remark, c.alias, c.small_head_url, c.big_head_url
         FROM chatroom_member m
         JOIN name2id n ON m.member_id = n.rowid
         LEFT JOIN contact c ON n.username = c.username
         WHERE m.room_id = (SELECT rowid FROM name2id WHERE username = ?)`,
        [chatroomId]
      )

      return rows.map((row) => ({
        username: row.username,
        displayName: row.remark || row.nick_name || row.alias || row.username,
        avatarUrl: row.big_head_url || row.small_head_url || undefined
      }))
    } catch (error) {
      console.warn('[GroupMetadataService] Failed to read group members:', chatroomId, error)
      return []
    }
  }

  async getGroupMembersByUsernames(chatroomId: string, usernames: string[]): Promise<GroupMemberMetadata[]> {
    if (!chatroomId) return []
    const uniqueUsernames = Array.from(new Set(usernames.map(item => String(item || '').trim()).filter(Boolean)))
    if (uniqueUsernames.length === 0) return []

    try {
      if (!await this.hasGroupMemberTables()) return []

      const members: GroupMemberMetadata[] = []
      for (let i = 0; i < uniqueUsernames.length; i += 400) {
        const batch = uniqueUsernames.slice(i, i + 400)
        const placeholders = batch.map(() => '?').join(',')
        const rows = await dbAdapter.all<{
          username: string
          nick_name?: string
          remark?: string
          alias?: string
          small_head_url?: string
          big_head_url?: string
        }>(
          'contact',
          '',
          `SELECT n.username, c.nick_name, c.remark, c.alias, c.small_head_url, c.big_head_url
           FROM chatroom_member m
           JOIN name2id n ON m.member_id = n.rowid
           LEFT JOIN contact c ON n.username = c.username
           WHERE m.room_id = (SELECT rowid FROM name2id WHERE username = ?)
             AND n.username IN (${placeholders})`,
          [chatroomId, ...batch]
        )

        members.push(...rows.map((row) => ({
          username: row.username,
          displayName: row.remark || row.nick_name || row.alias || row.username,
          avatarUrl: row.big_head_url || row.small_head_url || undefined
        })))
      }

      return members
    } catch (error) {
      console.warn('[GroupMetadataService] Failed to read selected group members:', chatroomId, error)
      return []
    }
  }
}

export const groupMetadataService = new GroupMetadataService()
