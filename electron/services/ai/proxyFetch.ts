/**
 * 给 AI SDK 调用注入代理 —— Node 全局 fetch(undici) 不认 https-proxy-agent 的 http.Agent，
 * 需用 undici 的 ProxyAgent 作 dispatcher。用 undici 自带的 fetch + ProxyAgent（同包，兼容）。
 *
 * 代理 URL 的跨进程流转：主进程靠 Electron session 探测系统代理（子进程无此 API），
 * 探测结果写入 config.aiResolvedProxyUrl；主/子进程都从 config 读（ConfigService 两边可用）。
 * 适用范围：http/https 代理。SOCKS 暂不支持（undici ProxyAgent 不支持），会回退直连。
 */
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import { ConfigService } from '../config'

const CONFIG_KEY = 'aiResolvedProxyUrl'

/** 读取已持久化的代理 URL（任意进程可用）。 */
export function getResolvedProxyUrl(): string | null {
  const cs = new ConfigService()
  try {
    const v = String(cs.get(CONFIG_KEY) || '').trim()
    return v || null
  } catch {
    return null
  } finally {
    cs.close()
  }
}

/**
 * 主进程：探测系统代理并持久化到 config，供子进程读取。
 * 子进程无 session API，proxyService 会返回 null（即写空 = 直连），故此函数实际只在主进程有意义。
 */
export async function refreshResolvedProxyUrl(): Promise<string | null> {
  try {
    const { proxyService } = await import('./proxyService')
    const url = await proxyService.getSystemProxy()
    const cs = new ConfigService()
    try {
      cs.set(CONFIG_KEY, url || '')
    } finally {
      cs.close()
    }
    return url || null
  } catch {
    return null
  }
}

/**
 * 把代理 URL 变成可注入 AI SDK provider 的 fetch；无代理 / SOCKS 返回 undefined → 走默认直连。
 */
export function createProxyFetch(proxyUrl?: string | null): typeof globalThis.fetch | undefined {
  if (!proxyUrl) return undefined
  if (proxyUrl.startsWith('socks')) {
    console.warn('[proxyFetch] 暂不支持 SOCKS 代理（undici ProxyAgent 仅 http/https），回退直连；建议改用 HTTP 代理端口。')
    return undefined
  }
  let dispatcher: ProxyAgent
  try {
    dispatcher = new ProxyAgent(proxyUrl)
  } catch (e) {
    console.error('[proxyFetch] 创建 ProxyAgent 失败，回退直连：', e)
    return undefined
  }
  const proxied = (input: any, init?: any) => undiciFetch(input, { ...init, dispatcher })
  return proxied as unknown as typeof globalThis.fetch
}
