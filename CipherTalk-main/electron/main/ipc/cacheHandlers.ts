import { ipcMain } from 'electron'
import type { MainProcessContext } from '../context'

/**
 * 缓存清理 IPC。
 * CacheService 依赖当前 ConfigService，执行时从 context 读取以避免注册阶段空引用。
 */
export function registerCacheHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('cache:clearImages', async () => {
    ctx.getLogService()?.info('Cache', '开始清除图片缓存')
    try {
      const cacheService = new (await import('../../services/cacheService')).CacheService(ctx.getConfigService()!)
      const result = await cacheService.clearImages()
      if (result.success) {
        ctx.getLogService()?.info('Cache', '图片缓存清除成功')
      } else {
        ctx.getLogService()?.error('Cache', '图片缓存清除失败', { error: result.error })
      }
      return result
    } catch (e) {
      ctx.getLogService()?.error('Cache', '图片缓存清除异常', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('cache:clearEmojis', async () => {
    ctx.getLogService()?.info('Cache', '开始清除表情包缓存')
    try {
      const cacheService = new (await import('../../services/cacheService')).CacheService(ctx.getConfigService()!)
      const result = await cacheService.clearEmojis()
      if (result.success) {
        ctx.getLogService()?.info('Cache', '表情包缓存清除成功')
      } else {
        ctx.getLogService()?.error('Cache', '表情包缓存清除失败', { error: result.error })
      }
      return result
    } catch (e) {
      ctx.getLogService()?.error('Cache', '表情包缓存清除异常', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('cache:clearDatabases', async () => {
    // Direct DB 迁移后，不再有独立的数据库缓存需要清理。保留 channel，
    // 直接返回"已废弃"语义的成功结果，避免前端旧代码调用报错。
    console.warn('[ipc] cache:clearDatabases is deprecated after direct-db migration')
    ctx.getLogService()?.warn('Cache', 'cache:clearDatabases 已废弃，Direct DB 模式下无数据库缓存')
    return { success: true, skipped: true }
  })

  ipcMain.handle('cache:clearAIData', async () => {
    ctx.getLogService()?.info('Cache', '开始清除 AI 功能产生的数据库')
    try {
      const cacheService = new (await import('../../services/cacheService')).CacheService(ctx.getConfigService()!)
      const result = await cacheService.clearAIData()
      if (result.success) {
        ctx.getLogService()?.info('Cache', 'AI 数据库清除成功', { deletedFiles: result.deletedFiles?.length || 0 })
      } else {
        ctx.getLogService()?.error('Cache', 'AI 数据库清除失败', { error: result.error, failedFiles: result.failedFiles })
      }
      return result
    } catch (e) {
      ctx.getLogService()?.error('Cache', 'AI 数据库清除异常', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('cache:clearAll', async () => {
    ctx.getLogService()?.info('Cache', '开始清除所有缓存')
    try {
      const cacheService = new (await import('../../services/cacheService')).CacheService(ctx.getConfigService()!)
      const result = await cacheService.clearAll()
      if (result.success) {
        ctx.getLogService()?.info('Cache', '所有缓存清除成功')
      } else {
        ctx.getLogService()?.error('Cache', '所有缓存清除失败', { error: result.error })
      }
      return result
    } catch (e) {
      ctx.getLogService()?.error('Cache', '所有缓存清除异常', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('cache:clearConfig', async () => {
    ctx.getLogService()?.info('Cache', '开始清除配置')
    try {
      const cacheService = new (await import('../../services/cacheService')).CacheService(ctx.getConfigService()!)
      const result = await cacheService.clearConfig()
      if (result.success) {
        ctx.getLogService()?.info('Cache', '配置清除成功')
      } else {
        ctx.getLogService()?.error('Cache', '配置清除失败', { error: result.error })
      }
      return result
    } catch (e) {
      ctx.getLogService()?.error('Cache', '配置清除异常', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('cache:clearCurrentAccount', async (_, deleteLocalData = false) => {
    ctx.getLogService()?.info('Cache', '开始清除当前账号配置', { deleteLocalData })
    try {
      const cacheService = new (await import('../../services/cacheService')).CacheService(ctx.getConfigService()!)
      return await cacheService.clearCurrentAccount(deleteLocalData)
    } catch (e) {
      ctx.getLogService()?.error('Cache', '清除当前账号配置异常', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('cache:clearAllAccountConfigs', async () => {
    ctx.getLogService()?.info('Cache', '开始清空全部账号配置')
    try {
      const cacheService = new (await import('../../services/cacheService')).CacheService(ctx.getConfigService()!)
      return await cacheService.clearAllAccountConfigs()
    } catch (e) {
      ctx.getLogService()?.error('Cache', '清空全部账号配置异常', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('cache:getCacheSize', async () => {
    try {
      const cacheService = new (await import('../../services/cacheService')).CacheService(ctx.getConfigService()!)
      return await cacheService.getCacheSize()
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 日志管理

}
