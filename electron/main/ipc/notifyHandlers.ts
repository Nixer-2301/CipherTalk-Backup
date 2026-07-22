import { ipcMain } from 'electron'
import type { MainProcessContext } from '../context'
import { notifyService } from '../../services/notifyService'

/**
 * 消息提醒 IPC。提醒逻辑本体在 notifyService（主进程，挂在 dbChange 事件上）。
 */
export function registerNotifyHandlers(ctx: MainProcessContext): void {
  notifyService.init(ctx)

  // 某会话当前是否开启提醒列表（渲染端用来回显铃铛状态）
  ipcMain.handle('notify:getEnabledSessions', async () => {
    return notifyService.getEnabledSessions()
  })

  // 开/关某会话的消息提醒
  ipcMain.handle('notify:setSessionEnabled', async (_, username: string, enabled: boolean) => {
    notifyService.setSessionEnabled(username, Boolean(enabled))
    return { success: true }
  })

  // 渲染端上报当前正在查看的会话（用于"正在看的不提醒"）；离开聊天页时传 null
  ipcMain.on('notify:setActiveSession', (_, sessionId: string | null) => {
    notifyService.setActiveSession(sessionId ?? null)
  })

  // 点击桌宠气泡：把主窗口带到前台
  ipcMain.on('notify:activate', () => {
    const win = ctx.getMainWindow()
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
}
