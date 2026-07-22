import { Notification } from 'electron'
import type { MainProcessContext } from '../main/context'
import { getNotificationIconPath } from '../main/windows/windowManager'

/**
 * 桌宠纪念日/定时提醒服务（主进程）。
 *
 * - 提醒数据存 config key `petReminders`（PetsPage「互动」Tab 增删），本服务每 30s 轮询判定。
 * - once：到点触发后整条删除；错过超过 24h 直接作废删除（避免开机补发陈年提醒）。
 * - daily：每天到点触发一次，lastFired 记 YYYY-MM-DD 防重。
 * - yearly：纪念日，按 date 的月-日每年触发一次，lastFired 记年份防重；错过当天作废到明年。
 * - 触发时桌宠开着 → pet:bubble 气泡；没开 → 系统通知（点击拉起主窗口）。
 */

export interface PetReminder {
  id: string
  text: string
  kind: 'once' | 'daily' | 'yearly'
  /** YYYY-MM-DD；once 必填，yearly 取月-日，daily 不用 */
  date?: string
  /** HH:mm */
  time: string
  /** daily: YYYY-MM-DD；yearly: YYYY */
  lastFired?: string
}

const CHECK_INTERVAL_MS = 30_000
const ONCE_EXPIRE_MS = 24 * 3600 * 1000

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function parseTime(time: string): { hh: number; mm: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || '').trim())
  if (!m) return null
  const hh = Number(m[1])
  const mm = Number(m[2])
  if (hh > 23 || mm > 59) return null
  return { hh, mm }
}

function parseDate(date?: string): { y: number; mo: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || '').trim())
  if (!m) return null
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) }
}

/** 本次应触发的时间点（毫秒）；不该触发返回 null。 */
function dueMsFor(reminder: PetReminder, now: Date): number | null {
  const t = parseTime(reminder.time)
  if (!t) return null
  if (reminder.kind === 'once') {
    const d = parseDate(reminder.date)
    if (!d) return null
    return new Date(d.y, d.mo - 1, d.d, t.hh, t.mm).getTime()
  }
  if (reminder.kind === 'daily') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), t.hh, t.mm).getTime()
  }
  // yearly：用今年 + 提醒里的月-日
  const d = parseDate(reminder.date)
  if (!d) return null
  return new Date(now.getFullYear(), d.mo - 1, d.d, t.hh, t.mm).getTime()
}

class PetReminderService {
  private ctx: MainProcessContext | null = null
  private timer: NodeJS.Timeout | null = null

  init(ctx: MainProcessContext): void {
    if (this.timer) return
    this.ctx = ctx
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS)
  }

  private check(): void {
    const ctx = this.ctx
    const config = ctx?.getConfigService()
    if (!ctx || !config) return
    const stored = config.get('petReminders')
    if (!Array.isArray(stored) || stored.length === 0) return

    const now = new Date()
    const nowMs = now.getTime()
    const todayKey = localDateKey(now)
    const yearKey = String(now.getFullYear())
    const kept: PetReminder[] = []
    let changed = false

    for (const item of stored as PetReminder[]) {
      const due = item?.text ? dueMsFor(item, now) : null
      if (due === null) {
        kept.push(item)
        continue
      }
      if (item.kind === 'once') {
        if (nowMs < due) {
          kept.push(item)
          continue
        }
        // 到点：24h 内补发，超时作废；两种情况都移除
        if (nowMs - due <= ONCE_EXPIRE_MS) this.fire(item)
        changed = true
        continue
      }
      if (item.kind === 'daily') {
        if (nowMs >= due && item.lastFired !== todayKey) {
          this.fire(item)
          kept.push({ ...item, lastFired: todayKey })
          changed = true
        } else {
          kept.push(item)
        }
        continue
      }
      // yearly：限当天内触发，错过等明年
      if (nowMs >= due && nowMs - due <= ONCE_EXPIRE_MS && item.lastFired !== yearKey) {
        this.fire(item)
        kept.push({ ...item, lastFired: yearKey })
        changed = true
      } else {
        kept.push(item)
      }
    }

    if (changed) {
      config.set('petReminders', kept)
      ctx.broadcastToWindows('config:changed', { key: 'petReminders', value: kept })
    }
  }

  private fire(reminder: PetReminder): void {
    const ctx = this.ctx
    if (!ctx) return
    const title = reminder.kind === 'yearly' ? '纪念日' : '提醒'
    if (ctx.getWindowManager().isPetWindowOpen()) {
      ctx.broadcastToWindows('pet:bubble', { kind: 'reminder', title, text: reminder.text, id: reminder.id })
      return
    }
    if (!Notification.isSupported()) return
    try {
      const iconPath = getNotificationIconPath()
      const notification = new Notification({ title, body: reminder.text, silent: false, ...(iconPath ? { icon: iconPath } : {}) })
      notification.on('click', () => {
        const win = ctx.getMainWindow()
        if (win && !win.isDestroyed()) {
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
        }
      })
      notification.show()
    } catch (e) {
      ctx.getLogService()?.warn('PetReminder', '系统通知失败', { error: String(e) })
    }
  }
}

export const petReminderService = new PetReminderService()
