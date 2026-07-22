/**
 * 在主进程解析当前 AI provider 配置，注入给 AI 子进程（子进程不依赖 ConfigService/catalog）。
 * 复用现有 ConfigService + catalog，不新增配置来源。
 */
import { ConfigService } from '../config'
import {
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  getProviderDefinition,
  normalizeProviderId,
} from '../ai/providers/catalog'
import { getResolvedProxyUrl } from '../ai/proxyFetch'
import { getCodexSubscriptionAuthPath, CODEX_SUBSCRIPTION_DUMMY_API_KEY } from '../ai/codexSubscriptionAuth'
import type { AgentProviderConfig, AgentProviderConfigOverride } from './types'

export function resolveProviderConfig(override?: AgentProviderConfigOverride | null): AgentProviderConfig {
  const config = new ConfigService()
  try {
    const name = normalizeProviderId(override?.provider || config.getAICurrentProvider() || 'deepseek')
    const def = getProviderDefinition(name)
    if (!def) throw new Error(`不支持的 AI 服务商: ${name}`)

    const providerConfig = {
      ...(config.getAIProviderConfig(name) || {}),
      ...(override || {}),
    }
    const isCodexSubscription = name === CODEX_SUBSCRIPTION_PROVIDER_ID
    const configuredProtocol = providerConfig?.protocol
    const providerKind = isCodexSubscription
      ? 'codex-subscription'
      : configuredProtocol === 'codex-subscription'
        ? def.protocol
        : configuredProtocol || def.protocol || 'openai-compatible'
    const apiKey = isCodexSubscription ? CODEX_SUBSCRIPTION_DUMMY_API_KEY : providerConfig?.apiKey || ''
    const baseURL = isCodexSubscription ? 'https://api.openai.com/v1' : providerConfig?.baseURL || def.baseURL || ''
    const model = providerConfig?.model || def.models?.[0] || ''
    if (!apiKey && !isCodexSubscription) throw new Error('未配置 AI 服务商的 API Key，请先在设置中配置')
    if (!model) throw new Error('未选择模型，请先在设置中选择模型')

    // 模型上下文窗口（token），供引擎 >90% 自动压缩判断用；自定义/未知模型取不到则留空，引擎兜默认值
    const contextWindow = def.modelDetails?.find((item) => item.id === model)?.limits?.context

    return {
      providerKind,
      name,
      apiKey,
      baseURL,
      model,
      ...(isCodexSubscription ? { authFilePath: getCodexSubscriptionAuthPath() } : {}),
      reasoningEffort: providerConfig?.reasoningEffort,
      proxyUrl: getResolvedProxyUrl() || undefined,
      contextWindow: typeof contextWindow === 'number' && contextWindow > 0 ? contextWindow : undefined,
      anthropicCacheTtl: config.get('anthropicCacheTtl') === '1h' ? '1h' : '5m',
    }
  } finally {
    config.close()
  }
}
