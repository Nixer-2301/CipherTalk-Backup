// 各家在线转写接口的 URL 解析：宽容处理用户填的是「基地址」还是「完整接口地址」。

export function resolveTranscriptionUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '')
  if (!trimmed) return ''

  try {
    const url = new URL(trimmed)
    if (url.pathname.endsWith('/audio/transcriptions')) {
      return url.toString()
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/audio/transcriptions`
    return url.toString()
  } catch {
    return trimmed
  }
}

export function resolveModelsUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '')
  if (!trimmed) return ''

  try {
    const url = new URL(trimmed)
    if (url.pathname.endsWith('/audio/transcriptions')) {
      url.pathname = url.pathname.replace(/\/audio\/transcriptions$/, '/models')
    } else {
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`
    }
    return url.toString()
  } catch {
    return trimmed
  }
}

export function resolveAliyunChatUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '')
  if (!trimmed) return ''

  try {
    const url = new URL(trimmed)
    if (url.pathname.endsWith('/chat/completions')) {
      return url.toString()
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`
    return url.toString()
  } catch {
    return trimmed
  }
}

// 火山豆包极速版固定端点；只填了域名时自动补全 flash 路径
const VOLCANO_FLASH_PATH = '/api/v3/auc/bigmodel/recognize/flash'

export function resolveVolcanoUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '')
  if (!trimmed) return ''

  try {
    const url = new URL(trimmed)
    if (url.pathname && url.pathname !== '/') {
      return url.toString()
    }
    url.pathname = VOLCANO_FLASH_PATH
    return url.toString()
  } catch {
    return trimmed
  }
}

// 脱敏打印 API Key，便于排错又不泄露完整密钥
export function maskKey(apiKey: string): string {
  return apiKey ? `${apiKey.slice(0, 6)}…${apiKey.slice(-4)} (len=${apiKey.length})` : '(空)'
}
