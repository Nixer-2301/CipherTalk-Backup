/**
 * chat_stats —— 纯 SQL 统计（数量/排名/频率），不靠检索去数。
 * 复用现有 stats helper（statsSqlHelpers / messageDbScanner / statsConstants），读原微信库（经 wcdb 代理）。
 *
 * 性能：原始消息按"多个 message 库 × 每会话一张 msg_ 表"分片。为压低代理 IPC 跳数，
 * 每个库把多张表用 UNION ALL 合成一条查询（按 200 张分批，避开 SQLite 复合 SELECT 上限）。
 */
import { tool } from 'ai'
import { z } from 'zod'
import { dbAdapter } from '../../dbAdapter'
import {
  extractExactMessageTableHash,
  findSessionMessageTables,
  getMessageTableHash,
  listExactMessageTables,
} from '../../messageDbScanner'
import { findMessageDbPaths } from '../../dbStoragePaths'
import { resolveContactNames } from '../../contactNameResolver'
import { buildMessageStatsWhere, normalizeTimeRange, quoteIdent, type TimeRangeSec } from '../../statsSqlHelpers'
import {
  SYSTEM_USERNAME_CONTAINS,
  SYSTEM_USERNAME_EXACT,
  SYSTEM_USERNAME_PREFIXES,
  TEXT_LOCAL_TYPES,
} from '../../statsConstants'

const CHUNK = 200
const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function sqlLiteral(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** 把单库内的多张表合成 UNION ALL 子查询。innerCols 不含表标签；labelTable 时额外加 `<lit> AS tbl`。 */
function buildUnion(
  tables: string[],
  innerCols: string,
  where: { sql: string; params: unknown[] },
  labelTable = false,
): { sql: string; params: unknown[] } {
  const parts: string[] = []
  const params: unknown[] = []
  for (const t of tables) {
    const label = labelTable ? `${sqlLiteral(t)} AS tbl, ` : ''
    parts.push(`SELECT ${label}${innerCols} FROM ${quoteIdent(t)} ${where.sql}`)
    params.push(...where.params)
  }
  return { sql: parts.join(' UNION ALL '), params }
}

/** 探测某库的 msg 表是否有 is_send 列（不同版本有差异）。 */
async function hasIsSend(dbPath: string, sampleTable: string): Promise<boolean> {
  try {
    const cols = await dbAdapter.all<{ name: string }>('message', dbPath, `PRAGMA table_info(${quoteIdent(sampleTable)})`)
    return cols.some((c) => c.name === 'is_send')
  } catch {
    return false
  }
}

/** 收集要统计的 (dbPath, tables)。给 sessionId 则只取该会话的表，否则全量。 */
async function collectScope(sessionId?: string): Promise<Array<{ dbPath: string; tables: string[] }>> {
  if (sessionId) {
    const pairs = await findSessionMessageTables(sessionId)
    const byDb = new Map<string, string[]>()
    for (const p of pairs) {
      const list = byDb.get(p.dbPath) || []
      list.push(p.tableName)
      byDb.set(p.dbPath, list)
    }
    return [...byDb].map(([dbPath, tables]) => ({ dbPath, tables }))
  }
  const result: Array<{ dbPath: string; tables: string[] }> = []
  for (const dbPath of findMessageDbPaths()) {
    const tables = await listExactMessageTables(dbPath)
    if (tables.length > 0) result.push({ dbPath, tables })
  }
  return result
}

function isPrivateSession(username: string): boolean {
  const u = String(username || '').trim().toLowerCase()
  if (!u || u.includes('@chatroom')) return false
  if (SYSTEM_USERNAME_EXACT.has(u)) return false
  if (SYSTEM_USERNAME_PREFIXES.some((p) => u.startsWith(p))) return false
  if (SYSTEM_USERNAME_CONTAINS.some((p) => u.includes(p))) return false
  return true
}

// ========= 三种统计 =========

async function runOverview(scope: Array<{ dbPath: string; tables: string[] }>, range: TimeRangeSec) {
  const where = buildMessageStatsWhere({ range })
  const tt = TEXT_LOCAL_TYPES.map(() => '?').join(',')
  const acc = {
    total: 0, text: 0, image: 0, voice: 0, video: 0, emoji: 0, sent: 0, received: 0,
    firstTime: null as number | null, lastTime: null as number | null,
  }
  const activeDays = new Set<string>()
  let partialFailures = 0

  for (const { dbPath, tables } of scope) {
    const withIsSend = await hasIsSend(dbPath, tables[0])
    const sendCol = withIsSend ? 'is_send' : 'NULL AS is_send'
    for (const batch of chunk(tables, CHUNK)) {
      try {
        const union = buildUnion(batch, `local_type, ${sendCol}, create_time`, where)
        const row = await dbAdapter.get<any>(
          'message',
          dbPath,
          `SELECT COUNT(*) total,
            SUM(CASE WHEN local_type IN (${tt}) THEN 1 ELSE 0 END) text_count,
            SUM(CASE WHEN local_type = 3 THEN 1 ELSE 0 END) image_count,
            SUM(CASE WHEN local_type = 34 THEN 1 ELSE 0 END) voice_count,
            SUM(CASE WHEN local_type = 43 THEN 1 ELSE 0 END) video_count,
            SUM(CASE WHEN local_type = 47 THEN 1 ELSE 0 END) emoji_count,
            SUM(CASE WHEN is_send = 1 THEN 1 ELSE 0 END) sent_count,
            SUM(CASE WHEN is_send = 0 THEN 1 ELSE 0 END) received_count,
            MIN(create_time) first_time, MAX(create_time) last_time
           FROM (${union.sql})`,
          [...TEXT_LOCAL_TYPES, ...union.params],
        )
        if (row) {
          acc.total += row.total || 0
          acc.text += row.text_count || 0
          acc.image += row.image_count || 0
          acc.voice += row.voice_count || 0
          acc.video += row.video_count || 0
          acc.emoji += row.emoji_count || 0
          acc.sent += row.sent_count || 0
          acc.received += row.received_count || 0
          if (row.first_time > 0) acc.firstTime = acc.firstTime == null ? row.first_time : Math.min(acc.firstTime, row.first_time)
          if (row.last_time > 0) acc.lastTime = acc.lastTime == null ? row.last_time : Math.max(acc.lastTime, row.last_time)
        }
        const dateUnion = buildUnion(batch, 'create_time', where)
        const days = await dbAdapter.all<{ d: string }>(
          'message',
          dbPath,
          `SELECT DISTINCT strftime('%Y-%m-%d', create_time, 'unixepoch', 'localtime') d FROM (${dateUnion.sql})`,
          dateUnion.params,
        )
        for (const { d } of days) if (d) activeDays.add(d)
      } catch {
        partialFailures += 1
      }
    }
  }

  const other = acc.total - acc.text - acc.image - acc.voice - acc.video - acc.emoji
  return {
    metric: 'overview',
    total: acc.total,
    byType: { 文字: acc.text, 图片: acc.image, 语音: acc.voice, 视频: acc.video, 表情: acc.emoji, 其它: other < 0 ? 0 : other },
    sent: acc.sent,
    received: acc.received,
    activeDays: activeDays.size,
    firstTime: acc.firstTime ? acc.firstTime * 1000 : null,
    lastTime: acc.lastTime ? acc.lastTime * 1000 : null,
    ...(partialFailures ? { partialFailures } : {}),
  }
}

async function runTimeDistribution(
  scope: Array<{ dbPath: string; tables: string[] }>,
  range: TimeRangeSec,
  groupBy: 'hour' | 'weekday' | 'month',
) {
  const where = buildMessageStatsWhere({ range })
  const fmt = groupBy === 'hour' ? '%H' : groupBy === 'weekday' ? '%w' : '%Y-%m'
  const counts = new Map<string, number>()
  let partialFailures = 0

  for (const { dbPath, tables } of scope) {
    for (const batch of chunk(tables, CHUNK)) {
      try {
        const union = buildUnion(batch, 'create_time', where)
        const rows = await dbAdapter.all<{ k: string; c: number }>(
          'message',
          dbPath,
          `SELECT strftime('${fmt}', create_time, 'unixepoch', 'localtime') k, COUNT(*) c FROM (${union.sql}) GROUP BY k`,
          union.params,
        )
        for (const { k, c } of rows) {
          if (k == null) continue
          counts.set(k, (counts.get(k) || 0) + (c || 0))
        }
      } catch {
        partialFailures += 1
      }
    }
  }

  // 整理成有序、可读的分布
  let distribution: Record<string, number>
  if (groupBy === 'hour') {
    distribution = {}
    for (let h = 0; h < 24; h++) distribution[`${h}时`] = counts.get(String(h).padStart(2, '0')) || 0
  } else if (groupBy === 'weekday') {
    distribution = {}
    for (let d = 1; d <= 7; d++) { const idx = d % 7; distribution[WEEKDAY_LABELS[idx]] = counts.get(String(idx)) || 0 }
  } else {
    distribution = Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)))
  }

  const peak = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  return {
    metric: 'time_distribution',
    groupBy,
    distribution,
    peak: peak ? { bucket: groupBy === 'weekday' ? WEEKDAY_LABELS[Number(peak[0]) % 7] : groupBy === 'hour' ? `${Number(peak[0])}时` : peak[0], count: peak[1] } : null,
    ...(partialFailures ? { partialFailures } : {}),
  }
}

async function runRanking(range: TimeRangeSec, limit: number) {
  // 候选私聊会话 → hash → username
  let usernames: string[] = []
  try {
    const sessions = await dbAdapter.all<{ username: string }>('session', '', 'SELECT username FROM SessionTable')
    usernames = sessions.map((s) => s.username).filter(isPrivateSession)
  } catch (e) {
    return { error: `读取会话列表失败: ${e instanceof Error ? e.message : String(e)}` }
  }
  const hashToUser = new Map<string, string>()
  for (const u of usernames) hashToUser.set(getMessageTableHash(u), u)

  const where = buildMessageStatsWhere({ range })
  const byUser = new Map<string, { count: number; sent: number; received: number; last: number }>()
  let partialFailures = 0

  for (const dbPath of findMessageDbPaths()) {
    const allTables = await listExactMessageTables(dbPath)
    const tables = allTables.filter((t) => {
      const h = extractExactMessageTableHash(t)
      return h ? hashToUser.has(h) : false
    })
    if (tables.length === 0) continue
    const withIsSend = await hasIsSend(dbPath, tables[0])
    const sendCol = withIsSend ? 'is_send' : 'NULL AS is_send'

    for (const batch of chunk(tables, CHUNK)) {
      try {
        const union = buildUnion(batch, `${sendCol}, create_time`, where, true)
        const rows = await dbAdapter.all<any>(
          'message',
          dbPath,
          `SELECT tbl, COUNT(*) c,
            SUM(CASE WHEN is_send = 1 THEN 1 ELSE 0 END) sent,
            SUM(CASE WHEN is_send = 0 THEN 1 ELSE 0 END) recv,
            MAX(create_time) last
           FROM (${union.sql}) GROUP BY tbl`,
          union.params,
        )
        for (const r of rows) {
          const h = extractExactMessageTableHash(r.tbl)
          const user = h ? hashToUser.get(h) : undefined
          if (!user) continue
          const cur = byUser.get(user) || { count: 0, sent: 0, received: 0, last: 0 }
          cur.count += r.c || 0
          cur.sent += r.sent || 0
          cur.received += r.recv || 0
          if ((r.last || 0) > cur.last) cur.last = r.last || 0
          byUser.set(user, cur)
        }
      } catch {
        partialFailures += 1
      }
    }
  }

  const top = [...byUser.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, limit)
  const names = await resolveContactNames(top.map(([u]) => u))
  return {
    metric: 'ranking',
    rankings: top.map(([username, s]) => ({
      username,
      displayName: names.get(username)?.displayName || username,
      messageCount: s.count,
      sent: s.sent,
      received: s.received,
      lastTime: s.last ? s.last * 1000 : null,
    })),
    ...(partialFailures ? { partialFailures } : {}),
  }
}

export const chatStats = tool({
  description:
    '纯 SQL 聚合统计，回答"数量/排名/频率/总和"这类问题——别拿检索工具去数。三种 metric：\n' +
    '- overview：消息总数、各类型(文字/图片/语音/视频/表情)条数、我发vs收到、活跃天数、时间跨度。可选 sessionId 限定某会话。\n' +
    '- ranking：互动最多的联系人排行（按消息数，私聊），全局；用于"谁聊得最多"。\n' +
    '- time_distribution：按 groupBy(hour/weekday/month) 的消息量分布，附峰值；用于"互动高峰在什么时候"。\n' +
    'sessionId 来自 list_contacts；时间一律毫秒时间戳。要看具体聊了啥用 get_timeline / search_messages，不要用本工具。',
  inputSchema: z.object({
    metric: z.enum(['overview', 'ranking', 'time_distribution']).describe('统计类型'),
    sessionId: z.string().optional().describe('限定某会话（username，来自 list_contacts）；ranking 忽略此项（恒全局）'),
    startTimeMs: z.number().optional().describe('起始时间，毫秒时间戳'),
    endTimeMs: z.number().optional().describe('结束时间，毫秒时间戳'),
    groupBy: z.enum(['hour', 'weekday', 'month']).optional().describe('time_distribution 的分组维度，默认 hour'),
    limit: z.number().int().min(1).max(50).default(20).describe('ranking 返回的排行条数'),
  }),
  execute: async ({ metric, sessionId, startTimeMs, endTimeMs, groupBy, limit }) => {
    try {
      const range = normalizeTimeRange(startTimeMs, endTimeMs)
      if (metric === 'ranking') return await runRanking(range, limit)
      const scope = await collectScope(sessionId)
      if (scope.length === 0) return { metric, note: '没有可统计的消息库（会话可能未加载或 sessionId 无效）' }
      if (metric === 'overview') return await runOverview(scope, range)
      return await runTimeDistribution(scope, range, groupBy || 'hour')
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
})
