import { ipcMain } from 'electron'
import type { MainProcessContext } from '../context'

/**
 * 日志管理 IPC。
 * 日志服务在主窗口创建后才初始化，因此每次调用都从 context 读取最新实例。
 */
export function registerLogHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('log:getLogFiles', async () => {
    try {
      return { success: true, files: ctx.getLogService()?.getLogFiles() || [] }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('log:readLogFile', async (_, filename: string) => {
    try {
      const content = ctx.getLogService()?.readLogFile(filename)
      return { success: true, content }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('log:clearLogs', async () => {
    try {
      return ctx.getLogService()?.clearLogs() || { success: false, error: '????????' }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('log:getLogSize', async () => {
    try {
      const size = ctx.getLogService()?.getLogSize() || 0
      return { success: true, size }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('log:getLogDirectory', async () => {
    try {
      const directory = ctx.getLogService()?.getLogDirectory() || ''
      return { success: true, directory }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('log:setLogLevel', async (_, level: string) => {
    try {
      const logService = ctx.getLogService()
      if (!logService) {
        return { success: false, error: '????????' }
      }

      let logLevel: number
      switch (level.toUpperCase()) {
        case 'DEBUG':
          logLevel = 0
          break
        case 'INFO':
          logLevel = 1
          break
        case 'WARN':
          logLevel = 2
          break
        case 'ERROR':
          logLevel = 3
          break
        default:
          return { success: false, error: '???????' }
      }

      logService.setLogLevel(logLevel)
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('log:getLogLevel', async () => {
    try {
      const logService = ctx.getLogService()
      if (!logService) {
        return { success: false, error: '????????' }
      }

      const level = logService.getLogLevel()
      const levelNames = ['DEBUG', 'INFO', 'WARN', 'ERROR']
      return { success: true, level: levelNames[level] }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

}
