import { memoryDatabase } from '../memory/memoryDatabase'
import type { MemoryKeywordSearchHit } from '../memory/memoryDatabase'
import { evidenceService } from '../memory/evidenceService'
import type { MemoryItem } from '../memory/memorySchema'
import { reciprocalRankFusion } from './rrf'
import type {
  RetrievalCandidate,
  RetrievalEngineOptions,
  RetrievalEngineResult,
  RetrievalHit,
  RetrievalRerankStats,
  RetrievalSourceName,
  RetrievalSourceStats
} from './retrievalTypes'

type SourceHit = {
  source: RetrievalSourceName
  memory: MemoryItem
  rank: number
  score: number
}

const DEFAULT_LIMIT = 20
const DEFAULT_KEYWORD_LIMIT = 80
const DEFAULT_RRF_K = 60

function uniqueQueries(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const query = String(value || '').replace(/\s+/g, ' ').trim()
    const key = query.toLowerCase()
    if (!query || seen.has(key)) continue
    seen.add(key)
    result.push(query)
  }
  return result
}

function memoryKey(memory: MemoryItem): string {
  return String(memory.id)
}

function toCandidate(hit: SourceHit): RetrievalCandidate {
  return {
    key: memoryKey(hit.memory),
    memory: hit.memory,
    sources: [hit.source],
    sourceRanks: { [hit.source]: hit.rank },
    sourceScores: { [hit.source]: hit.score },
    rrfScore: 0
  }
}

function mergeSourceDetails(candidate: RetrievalCandidate, hits: SourceHit[]): RetrievalCandidate {
  const sources: RetrievalSourceName[] = []
  const sourceRanks: RetrievalCandidate['sourceRanks'] = {}
  const sourceScores: RetrievalCandidate['sourceScores'] = {}

  for (const hit of hits) {
    if (!sources.includes(hit.source)) sources.push(hit.source)
    sourceRanks[hit.source] = Math.min(sourceRanks[hit.source] || Number.MAX_SAFE_INTEGER, hit.rank)
    sourceScores[hit.source] = Math.max(sourceScores[hit.source] || 0, hit.score)
  }

  return {
    ...candidate,
    sources,
    sourceRanks,
    sourceScores
  }
}

function normalizeLimit(value: unknown, fallback: number, max: number): number {
  const numberValue = Math.floor(Number(value || fallback))
  return Math.max(1, Math.min(Number.isFinite(numberValue) ? numberValue : fallback, max))
}

export class RetrievalEngine {
  async search(options: RetrievalEngineOptions): Promise<RetrievalEngineResult> {
    const startedAt = Date.now()
    const query = String(options.query || '').trim()
    if (!query) {
      return {
        query,
        hits: [],
        sourceStats: [],
        rerank: { attempted: false, applied: false, skippedReason: 'empty_query' },
        latencyMs: Date.now() - startedAt
      }
    }

    const limit = normalizeLimit(options.limit, DEFAULT_LIMIT, 100)
    const keywordLimit = normalizeLimit(options.keywordLimit, DEFAULT_KEYWORD_LIMIT, 500)
    const keywordQueries = uniqueQueries([query, ...(options.keywordQueries || [])])
    const sourceStats: RetrievalSourceStats[] = []

    const keywordHits = this.collectKeywordHits(options, keywordQueries, keywordLimit, sourceStats)
    const candidates = this.fuseCandidates(keywordHits, options.rrfK)
    const rerankStats: RetrievalRerankStats = {
      attempted: false,
      applied: false,
      skippedReason: 'rerank_removed'
    }
    const selected = candidates.slice(0, limit)
    const hits = await this.expandHits(selected, options.expandEvidence !== false)

    return {
      query,
      hits,
      sourceStats,
      rerank: rerankStats,
      latencyMs: Date.now() - startedAt
    }
  }

  private collectKeywordHits(
    options: RetrievalEngineOptions,
    queries: string[],
    limit: number,
    sourceStats: RetrievalSourceStats[]
  ): SourceHit[] {
    const hits: SourceHit[] = []
    let error: string | undefined

    for (const query of queries) {
      try {
        const rows = memoryDatabase.searchMemoryItemsByKeyword({
          query,
          sessionId: options.sessionId,
          sourceTypes: options.sourceTypes,
          startTimeMs: options.startTimeMs,
          endTimeMs: options.endTimeMs,
          limit
        })
        hits.push(...rows.map((row) => this.keywordRowToSourceHit(row)))
      } catch (searchError) {
        error = String(searchError)
      }
    }

    const ftsCount = hits.filter((hit) => hit.source === 'memory_fts').length
    const likeCount = hits.filter((hit) => hit.source === 'memory_like').length
    sourceStats.push({ name: 'memory_fts', attempted: true, hitCount: ftsCount, ...(error ? { error } : {}) })
    sourceStats.push({ name: 'memory_like', attempted: true, hitCount: likeCount, ...(error ? { error } : {}) })
    return this.dedupeSourceHits(hits)
  }

  private keywordRowToSourceHit(row: MemoryKeywordSearchHit): SourceHit {
    return {
      source: row.retrievalSource,
      memory: row.item,
      rank: row.rank,
      score: row.score
    }
  }

  private dedupeSourceHits(hits: SourceHit[]): SourceHit[] {
    const byKey = new Map<string, SourceHit>()
    for (const hit of hits) {
      const key = `${hit.source}:${memoryKey(hit.memory)}`
      const existing = byKey.get(key)
      if (!existing || hit.rank < existing.rank || hit.score > existing.score) {
        byKey.set(key, hit)
      }
    }
    return Array.from(byKey.values()).sort((a, b) => a.rank - b.rank || b.score - a.score)
  }

  private fuseCandidates(sourceHits: SourceHit[], rrfK?: number): RetrievalCandidate[] {
    const hitsByMemory = new Map<string, SourceHit[]>()
    const listsBySource = new Map<RetrievalSourceName, SourceHit[]>()

    for (const hit of sourceHits) {
      const key = memoryKey(hit.memory)
      const grouped = hitsByMemory.get(key) || []
      grouped.push(hit)
      hitsByMemory.set(key, grouped)

      const list = listsBySource.get(hit.source) || []
      list.push(hit)
      listsBySource.set(hit.source, list)
    }

    const fused = reciprocalRankFusion(
      Array.from(listsBySource.values()).map((list) => list
        .sort((a, b) => a.rank - b.rank || b.score - a.score)
        .map((hit, index) => ({ item: hit, rank: hit.rank || index + 1, score: hit.score }))),
      (hit) => memoryKey(hit.memory),
      rrfK || DEFAULT_RRF_K
    )

    return fused.map((item) => {
      const candidate = toCandidate(item.item)
      candidate.rrfScore = Number(item.rrfScore.toFixed(8))
      return mergeSourceDetails(candidate, hitsByMemory.get(item.key) || [item.item])
    })
  }

  private async expandHits(candidates: RetrievalCandidate[], expandEvidence: boolean): Promise<RetrievalHit[]> {
    const hits: RetrievalHit[] = []
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index] as RetrievalCandidate & { rerankScore?: number; finalScore?: number }
      const evidence = expandEvidence ? await evidenceService.expandMemoryEvidence(candidate.memory) : []
      hits.push({
        ...candidate,
        rank: index + 1,
        score: Number((candidate.finalScore ?? candidate.rerankScore ?? candidate.rrfScore).toFixed(8)),
        ...(candidate.rerankScore != null ? { rerankScore: candidate.rerankScore } : {}),
        evidence
      })
    }
    return hits
  }
}

export const retrievalEngine = new RetrievalEngine()
