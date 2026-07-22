import { dbAdapter } from '../dbAdapter'
import { extractWeComWordingRef, extractWeComCorpName } from './weComParser'
import type { ChatServiceState } from './state'

export async function resolveWeComCorpName(state: ChatServiceState, extraBuffer: any, knownStrings: Array<string | undefined>): Promise<string | undefined> {
  const ref = extractWeComWordingRef(extraBuffer)
  if (ref) {
    const cacheKey = `${ref.appId || ''}\n${ref.wordingId}`
    if (state.weComCorpNameCache.has(cacheKey)) {
      return state.weComCorpNameCache.get(cacheKey) || extractWeComCorpName(extraBuffer, knownStrings)
    }

    try {
      if (state.hasOpenImWordingTable === null) {
        const table = await dbAdapter.get<{ name: string }>(
          'contact',
          '',
          "SELECT name FROM sqlite_master WHERE type='table' AND name='openim_wording'"
        )
        state.hasOpenImWordingTable = Boolean(table)
      }

      if (state.hasOpenImWordingTable) {
        const sql = ref.appId
          ? `SELECT wording FROM openim_wording
             WHERE app_id = ? AND wording_id = ? AND wording <> ''
             ORDER BY CASE WHEN lang_id = 1 THEN 0 ELSE 1 END, update_time DESC
             LIMIT 1`
          : `SELECT wording FROM openim_wording
             WHERE wording_id = ? AND wording <> ''
             ORDER BY CASE WHEN lang_id = 1 THEN 0 ELSE 1 END, update_time DESC
             LIMIT 1`
        const params = ref.appId ? [ref.appId, ref.wordingId] : [ref.wordingId]
        const row = await dbAdapter.get<{ wording?: string }>('contact', '', sql, params)
        const wording = typeof row?.wording === 'string' ? row.wording.trim() : ''
        if (wording) {
          state.weComCorpNameCache.set(cacheKey, wording)
          return wording
        }
      }
      state.weComCorpNameCache.set(cacheKey, undefined)
    } catch {
      // 旧数据库可能没有 openim_wording；继续尝试旧的 extra_buffer 提取。
    }
  }

  return extractWeComCorpName(extraBuffer, knownStrings)
}
