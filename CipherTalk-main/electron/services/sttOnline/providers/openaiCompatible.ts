import type { OnlineSttProvider, OnlineTranscribeConfig, TranscribeResult, TestResult } from '../types'
import { resolveModelsUrl, resolveTranscriptionUrl } from '../urls'

// OpenAI 兼容的 /audio/transcriptions（multipart 上传）；'custom' 直接按用户填写的完整 URL 请求。
// 两者共用同一上传/解析逻辑，仅 URL 解析与测试容错策略不同。

function resolveRequestUrl(config: OnlineTranscribeConfig): string {
  return config.provider === 'custom' ? config.baseURL.trim() : resolveTranscriptionUrl(config.baseURL)
}

function resolveTestUrl(config: OnlineTranscribeConfig): string {
  return config.provider === 'custom' ? config.baseURL.trim() : resolveModelsUrl(config.baseURL)
}

async function transcribe(
  wavData: Buffer,
  config: OnlineTranscribeConfig,
  signal: AbortSignal
): Promise<TranscribeResult> {
  const form = new FormData()
  const file = new Blob([new Uint8Array(wavData)], { type: 'audio/wav' })
  form.append('file', file, 'voice.wav')
  form.append('model', config.model)
  if (config.language && config.language !== 'auto') {
    form.append('language', config.language)
  }
  form.append('response_format', 'json')

  const response = await fetch(resolveRequestUrl(config), {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: form,
    signal
  })

  let payload: any = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return { success: false, error: '在线转写认证失败，请检查 API Key' }
    }
    if (response.status === 429) {
      return { success: false, error: '在线转写请求过于频繁或额度不足，请稍后重试' }
    }
    const message = payload?.error?.message || payload?.message || `HTTP ${response.status}`
    return { success: false, error: `在线转写失败: ${message}` }
  }

  const transcript = String(payload?.text || payload?.transcript || '').trim()
  if (!transcript) {
    return { success: false, error: '在线转写成功但未返回文本结果' }
  }
  return { success: true, transcript }
}

async function test(config: OnlineTranscribeConfig, signal: AbortSignal): Promise<TestResult> {
  const response = await fetch(resolveTestUrl(config), {
    method: 'GET',
    headers: { Authorization: `Bearer ${config.apiKey}` },
    signal
  })

  if (response.ok) {
    return { success: true }
  }
  if (response.status === 401 || response.status === 403) {
    return { success: false, error: '在线转写认证失败，请检查 API Key' }
  }
  // 自定义接口对 GET 可能返回这些状态码，但说明地址可达
  if (config.provider === 'custom' && [400, 405, 415].includes(response.status)) {
    return { success: true }
  }
  if (response.status === 404) {
    return {
      success: false,
      error:
        config.provider === 'custom'
          ? '自定义接口 URL 不可用，请确认你填写的是完整接口地址'
          : '接口 URL 不可用，请确认它是否为 OpenAI 兼容接口或对应的 /v1 地址'
    }
  }
  return { success: false, error: `在线转写配置测试失败: HTTP ${response.status}` }
}

export const openaiCompatibleProvider: OnlineSttProvider = { transcribe, test }
