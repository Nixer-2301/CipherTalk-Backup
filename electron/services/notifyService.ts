import { Notification, nativeImage } from 'electron'
import { readFile } from 'fs/promises'
import sharp from 'sharp'
import type { MainProcessContext } from '../main/context'
import { getNotificationIconPath } from '../main/windows/windowManager'
import { chatService } from './chatService'
import type { ChatSession } from './chat/types'

/**
 * 消息提醒服务（主进程）。
 *
 * 设计要点（性能优先）：
 * - 不新增轮询/定时器，挂在已有的 monitorBridge → chatService 'dbChange' 事件上。
 * - 默认全关：启用集合为空时第一行就 return，零额外查询/diff 开销。
 * - 只读 Session 表增量（summary/unreadCount/lastTimestamp），不扫消息库、不解密消息体。
 * - 判定"别人发来的新消息"：lastTimestamp 增大 且 unreadCount > 0（自己从微信发出去的会清未读）。
 * - 仅私聊；群聊/公众号一律不提醒。
 * - 正在看的会话（active session 且主窗口聚焦）抑制气泡。
 * - 桌宠开着 → 推气泡给桌宠窗口；没开 → 回退系统通知。
 */

const DEBOUNCE_MS = 400
// 新消息会把会话顶到列表前面，取前若干条足以覆盖；只在有人开启提醒时才查询。
const SESSION_QUERY_LIMIT = 120

export interface NotifyPayload {
  username: string
  displayName: string
  avatarUrl?: string
  preview: string
  timestamp: number
}

// 苹果 App 图标的圆角是超椭圆 |x|^n+|y|^n=1（n≈5），并非普通圆弧，故用参数方程采样成多边形当遮罩。
function squircleMaskSvg(size: number): string {
  const n = 5
  const r = size / 2
  const N = 180
  let pts = ''
  for (let i = 0; i < N; i++) {
    const t = (i / N) * 2 * Math.PI
    const c = Math.cos(t), s = Math.sin(t)
    const x = r + Math.sign(c) * r * Math.abs(c) ** (2 / n)
    const y = r + Math.sign(s) * r * Math.abs(s) ** (2 / n)
    pts += `${x.toFixed(2)},${y.toFixed(2)} `
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><polygon points="${pts.trim()}" fill="#fff"/></svg>`
}

interface SessionSnap {
  lastTs: number
  unread: number
}

export function isPrivateSession(session: ChatSession): boolean {
  const username = String(session.username || '')
  if (!username) return false
  if (username.includes('@chatroom')) return false
  if (username.startsWith('gh_')) return false
  if (session.isOfficialAccount || session.isOfficialFolder || session.isFoldGroup) return false
  return true
}

class NotifyService {
  private ctx: MainProcessContext | null = null
  private started = false
  private enabled = new Set<string>()
  private snapshot = new Map<string, SessionSnap>()
  private activeSessionId: string | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  private checking = false

  init(ctx: MainProcessContext): void {
    if (this.started) return
    this.started = true
    this.ctx = ctx

    const stored = ctx.getConfigService()?.get('notifySessions')
    if (Array.isArray(stored)) this.enabled = new Set(stored.filter((u) => typeof u === 'string'))

    // 复用已有的实时变更事件，不再额外监听文件/轮询
    chatService.on('dbChange', (payload: { table?: string }) => {
      const table = String(payload?.table || '')
      if (table !== 'Session' && table !== 'Message') return
      this.scheduleCheck()
    })

    // 启动时给已开启的会话播种一次快照，避免重启后第一条新消息被当成播种而漏弹
    if (this.enabled.size > 0) void this.seed()
  }

  getEnabledSessions(): string[] {
    return Array.from(this.enabled)
  }

  setSessionEnabled(username: string, on: boolean): void {
    const name = String(username || '').trim()
    if (!name) return
    if (on) {
      this.enabled.add(name)
      // 立即播种该会话快照，确保开启后到达的第一条新消息也能弹（避免被当成播种漏掉）
      void this.seed(name)
    } else {
      this.enabled.delete(name)
      this.snapshot.delete(name) // 关闭后清快照，下次再开重新播种
    }
    this.ctx?.getConfigService()?.set('notifySessions', Array.from(this.enabled))
    this.ctx?.broadcastToWindows('config:changed', { key: 'notifySessions', value: Array.from(this.enabled) })
  }

  setActiveSession(sessionId: string | null): void {
    this.activeSessionId = sessionId ? String(sessionId) : null
  }

  /** 静默播种快照（不弹提醒）：记录当前 lastTs/unread 作为基线。 */
  private async seed(onlyUsername?: string): Promise<void> {
    if (this.enabled.size === 0) return
    try {
      const result = await chatService.getSessions(0, SESSION_QUERY_LIMIT)
      if (!result.success || !Array.isArray(result.sessions)) return
      for (const session of result.sessions) {
        const username = String(session.username || '')
        if (onlyUsername ? username !== onlyUsername : !this.enabled.has(username)) continue
        this.snapshot.set(username, {
          lastTs: Number(session.lastTimestamp || session.sortTimestamp || 0),
          unread: Number(session.unreadCount || 0),
        })
      }
    } catch {
      // 播种失败（如库未连接）就留给首次 check 懒播种兜底
    }
  }

  private scheduleCheck(): void {
    if (this.enabled.size === 0) return // 默认全关：零开销快速返回
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.check()
    }, DEBOUNCE_MS)
  }

  private async check(): Promise<void> {
    if (this.enabled.size === 0 || this.checking) return
    this.checking = true
    try {
      const result = await chatService.getSessions(0, SESSION_QUERY_LIMIT)
      if (!result.success || !Array.isArray(result.sessions)) return

      for (const session of result.sessions) {
        const username = String(session.username || '')
        if (!this.enabled.has(username)) continue

        const cur: SessionSnap = {
          lastTs: Number(session.lastTimestamp || session.sortTimestamp || 0),
          unread: Number(session.unreadCount || 0),
        }
        const prev = this.snapshot.get(username)
        this.snapshot.set(username, cur)

        if (!prev) continue // 首次见到：静默播种，不补弹历史
        if (!isPrivateSession(session)) continue
        // 别人发来的新消息：有更新的时间线 且 存在未读
        if (cur.lastTs <= prev.lastTs || cur.unread <= 0) continue

        this.deliver(session, cur.lastTs)
      }
    } catch (e) {
      this.ctx?.getLogService()?.warn('Notify', '检查新消息提醒失败', { error: String(e) })
    } finally {
      this.checking = false
    }
  }

  private deliver(session: ChatSession, timestamp: number): void {
    const username = String(session.username || '')
    // 正在看这个会话且主窗口聚焦时不打扰
    if (username === this.activeSessionId && this.ctx?.getMainWindow()?.isFocused()) return

    const displayName = session.displayName || username
    const preview = String(session.summary || '').split('\n')[0].trim() || '发来一条新消息'
    const payload: NotifyPayload = {
      username,
      displayName,
      avatarUrl: session.avatarUrl,
      preview,
      timestamp,
    }

    if (this.ctx?.getWindowManager().isPetWindowOpen()) {
      this.ctx.broadcastToWindows('pet:notify', payload)
    } else {
      void this.showSystemNotification(payload)
    }
  }

  /** 头像可能是远程 http URL、data:URL 或本地路径，统一取原始字节。 */
  private async loadAvatarBuffer(avatarUrl?: string): Promise<Buffer | null> {
    if (!avatarUrl) return null
    try {
      if (avatarUrl.startsWith('data:')) {
        return Buffer.from(avatarUrl.slice(avatarUrl.indexOf(',') + 1), 'base64')
      }
      if (/^https?:\/\//.test(avatarUrl)) {
        const res = await fetch(avatarUrl)
        return res.ok ? Buffer.from(await res.arrayBuffer()) : null
      }
      return await readFile(avatarUrl)
    } catch {
      return null
    }
  }

  /** 头像裁成苹果 App 图标那种超椭圆（squircle）连续曲率圆角，透明背景。 */
  private async squircleAvatar(avatarUrl?: string): Promise<Electron.NativeImage | null> {
    const src = await this.loadAvatarBuffer(avatarUrl)
    if (!src) return null
    try {
      const size = 256
      const png = await sharp(src)
        .resize(size, size, { fit: 'cover' })
        .composite([{ input: Buffer.from(squircleMaskSvg(size)), blend: 'dest-in' }])
        .png()
        .toBuffer()
      const img = nativeImage.createFromBuffer(png)
      return img.isEmpty() ? null : img
    } catch {
      // sharp 处理失败（如格式不支持）就退回原图不裁角
      const img = nativeImage.createFromBuffer(src)
      return img.isEmpty() ? null : img
    }
  }

  private async showSystemNotification(payload: NotifyPayload): Promise<void> {
    if (!Notification.isSupported()) return
    try {
      const avatar = await this.squircleAvatar(payload.avatarUrl)
      const iconPath = getNotificationIconPath()
      // 优先发送者头像，拉取失败回退 App 图标
      const icon = avatar || (iconPath ? nativeImage.createFromPath(iconPath) : null)
      const notification = new Notification({
        title: payload.displayName,
        body: payload.preview,
        silent: false,
        ...(icon ? { icon } : {}),
      })
      notification.on('click', () => {
        const win = this.ctx?.getMainWindow()
        if (win && !win.isDestroyed()) {
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
        }
      })
      notification.show()
    } catch (e) {
      this.ctx?.getLogService()?.warn('Notify', '系统通知失败', { error: String(e) })
    }
  }
}

export const notifyService = new NotifyService()
