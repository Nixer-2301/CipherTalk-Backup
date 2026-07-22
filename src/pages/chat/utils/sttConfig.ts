export async function checkOnlineSttConfigReady() {
  const [apiKey, baseURL, model] = await Promise.all([
    window.electronAPI.config.get('sttOnlineApiKey'),
    window.electronAPI.config.get('sttOnlineBaseURL'),
    window.electronAPI.config.get('sttOnlineModel')
  ])

  const missing: string[] = []
  if (!String(baseURL || '').trim()) missing.push('接口 URL')
  if (!String(apiKey || '').trim()) missing.push('API Key')
  if (!String(model || '').trim()) missing.push('模型名称')

  if (missing.length > 0) {
    return {
      ready: false,
      error: `在线转写配置不完整：缺少${missing.join('、')}，请先到设置页完善在线模式配置`
    }
  }

  return { ready: true }
}
