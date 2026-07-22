import { ConfigService } from './config'
import type {
  OnlineProvider,
  OnlineSttProvider,
  OnlineTranscribeConfig,
  OnlineTranscribeOverrides,
  TestResult,
  TranscribeResult
} from './sttOnline/types'
import { aliyunProvider } from './sttOnline/providers/aliyun'
import { volcanoProvider } from './sttOnline/providers/volcano'
import { openaiCompatibleProvider } from './sttOnline/providers/openaiCompatible'

export type { OnlineTranscribeConfig, OnlineProvider } from './sttOnline/types'

// 服务商注册表：新增一家在线转写服务 = 新建 sttOnline/providers/<name>.ts 并在此登记。
const PROVIDER_REGISTRY: Record<OnlineProvider, OnlineSttProvider> = {
  'aliyun-qwen-asr': aliyunProvider,
  'qianwen-cloud': aliyunProvider,
  'volcano-doubao': volcanoProvider,
  'openai-compatible': openaiCompatibleProvider,
  custom: openaiCompatibleProvider
}

export class VoiceTranscribeServiceOnline {
  private configService = new ConfigService()

  getConfig(): OnlineTranscribeConfig {
    return {
      provider: (this.configService.get('sttOnlineProvider') as OnlineProvider) || 'openai-compatible',
      apiKey: String(this.configService.get('sttOnlineApiKey') || '').trim(),
      baseURL: String(this.configService.get('sttOnlineBaseURL') || '').trim(),
      model: String(this.configService.get('sttOnlineModel') || '').trim(),
      language: String(this.configService.get('sttOnlineLanguage') || 'auto').trim() || 'auto',
      timeoutMs: Number(this.configService.get('sttOnlineTimeoutMs') || 60000) || 60000
    }
  }

  validateConfig(config = this.getConfig()): { valid: boolean; error?: string } {
    if (!config.baseURL) {
      return { valid: false, error: '请先配置在线转写接口 URL' }
    }
    try {
      new URL(config.baseURL)
    } catch {
      return { valid: false, error: '在线转写接口 URL 格式无效' }
    }
    if (!config.apiKey) {
      return { valid: false, error: '请先配置在线转写 API Key' }
    }
    if (!config.model) {
      return { valid: false, error: '请先配置在线转写模型名称' }
    }
    if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 5000) {
      return { valid: false, error: '在线转写超时时间配置无效' }
    }
    return { valid: true }
  }

  private getProvider(provider: OnlineProvider): OnlineSttProvider {
    return PROVIDER_REGISTRY[provider] || openaiCompatibleProvider
  }

  async testConfig(overrides?: OnlineTranscribeOverrides): Promise<TestResult> {
    const config = { ...this.getConfig(), ...overrides }
    const validation = this.validateConfig(config)
    if (!validation.valid) {
      return { success: false, error: validation.error }
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs)

    try {
      return await this.getProvider(config.provider).test(config, controller.signal)
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        return { success: false, error: '在线转写配置测试超时，请检查网络或缩短接口链路' }
      }
      return { success: false, error: `在线转写配置测试失败: ${String(e)}` }
    } finally {
      clearTimeout(timeout)
    }
  }

  async transcribeWavBuffer(
    wavData: Buffer,
    onPartial?: (text: string) => void
  ): Promise<TranscribeResult> {
    const config = this.getConfig()
    const validation = this.validateConfig(config)
    if (!validation.valid) {
      return { success: false, error: validation.error }
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs)

    try {
      return await this.getProvider(config.provider).transcribe(wavData, config, controller.signal, onPartial)
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        return { success: false, error: '在线转写请求超时，请稍后重试' }
      }
      return { success: false, error: `在线转写失败: ${String(e)}` }
    } finally {
      clearTimeout(timeout)
    }
  }
}

export const voiceTranscribeServiceOnline = new VoiceTranscribeServiceOnline()
