import fs from 'fs'
import path from 'path'
import { BaseAIProvider, type ProviderKind } from './base'
import { getAppPath, getUserDataPath, isElectronPackaged } from '../../runtimePaths'
import { getCodexSubscriptionAuthPath, CODEX_SUBSCRIPTION_DUMMY_API_KEY } from '../codexSubscriptionAuth'

export type AIProviderProtocol = ProviderKind

export interface AIProviderMetadata {
  id: string
  name: string
  displayName: string
  description: string
  protocol: AIProviderProtocol
  baseURL: string
  models: string[]
  modelDetails?: AIModelInfo[]
  pricing: string
  pricingDetail: {
    input: number
    output: number
  }
  website?: string
  logo?: string
  optionalApiKey?: boolean
  accountAuth?: boolean
  allowCustomBaseURL?: boolean
  protocolOptions?: AIProviderProtocol[]
}

export interface AIModelInfo {
  id: string
  name: string
  providerId: string
  family?: string
  modalities: {
    input: string[]
    output: string[]
  }
  capabilities: {
    attachment: boolean
    reasoning: boolean
    toolCall: boolean
    structuredOutput: boolean
    temperature: boolean
    openWeights: boolean
  }
  limits: {
    context?: number
    input?: number
    output?: number
  }
  cost?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    inputAudio?: number
    outputAudio?: number
    reasoning?: number
    tiers?: unknown[]
    contextOver200k?: unknown
  }
  status?: string
  knowledge?: string
  releaseDate?: string
  lastUpdated?: string
  interleaved?: {
    field?: string
  }
  provider?: {
    npm?: string
    api?: string
    shape?: string
  }
}

const EMPTY_PRICING = {
  pricing: '在线获取',
  pricingDetail: { input: 0, output: 0 }
}

const CUSTOM_PROVIDER_DEFINITION: AIProviderMetadata = {
  id: 'custom',
  name: 'custom',
  displayName: '自定义',
  description: '自定义 OpenAI、Anthropic 或 Gemini 兼容接口',
  protocol: 'openai-compatible',
  baseURL: '',
  models: [],
  modelDetails: [],
  pricing: '自定义',
  pricingDetail: { input: 0, output: 0 },
  allowCustomBaseURL: true,
  protocolOptions: ['openai-responses', 'openai-compatible', 'anthropic', 'google']
}

export const CODEX_SUBSCRIPTION_PROVIDER_ID = 'openai-codex'

const CODEX_SUBSCRIPTION_MODEL_DETAILS: AIModelInfo[] = [
  { id: 'gpt-5.5', name: 'GPT-5.5', providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, family: 'gpt', modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }, capabilities: { attachment: true, reasoning: true, toolCall: true, structuredOutput: true, temperature: false, openWeights: false }, limits: { context: 400_000, input: 272_000, output: 128_000 } },
  { id: 'gpt-5.4', name: 'GPT-5.4', providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, family: 'gpt', modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }, capabilities: { attachment: true, reasoning: true, toolCall: true, structuredOutput: true, temperature: false, openWeights: false }, limits: { context: 1_050_000, input: 922_000, output: 128_000 } },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini', providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, family: 'gpt-mini', modalities: { input: ['text', 'image'], output: ['text'] }, capabilities: { attachment: true, reasoning: true, toolCall: true, structuredOutput: true, temperature: false, openWeights: false }, limits: { context: 400_000, input: 272_000, output: 128_000 } },
  { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, family: 'gpt-codex-spark', modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }, capabilities: { attachment: true, reasoning: true, toolCall: true, structuredOutput: true, temperature: false, openWeights: false }, limits: { context: 128_000, input: 100_000, output: 32_000 } },
]

const CODEX_SUBSCRIPTION_PROVIDER_DEFINITION: AIProviderMetadata = {
  id: CODEX_SUBSCRIPTION_PROVIDER_ID,
  name: CODEX_SUBSCRIPTION_PROVIDER_ID,
  displayName: 'ChatGPT 订阅',
  description: '使用 ChatGPT 账号登录，直连 ChatGPT Codex Responses 接口调用订阅内额度',
  protocol: 'codex-subscription',
  baseURL: '',
  models: CODEX_SUBSCRIPTION_MODEL_DETAILS.map((model) => model.id),
  modelDetails: CODEX_SUBSCRIPTION_MODEL_DETAILS,
  pricing: '订阅额度',
  pricingDetail: { input: 0, output: 0 },
  optionalApiKey: true,
  accountAuth: true,
  logo: 'openai'
}

const PROVIDER_ID_ALIASES: Record<string, string> = {
  gemini: 'google',
  qwen: 'alibaba-cn',
  kimi: 'moonshotai-cn',
  siliconflow: 'siliconflow-cn',
  zhipu: 'zhipuai',
  tencent: 'tencent-tokenhub',
  'custom-responses': 'openai'
}
let modelsDevCache: { updatedAt: number; data: any } | null = null
const MODELS_DEV_CACHE_MS = 1000 * 60 * 5
const MODELS_DEV_SOURCE = process.env.CIPHERTALK_MODELS_URL || 'https://models.dev'
const MODELS_DEV_CACHE_PATH = process.env.CIPHERTALK_MODELS_PATH || path.join(
  getUserDataPath(),
  MODELS_DEV_SOURCE === 'https://models.dev' ? 'models-dev.json' : `models-dev-${Buffer.from(MODELS_DEV_SOURCE).toString('hex').slice(0, 16)}.json`
)
let modelsDevFetchPromise: Promise<any> | null = null

function toMetadata(provider: Omit<AIProviderMetadata, 'models' | 'modelDetails' | 'pricing' | 'pricingDetail'>, modelDetails: AIModelInfo[] = [], pricing = EMPTY_PRICING): AIProviderMetadata {
  return {
    ...provider,
    models: modelDetails.map(model => model.id),
    modelDetails,
    pricing: pricing.pricing,
    pricingDetail: { ...pricing.pricingDetail }
  }
}

function cloneMetadata(provider: AIProviderMetadata): AIProviderMetadata {
  return {
    ...provider,
    models: [...provider.models],
    protocolOptions: provider.protocolOptions ? [...provider.protocolOptions] : undefined,
    modelDetails: provider.modelDetails?.map(model => ({
      ...model,
      modalities: { input: [...model.modalities.input], output: [...model.modalities.output] },
      capabilities: { ...model.capabilities },
      limits: { ...model.limits },
      cost: model.cost ? { ...model.cost, tiers: model.cost.tiers ? [...model.cost.tiers] : undefined } : undefined,
      interleaved: model.interleaved ? { ...model.interleaved } : undefined,
      provider: model.provider ? { ...model.provider } : undefined
    })),
    pricingDetail: { ...provider.pricingDetail }
  }
}

export function normalizeProviderId(providerId: string): string {
  return PROVIDER_ID_ALIASES[providerId] || providerId
}

function readModelsDevCacheFile(): { updatedAt: number; data: any } | null {
  try {
    if (!fs.existsSync(MODELS_DEV_CACHE_PATH)) return null
    const stat = fs.statSync(MODELS_DEV_CACHE_PATH)
    const data = JSON.parse(fs.readFileSync(MODELS_DEV_CACHE_PATH, 'utf-8'))
    return { updatedAt: stat.mtimeMs, data }
  } catch (error) {
    console.warn('[AIProviderCatalog] 读取 models.dev 缓存失败:', error instanceof Error ? error.message : String(error))
    return null
  }
}

function writeModelsDevCacheFile(data: any): void {
  try {
    fs.mkdirSync(path.dirname(MODELS_DEV_CACHE_PATH), { recursive: true })
    fs.writeFileSync(MODELS_DEV_CACHE_PATH, JSON.stringify(data), 'utf-8')
  } catch (error) {
    console.warn('[AIProviderCatalog] 写入 models.dev 缓存失败:', error instanceof Error ? error.message : String(error))
  }
}

function getBundledModelsDevPath(): string {
  return isElectronPackaged()
    ? path.join(process.resourcesPath, 'assets', 'models-dev.json')
    : path.join(getAppPath(), 'electron', 'assets', 'models-dev.json')
}

function readBundledModelsDevData(): any | null {
  try {
    const bundledPath = getBundledModelsDevPath()
    if (!fs.existsSync(bundledPath)) return null
    return JSON.parse(fs.readFileSync(bundledPath, 'utf-8'))
  } catch (error) {
    console.warn('[AIProviderCatalog] 读取内置 models.dev 快照失败:', error instanceof Error ? error.message : String(error))
    return null
  }
}

function readAvailableModelsDevData(): any | null {
  if (modelsDevCache?.data) return modelsDevCache.data

  const diskCache = readModelsDevCacheFile()
  if (diskCache) {
    modelsDevCache = diskCache
    return diskCache.data
  }

  const bundled = readBundledModelsDevData()
  if (bundled) {
    modelsDevCache = { updatedAt: Date.now(), data: bundled }
    return bundled
  }

  return null
}

function getModelsDevProviders(data: any): Record<string, any> {
  const providers = data?.providers || data
  return providers && typeof providers === 'object' && !Array.isArray(providers) ? providers : {}
}

function inferProtocolFromModelsDevProvider(provider: any): AIProviderProtocol | null {
  const npmPackage = String(provider?.npm || '').trim()
  if (npmPackage === '@ai-sdk/openai-compatible') return 'openai-compatible'
  if (npmPackage === '@ai-sdk/xai') return 'openai-compatible'
  if (npmPackage === '@openrouter/ai-sdk-provider') return 'openai-compatible'
  if (npmPackage === '@ai-sdk/openai') return 'openai-responses'
  if (npmPackage === '@ai-sdk/anthropic') return 'anthropic'
  if (npmPackage === '@ai-sdk/google') return 'google'
  return null
}

function getModelsDevProviderBaseURL(provider: any): string {
  const configured = String(provider?.api || '').trim().replace(/\/+$/, '')
  if (configured) return configured
  if (String(provider?.npm || '').trim() === '@ai-sdk/xai') return 'https://api.x.ai/v1'
  return ''
}

function getModelsDevProviderLogo(providerId: string): string {
  return `${MODELS_DEV_SOURCE.replace(/\/+$/, '')}/logos/${providerId}.svg`
}

function buildModelsDevProviderMetadata(
  providerId: string,
  modelsDevProvider: any
): AIProviderMetadata | null {
  const protocol = inferProtocolFromModelsDevProvider(modelsDevProvider)
  if (!protocol) return null

  const baseURL = getModelsDevProviderBaseURL(modelsDevProvider)
  if (!baseURL && protocol === 'openai-compatible') return null

  const connection = {
    id: providerId,
    name: providerId,
    displayName: String(modelsDevProvider?.name || providerId),
    description: `${protocol} · ${modelsDevProvider?.npm || 'models.dev'}`,
    protocol,
    baseURL,
    website: modelsDevProvider?.doc || '',
    logo: getModelsDevProviderLogo(providerId)
  }

  return toMetadata(
    connection,
    readModelDetailsFromModelsDevProvider(connection.id, modelsDevProvider),
    getPricingFromModelsDevProvider(modelsDevProvider)
  )
}

async function fetchModelsDevData(): Promise<any> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  try {
    const response = await fetch(`${MODELS_DEV_SOURCE.replace(/\/+$/, '')}/api.json`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'CipherTalk' }
    })
    if (!response.ok) {
      throw new Error(`models.dev 请求失败: ${response.status}`)
    }
    return await response.json()
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchAndCacheModelsDevData(): Promise<any> {
  if (!modelsDevFetchPromise) {
    modelsDevFetchPromise = fetchModelsDevData()
      .then((data) => {
        modelsDevCache = { updatedAt: Date.now(), data }
        writeModelsDevCacheFile(data)
        return data
      })
      .finally(() => {
        modelsDevFetchPromise = null
      })
  }

  return modelsDevFetchPromise
}

async function getModelsDevData(): Promise<any> {
  const now = Date.now()
  if (modelsDevCache && now - modelsDevCache.updatedAt < MODELS_DEV_CACHE_MS) {
    return modelsDevCache.data
  }

  const diskCache = readModelsDevCacheFile()
  if (diskCache && now - diskCache.updatedAt < MODELS_DEV_CACHE_MS) {
    modelsDevCache = diskCache
    return diskCache.data
  }

  if (process.env.CIPHERTALK_DISABLE_MODELS_FETCH === '1') {
    if (diskCache) {
      modelsDevCache = diskCache
      return diskCache.data
    }
    const bundled = readBundledModelsDevData()
    if (bundled) {
      modelsDevCache = { updatedAt: now, data: bundled }
      return bundled
    }
    return {}
  }

  try {
    return await fetchAndCacheModelsDevData()
  } catch (error) {
    if (diskCache) {
      console.warn('[AIProviderCatalog] models.dev 在线获取失败，使用本地缓存:', error instanceof Error ? error.message : String(error))
      modelsDevCache = diskCache
      return diskCache.data
    }
    const bundled = readBundledModelsDevData()
    if (bundled) {
      console.warn('[AIProviderCatalog] models.dev 在线获取失败，使用内置快照:', error instanceof Error ? error.message : String(error))
      modelsDevCache = { updatedAt: now, data: bundled }
      return bundled
    }
    throw error
  }
}

export async function refreshModelsDevCache(force = false): Promise<void> {
  const now = Date.now()
  const diskCache = readModelsDevCacheFile()
  if (!force && diskCache && now - diskCache.updatedAt < MODELS_DEV_CACHE_MS) {
    modelsDevCache = diskCache
    return
  }

  if (process.env.CIPHERTALK_DISABLE_MODELS_FETCH === '1') {
    if (diskCache) modelsDevCache = diskCache
    return
  }

  const data = await fetchModelsDevData()
  modelsDevCache = { updatedAt: Date.now(), data }
  writeModelsDevCacheFile(data)
}

function normalizeModelsDevProviderId(providerId: string): string[] {
  const aliases: Record<string, string[]> = {
    gemini: ['google'],
    qwen: ['alibaba-cn'],
    doubao: ['bytedance', 'volcengine', 'doubao'],
    kimi: ['moonshotai-cn'],
    siliconflow: ['siliconflow-cn'],
    zhipu: ['zhipuai'],
    tencent: ['tencent-tokenhub']
  }
  return aliases[providerId] || [providerId]
}

function getModelsDevProvider(data: any, providerId: string): any | undefined {
  const providers = getModelsDevProviders(data)
  for (const candidate of normalizeModelsDevProviderId(providerId)) {
    if (providers?.[candidate]) return providers[candidate]
  }
  return undefined
}

function getModelsDevModelEntries(provider: any): any[] {
  const models = provider?.models || provider
  if (Array.isArray(models)) return models
  if (models && typeof models === 'object') return Object.values(models)
  return []
}

function isTextChatModel(model: any): boolean {
  const input = Array.isArray(model?.modalities?.input) ? model.modalities.input : []
  const output = Array.isArray(model?.modalities?.output) ? model.modalities.output : []
  if (output.length > 0 && !output.includes('text')) return false
  if (input.length > 0 && !input.includes('text')) return false
  const id = String(model?.id || model?.name || '').toLowerCase()
  return !['embedding', 'rerank', 'whisper', 'tts', 'transcribe', 'speech', 'moderation', 'dall-e', 'image'].some(pattern => id.includes(pattern))
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => String(item || '').trim()).filter(Boolean) : []
}

function optionalNumber(value: unknown): number | undefined {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : undefined
}

function readModelDetailsFromModelsDevProvider(providerId: string, provider: any): AIModelInfo[] {
  return getModelsDevModelEntries(provider)
    .filter(isTextChatModel)
    .map((model: any): AIModelInfo | null => {
      const id = String(model?.id || model?.name || '').replace(/^models\//, '').trim()
      if (!id) return null

      return {
        id,
        name: String(model?.name || id),
        providerId,
        family: model?.family ? String(model.family) : undefined,
        modalities: {
          input: toStringArray(model?.modalities?.input),
          output: toStringArray(model?.modalities?.output)
        },
        capabilities: {
          attachment: Boolean(model?.attachment),
          reasoning: Boolean(model?.reasoning),
          toolCall: Boolean(model?.tool_call),
          structuredOutput: Boolean(model?.structured_output),
          temperature: model?.temperature !== false,
          openWeights: Boolean(model?.open_weights)
        },
        limits: {
          context: optionalNumber(model?.limit?.context),
          input: optionalNumber(model?.limit?.input),
          output: optionalNumber(model?.limit?.output)
        },
        cost: model?.cost ? {
          input: optionalNumber(model.cost.input),
          output: optionalNumber(model.cost.output),
          cacheRead: optionalNumber(model.cost.cache_read),
          cacheWrite: optionalNumber(model.cost.cache_write),
          inputAudio: optionalNumber(model.cost.input_audio),
          outputAudio: optionalNumber(model.cost.output_audio),
          reasoning: optionalNumber(model.cost.reasoning),
          tiers: Array.isArray(model.cost.tiers) ? model.cost.tiers : undefined,
          contextOver200k: model.cost.context_over_200k
        } : undefined,
        status: model?.status ? String(model.status) : undefined,
        knowledge: model?.knowledge ? String(model.knowledge) : undefined,
        releaseDate: model?.release_date ? String(model.release_date) : undefined,
        lastUpdated: model?.last_updated ? String(model.last_updated) : undefined,
        interleaved: model?.interleaved ? { field: model.interleaved.field ? String(model.interleaved.field) : undefined } : undefined,
        provider: (model?.provider || provider?.npm || provider?.api) ? {
          npm: model?.provider?.npm ? String(model.provider.npm) : (provider?.npm ? String(provider.npm) : undefined),
          api: model?.provider?.api ? String(model.provider.api) : (provider?.api ? String(provider.api) : undefined),
          shape: model?.provider?.shape ? String(model.provider.shape) : undefined
        } : undefined
      }
    })
    .filter((model): model is AIModelInfo => Boolean(model))
}

function getPricingFromModelsDevProvider(provider: any): { pricing: string; pricingDetail: { input: number; output: number } } {
  const pricedModels = getModelsDevModelEntries(provider)
    .filter(isTextChatModel)
    .map((model: any) => ({
      input: Number(model?.cost?.input),
      output: Number(model?.cost?.output)
    }))
    .filter(item => Number.isFinite(item.input) && Number.isFinite(item.output))

  if (pricedModels.length === 0) return EMPTY_PRICING

  const cheapest = pricedModels.reduce((best, item) => (
    item.input + item.output < best.input + best.output ? item : best
  ), pricedModels[0])

  return {
    pricing: `$${cheapest.input}/1M input, $${cheapest.output}/1M output 起`,
    pricingDetail: {
      input: cheapest.input / 1000,
      output: cheapest.output / 1000
    }
  }
}

function sortProviderDefinitions(providers: AIProviderMetadata[]): AIProviderMetadata[] {
  return [...providers].sort((a, b) => {
    return a.displayName.localeCompare(b.displayName, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
  })
}

function withCustomProvider(providers: AIProviderMetadata[]): AIProviderMetadata[] {
  return [
    cloneMetadata(CUSTOM_PROVIDER_DEFINITION),
    cloneMetadata(CODEX_SUBSCRIPTION_PROVIDER_DEFINITION),
    ...providers.filter(provider => provider.id !== CUSTOM_PROVIDER_DEFINITION.id && provider.id !== CODEX_SUBSCRIPTION_PROVIDER_ID)
  ]
}

function getProviderDefinitionsFromModelsDevData(data: any): AIProviderMetadata[] {
  const result = new Map<string, AIProviderMetadata>()
  const providers = getModelsDevProviders(data)
  for (const [providerId, modelsDevProvider] of Object.entries(providers)) {
    const metadata = buildModelsDevProviderMetadata(providerId, modelsDevProvider)
    if (!metadata || metadata.modelDetails?.length === 0) continue
    result.set(metadata.id, metadata)
  }

  return sortProviderDefinitions(Array.from(result.values()))
}

export async function getProviderDefinitions(): Promise<AIProviderMetadata[]> {
  try {
    const data = await getModelsDevData()
    return withCustomProvider(getProviderDefinitionsFromModelsDevData(data))
  } catch (error) {
    console.warn('[AIProviderCatalog] models.dev 获取失败，使用可用缓存:', error instanceof Error ? error.message : String(error))
    const data = readAvailableModelsDevData()
    if (data) return withCustomProvider(getProviderDefinitionsFromModelsDevData(data))
    return withCustomProvider([])
  }
}

export function getProviderDefinition(providerId: string): AIProviderMetadata | undefined {
  const resolvedProviderId = normalizeProviderId(providerId)
  if (resolvedProviderId === CODEX_SUBSCRIPTION_PROVIDER_ID) {
    return cloneMetadata(CODEX_SUBSCRIPTION_PROVIDER_DEFINITION)
  }
  if (resolvedProviderId === CUSTOM_PROVIDER_DEFINITION.id) {
    return cloneMetadata(CUSTOM_PROVIDER_DEFINITION)
  }

  const data = readAvailableModelsDevData()
  if (data) {
    const definition = getProviderDefinitionsFromModelsDevData(data).find(provider => provider.id === resolvedProviderId)
    if (definition) return cloneMetadata(definition)
  }

  return undefined
}

export async function getProviderDefinitionOnline(providerId: string): Promise<AIProviderMetadata | undefined> {
  const resolvedProviderId = normalizeProviderId(providerId)
  if (resolvedProviderId === CODEX_SUBSCRIPTION_PROVIDER_ID) {
    return cloneMetadata(CODEX_SUBSCRIPTION_PROVIDER_DEFINITION)
  }
  if (resolvedProviderId === CUSTOM_PROVIDER_DEFINITION.id) {
    return cloneMetadata(CUSTOM_PROVIDER_DEFINITION)
  }

  const data = await getModelsDevData()
  const definition = getProviderDefinitionsFromModelsDevData(data).find(provider => provider.id === resolvedProviderId)
  return definition
}

export class CatalogAIProvider extends BaseAIProvider {
  name: string
  displayName: string
  models: string[]
  pricing: { input: number; output: number }
  private definition: AIProviderMetadata

  constructor(definition: AIProviderMetadata, apiKey: string, baseURL?: string) {
    const effectiveBaseURL = baseURL || definition.baseURL
    super(
      definition.protocol === 'codex-subscription' ? CODEX_SUBSCRIPTION_DUMMY_API_KEY : apiKey,
      definition.protocol === 'codex-subscription' ? 'https://api.openai.com/v1' : effectiveBaseURL,
      definition.protocol,
      definition.protocol === 'codex-subscription' ? getCodexSubscriptionAuthPath() : undefined,
    )
    this.definition = definition
    this.name = definition.name
    this.displayName = definition.displayName
    this.models = definition.models
    this.pricing = definition.pricingDetail
  }

  protected getDefaultHeaders(): Record<string, string> | undefined {
    if (this.definition.id !== 'tencent' || !this.apiKey.includes('|')) {
      return undefined
    }

    const [secretId, secretKey] = this.apiKey.split('|').map(part => part.trim())
    if (!secretId || !secretKey) return undefined
    return { Authorization: `Bearer ${secretId};${secretKey}` }
  }

}

export async function getModelsDevModels(providerId: string): Promise<string[]> {
  const resolvedProviderId = normalizeProviderId(providerId)
  if (resolvedProviderId === CUSTOM_PROVIDER_DEFINITION.id || resolvedProviderId === CODEX_SUBSCRIPTION_PROVIDER_ID) return []

  const data = await getModelsDevData()
  const provider = getModelsDevProvider(data, resolvedProviderId)
  return provider ? Array.from(new Set(readModelDetailsFromModelsDevProvider(resolvedProviderId, provider).map(model => model.id))) : []
}

export async function getModelsDevModelDetails(providerId: string): Promise<AIModelInfo[]> {
  const resolvedProviderId = normalizeProviderId(providerId)
  if (resolvedProviderId === CUSTOM_PROVIDER_DEFINITION.id || resolvedProviderId === CODEX_SUBSCRIPTION_PROVIDER_ID) return []

  const data = await getModelsDevData()
  const provider = getModelsDevProvider(data, resolvedProviderId)
  return provider ? readModelDetailsFromModelsDevProvider(resolvedProviderId, provider) : []
}
