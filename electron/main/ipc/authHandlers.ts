import { ipcMain } from 'electron'
import { systemAuthService } from '../../services/systemAuthService'
import type { MainProcessContext } from '../context'

/**
 * 系统权限认证 IPC。
 * 仅转发 systemAuth:* 到系统认证服务，保持 channel 和返回结构不变。
 */
export function registerAuthHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('systemAuth:getStatus', async () => {
    return systemAuthService.getStatus()
  })

  ipcMain.handle('systemAuth:verify', async (_, reason?: string) => {
    return systemAuthService.verify(reason)
  })

  // 密钥获取相关

}
