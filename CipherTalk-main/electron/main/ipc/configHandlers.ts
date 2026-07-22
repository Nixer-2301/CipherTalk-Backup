import { ipcMain } from 'electron'
import type { MainProcessContext } from '../context'
import { chatService } from '../../services/chatService'
import { clearMessageDbScannerCache } from '../../services/messageDbScanner'

function clearStatsCaches(): void {
  clearMessageDbScannerCache()
  chatService.close()
}

export function registerConfigHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('config:get', async (_, key: string) => {
    return ctx.getConfigService()?.get(key as any)
  })

  ipcMain.handle('config:set', async (_, key: string, value: any) => {
    const result = ctx.getConfigService()?.set(key as any, value)
    ctx.broadcastToWindows('config:changed', { key, value })
    if (['myWxid', 'dbPath', 'decryptKey'].includes(key)) clearStatsCaches()
    return result
  })

  ipcMain.handle('config:getTldCache', async () => {
    return ctx.getConfigService()?.getTldCache()
  })

  ipcMain.handle('config:setTldCache', async (_, tlds: string[]) => {
    return ctx.getConfigService()?.setTldCache(tlds)
  })
}
