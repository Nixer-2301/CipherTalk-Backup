/**
 * Export Utility Process.
 *
 * 把导出执行从主进程挪到独立 utility 进程，主进程只接收进度事件、保持窗口响应。
 * WCDB 查询通过通用 wcdb:call 转回主进程，避免本进程打开第二份微信数据库连接
 * （复用 wcdbProxyClient + 主进程 wcdbService.runProxiedCall，与 aiExportUtilityProcess 同机制）。
 *
 * 消息协议（与 aiExportUtilityProcess 一致）：
 *   主→子  { id, type, payload }            请求
 *   子→主  { id, result } / { id, error }   响应
 *   子→主  { id: -1, type: 'progress', payload: { requestId, progress } }  流式进度
 *   子→主  { id: 0, type: 'ready' }         启动就绪握手
 *   子↔主  wcdb:call / wcdb:result          由 wcdbProxyClient 自行收发，本进程仅忽略 wcdb:result
 */
import { exportService } from './services/exportService'
import { databaseExportService } from './services/databaseExportService'
import type { ExportOptions, ExportProgress } from './services/exportService'
import type { MomentsExportOptions, ContactExportOptions } from './services/exportService'
import type { DatabaseExportProgress } from './services/databaseExportService'

const parentPort = process.parentPort

if (!parentPort) {
  throw new Error('exportUtilityProcess 必须在 Electron utilityProcess 中运行')
}

const keepAliveTimer = setInterval(() => undefined, 60_000)
let activeRequestId: string | null = null

function formatExportError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function makeProgressSender(requestId: string, id: number) {
  return (progress: ExportProgress | DatabaseExportProgress) => {
    parentPort!.postMessage({
      id: -1,
      type: 'progress',
      payload: { requestId, progress },
    })
  }
}

parentPort.on('message', (event: Electron.MessageEvent) => {
  void handleMessage(event.data)
})

process.once('exit', () => {
  clearInterval(keepAliveTimer)
})

async function handleMessage(msg: any): Promise<void> {
  const { id, type, payload } = msg || {}
  // wcdb:result 由 wcdbProxyClient 内部监听器消费，这里直接忽略
  if (type === 'wcdb:result') return

  try {
    switch (type) {
      case 'exportSessions': {
        const { requestId, sessionIds, outputDir, options } = payload as {
          requestId: string
          sessionIds: string[]
          outputDir: string
          options: ExportOptions
        }
        if (activeRequestId && activeRequestId !== requestId) {
          parentPort!.postMessage({ id, error: 'EXPORT_BUSY' })
          return
        }

        activeRequestId = requestId
        try {
          const result = await exportService.exportSessions(
            sessionIds,
            outputDir,
            options,
            makeProgressSender(requestId, id),
          )
          parentPort!.postMessage({ id, result })
        } finally {
          if (activeRequestId === requestId) activeRequestId = null
        }
        break
      }

      case 'exportSession': {
        const { requestId, sessionId, outputPath, options } = payload as {
          requestId: string
          sessionId: string
          outputPath: string
          options: ExportOptions
        }
        if (activeRequestId && activeRequestId !== requestId) {
          parentPort!.postMessage({ id, error: 'EXPORT_BUSY' })
          return
        }

        activeRequestId = requestId
        try {
          const result = await exportService.exportSessionToChatLab(
            sessionId,
            outputPath,
            options,
            makeProgressSender(requestId, id),
          )
          parentPort!.postMessage({ id, result })
        } finally {
          if (activeRequestId === requestId) activeRequestId = null
        }
        break
      }

      case 'exportContacts': {
        const { requestId, outputDir, options } = payload as {
          requestId: string
          outputDir: string
          options: ContactExportOptions
        }
        if (activeRequestId && activeRequestId !== requestId) {
          parentPort!.postMessage({ id, error: 'EXPORT_BUSY' })
          return
        }

        activeRequestId = requestId
        try {
          const result = await exportService.exportContacts(
            outputDir,
            options,
            makeProgressSender(requestId, id),
          )
          parentPort!.postMessage({ id, result })
        } finally {
          if (activeRequestId === requestId) activeRequestId = null
        }
        break
      }

      case 'exportMoments': {
        const { requestId, outputDir, options } = payload as {
          requestId: string
          outputDir: string
          options: MomentsExportOptions
        }
        if (activeRequestId && activeRequestId !== requestId) {
          parentPort!.postMessage({ id, error: 'EXPORT_BUSY' })
          return
        }

        activeRequestId = requestId
        try {
          const result = await exportService.exportMoments(
            outputDir,
            options,
            makeProgressSender(requestId, id),
          )
          parentPort!.postMessage({ id, result })
        } finally {
          if (activeRequestId === requestId) activeRequestId = null
        }
        break
      }

      case 'scanDatabases': {
        // 扫描数据库列表：轻量操作，不参与单任务互斥
        const result = await databaseExportService.scanDatabases()
        parentPort!.postMessage({ id, result })
        break
      }

      case 'exportDatabases': {
        const { requestId, selectedPaths, outputDir } = payload as {
          requestId: string
          selectedPaths: string[]
          outputDir: string
        }
        if (activeRequestId && activeRequestId !== requestId) {
          parentPort!.postMessage({ id, error: 'EXPORT_BUSY' })
          return
        }

        activeRequestId = requestId
        try {
          const result = await databaseExportService.exportDatabases(
            selectedPaths,
            outputDir,
            makeProgressSender(requestId, id),
          )
          parentPort!.postMessage({ id, result })
        } finally {
          if (activeRequestId === requestId) activeRequestId = null
        }
        break
      }

      default:
        parentPort!.postMessage({ id, error: `unknown type: ${type}` })
    }
  } catch (error) {
    parentPort!.postMessage({ id, error: formatExportError(error) })
  }
}

parentPort.postMessage({ id: 0, type: 'ready' })
