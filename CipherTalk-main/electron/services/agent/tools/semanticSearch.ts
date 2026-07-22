/**
 * semantic_search —— "找相关内容/某主题"的检索。
 * - 已启用嵌入(embeddingConfig.enabled) 且指定 sessionId → 走混合检索（hybrid）：
 *   向量(片段语义) + 关键词(原文 FTS) 并行跑，用 RRF 按排名融合；
 *   关键词命中落在某向量片段区间内则并入该片段（双路命中加权、同区域去重）。
 * - 否则（全局 / 未启用嵌入）→ 关键词检索原文（searchChat）兜底。
 */
import { tool } from 'ai'
import { z } from 'zod'
import { rerankCandidates } from '../../ai/rerankService'
import { reciprocalRankFusion } from '../../retrieval/rrf'
import { reportAgentProgress } from '../progress'
import { describeToolError, evidenceFromHit, searchChat, resolveSenders, toLocalTime } from './shared'

interface FusedHit {
  key: string
  source: 'vector' | 'keyword'
  sessionId: string
  time: string | null
  sender: string
  excerpt: string
  anchor: { sessionId: string; localId: number; sortSeq: number; createTime: number }
}

function semanticFallbackReason(sessionId: string | undefined, embeddingReady: boolean): string | undefined {
  if (!sessionId) return 'missing_session'
  if (!embeddingReady) return 'embedding_not_ready'
  return undefined
}

export const semanticSearch = tool({
  description:
    '查找与某主题/某件事相关的聊天记录，适合"聊过类似 X 吗 / 关于某话题都说了啥"。' +
    '每条命中带 anchor，拿到后用 get_context 展开前后原文核对、标注出处。' +
    '配了嵌入模型且带 sessionId 时走语义向量+关键词混合检索；否则按关键词检索原文。建议带 sessionId 限定范围（先用 list_contacts 拿 username）。' +
    '要精确词用 search_messages；要数量/排名用 chat_stats。',
  inputSchema: z.object({
    query: z.string().describe('自然语言检索意图 / 关键词'),
    sessionId: z.string().optional().describe('限定某会话/群（username，来自 list_contacts）；语义向量仅在带 sessionId 时启用'),
    startTimeMs: z.number().optional().describe('起始时间，毫秒时间戳（仅关键词路径生效）'),
    endTimeMs: z.number().optional().describe('结束时间，毫秒时间戳（仅关键词路径生效）'),
    limit: z.number().int().min(1).max(50).default(10).describe('返回条数上限'),
  }),
  execute: async ({ query, sessionId, startTimeMs, endTimeMs, limit }) => {
    try {
      const candidateLimit = Math.min(50, Math.max(limit, limit * 3))
      const { getEmbeddingConfig } = await import('../../ai/embeddingService')
      const { messageVectorService, embedQuery } = await import('../../search/messageVectorService')
      const cfg = getEmbeddingConfig()
      const embeddingReady = messageVectorService.isReady(cfg)

      // 混合路径：需启用嵌入 + 指定会话（懒构建成本只压在单个会话上）
      if (sessionId && embeddingReady) {
        const [vectorResult, keywordResult] = await Promise.allSettled([
          (async () => {
            const queryVec = await embedQuery(query, cfg)
            reportAgentProgress({
              stage: 'indexing',
              title: '准备会话语义索引',
              detail: query,
              sessionId,
            })
            const indexed = await messageVectorService.ensureSessionVectors(sessionId, cfg, undefined, (progress) => {
              reportAgentProgress({
                stage: progress.stage === 'embedding' ? 'indexing' : 'searching',
                title: progress.message,
                detail: query,
                sessionId,
                messagesScanned: progress.current,
                indexedCount: progress.indexed,
              })
            })
            reportAgentProgress({
              stage: 'searching',
              title: '搜索会话语义索引',
              detail: query,
              sessionId,
              indexedCount: indexed,
            })
            return { hits: messageVectorService.searchSession(sessionId, queryVec, candidateLimit), indexed }
          })(),
          searchChat({ query, sessionId, startTimeMs, endTimeMs, limit: candidateLimit }),
        ])
        const vectorError = vectorResult.status === 'rejected'
          ? describeToolError(vectorResult.reason, '向量检索失败')
          : undefined
        const keywordError = keywordResult.status === 'rejected'
          ? describeToolError(keywordResult.reason, '关键词检索失败')
          : undefined

        if (vectorResult.status === 'rejected' && keywordResult.status === 'rejected') {
          return {
            error: `semantic_search 检索失败：向量路径：${vectorError}；关键词路径：${keywordError}`,
            retrieval: {
              mode: 'hybrid',
              embeddingReady: true,
              vectorCount: 0,
              keywordCount: 0,
              vectorError,
              keywordError,
            },
            hits: [],
            evidence: [],
          }
        }

        const vector = vectorResult.status === 'fulfilled' ? vectorResult.value : { hits: [], indexed: 0 }
        const keyword = keywordResult.status === 'fulfilled'
          ? keywordResult.value
          : { hits: [], sessionsScanned: 0, coverage: 'keyword_failed' }

        const senderMap = await resolveSenders(vector.hits.map((h) => h.senderUsername || ''))

        // 向量命中 → 统一结构（key 用片段锚点 localId，片段内唯一）
        const vItems: FusedHit[] = vector.hits.map((h) => ({
          key: `v:${h.anchor.localId}`,
          source: 'vector',
          sessionId: h.sessionId,
          time: toLocalTime(h.time),
          sender: h.isSend === 1 ? '我' : senderMap.get(h.senderUsername || '') || h.senderUsername || '未知',
          excerpt: h.excerpt,
          anchor: h.anchor,
        }))

        // 关键词命中 → 若落在某返回片段区间内则借用该片段 key（RRF 合并加权），否则独立成项
        const kItems: FusedHit[] = keyword.hits.map((h) => {
          const covering = vector.hits.find(
            (v) => h.anchor.sortSeq >= v.startSortSeq && h.anchor.sortSeq <= v.endSortSeq,
          )
          return {
            key: covering ? `v:${covering.anchor.localId}` : `kw:${h.anchor.localId}`,
            source: 'keyword',
            sessionId: h.sessionId,
            time: h.time,
            sender: h.sender,
            excerpt: h.excerpt,
            anchor: h.anchor,
          }
        })

        const merged = reciprocalRankFusion<FusedHit>(
          [
            vItems.map((item, i) => ({ item, rank: i + 1 })),
            kItems.map((item, i) => ({ item, rank: i + 1 })),
          ],
          (item) => item.key,
        )

        const mergedHits = merged.slice(0, candidateLimit).map((m) => ({
          sessionId: m.item.sessionId,
          time: m.item.time,
          sender: m.item.sender,
          excerpt: m.item.excerpt,
          score: Number(m.rrfScore.toFixed(4)),
          matchedBy: m.ranks.length >= 2 ? 'both' : m.item.source,
          anchor: m.item.anchor,
        }))
        const { items: hits, meta: rerankMeta } = await rerankCandidates(
          query,
          mergedHits.map((hit) => ({
            item: hit,
            text: [hit.time, hit.sender, hit.excerpt, hit.matchedBy].filter(Boolean).join('\n'),
          })),
          { topN: limit },
        )

        return {
          mode: 'hybrid',
          retrieval: {
            mode: 'hybrid',
            embeddingReady: true,
            vectorCount: vector.hits.length,
            keywordCount: keyword.hits.length,
            degraded: Boolean(vectorError || keywordError),
            vectorError,
            keywordError,
            rerank: rerankMeta,
          },
          indexedVectors: vector.indexed,
          hits,
          evidence: hits.map((hit) => ({
            id: `${hit.sessionId}:${hit.anchor.localId}`,
            sessionId: hit.sessionId,
            localId: hit.anchor.localId,
            time: hit.time,
            sender: hit.sender,
            text: hit.excerpt,
          })),
        }
      }

      // 关键词回退（全局 / 未配嵌入）
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
        mode: 'keyword',
        retrieval: {
          mode: 'keyword',
          embeddingReady,
          fallbackReason: semanticFallbackReason(sessionId, embeddingReady),
          vectorCount: 0,
          keywordCount: rawHits.length,
          rerank: rerankMeta,
        },
        sessionsScanned,
        coverage,
        scope: sessionId ? 'session' : 'recent_sessions',
        hits,
        evidence: hits.map(evidenceFromHit),
      }
    } catch (error) {
      return { error: describeToolError(error, 'semantic_search 执行失败') }
    }
  },
})
