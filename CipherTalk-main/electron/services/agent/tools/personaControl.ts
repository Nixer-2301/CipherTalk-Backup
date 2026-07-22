/**
 * persona_control —— AI 助手里的数字分身控制工具。
 *
 * 工具运行在 AI utility process，不能直接打开窗口或触发主进程长任务；
 * 因此它只做联系人解析/状态判断，并返回前端可执行的 action。
 */
import { tool } from 'ai'
import { z } from 'zod'

type ContactKind = 'person' | 'group' | 'official'

function classifyContact(username: unknown): ContactKind {
  const id = String(username || '')
  if (id.endsWith('@chatroom')) return 'group'
  if (id.startsWith('gh_')) return 'official'
  return 'person'
}

function affirmativeText(text: string): boolean {
  const normalized = text.replace(/\s+/g, '').trim()
  return /^(确定|确认|可以|好|好的|行|开始|开吧|克隆|克隆吧|向量化|建立|继续|yes|y|ok|sure)$/i.test(normalized)
    || /(?:确定|确认|可以|开始|克隆|向量化|建立|继续).{0,6}(?:吧|一下|数字分身|语义索引)?$/i.test(normalized)
}

async function searchContacts(query: string, limit = 8) {
  const { dbAdapter } = await import('../../dbAdapter')
  const cols = await dbAdapter.all<{ name: string }>('contact', '', 'PRAGMA table_info(contact)')
  const colSet = new Set(cols.map((c) => c.name))
  if (!colSet.has('username')) return []
  const selectCols = ['username', 'remark', 'nick_name', 'alias'].filter((c) => colSet.has(c))
  const likeCols = ['remark', 'nick_name', 'alias', 'username'].filter((c) => colSet.has(c))
  if (likeCols.length === 0) return []
  const q = query.trim()
  const rows = await dbAdapter.all<any>(
    'contact',
    '',
    `SELECT ${selectCols.join(', ')} FROM contact WHERE ${likeCols.map((c) => `${c} LIKE ?`).join(' OR ')} LIMIT ?`,
    [...likeCols.map(() => `%${q}%`), Math.max(1, Math.min(20, limit))],
  )
  const seen = new Set<string>()
  return rows
    .map((row) => {
      const username = String(row.username || '').trim()
      return {
        username,
        displayName: String(row.remark || row.nick_name || row.alias || username).trim() || username,
        kind: classifyContact(username),
      }
    })
    .filter((item) => {
      if (!item.username || item.kind !== 'person' || seen.has(item.username)) return false
      seen.add(item.username)
      return true
    })
    .sort((a, b) => {
      const rank = (item: { username: string; displayName: string }) => {
        if (item.displayName === q || item.username === q) return 0
        if (item.displayName.startsWith(q) || item.username.startsWith(q)) return 1
        return 2
      }
      return rank(a) - rank(b) || a.displayName.localeCompare(b.displayName, 'zh-CN')
    })
    .slice(0, limit)
}

export const personaControl = tool({
  description:
    '控制数字分身/克隆好友流程。用户要求打开某人的数字分身、克隆某人、进入分身聊天、建立语义索引，或对上一轮克隆/向量化询问做肯定确认时使用。' +
    '本工具会解析联系人、检查数字分身是否存在，并返回需要应用执行的动作。',
  inputSchema: z.object({
    action: z.enum(['open', 'prepare_build', 'confirm_build', 'vectorize']).describe(
      'open=打开某人的数字分身；prepare_build=还没有分身时询问是否克隆；confirm_build=用户已确认克隆；vectorize=用户明确要求向量化/建立语义索引',
    ),
    query: z.string().optional().describe('联系人名/备注/昵称/微信号。open/prepare_build/vectorize 通常需要'),
    sessionId: z.string().optional().describe('上一轮工具输出给出的联系人 username；confirm_build 优先传这个'),
    displayName: z.string().optional().describe('联系人显示名；confirm_build 可沿用上一轮工具输出'),
    confirmationText: z.string().optional().describe('用户本轮确认文本；confirm_build 时用于判断是否为肯定'),
  }),
  execute: async ({ action, query, sessionId, displayName, confirmationText }) => {
    try {
      if (action === 'confirm_build' && confirmationText && !affirmativeText(confirmationText)) {
        return { success: false, error: '用户没有明确确认克隆' }
      }

      let targetSessionId = String(sessionId || '').trim()
      let targetDisplayName = String(displayName || '').trim()
      let candidates: Array<{ username: string; displayName: string; kind: ContactKind }> = []

      if (!targetSessionId) {
        const q = String(query || '').trim()
        if (!q) return { success: false, error: '缺少联系人名称' }
        candidates = await searchContacts(q)
        if (candidates.length === 0) return { success: false, error: `没有找到「${q}」对应的好友` }
        if (candidates.length > 1) {
          return {
            success: true,
            status: 'ambiguous',
            query: q,
            candidates,
            message: `找到多个「${q}」，请让用户指定更准确的备注、昵称或微信号。`,
          }
        }
        targetSessionId = candidates[0].username
        targetDisplayName = candidates[0].displayName
      }

      const { personaStore } = await import('../persona/personaStore')
      const persona = personaStore.get(targetSessionId)

      if (action === 'open') {
        if (persona) {
          return {
            success: true,
            status: 'exists',
            action: 'open_persona_chat',
            sessionId: persona.sessionId,
            displayName: persona.displayName,
            message: `已找到「${persona.displayName}」的数字分身，正在打开。`,
          }
        }
        return {
          success: true,
          status: 'missing',
          action: 'ask_persona_build',
          sessionId: targetSessionId,
          displayName: targetDisplayName || targetSessionId,
          message: `还没有「${targetDisplayName || targetSessionId}」的数字分身。请询问用户是否现在克隆。`,
        }
      }

      if (action === 'prepare_build') {
        return {
          success: true,
          status: persona ? 'exists' : 'missing',
          action: persona ? 'open_persona_chat' : 'ask_persona_build',
          sessionId: persona?.sessionId || targetSessionId,
          displayName: persona?.displayName || targetDisplayName || targetSessionId,
          message: persona
            ? `「${persona.displayName}」的数字分身已存在，可以直接打开。`
            : `还没有「${targetDisplayName || targetSessionId}」的数字分身。请询问用户是否现在克隆。`,
        }
      }

      if (action === 'vectorize') {
        return {
          success: true,
          status: 'ready',
          action: 'build_session_vectors',
          sessionId: targetSessionId,
          displayName: targetDisplayName || targetSessionId,
          message: `准备为「${targetDisplayName || targetSessionId}」建立语义索引。`,
        }
      }

      return {
        success: true,
        status: persona ? 'exists' : 'ready',
        action: 'build_persona',
        sessionId: targetSessionId,
        displayName: targetDisplayName || persona?.displayName || targetSessionId,
        message: `准备克隆「${targetDisplayName || persona?.displayName || targetSessionId}」的数字分身。`,
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },
})
