import { randomUUID } from 'crypto'
import type { OnlineSttProvider, OnlineTranscribeConfig, TranscribeResult, TestResult } from '../types'
import { maskKey, resolveVolcanoUrl } from '../urls'

// 火山引擎·豆包录音文件极速版（recognize/flash）：一次请求返回，base64 内联音频。
// 自定义 header 鉴权（新版控制台单 X-Api-Key），真实业务状态放在响应头 X-Api-Status-Code（20000000=成功）。

const DEFAULT_RESOURCE_ID = 'volc.bigasr.auc_turbo'

function buildHeaders(config: OnlineTranscribeConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Api-Key': config.apiKey,
    'X-Api-Resource-Id': config.model || DEFAULT_RESOURCE_ID,
    'X-Api-Request-Id': randomUUID(),
    'X-Api-Sequence': '-1'
  }
}

async function transcribe(
  wavData: Buffer,
  config: OnlineTranscribeConfig,
  signal: AbortSignal
): Promise<TranscribeResult> {
  const requestUrl = resolveVolcanoUrl(config.baseURL)
  const headers = buildHeaders(config)
  console.log('[STT-Online][Volcano] 发起转写请求', {
    url: requestUrl,
    resourceId: headers['X-Api-Resource-Id'],
    requestId: headers['X-Api-Request-Id'],
    apiKey: maskKey(config.apiKey),
    audioBytes: wavData.length
  })

  const response = await fetch(requestUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      user: { uid: 'ciphertalk' },
      audio: { data: wavData.toString('base64'), format: 'wav' },
      request: { model_name: 'bigmodel' }
    }),
    signal
  })

  const statusCode = response.headers.get('X-Api-Status-Code') || ''
  const apiMessage = response.headers.get('X-Api-Message') || ''
  const logId = response.headers.get('X-Tt-Logid') || ''
  console.log('[STT-Online][Volcano] 响应', { http: response.status, statusCode, apiMessage, logId })

  let payload: any = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  // 业务状态码优先：20000000 成功，其余为失败（火山把真实结果放在 X-Api-Status-Code 头）
  if (statusCode && statusCode !== '20000000') {
    console.error('[STT-Online][Volcano] 转写失败', { statusCode, apiMessage, logId, body: payload })
    if (statusCode === '20000003') {
      return { success: false, error: '火山豆包：未检测到人声（静音音频）' }
    }
    return { success: false, error: `火山豆包转写失败 (${statusCode})：${apiMessage || '未知错误'}` }
  }

  if (!response.ok && !statusCode) {
    if (response.status === 401 || response.status === 403) {
      return { success: false, error: '火山豆包认证失败，请检查 API Key 与 Resource-Id' }
    }
    return { success: false, error: `火山豆包转写失败: HTTP ${response.status}` }
  }

  const transcript = String(payload?.result?.text || '').trim()
  if (!transcript) {
    return { success: false, error: '火山豆包接口返回成功，但未提取到识别文本' }
  }
  return { success: true, transcript }
}

// 火山没有 models 探测端点：用空音频 POST 探测鉴权与链路，拿到任意业务状态码即视为可达
async function test(config: OnlineTranscribeConfig, signal: AbortSignal): Promise<TestResult> {
  const response = await fetch(resolveVolcanoUrl(config.baseURL), {
    method: 'POST',
    headers: buildHeaders(config),
    body: JSON.stringify({
      user: { uid: 'ciphertalk' },
      audio: { data: '', format: 'wav' },
      request: { model_name: 'bigmodel' }
    }),
    signal
  })

  if (response.status === 401 || response.status === 403) {
    return { success: false, error: '火山豆包认证失败，请检查 API Key' }
  }

  // 返回了业务状态码（如 45000002 空音频）说明 Key 与 Resource-Id 已通过，链路可达
  if (response.headers.get('X-Api-Status-Code') || response.ok) {
    return { success: true }
  }

  return { success: false, error: `火山豆包配置测试失败: HTTP ${response.status}` }
}

export const volcanoProvider: OnlineSttProvider = { transcribe, test }
