/**
 * 插件媒体一次性 URL（见 PLUGIN_SYSTEM_PLAN.md §5）。
 *
 * 大文件（解密图片、表情、视频）不走 postMessage 序列化，而是签发短时效 token，
 * 由 ct-plugin-media://<token> 协议流式提供。token 绑定签发它的插件 origin，
 * 过期或来源不符一律 404。
 */
import { randomBytes } from 'crypto'

const TOKEN_TTL_MS = 5 * 60 * 1000
const MAX_TOKENS = 2000

interface MediaGrant {
  filePath: string
  pluginId: string
  expiresAt: number
}

const grants = new Map<string, MediaGrant>()

function prune(): void {
  const now = Date.now()
  for (const [token, grant] of grants) {
    if (grant.expiresAt <= now) grants.delete(token)
  }
  // 极端情况下淘汰最旧的，防止恶意插件刷 token 占内存
  while (grants.size > MAX_TOKENS) {
    const oldest = grants.keys().next().value
    if (oldest === undefined) break
    grants.delete(oldest)
  }
}

export function issueMediaUrl(pluginId: string, filePath: string): string {
  prune()
  const token = randomBytes(16).toString('hex')
  grants.set(token, { filePath, pluginId, expiresAt: Date.now() + TOKEN_TTL_MS })
  return `ct-plugin-media://${token}`
}

/** referrerOrigin 来自协议请求头，用于校验请求方就是签发对象（防跨插件盗用） */
export function resolveMediaToken(token: string, referrerOrigin?: string | null): string | null {
  prune()
  const grant = grants.get(token)
  if (!grant) return null
  if (referrerOrigin && !referrerOrigin.startsWith(`ct-plugin://${grant.pluginId}`)) {
    return null
  }
  return grant.filePath
}
