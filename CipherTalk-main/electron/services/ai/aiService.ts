import { ConfigService } from '../config'
import { AIProvider } from './providers/base'
import {
  CatalogAIProvider,
  getModelsDevModelDetails,
  getProviderDefinition,
  getProviderDefinitionOnline,
  getProviderDefinitions,
  normalizeProviderId,
  type AIModelInfo,
  type AIProviderProtocol
} from './providers/catalog'

class AIService {
  private configService: ConfigService

  constructor() {
    this.configService = new ConfigService()
  }

  async getAllProviders() {
    return getProviderDefinitions()
  }

  createProvider(providerName?: string, apiKey?: string, baseURLOverride?: string): AIProvider {
    return this.getProvider(providerName, apiKey, baseURLOverride)
  }

  private resolveProviderDefinition(providerName?: string, protocolOverride?: AIProviderProtocol) {
    const rawName = providerName || this.configService.getAICurrentProvider() || 'deepseek'
    const name = normalizeProviderId(rawName)
    const definition = getProviderDefinition(name)
    if (!definition) {
      throw new Error(`不支持的提供商: ${name}`)
    }

    const providerConfig = this.configService.getAIProviderConfig(name)
      || (rawName !== name ? this.configService.getAIProviderConfig(rawName) : null)
    return { name, definition, providerConfig }
  }

  private getProvider(providerName?: string, apiKey?: string, baseURLOverride?: string, protocolOverride?: AIProviderProtocol): AIProvider {
    const { name, definition, providerConfig } = this.resolveProviderDefinition(providerName, protocolOverride)
    const key = apiKey || providerConfig?.apiKey || ''
    const baseURL = baseURLOverride || providerConfig?.baseURL || definition.baseURL
    const effectiveDefinition = {
      ...definition,
      protocol: protocolOverride || providerConfig?.protocol || definition.protocol
    }

    if (!key && !definition.optionalApiKey) {
      throw new Error('未配置API密钥')
    }
    if (definition.allowCustomBaseURL && !baseURL) {
      throw new Error('自定义服务需要配置服务地址')
    }

    return new CatalogAIProvider(effectiveDefinition, key || name, baseURL)
  }

  estimateTokens(text: string): number {
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length
    const otherChars = text.length - chineseChars
    return Math.ceil(chineseChars / 1.5 + otherChars / 4)
  }

  estimateCost(tokenCount: number, providerName: string): number {
    const provider = this.getProvider(providerName)
    return (tokenCount / 1000) * provider.pricing.input
  }

  async testConnection(providerName: string, apiKey: string, baseURL?: string, protocol?: AIProviderProtocol, model?: string): Promise<{ success: boolean; error?: string; needsProxy?: boolean }> {
    try {
      const provider = this.getProvider(providerName, apiKey, baseURL, protocol)
      return await provider.testConnection(model)
    } catch (error) {
      return {
        success: false,
        error: `连接失败: ${String(error)}`,
        needsProxy: true
      }
    }
  }

  private normalizeRemoteModelList(models: string[]): string[] {
    const unique = Array.from(new Set(
      models
        .map((model) => String(model || '').trim())
        .filter(Boolean)
    ))

    const nonChatPatterns = [
      'embedding',
      'rerank',
      'whisper',
      'tts',
      'transcribe',
      'speech',
      'moderation',
      'dall-e',
      'image',
      'stable-diffusion'
    ]
    const chatModels = unique.filter((model) => {
      const lower = model.toLowerCase()
      return !nonChatPatterns.some((pattern) => lower.includes(pattern))
    })

    return chatModels.length > 0 ? chatModels : unique
  }

  private compareDiscoveredModels(a: string, b: string): number {
    const parseSortParts = (model: string) => {
      const lower = model.toLowerCase()
      const dateMatch = lower.match(/20\d{2}[-_.]?\d{2}[-_.]?\d{2}|20\d{4}/)
      const dateValue = dateMatch ? Number(dateMatch[0].replace(/\D/g, '')) : 0
      const numbers = Array.from(lower.matchAll(/\d+(?:\.\d+)?/g)).map(match => Number(match[0]))
      const family = lower
        .replace(/20\d{2}[-_.]?\d{2}[-_.]?\d{2}|20\d{4}/g, '')
        .replace(/\d+(?:\.\d+)?/g, '')
        .replace(/[-_.:]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      return {
        lower,
        family,
        numbers,
        dateValue,
        latest: lower.includes('latest')
      }
    }

    const left = parseSortParts(a)
    const right = parseSortParts(b)
    const familyCompare = left.family.localeCompare(right.family, 'en', { sensitivity: 'base' })
    if (familyCompare !== 0) return familyCompare
    if (left.latest !== right.latest) return left.latest ? -1 : 1
    if (left.dateValue !== right.dateValue) return right.dateValue - left.dateValue

    const maxLength = Math.max(left.numbers.length, right.numbers.length)
    for (let index = 0; index < maxLength; index += 1) {
      const leftNumber = left.numbers[index] ?? -1
      const rightNumber = right.numbers[index] ?? -1
      if (leftNumber !== rightNumber) return rightNumber - leftNumber
    }

    return left.lower.localeCompare(right.lower, 'en', { numeric: true, sensitivity: 'base' })
  }

  private mergeModelLists(provider: AIProvider, ...modelLists: string[][]): string[] {
    const result: string[] = []
    const seen = new Set<string>()
    const addModel = (model: string) => {
      const value = String(model || '').trim()
      if (!value) return
      const identity = provider.getModelIdentity(value) || value.toLowerCase()
      if (seen.has(identity)) return
      seen.add(identity)
      result.push(value)
    }

    provider.models.forEach(addModel)
    modelLists
      .flat()
      .filter(model => !seen.has(provider.getModelIdentity(model) || model.toLowerCase()))
      .sort((a, b) => this.compareDiscoveredModels(a, b))
      .forEach(addModel)

    return result
  }

  async listProviderModels(options: { provider: string; apiKey?: string; baseURL?: string; protocol?: AIProviderProtocol }): Promise<{ success: boolean; models?: string[]; modelDetails?: AIModelInfo[]; error?: string }> {
    try {
      const providerId = normalizeProviderId(options.provider)
      const onlineDefinition = await getProviderDefinitionOnline(providerId)
      const definition = onlineDefinition
      if (!definition) {
        throw new Error(`不支持的提供商: ${providerId}`)
      }
      const providerConfig = this.configService.getAIProviderConfig(providerId)
        || (options.provider !== providerId ? this.configService.getAIProviderConfig(options.provider) : null)
      const key = options.apiKey || providerConfig?.apiKey || ''
      const effectiveDefinition = {
        ...definition,
        protocol: options.protocol || providerConfig?.protocol || definition.protocol
      }
      const provider = new CatalogAIProvider(
        effectiveDefinition,
        key || providerId,
        options.baseURL || providerConfig?.baseURL || definition.baseURL
      )
      const [modelsDevDetails, remoteModels] = await Promise.all([
        getModelsDevModelDetails(providerId).catch((error) => {
          console.warn('[AIService] models.dev 获取模型列表失败:', error instanceof Error ? error.message : String(error))
          return []
        }),
        key || definition.optionalApiKey
          ? provider.listModels().catch((error) => {
              console.warn('[AIService] 服务商模型列表获取失败:', error instanceof Error ? error.message : String(error))
              return []
            })
          : Promise.resolve([])
      ])
      const modelsDevModels = modelsDevDetails.map(model => model.id)

      const models = this.mergeModelLists(
        provider,
        this.normalizeRemoteModelList(modelsDevModels),
        this.normalizeRemoteModelList(remoteModels)
      )
      if (models.length === 0) {
        return { success: false, error: '服务商未返回可用模型列表' }
      }
      const modelDetailsById = new Map(modelsDevDetails.map(model => [provider.getModelIdentity(model.id), model]))
      return {
        success: true,
        models,
        modelDetails: models
          .map(model => modelDetailsById.get(provider.getModelIdentity(model)))
          .filter((model): model is AIModelInfo => Boolean(model))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[AIService] 获取模型列表失败:', message)
      return { success: false, error: message }
    }
  }
}

export const aiService = new AIService()
