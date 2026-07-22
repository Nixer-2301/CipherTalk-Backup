/**
 * search_messages —— 关键词检索聊天原文（基于 chatSearchIndexService 的本地 FTS，按需建索引）。
 * 命中带 anchor（消息锚点），可交给 get_context 展开原文核对、标注出处。
 * 注：原 memory_items 派生层已移除，检索一律走原文索引。
 */
import { tool } from 'ai'
import { z } from 'zod'
import { rerankCandidates } from '../../ai/rerankService'
import { evidenceFromHit, searchChat } from './shared'

export const searchMessages = tool({
  description:
    '按关键词检索聊天记录原文，适合"谁提过 X / 搜含某个词的消息 / 找某件具体的事"。' +
    '每条命中带 anchor 字段（消息锚点），拿到后用 get_context 展开前后原文来核对、引用。' +
    '强烈建议带 sessionId 限定范围（先用 list_contacts 拿 username）——不带则只扫最近活跃的若干会话，且首次会现建索引偏慢。' +
    '要数量/排名/频率用 chat_stats，不要用检索去数。',
  inputSchema: z.object({
    query: z.string().describe('关键词/词组'),
    sessionId: z.string().optional().describe('限定某会话/群（username，来自 list_contacts）；不传则扫最近会话'),
    startTimeMs: z.number().optional().describe('起始时间，毫秒时间戳'),
    endTimeMs: z.number().optional().describe('结束时间，毫秒时间戳'),
    limit: z.number().int().min(1).max(50).default(10).describe('返回条数上限'),
  }),
  execute: async ({ query, sessionId, startTimeMs, endTimeMs, limit }) => {
    try {
      const candidateLimit = Math.min(50, Math.max(limit, limit * 3))
      const { hits: rawHits, sessionsScanned, coverage } = await searchChat({ query, sessionId, startTimeMs, endTimeMs, limit: candidateLimit })
      const { items: hits, meta: rerankMeta } = await rerankCandidates(
        query,
        rawHits.map((hit) => ({
          item: hit,
          text: [hit.time, hit.sender, hit.excerpt].filter(Boolean).join('\n'),
        })),
        { topN: limit },
      )
      return {
        retrieval: {
          mode: 'keyword',
          rerank: rerankMeta,
        },
        sessionsScanned,
        coverage,
        scope: sessionId ? 'session' : 'recent_sessions',
        hits,
        evidence: hits.map(evidenceFromHit),
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
})
