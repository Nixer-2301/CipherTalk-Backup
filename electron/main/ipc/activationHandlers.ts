import { ipcMain } from 'electron'
import { activationService } from '../../services/activationService'
import type { MainProcessContext } from '../context'

/**
 * 激活授权 IPC。
 * 只迁移注册位置，不改变激活码验证、状态查询和缓存清理行为。
 */
export function registerActivationHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('activation:getDeviceId', async () => {
    return activationService.getDeviceId()
  })

  ipcMain.handle('activation:verifyCode', async (_, code: string) => {
    return activationService.verifyCode(code)
  })

  ipcMain.handle('activation:activate', async (_, code: string) => {
    return activationService.activate(code)
  })

  ipcMain.handle('activation:checkStatus', async () => {
    return activationService.checkActivation()
  })

  ipcMain.handle('activation:getTypeDisplayName', async (_, type: string | null) => {
    return activationService.getTypeDisplayName(type)
  })

  ipcMain.handle('activation:clearCache', async () => {
    activationService.clearCache()
    return true
  })

  // 缓存管理

}
