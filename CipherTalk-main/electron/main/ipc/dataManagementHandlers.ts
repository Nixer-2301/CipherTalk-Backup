import { ipcMain } from 'electron'
import { dataManagementService } from '../../services/dataManagementService'
import type { MainProcessContext } from '../context'

/**
 * 数据管理 IPC。
 *
 * Direct DB 迁移后，旧的数据库落地解密/增量更新/缓存迁移/自动更新链路已废弃，
 * 这里的 handler 保留 channel 以兼容前端旧代码，统一返回"已废弃"语义，避免
 * 渲染端因 "No handler registered" 报错。真正的实时变更通过新的
 * `wcdb:change` 广播通道推送。
 */
export function registerDataManagementHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('dataManagement:scanDatabases', async () => {
    return dataManagementService.scanDatabases()
  })

  ipcMain.handle('dataManagement:decryptAll', async () => {
    console.warn('[ipc] dataManagement:decryptAll is deprecated after direct-db migration')
    return { success: true, successCount: 0, failCount: 0, skipped: true }
  })

  ipcMain.handle('dataManagement:decryptSingleDatabase', async (_, _filePath: string) => {
    console.warn('[ipc] dataManagement:decryptSingleDatabase is deprecated after direct-db migration')
    return { success: true, skipped: true }
  })

  ipcMain.handle('dataManagement:incrementalUpdate', async () => {
    console.warn('[ipc] dataManagement:incrementalUpdate is deprecated after direct-db migration')
    return { success: true, successCount: 0, failCount: 0, skipped: true }
  })

  ipcMain.handle('dataManagement:getCurrentCachePath', async () => {
    return dataManagementService.getCurrentCachePath()
  })

  ipcMain.handle('dataManagement:getDefaultCachePath', async () => {
    return dataManagementService.getDefaultCachePath()
  })

  ipcMain.handle('dataManagement:migrateCache', async (_, _newCachePath: string) => {
    console.warn('[ipc] dataManagement:migrateCache is deprecated after direct-db migration')
    return { success: true, movedCount: 0, skipped: true }
  })

  ipcMain.handle('dataManagement:scanImages', async (_, dirPath: string) => {
    return dataManagementService.scanImages(dirPath)
  })

  ipcMain.handle('dataManagement:decryptImages', async (_, dirPath: string) => {
    return dataManagementService.decryptImages(dirPath)
  })

  ipcMain.handle('dataManagement:getImageDirectories', async () => {
    return dataManagementService.getImageDirectories()
  })

  ipcMain.handle('dataManagement:decryptSingleImage', async (_, filePath: string) => {
    return dataManagementService.decryptSingleImage(filePath)
  })

  ipcMain.handle('dataManagement:checkForUpdates', async () => {
    console.warn('[ipc] dataManagement:checkForUpdates is deprecated after direct-db migration')
    return { hasUpdate: false, updateCount: 0, skipped: true }
  })

  ipcMain.handle('dataManagement:enableAutoUpdate', async (_, _intervalSeconds?: number) => {
    console.warn('[ipc] dataManagement:enableAutoUpdate is deprecated after direct-db migration')
    return { success: true, skipped: true }
  })

  ipcMain.handle('dataManagement:disableAutoUpdate', async () => {
    console.warn('[ipc] dataManagement:disableAutoUpdate is deprecated after direct-db migration')
    return { success: true, skipped: true }
  })

  ipcMain.handle('dataManagement:autoIncrementalUpdate', async (_, _silent?: boolean) => {
    console.warn('[ipc] dataManagement:autoIncrementalUpdate is deprecated after direct-db migration')
    return { success: true, updated: false, skipped: true }
  })
}
