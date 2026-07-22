/**
 * 重排服务 —— 用 AI SDK rerank() 统一承接候选重排。
 * OpenAI 兼容服务通常没有 AI SDK provider，所以这里只实现很薄的 RerankingModelV3 适配器。
 */
import { rerank, type RerankingModel } from 'ai'
import type { RerankingModelV3, RerankingModelV3CallOptions } from '@ai-sdk/provider'
import { ConfigService } from '../config'
import { createProxyFetch, getResolvedProxyUrl } from './proxyFetch'

export interface RerankConfig {
  enabled: boolean
  provider: string
  protocol: 'openai-compatible'
  apiKey: string
  baseURL: string
  model: string
  timeoutMs: number
}

export interface RerankMeta {
  enabled: boolean
  applied: boolean
  candidateCount: number
  resultCount: number
  error?: string
}

export interface RerankCandidate<T> {
  item: T
  text: string
}

const DOCUMENT_TEXT_CAP = 2400

function normalizeBaseURL(baseURL: string): string {
  return String(baseURL || '').trim().replace(/\/+$/, '')
}

function trimDocument(text: string): string {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  return normalized.length > DOCUMENT_TEXT_CAP ? normalized.slice(0, DOCUMENT_TEXT_CAP) : normalized
}

function isReady(cfg: RerankConfig): boolean {
  return !!(cfg.enabled && cfg.apiKey && cfg.baseURL && cfg.model)
}

export function getRerankConfig(): RerankConfig {
  const cs = new ConfigService()
  try {
    return cs.get('rerankConfig')
  } finally {
    cs.close()
  }
}

export function saveRerankConfig(patch: Partial<RerankConfig>): RerankConfig {
  const cs = new ConfigService()
  try {
    const current = cs.get('rerankConfig')
    const next: RerankConfig = {
      ...current,
      ...patch,
      protocol: 'openai-compatible',
      timeoutMs: Math.max(3000, Math.min(120000, Math.floor(Number(patch.timeoutMs ?? current.timeoutMs) || 15000))),
    }
    cs.set('rerankConfig', next)
    return next
  } finally {
    cs.close()
  }
}

class OpenAICompatibleRerankingModel implements RerankingModelV3 {
  readonly specificationVersion = 'v3' as const
  readonly provider = 'openai-compatible-rerank'
  readonly modelId: string

  constructor(private readonly cfg: RerankConfig) {
    this.modelId = cfg.model
  }

  async doRerank(options: RerankingModelV3CallOptions) {
    const documents = options.documents.type === 'text'
      ? options.documents.values
      : options.documents.values.map((value) => JSON.stringify(value))
    const fetchImpl = createProxyFetch(getResolvedProxyUrl()) || fetch
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error(`Rerank timed out after ${this.cfg.timeoutMs}ms`)), this.cfg.timeoutMs)
    if (options.abortSignal) {
      if (options.abortSignal.aborted) controller.abort(options.abortSignal.reason)
      else options.abortSignal.addEventListener('abort', () => controller.abort(options.abortSignal!.reason), { once: true })
    }

    try {
      const response = await fetchImpl(`${normalizeBaseURL(this.cfg.baseURL)}/rerank`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.apiKey}`,
          ...(options.headers || {}),
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.cfg.model,
          query: options.query,
          documents,
          top_n: options.topN,
        }),
      })
      const body = await response.json().catch(() => undefined)
      if (!response.ok) {
        throw new Error(`Rerank request failed: ${response.status} ${JSON.stringify(body || {})}`)
      }
      const ranking = parseRerankResponse(body, documents.length, options.topN)
      if (ranking.length === 0) throw new Error('Rerank response contains no ranking')
      return {
        ranking,
        response: {
          timestamp: new Date(),
          modelId: this.cfg.model,
          headers: Object.fromEntries(response.headers.entries()),
          body,
        },
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}

function parseRerankResponse(body: any, documentCount: number, topN?: number) {
  const rows = Array.isArray(body?.results)
    ? body.results
    : Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body?.ranking)
        ? body.ranking
        : Array.isArray(body?.rankings)
          ? body.rankings
          : []

  const out = rows
    .map((row: any) => {
      const index = Number(
        row?.index ?? row?.originalIndex ?? row?.document_index ?? row?.documentIndex ?? row?.document?.index,
      )
      const relevanceScore = Number(
        row?.relevance_score ?? row?.relevanceScore ?? row?.score ?? row?.rank_score ?? row?.rankScore,
      )
      return { index, relevanceScore }
    })
    .filter((row: { index: number; relevanceScore: number }) => (
      Number.isInteger(row.index) &&
      row.index >= 0 &&
      row.index < documentCount &&
      Number.isFinite(row.relevanceScore)
    ))
    .sort((a: { relevanceScore: number }, b: { relevanceScore: number }) => b.relevanceScore - a.relevanceScore)

  return out.slice(0, topN || out.length)
}

function buildRerankingModel(cfg: RerankConfig): RerankingModel {
  if (!cfg.apiKey) throw new Error('未配置重排模型 API Key')
  if (!cfg.baseURL) throw new Error('未配置重排模型接口 URL')
  if (!cfg.model) throw new Error('未配置重排模型')
  return new OpenAICompatibleRerankingModel(cfg)
}

export async function testRerankConfig(cfg: RerankConfig): Promise<{ success: boolean; error?: string }> {
  try {
    const model = buildRerankingModel({ ...cfg, enabled: true, protocol: 'openai-compatible' })
    const result = await rerank({
      model,
      query: '密语重排连接测试',
      documents: ['密语是一款聊天记录分析工具。', '今天午饭吃什么？', '这条文本与测试无关。'],
      topN: 2,
      maxRetries: 0,
    })
    return result.ranking.length > 0 ? { success: true } : { success: false, error: '重排返回为空' }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function rerankCandidates<T>(
  query: string,
  candidates: Array<RerankCandidate<T>>,
  opts: { topN?: number; cfg?: RerankConfig; timeoutMsOverride?: number } = {},
): Promise<{ items: T[]; meta: RerankMeta }> {
  const baseCfg = opts.cfg || getRerankConfig()
  const timeoutMsOverride = Math.floor(Number(opts.timeoutMsOverride) || 0)
  const cfg = timeoutMsOverride > 0
    ? { ...baseCfg, timeoutMs: Math.max(100, timeoutMsOverride) }
    : baseCfg
  const topN = Math.max(1, Math.floor(opts.topN || candidates.length))
  const fallbackItems = candidates.slice(0, topN).map((candidate) => candidate.item)
  const baseMeta = {
    enabled: !!cfg.enabled,
    applied: false,
    candidateCount: candidates.length,
    resultCount: fallbackItems.length,
  }

  if (!isReady(cfg) || !query.trim() || candidates.length <= 1) {
    return { items: fallbackItems, meta: baseMeta }
  }

  try {
    const docs = candidates.map((candidate) => trimDocument(candidate.text))
    const result = await rerank({
      model: buildRerankingModel(cfg),
      query,
      documents: docs,
      topN,
      maxRetries: 0,
    })
    const items = result.ranking
      .map((row) => candidates[row.originalIndex]?.item)
      .filter((item): item is T => item !== undefined)
    return {
      items: items.length > 0 ? items : fallbackItems,
      meta: {
        enabled: true,
        applied: items.length > 0,
        candidateCount: candidates.length,
        resultCount: items.length || fallbackItems.length,
      },
    }
  } catch (e) {
    return {
      items: fallbackItems,
      meta: {
        ...baseMeta,
        error: e instanceof Error ? e.message : String(e),
      },
    }
  }
}
