import { ipcMain } from 'electron'
import type { MainProcessContext } from '../context'
import { chatService } from '../../services/chatService'
import { clearMessageDbScannerCache } from '../../services/messageDbScanner'

function clearStatsCaches(): void {
  clearMessageDbScannerCache()
  chatService.close()
}

export function registerAccountHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('accounts:list', async () => {
    return ctx.getConfigService()?.listAccounts() || []
  })

  ipcMain.handle('accounts:getActive', async () => {
    return ctx.getConfigService()?.getActiveAccount() || null
  })

  ipcMain.handle('accounts:setActive', async (_, accountId: string) => {
    const result = ctx.getConfigService()?.setActiveAccount(accountId) || null
    clearStatsCaches()
    return result
  })

  ipcMain.handle('accounts:save', async (_, profile: any) => {
    const result = ctx.getConfigService()?.saveAccount(profile) || null
    clearStatsCaches()
    return result
  })

  ipcMain.handle('accounts:update', async (_, accountId: string, patch: any) => {
    return ctx.getConfigService()?.updateAccount(accountId, patch) || null
  })

  ipcMain.handle('accounts:delete', async (_, accountId: string, deleteLocalData = false) => {
    const configService = ctx.getConfigService()
    if (!configService) {
      return { success: false, error: '配置服务未初始化' }
    }

    const deleted = configService.listAccounts().find((item) => item.id === accountId) || null
    if (!deleted) {
      return { success: false, error: '账号不存在' }
    }

    if (deleteLocalData) {
      // Direct DB 迁移后，账号已不再拥有独立的本地解密库目录。
      // 这里不再尝试删库，仅打印一条已废弃提示，仍继续按普通流程删除账号配置。
      console.warn('[ipc] accounts:delete(deleteLocalData=true) is deprecated after direct-db migration')
    }

    const result = configService.deleteAccount(accountId)
    clearStatsCaches()
    return { success: true, deleted: result.deleted, nextActiveAccountId: result.nextActiveAccountId }
  })
}
