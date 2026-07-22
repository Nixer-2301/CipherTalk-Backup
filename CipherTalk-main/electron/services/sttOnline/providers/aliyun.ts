import type { OnlineSttProvider, OnlineTranscribeConfig, TranscribeResult, TestResult } from '../types'
import { maskKey, resolveAliyunChatUrl, resolveModelsUrl } from '../urls'

// 阿里云 DashScope 兼容入口（qwen3-asr-flash 等），千问云同端点共用此实现。
// 走 /chat/completions + input_audio 流式（SSE），逐 chunk 拼接识别文本。

function extractTextFromContent(content: any): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item
        return item?.text || item?.transcript || item?.content || ''
      })
      .join('')
  }
  return String(content?.text || content?.transcript || content?.content || '')
}

async function transcribe(
  wavData: Buffer,
  config: OnlineTranscribeConfig,
  signal: AbortSignal,
  onPartial?: (text: string) => void
): Promise<TranscribeResult> {
  const dataUrl = `data:audio/wav;base64,${wavData.toString('base64')}`
  const requestUrl = resolveAliyunChatUrl(config.baseURL)
  console.log('[STT-Online][Aliyun] 发起转写请求', {
    provider: config.provider,
    url: requestUrl,
    model: config.model,
    apiKey: maskKey(config.apiKey),
    audioBytes: wavData.length
  })

  const response = await fetch(requestUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.model,
      stream: true,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: {
                data: dataUrl,
                format: 'wav'
              }
            }
          ]
        }
      ]
    }),
    signal
  })

  console.log('[STT-Online][Aliyun] 响应状态', response.status, response.statusText)

  if (!response.ok) {
    let rawBody = ''
    try {
      rawBody = await response.text()
    } catch {
      rawBody = ''
    }
    let payload: any = null
    try {
      payload = rawBody ? JSON.parse(rawBody) : null
    } catch {
      payload = null
    }

    console.error('[STT-Online][Aliyun] 转写失败', {
      status: response.status,
      url: requestUrl,
      model: config.model,
      body: rawBody || '(空响应体)'
    })

    const serverMessage = payload?.error?.message || payload?.message || rawBody?.slice(0, 300)

    if (response.status === 401) {
      return {
        success: false,
        error: serverMessage ? `在线转写认证失败：${serverMessage}` : '在线转写认证失败，请检查 API Key'
      }
    }
    if (response.status === 403) {
      // 403 多为额度耗尽或无该模型权限，而非 Key 错误
      return {
        success: false,
        error: serverMessage
          ? `在线转写被拒绝 (403)：${serverMessage}`
          : '在线转写被拒绝 (403)，可能是免费额度耗尽或无该模型权限，请到控制台检查'
      }
    }
    if (response.status === 429) {
      return { success: false, error: '阿里云在线转写请求过于频繁或额度不足，请稍后重试' }
    }
    const message = serverMessage || `HTTP ${response.status}`
    return { success: false, error: `阿里云在线转写失败: ${message}` }
  }

  if (!response.body) {
    return { success: false, error: '阿里云在线转写未返回可读取的数据流' }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let transcript = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split('\n\n')
    buffer = events.pop() || ''

    for (const event of events) {
      const dataLines = event
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('data:'))

      for (const line of dataLines) {
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue

        try {
          const chunk = JSON.parse(data)
          const delta = chunk?.choices?.[0]?.delta
          const text = extractTextFromContent(delta?.content)
          if (text) {
            transcript += text
            onPartial?.(transcript)
          }
        } catch {
          // ignore malformed chunk
        }
      }
    }
  }

  transcript = transcript.trim()
  if (!transcript) {
    return { success: false, error: '阿里云接口返回成功，但未提取到识别文本' }
  }

  return { success: true, transcript }
}

async function test(config: OnlineTranscribeConfig, signal: AbortSignal): Promise<TestResult> {
  const response = await fetch(resolveModelsUrl(config.baseURL), {
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
  if (response.status === 404) {
    return { success: false, error: '接口 URL 不可用，请确认是否为 DashScope 兼容入口地址' }
  }
  return { success: false, error: `在线转写配置测试失败: HTTP ${response.status}` }
}

export const aliyunProvider: OnlineSttProvider = { transcribe, test }
