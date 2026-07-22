import { ipcMain } from 'electron'
import { dbPathService } from '../../services/dbPathService'
import { getBestCachePath } from '../../services/platformService'
import type { MainProcessContext } from '../context'

/**
 * 数据库路径探测 IPC。
 * 只负责路径发现和平台默认缓存目录查询，不直接打开 WCDB 连接。
 */
export function registerDbPathHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('dbpath:autoDetect', async () => {
    return dbPathService.autoDetect()
  })

  ipcMain.handle('dbpath:scanWxids', async (_, rootPath: string) => {
    return dbPathService.scanWxids(rootPath)
  })

  ipcMain.handle('dbpath:getDefault', async () => {
    return dbPathService.getDefaultPath()
  })

  // 获取最佳缓存目录
  ipcMain.handle('dbpath:getBestCachePath', async () => {
    const result = getBestCachePath()
    ctx.getLogService()?.info('CachePath', '返回平台默认缓存目录', result)
    return result
  })

  // WCDB 数据库相关

}
