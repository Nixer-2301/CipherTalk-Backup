import { ipcMain, shell } from 'electron'
import type { MainProcessContext } from '../context'
import { codexSubscriptionService } from '../../services/ai/codexSubscriptionService'

export function registerCodexSubscriptionHandlers(ctx: MainProcessContext): void {
  let loginPending = false

  codexSubscriptionService.onStatusChanged((status) => {
    ctx.broadcastToWindows('codexSubscription:statusChanged', status)
    if (!loginPending) return
    if (!status.authenticated) {
      if (status.error) loginPending = false
      return
    }
    loginPending = false
    const mainWindow = ctx.getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  ipcMain.handle('codexSubscription:getStatus', async () => codexSubscriptionService.getStatus())

  ipcMain.handle('codexSubscription:getUsage', async (_event, forceRefresh?: boolean) => {
    try {
      const usage = await codexSubscriptionService.getUsage(Boolean(forceRefresh))
      return { success: true, usage }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[codex-subscription:usage] IPC 调用失败:', message)
      return { success: false, error: message }
    }
  })

  ipcMain.handle('codexSubscription:login', async () => {
    try {
      const result = await codexSubscriptionService.startLogin()
      loginPending = true
      await shell.openExternal(result.authUrl)
      return { success: true, loginId: result.loginId }
    } catch (error) {
      loginPending = false
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('codexSubscription:importFromCodexCli', async () => {
    try {
      loginPending = false
      await codexSubscriptionService.importFromCodexCli()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('codexSubscription:listAccounts', async () => {
    try {
      const accounts = await codexSubscriptionService.listAccounts()
      return { success: true, accounts }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('codexSubscription:setActiveAccount', async (_event, id: string) => {
    try {
      await codexSubscriptionService.setActiveAccount(id)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('codexSubscription:removeAccount', async (_event, id: string) => {
    try {
      loginPending = false
      await codexSubscriptionService.removeAccount(id)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('codexSubscription:logout', async () => {
    try {
      loginPending = false
      await codexSubscriptionService.logout()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('codexSubscription:listModels', async () => {
    try {
      const models = await codexSubscriptionService.listModels()
      return { success: true, models }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
