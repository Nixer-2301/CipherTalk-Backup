/**
 * 嵌入服务 —— 独立的嵌入模型配置（语义/向量检索用），与聊天模型分开。
 * 配置存 ConfigService.embeddingConfig；provider 构造方式对齐 base.ts 的 getModelProvider。
 * 可在主进程与 AI 子进程复用（ConfigService 在两边都能解析路径）。
 */
import { embed, embedMany } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenAI } from '@ai-sdk/openai'
import { ConfigService } from '../config'
import { createProxyFetch, getResolvedProxyUrl } from './proxyFetch'

export interface EmbeddingConfig {
  enabled: boolean
  provider: string
  protocol: 'openai-compatible' | 'openai'
  apiKey: string
  baseURL: string
  model: string
  dimension: number
  imageEnabled?: boolean
  imageInputMode?: 'auto' | 'image_base64' | 'content_part' | 'data_url'
}

export interface ImageEmbeddingInput {
  data: Buffer
  mediaType: string
  filename?: string
}

export type ResolvedImageInputMode = 'image_base64' | 'content_part' | 'data_url'

/** 读取持久化的嵌入配置。 */
export function getEmbeddingConfig(): EmbeddingConfig {
  const cs = new ConfigService()
  try {
    return cs.get('embeddingConfig')
  } finally {
    cs.close()
  }
}

/** 写入嵌入配置（部分字段合并）。 */
export function saveEmbeddingConfig(patch: Partial<EmbeddingConfig>): EmbeddingConfig {
  const cs = new ConfigService()
  try {
    const next = { ...cs.get('embeddingConfig'), ...patch }
    cs.set('embeddingConfig', next)
    return next
  } finally {
    cs.close()
  }
}

function buildEmbeddingModel(cfg: EmbeddingConfig) {
  if (!cfg.apiKey) throw new Error('未配置嵌入模型 API Key')
  if (!cfg.model) throw new Error('未配置嵌入模型')
  const fetch = createProxyFetch(getResolvedProxyUrl())
  if (cfg.protocol === 'openai') {
    return createOpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL || undefined, name: 'embedding', fetch }).textEmbeddingModel(cfg.model)
  }
  return createOpenAICompatible({ name: 'embedding', apiKey: cfg.apiKey, baseURL: cfg.baseURL, fetch }).textEmbeddingModel(cfg.model)
}

function normalizeImageInputMode(mode: EmbeddingConfig['imageInputMode']): 'auto' | ResolvedImageInputMode {
  return mode === 'image_base64' || mode === 'content_part' || mode === 'data_url' ? mode : 'auto'
}

/** dimension>0 时要求接口按该维度输出（需模型支持）；两种 provider key 都带，互不干扰。0 = 不指定。 */
function embeddingProviderOptions(cfg: EmbeddingConfig) {
  if (!cfg.dimension || cfg.dimension <= 0) return undefined
  return { openai: { dimensions: cfg.dimension }, openaiCompatible: { dimensions: cfg.dimension } }
}

function embeddingsEndpoint(cfg: EmbeddingConfig): string {
  const base = (cfg.baseURL || '').trim().replace(/\/+$/, '')
  if (!base) throw new Error('未配置嵌入模型 baseURL')
  return /\/embeddings$/i.test(base) ? base : `${base}/embeddings`
}

function imageToDataUrl(input: ImageEmbeddingInput): string {
  if (!input.mediaType || !input.mediaType.startsWith('image/')) {
    throw new Error(`不支持的图片类型：${input.mediaType || 'unknown'}`)
  }
  if (!input.data || input.data.length === 0) throw new Error('图片数据为空')
  return `data:${input.mediaType};base64,${input.data.toString('base64')}`
}

function buildImageEmbeddingBody(
  cfg: EmbeddingConfig,
  input: ImageEmbeddingInput,
  mode: ResolvedImageInputMode,
): Record<string, unknown> {
  const dataUrl = imageToDataUrl(input)
  const body: Record<string, unknown> = {
    model: cfg.model,
    input: mode === 'image_base64'
      ? { image: input.data.toString('base64') }
      : mode === 'content_part'
        ? [{ type: 'image_url', image_url: { url: dataUrl } }]
        : dataUrl,
    encoding_format: 'float',
  }
  if (cfg.dimension && cfg.dimension > 0) body.dimensions = cfg.dimension
  return body
}

function parseEmbeddingResponse(body: unknown): number[] {
  const data = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const first = Array.isArray(data.data) ? data.data[0] : undefined
  const embedding = first && typeof first === 'object'
    ? (first as Record<string, unknown>).embedding
    : Array.isArray((data as { embeddings?: unknown }).embeddings)
      ? (data as { embeddings: unknown[] }).embeddings[0]
      : undefined
  if (!Array.isArray(embedding)) throw new Error('嵌入接口未返回 embedding 数组')
  const vector = embedding.map((item) => Number(item)).filter((item) => Number.isFinite(item))
  if (vector.length === 0) throw new Error('嵌入返回为空')
  return vector
}

const imageModeCache = new Map<string, ResolvedImageInputMode>()

async function requestImageEmbedding(
  cfg: EmbeddingConfig,
  input: ImageEmbeddingInput,
  mode: ResolvedImageInputMode,
  opts?: { timeoutMs?: number },
): Promise<number[]> {
  if (!cfg.apiKey) throw new Error('未配置嵌入模型 API Key')
  if (!cfg.model) throw new Error('未配置嵌入模型')
  const fetchImpl = createProxyFetch(getResolvedProxyUrl()) || fetch
  const timeoutMs = Math.max(1000, Math.floor(opts?.timeoutMs ?? 30000))
  const res = await fetchImpl(embeddingsEndpoint(cfg), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildImageEmbeddingBody(cfg, input, mode)),
    signal: AbortSignal.timeout(timeoutMs),
  } as RequestInit)
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  if (!res.ok) {
    const message = json && typeof json === 'object'
      ? String((json as any).error?.message || (json as any).message || text || res.statusText)
      : String(text || res.statusText)
    throw new Error(`图片嵌入失败（HTTP ${res.status}）：${message.slice(0, 500)}`)
  }
  return parseEmbeddingResponse(json)
}

/** 批量嵌入（建索引用）。 */
export async function embedTexts(texts: string[], cfg?: EmbeddingConfig): Promise<number[][]> {
  if (texts.length === 0) return []
  const c = cfg || getEmbeddingConfig()
  const { embeddings } = await embedMany({ model: buildEmbeddingModel(c), values: texts, providerOptions: embeddingProviderOptions(c) })
  return embeddings
}

/** 单张图片嵌入。仅在 imageEnabled=true 时使用，避免历史图片被意外发送到嵌入服务商。 */
export async function embedImage(
  input: ImageEmbeddingInput,
  cfg?: EmbeddingConfig,
  opts?: { timeoutMs?: number },
): Promise<{ embedding: number[]; imageInputMode: ResolvedImageInputMode }> {
  const c = cfg || getEmbeddingConfig()
  if (!c.imageEnabled) throw new Error('图片向量化未开启。请先在嵌入设置里开启“图片向量化”。')
  const requested = normalizeImageInputMode(c.imageInputMode)
  const cacheKey = [c.protocol, c.baseURL, c.model, c.dimension || 0].join('\n')
  const modes: ResolvedImageInputMode[] = requested === 'auto'
    ? [imageModeCache.get(cacheKey), 'image_base64', 'content_part', 'data_url'].filter(Boolean) as ResolvedImageInputMode[]
    : [requested]
  const uniqueModes = Array.from(new Set(modes))
  const errors: string[] = []
  for (const mode of uniqueModes) {
    try {
      const embedding = await requestImageEmbedding(c, input, mode, opts)
      imageModeCache.set(cacheKey, mode)
      return { embedding, imageInputMode: mode }
    } catch (error) {
      errors.push(`${mode}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(errors.join('；') || '图片嵌入失败')
}

// 查询嵌入短 TTL 缓存（含在飞请求去重）：Agent 准备阶段会对同一个问题并行做
// MCP 工具/技能两路向量筛选，靠这里共享同一次嵌入请求；“重新生成”同样命中。
const QUERY_EMBED_CACHE_TTL_MS = 60 * 1000
const QUERY_EMBED_CACHE_MAX = 20
const queryEmbedCache = new Map<string, { at: number; promise: Promise<number[]> }>()

/** 单条嵌入（查询用）。查询是延迟敏感路径：默认 10s 兜底超时；Agent 准备阶段可传更短预算 + 关闭重试。 */
export function embedQuery(
  text: string,
  cfg?: EmbeddingConfig,
  opts?: { timeoutMs?: number; maxRetries?: number },
): Promise<number[]> {
  const c = cfg || getEmbeddingConfig()
  const key = [c.protocol, c.baseURL, c.model, c.dimension || 0, text].join('\n')
  const cached = queryEmbedCache.get(key)
  if (cached && Date.now() - cached.at < QUERY_EMBED_CACHE_TTL_MS) return cached.promise

  const timeoutMs = Math.max(200, Math.floor(opts?.timeoutMs ?? 10000))
  const promise = embed({
    model: buildEmbeddingModel(c),
    value: text,
    providerOptions: embeddingProviderOptions(c),
    abortSignal: AbortSignal.timeout(timeoutMs),
    ...(opts?.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
  })
    .then(({ embedding }) => embedding)
  queryEmbedCache.set(key, { at: Date.now(), promise })
  promise.catch(() => queryEmbedCache.delete(key)) // 失败不留缓存
  while (queryEmbedCache.size > QUERY_EMBED_CACHE_MAX) {
    const oldest = queryEmbedCache.keys().next().value
    if (oldest === undefined) break
    queryEmbedCache.delete(oldest)
  }
  return promise
}

/** 测试嵌入配置：成功则回传实际维度。优先按用户设定维度测试，不匹配则回退到默认维度重试。 */
export async function testEmbeddingConfig(cfg: EmbeddingConfig): Promise<{
  success: boolean
  dimension?: number
  imageDimension?: number
  imageInputMode?: ResolvedImageInputMode
  error?: string
  dimensionMismatch?: string
}> {
  try {
    const userDimension = cfg.dimension && cfg.dimension > 0 ? cfg.dimension : 0
    let vector: number[]
    if (userDimension > 0) {
      try {
        vector = await embedQuery('密语语义检索连接测试', cfg)
      } catch {
        vector = await embedQuery('密语语义检索连接测试', { ...cfg, dimension: 0 })
      }
    } else {
      vector = await embedQuery('密语语义检索连接测试', cfg)
    }
    if (!Array.isArray(vector) || vector.length === 0) {
      return { success: false, error: '嵌入返回为空' }
    }
    const actualDim = vector.length
    const baseResult = userDimension > 0 && actualDim !== userDimension
      ? {
        success: true,
        dimension: actualDim,
        dimensionMismatch: `连接成功，回退到模型默认维度 ${actualDim}`
      }
      : { success: true, dimension: actualDim }
    if (!cfg.imageEnabled) return baseResult

    const tinyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      'base64',
    )
    const image = await embedImage({ data: tinyPng, mediaType: 'image/png', filename: 'embedding-test.png' }, cfg, { timeoutMs: 30000 })
    return { ...baseResult, imageDimension: image.embedding.length, imageInputMode: image.imageInputMode }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  }
}
