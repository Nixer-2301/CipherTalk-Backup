import type { Message } from '../chatService'
import type { MemoryEvidenceRef, MemoryItem, MemorySourceType } from '../memory/memorySchema'

export type RetrievalSourceName = 'memory_fts' | 'memory_like'

export type RetrievalEngineOptions = {
  query: string
  keywordQueries?: string[]
  sessionId?: string
  sourceTypes?: MemorySourceType[]
  startTimeMs?: number
  endTimeMs?: number
  direction?: 'in' | 'out'
  senderUsername?: string
  limit?: number
  keywordLimit?: number
  rrfK?: number
  expandEvidence?: boolean
}

export type RetrievalCandidate = {
  key: string
  memory: MemoryItem
  sources: RetrievalSourceName[]
  sourceRanks: Partial<Record<RetrievalSourceName, number>>
  sourceScores: Partial<Record<RetrievalSourceName, number>>
  rrfScore: number
}

export type RetrievalExpandedEvidence = {
  ref: MemoryEvidenceRef
  before: Message[]
  anchor: Message | null
  after: Message[]
}

export type RetrievalHit = RetrievalCandidate & {
  rank: number
  score: number
  rerankScore?: number
  evidence: RetrievalExpandedEvidence[]
}

export type RetrievalSourceStats = {
  name: RetrievalSourceName
  attempted: boolean
  hitCount: number
  skippedReason?: string
  error?: string
}

export type RetrievalRerankStats = {
  attempted: boolean
  applied: boolean
  skippedReason?: string
  error?: string
}

export type RetrievalEngineResult = {
  query: string
  hits: RetrievalHit[]
  sourceStats: RetrievalSourceStats[]
  rerank: RetrievalRerankStats
  latencyMs: number
}

export type RetrievalEvalEvidenceRef = {
  localId: number
  createTime: number
  sortSeq: number
}

export type RetrievalEvalCase = {
  id: string
  sessionId: string
  question: string
  expectedEvidence: RetrievalEvalEvidenceRef[]
  expectedKeywords?: string[]
  startTimeMs?: number
  endTimeMs?: number
  direction?: 'in' | 'out'
  senderUsername?: string
  limit?: number
}

export type RetrievalEvalMode = 'keyword'

export type RetrievalEvalMessage = {
  localId: number
  createTime: number
  sortSeq: number
  [key: string]: unknown
}

export type RetrievalEvalHit = {
  sessionId: string
  message: RetrievalEvalMessage
  excerpt: string
  matchedField: 'text' | 'raw'
  score: number
  retrievalSource: 'keyword_index'
}

export type RetrievalEvalCaseResult = {
  id: string
  sessionId: string
  question: string
  mode: RetrievalEvalMode
  hitCount: number
  recallAt10: boolean
  recallAt20: boolean
  reciprocalRank: number
  firstMatchRank: number | null
  latencyMs: number
  vectorAttempted: boolean
  vectorSkippedReason?: string
  error?: string
}

export type RetrievalEvalSummary = {
  mode: RetrievalEvalMode
  caseCount: number
  successfulCases: number
  failedCases: number
  recallAt10: number
  recallAt20: number
  mrr: number
  latencyP50Ms: number
  latencyP95Ms: number
  startedAt: string
  completedAt: string
}

export type RetrievalEvalReport = {
  summary: RetrievalEvalSummary
  cases: RetrievalEvalCaseResult[]
}
