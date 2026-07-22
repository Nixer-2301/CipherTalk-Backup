import { net, protocol } from 'electron'
import { pathToFileURL } from 'url'
import { pluginManagerService } from '../services/pluginManagerService'
import { resolveMediaToken } from '../services/pluginMediaService'

/**
 * 本地媒体协议处理。
 * privileged scheme 仍在 main.ts 的 app ready 前注册；这里仅负责 ready 后绑定 handler。
 */
export function registerLocalProtocols(): void {
  protocol.handle('local-video', (request) => {
    // Windows 路径会包含反斜杠，转为 file URL 可识别的正斜杠格式。
    let filePath = decodeURIComponent(request.url.replace('local-video://', ''))
    filePath = filePath.replace(/\\/g, '/')
    console.log('[Protocol] 加载视频:', filePath)
    return net.fetch(`file:///${filePath}`)
  })

  protocol.handle('local-image', (request) => {
    let filePath = decodeURIComponent(request.url.replace('local-image://', ''))
    filePath = filePath.replace(/\\/g, '/')
    return net.fetch(`file:///${filePath}`)
  })
}

/**
 * ct-plugin:// 插件资源协议（见 PLUGIN_SYSTEM_PLAN.md §1、§4）。
 * - 每个插件独立 origin：ct-plugin://<plugin-id>/...
 * - 仅服务已启用插件自己目录内的文件，路径穿越由 pluginManagerService 拦截
 * - CSP 按 network 权限下发：未授权的插件在响应头层面禁止一切外联
 */
export function registerPluginProtocol(): void {
  protocol.handle('ct-plugin', async (request) => {
    const url = new URL(request.url)
    const pluginId = url.hostname
    const filePath = pluginManagerService.resolveResource(pluginId, url.pathname)
    if (!filePath) {
      return new Response('Not Found', { status: 404 })
    }

    const fileResponse = await net.fetch(pathToFileURL(filePath).toString())
    if (!fileResponse.ok) return fileResponse

    const headers = new Headers(fileResponse.headers)
    const hasNetwork = pluginManagerService.hasPermission(pluginId, 'network')
    // 'self' = 本插件 origin；样式允许 inline（构建产物常见）；脚本不允许 inline。
    // 无 network 权限时不出现任何 http(s)/ws 来源，数据无法外传。
    // ct-plugin-media: 是宿主签发的一次性媒体 URL，允许作为图片/媒体来源。
    const csp = hasNetwork
      ? "default-src 'self' data: blob: ct-plugin-media: https: wss:; script-src 'self'; style-src 'self' 'unsafe-inline'"
      : "default-src 'self' data: blob: ct-plugin-media:; script-src 'self'; style-src 'self' 'unsafe-inline'"
    headers.set('Content-Security-Policy', csp)
    return new Response(fileResponse.body, { status: fileResponse.status, headers })
  })

  // 插件媒体一次性 URL：token 短时效 + 绑定签发插件
  protocol.handle('ct-plugin-media', (request) => {
    const url = new URL(request.url)
    const referrer = request.headers.get('Referer') || request.headers.get('Origin')
    const filePath = resolveMediaToken(url.hostname, referrer)
    if (!filePath) return new Response('Not Found', { status: 404 })
    return net.fetch(pathToFileURL(filePath).toString())
  })
}
