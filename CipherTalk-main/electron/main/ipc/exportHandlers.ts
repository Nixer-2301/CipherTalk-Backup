import { ipcMain } from 'electron'
import { exportProcessService } from '../../services/exportProcessService'
import type { ExportOptions, MomentsExportOptions } from '../../services/exportService'
import type { MainProcessContext } from '../context'

/**
 * 导出 IPC —— 薄转发层。
 *
 * 全部导出执行都在 exportProcessService 持有的独立 utilityProcess 内完成，
 * 主进程只接收 renderer 请求 → 转发 worker → 把进度回传给原发起 renderer。
 * silk-wasm 解码、fs 同步写盘、JSON.stringify 大对象都不再阻塞主进程事件循环。
 * channel 名/参数顺序/返回形状/preload 全部不变，renderer 零改动。
 */
function genRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function registerExportHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('export:exportSessions', async (event, sessionIds: string[], outputDir: string, options: ExportOptions) => {
    const requestId = genRequestId('sessions')
    return exportProcessService.exportSessions(
      requestId,
      sessionIds,
      outputDir,
      options,
      (progress) => event.sender.send('export:progress', progress),
    )
  })

  ipcMain.handle('export:exportSession', async (event, sessionId: string, outputPath: string, options: ExportOptions) => {
    const requestId = genRequestId('session')
    return exportProcessService.exportSession(
      requestId,
      sessionId,
      outputPath,
      options,
      (progress) => event.sender.send('export:progress', progress),
    )
  })

  ipcMain.handle('export:exportContacts', async (event, outputDir: string, options: any) => {
    const requestId = genRequestId('contacts')
    return exportProcessService.exportContacts(
      requestId,
      outputDir,
      options,
      (progress) => event.sender.send('export:progress', progress),
    )
  })

  ipcMain.handle('export:exportMoments', async (event, outputDir: string, options: MomentsExportOptions) => {
    const requestId = genRequestId('moments')
    return exportProcessService.exportMoments(
      requestId,
      outputDir,
      options,
      (progress) => event.sender.send('export:progress', progress),
    )
  })

  // 数据库导出（解密落地）
  ipcMain.handle('export:scanDatabases', async () => {
    return exportProcessService.scanDatabases()
  })

  ipcMain.handle('export:exportDatabases', async (event, selectedPaths: string[], outputDir: string) => {
    const requestId = genRequestId('databases')
    return exportProcessService.exportDatabases(
      requestId,
      selectedPaths,
      outputDir,
      (progress) => event.sender.send('export:progress', progress),
    )
  })

  // 数据分析相关
}
