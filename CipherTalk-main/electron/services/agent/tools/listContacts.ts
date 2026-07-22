/**
 * list_contacts —— 把人名/群名解析成 username（= 其它工具的 sessionId）。
 * 读原微信库 contact 表（经 dbAdapter，子进程内由 wcdb 代理转发到主进程）。
 */
import { tool } from 'ai'
import { z } from 'zod'

function classifyContact(username: unknown): 'group' | 'official' | 'person' {
  if (typeof username !== 'string') return 'person'
  if (username.endsWith('@chatroom')) return 'group'
  if (username.startsWith('gh_')) return 'official'
  return 'person'
}

export const listContacts = tool({
  description:
    '把人名/群名解析成 username（微信内部 id）。其它工具要限定"某个人/某个群"时，sessionId 填的就是这里返回的 username——所以先用本工具拿到 username，再去检索/读时间线。' +
    '传 query 按备注/微信昵称/群名模糊匹配；留空则列出一批联系人。' +
    '注意：这是查"联系人是谁"，不是查聊天内容；找聊天记录请用 search_messages / semantic_search。',
  inputSchema: z.object({
    query: z.string().optional().describe('人名/群名片段，匹配备注、微信昵称、群名、username。留空则列出一批联系人'),
    limit: z.number().int().min(1).max(50).default(20).describe('返回条数上限'),
  }),
  execute: async ({ query, limit }) => {
    try {
      const { dbAdapter } = await import('../../dbAdapter')
      // 不同微信版本列名有差异，先探测可用列
      const cols = await dbAdapter.all<{ name: string }>('contact', '', 'PRAGMA table_info(contact)')
      const colSet = new Set(cols.map((c) => c.name))
      if (!colSet.has('username')) return { error: '联系人表结构异常：缺少 username 列' }

      const selectCols = ['username', 'remark', 'nick_name', 'alias'].filter((c) => colSet.has(c))
      const q = String(query || '').trim()
      let sql: string
      let params: any[]
      if (q) {
        const likeCols = ['remark', 'nick_name', 'alias', 'username'].filter((c) => colSet.has(c))
        const where = likeCols.map((c) => `${c} LIKE ?`).join(' OR ')
        params = [...likeCols.map(() => `%${q}%`), limit]
        sql = `SELECT ${selectCols.join(', ')} FROM contact WHERE ${where} LIMIT ?`
      } else {
        sql = `SELECT ${selectCols.join(', ')} FROM contact LIMIT ?`
        params = [limit]
      }

      const rows = await dbAdapter.all<any>('contact', '', sql, params)
      return rows.map((row) => ({
        username: row.username,
        displayName: row.remark || row.nick_name || row.alias || row.username,
        kind: classifyContact(row.username),
      }))
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
})
