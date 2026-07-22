/**
 * AI 导出代理客户端 —— 运行在 AI agent utilityProcess 内。
 *
 * Agent 工具不直接导出文件，只把 export_chat 请求转发给主进程；
 * 主进程再按需拉起独立 aiExportUtilityProcess。
 */
import type { AiExportProgress } from './aiExportTypes'

const parentPort = process.parentPort

type Pending = {
  resolve: (value: any) => void
  reject: (reason: any) => void
  onProgress?: (progress: AiExportProgress) => void
  abortListener?: () => void
  signal?: AbortSignal
}

const pending = new Map<number, Pending>()
let seq = 0
let listenerInstalled = false

function ensureListener(): void {
  if (listenerInstalled || !parentPort) return
  listenerInstalled = true
  parentPort.on('message', (event: Electron.MessageEvent) => {
    const msg: any = event.data
    if (!msg || (msg.type !== 'aiExport:result' && msg.type !== 'aiExport:progress')) return
    const { reqId, result, error, progress } = msg.payload || {}
    const entry = pending.get(reqId)
    if (!entry) return

    if (msg.type === 'aiExport:progress') {
      entry.onProgress?.(progress)
      return
    }

    pending.delete(reqId)
    if (entry.abortListener) entry.signal?.removeEventListener('abort', entry.abortListener)
    if (error) entry.reject(new Error(error))
    else entry.resolve(result)
  })
}

export function proxyAiExportCall<T = any>(
  method: string,
  args: Record<string, unknown>,
  options?: {
    signal?: AbortSignal
    onProgress?: (progress: AiExportProgress) => void
  },
): Promise<T> {
  if (!parentPort) {
    return Promise.reject(new Error('aiExportProxyClient 只能在 utilityProcess 子进程中运行'))
  }
  ensureListener()
  const reqId = ++seq

  return new Promise<T>((resolve, reject) => {
    const abortListener = () => {
      if (!pending.has(reqId)) return
      pending.delete(reqId)
      try {
        parentPort!.postMessage({ type: 'aiExport:abort', payload: { reqId } })
      } catch {
        // ignore abort forwarding races
      }
      reject(new Error('EXPORT_ABORTED'))
    }

    if (options?.signal?.aborted) {
      reject(new Error('EXPORT_ABORTED'))
      return
    }

    pending.set(reqId, {
      resolve,
      reject,
      onProgress: options?.onProgress,
      abortListener,
      signal: options?.signal,
    })
    options?.signal?.addEventListener('abort', abortListener, { once: true })

    try {
      parentPort!.postMessage({ type: 'aiExport:call', payload: { reqId, method, args } })
    } catch (e: any) {
      pending.delete(reqId)
      options?.signal?.removeEventListener('abort', abortListener)
      reject(new Error(`AI 导出代理转发失败: ${e?.message || String(e)}`))
    }
  })
}

