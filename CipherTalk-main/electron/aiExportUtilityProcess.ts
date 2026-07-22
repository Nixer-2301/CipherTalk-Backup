/**
 * AI Export Utility Process.
 *
 * 只负责 AI 助手的聊天导出校验与执行。WCDB 查询通过通用 wcdb:call 转回主进程，
 * 避免本进程打开第二份微信数据库连接，也不复用 MCP。
 */
import { exportChatFromAi } from './services/agent/aiExportRunner'
import type { AiExportCallPayload } from './services/agent/aiExportTypes'

const parentPort = process.parentPort

if (!parentPort) {
  throw new Error('aiExportUtilityProcess 必须在 Electron utilityProcess 中运行')
}

const aborters = new Map<string, AbortController>()
const keepAliveTimer = setInterval(() => undefined, 60_000)
let activeRequestId: string | null = null

function formatExportError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

parentPort.on('message', (event: Electron.MessageEvent) => {
  void handleMessage(event.data)
})

process.once('exit', () => {
  clearInterval(keepAliveTimer)
})

async function handleMessage(msg: any): Promise<void> {
  const { id, type, payload } = msg || {}
  if (type === 'wcdb:result') return

  try {
    switch (type) {
      case 'exportChat': {
        const { requestId, args } = payload as AiExportCallPayload
        if (activeRequestId && activeRequestId !== requestId) {
          parentPort!.postMessage({
            id,
            error: 'EXPORT_BUSY',
          })
          return
        }

        const aborter = new AbortController()
        activeRequestId = requestId
        aborters.set(requestId, aborter)
        try {
          const result = await exportChatFromAi(
            args,
            (progress) => parentPort!.postMessage({
              id: -1,
              type: 'progress',
              payload: { requestId, progress },
            }),
            aborter.signal,
          )
          parentPort!.postMessage({ id, result })
        } finally {
          aborters.delete(requestId)
          if (activeRequestId === requestId) activeRequestId = null
        }
        break
      }

      case 'abort': {
        const requestId = String(payload?.requestId || '')
        aborters.get(requestId)?.abort()
        parentPort!.postMessage({ id, result: { aborted: true } })
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

