import { dbAdapter } from './dbAdapter'

export interface ResolvedContactName {
  username: string
  displayName: string
  avatarUrl?: string
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

async function getContactColumns(): Promise<Set<string>> {
  const columns = await dbAdapter.all<{ name: string }>('contact', '', 'PRAGMA table_info(contact)')
  return new Set(columns.map(c => c.name))
}

export async function resolveContactNames(usernames: string[]): Promise<Map<string, ResolvedContactName>> {
  const unique = Array.from(new Set(usernames.filter(Boolean)))
  const result = new Map<string, ResolvedContactName>()
  for (const username of unique) result.set(username, { username, displayName: username })
  if (unique.length === 0) return result

  try {
    const columns = await getContactColumns()
    const selectCols = ['username']
    for (const col of ['remark', 'nick_name', 'alias', 'big_head_url', 'small_head_url']) {
      if (columns.has(col)) selectCols.push(col)
    }

    for (const group of chunk(unique, 500)) {
      const placeholders = group.map(() => '?').join(',')
      const rows = await dbAdapter.all<any>(
        'contact',
        '',
        `SELECT ${selectCols.join(', ')} FROM contact WHERE username IN (${placeholders})`,
        group
      )
      for (const row of rows) {
        const avatarUrl = row.big_head_url || row.small_head_url || undefined
        result.set(row.username, {
          username: row.username,
          displayName: row.remark || row.nick_name || row.alias || row.username,
          avatarUrl,
        })
      }
    }
  } catch (e) {
    console.warn('[ContactNameResolver] 联系人名称解析失败:', e)
  }

  return result
}

export async function resolveContactName(username: string): Promise<ResolvedContactName> {
  const map = await resolveContactNames([username])
  return map.get(username) || { username, displayName: username }
}
