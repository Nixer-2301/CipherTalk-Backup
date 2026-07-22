// 会话列表全量拉取 - 供导出页、朋友圈窗口等一次性选择器使用
// （聊天页侧边栏走滚动分页，见 ChatPage 的 loadMoreSessions）
import type { ChatSession } from '../types/models'

const PAGE_SIZE = 1000 // 后端单页上限
// ponytail: 5 万原始行封顶，防御 hasMore 异常导致死循环；超过再调大
const MAX_PAGES = 50

/**
 * 循环翻页拉取全部会话（按 username 去重）。
 * offset 按后端原始行推进：后端返回前会过滤系统号等，前端条数 < 原始行数。
 */
export async function fetchAllSessions(): Promise<ChatSession[]> {
  const all: ChatSession[] = []
  const seen = new Set<string>()
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await window.electronAPI.chat.getSessions(page * PAGE_SIZE, PAGE_SIZE)
    if (!result.success || !result.sessions) {
      if (page === 0) throw new Error(result.error || '获取会话列表失败')
      break
    }
    for (const s of result.sessions) {
      if (seen.has(s.username)) continue
      seen.add(s.username)
      all.push(s)
    }
    if (!result.hasMore) break
  }
  return all
}
