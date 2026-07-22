import { ipcMain } from 'electron'
import type { MainProcessContext } from '../context'
import { weixinBotService } from '../../services/deviceConnect/weixinBotService'

/**
 * 设备连接 IPC —— 目前仅微信（iLink 直连）。
 * 连接逻辑本体在 weixinBotService；状态/二维码经 broadcastToWindows 推回渲染端。
 */
export function registerDeviceConnectHandlers(ctx: MainProcessContext): void {
  weixinBotService.init(ctx)

  ipcMain.handle('deviceConnect:wechat:getStatus', () => weixinBotService.getStatus())

  ipcMain.handle('deviceConnect:wechat:connect', () => weixinBotService.startConnect())

  ipcMain.handle('deviceConnect:wechat:cancel', () => {
    weixinBotService.cancelConnect()
    return { success: true }
  })

  ipcMain.handle('deviceConnect:wechat:disconnect', async () => {
    await weixinBotService.disconnect()
    return { success: true }
  })
}
