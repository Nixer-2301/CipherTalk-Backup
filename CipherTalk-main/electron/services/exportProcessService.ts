/**
 * ExportProcessService —— 导出功能 utility process 的主进程 broker。
 *
 * 把导出执行挪到独立 utilityProcess：silk-wasm 解码、fs 同步写盘、JSON.stringify 大对象
 * 全在子进程，主进程事件循环不再被阻塞，导出期间窗口保持响应。
 * WCDB 查询通过子进程的 wcdbProxyClient 转回主进程（CT_AGENT_WCDB_PROXY=1），复用主进程已开启的连接，
 * 不在子进程打开第二份微信数据库。镜像 aiExportProcessService 的 fork/握手/进度/取消/空闲退出机制。
 */
import { utilityProcess } from 'electron'
import type { UtilityProcess } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { getAppPath, isElectronPackaged } from './runtimePaths'
import { getElectronWorkerEnv } from './workerEnvironment'
import type {
  ExportOptions,
  ExportProgress,
  MomentsExportOptions,
  ContactExportOptions,
} from './exportService'
import type { DatabaseExportProgress, DatabaseExportResult, DatabaseScanResult } from './databaseExportService'

const UTILITY_FILE = 'exportUtilityProcess.js'
const IDLE_EXIT_MS = 180_000

type Pending = {
  resolve: (value: any) => void
  reject: (reason: any) => void
  type: string
  requestId?: string
  startedAt: number
}

type ExportSessionResult = { success: boolean; successCount: number; failCount: number; error?: string; outputPaths?: string[] }
type ExportSingleResult = { success: boolean; error?: string }
type ExportContactsResult = { success: boolean; successCount?: number; error?: string }
type ExportMomentsResult = { success: boolean; successCount: number; failCount: number; error?: string }
type ProgressFn = (progress: ExportProgress | DatabaseExportProgress) => void

function busyResult(): { success: boolean; error: string } {
  return {
    success: false,
    error: 'EXPORT_BUSY',
  }
}

export class ExportProcessService {
  private worker: UtilityProcess | null = null
  private pending = new Map<number, Pending>()
  private progressHandlers = new Map<string, ProgressFn>()
  private seq = 0
  private initPromise: Promise<void> | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private activeRequestId: string | null = null
  private shuttingDown = false

  async exportSessions(
    requestId: string,
    sessionIds: string[],
    outputDir: string,
    options: ExportOptions,
    onProgress?: ProgressFn,
  ): Promise<ExportSessionResult> {
    if (this.activeRequestId && this.activeRequestId !== requestId) {
      return { ...busyResult(), successCount: 0, failCount: 0 }
    }
    this.clearIdleTimer()
    this.activeRequestId = requestId
    if (onProgress) this.progressHandlers.set(requestId, onProgress)

    try {
      return await this.call<ExportSessionResult>('exportSessions', { requestId, sessionIds, outputDir, options }, requestId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, successCount: 0, failCount: 0, error: message }
    } finally {
      if (this.activeRequestId === requestId) this.activeRequestId = null
      this.progressHandlers.delete(requestId)
      this.scheduleIdleExit()
    }
  }

  async exportSession(
    requestId: string,
    sessionId: string,
    outputPath: string,
    options: ExportOptions,
    onProgress?: ProgressFn,
  ): Promise<ExportSingleResult> {
    if (this.activeRequestId && this.activeRequestId !== requestId) {
      return busyResult()
    }
    this.clearIdleTimer()
    this.activeRequestId = requestId
    if (onProgress) this.progressHandlers.set(requestId, onProgress)

    try {
      return await this.call<ExportSingleResult>('exportSession', { requestId, sessionId, outputPath, options }, requestId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message }
    } finally {
      if (this.activeRequestId === requestId) this.activeRequestId = null
      this.progressHandlers.delete(requestId)
      this.scheduleIdleExit()
    }
  }

  async exportContacts(
    requestId: string,
    outputDir: string,
    options: ContactExportOptions,
    onProgress?: ProgressFn,
  ): Promise<ExportContactsResult> {
    if (this.activeRequestId && this.activeRequestId !== requestId) {
      return busyResult()
    }
    this.clearIdleTimer()
    this.activeRequestId = requestId
    if (onProgress) this.progressHandlers.set(requestId, onProgress)

    try {
      return await this.call<ExportContactsResult>('exportContacts', { requestId, outputDir, options }, requestId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message }
    } finally {
      if (this.activeRequestId === requestId) this.activeRequestId = null
      this.progressHandlers.delete(requestId)
      this.scheduleIdleExit()
    }
  }

  async exportMoments(
    requestId: string,
    outputDir: string,
    options: MomentsExportOptions,
    onProgress?: ProgressFn,
  ): Promise<ExportMomentsResult> {
    if (this.activeRequestId && this.activeRequestId !== requestId) {
      return { ...busyResult(), successCount: 0, failCount: 0 }
    }
    this.clearIdleTimer()
    this.activeRequestId = requestId
    if (onProgress) this.progressHandlers.set(requestId, onProgress)

    try {
      return await this.call<ExportMomentsResult>('exportMoments', { requestId, outputDir, options }, requestId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, successCount: 0, failCount: 0, error: message }
    } finally {
      if (this.activeRequestId === requestId) this.activeRequestId = null
      this.progressHandlers.delete(requestId)
      this.scheduleIdleExit()
    }
  }

  async scanDatabases(): Promise<DatabaseScanResult> {
    // 扫描列表是轻量操作，不占用单任务槽
    try {
      return await this.call<DatabaseScanResult>('scanDatabases', {})
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message }
    } finally {
      this.scheduleIdleExit()
    }
  }

  async exportDatabases(
    requestId: string,
    selectedPaths: string[],
    outputDir: string,
    onProgress?: ProgressFn,
  ): Promise<DatabaseExportResult> {
    if (this.activeRequestId && this.activeRequestId !== requestId) {
      return { ...busyResult() }
    }
    this.clearIdleTimer()
    this.activeRequestId = requestId
    if (onProgress) this.progressHandlers.set(requestId, onProgress)

    try {
      return await this.call<DatabaseExportResult>('exportDatabases', { requestId, selectedPaths, outputDir }, requestId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message }
    } finally {
      if (this.activeRequestId === requestId) this.activeRequestId = null
      this.progressHandlers.delete(requestId)
      this.scheduleIdleExit()
    }
  }

  abort(requestId: string): void {
    if (!requestId || this.activeRequestId !== requestId) return
    this.rejectPendingByRequestId(requestId, 'EXPORT_ABORTED')
    this.progressHandlers.delete(requestId)
    this.activeRequestId = null
    this.killWorker()
  }

  shutdown(): void {
    this.shuttingDown = true
    this.rejectAllPending('export utility process shutdown')
    this.progressHandlers.clear()
    this.activeRequestId = null
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    this.killWorker()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private async initWorker(): Promise<void> {
    this.shuttingDown = false
    if (this.worker) return
    if (this.initPromise) return this.initPromise

    this.initPromise = new Promise<void>((resolve, reject) => {
      const utilityPath = this.resolveUtilityPath()
      if (!utilityPath) {
        this.initPromise = null
        console.error(`[ExportProcess] 未找到 ${UTILITY_FILE}`, {
          candidates: this.getUtilityPathCandidates(),
          packaged: isElectronPackaged(),
          appPath: getAppPath(),
          resourcesPath: process.resourcesPath || null,
        })
        reject(new Error(`未找到 ${UTILITY_FILE}`))
        return
      }

      let worker: UtilityProcess
      try {
        worker = utilityProcess.fork(utilityPath, [], {
          serviceName: 'CipherTalk Export',
          stdio: 'pipe',
          env: { ...getElectronWorkerEnv(), CT_AGENT_WCDB_PROXY: '1' },
        })
      } catch (error: any) {
        this.initPromise = null
        console.error('[ExportProcess] 启动 export utility process 失败:', error?.message || String(error))
        reject(new Error(`启动 export utility process 失败: ${error?.message || String(error)}`))
        return
      }

      this.worker = worker
      let readyFired = false
      let stderrTail = ''
      const rejectInitOnce = (err: Error) => {
        if (!readyFired) {
          readyFired = true
          reject(err)
        }
      }

      worker.on('spawn', () => {
        console.log(`[ExportProcess] export utility process 已启动 (pid=${worker.pid ?? 'unknown'})`)
      })

      worker.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim()
        if (text) console.debug(`[ExportProcess] stdout (pid=${worker.pid ?? 'unknown'}):`, text)
      })
      worker.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim()
        if (text) {
          stderrTail = `${stderrTail}\n${text}`.slice(-4000)
          console.warn(`[ExportProcess] stderr (pid=${worker.pid ?? 'unknown'}):`, text)
        }
      })

      worker.on('message', (msg: any) => {
        // wcdb 代理调用：转发给主进程已开启的 wcdbService
        if (msg?.type === 'wcdb:call') {
          void this.handleWcdbCall(worker, msg.payload)
          return
        }

        // 启动就绪握手
        if (msg?.id === 0 && msg.type === 'ready') {
          if (!readyFired) {
            readyFired = true
            console.log(`[ExportProcess] export utility process 已就绪 (pid=${worker.pid ?? 'unknown'})`)
            resolve()
          }
          return
        }

        // 流式进度：转发给注册的 onProgress 回调
        if (msg?.id === -1 && msg.type === 'progress') {
          const { requestId, progress } = msg.payload || {}
          this.progressHandlers.get(requestId)?.(progress)
          return
        }

        // 请求-响应关联
        if (typeof msg?.id === 'number') {
          const pending = this.pending.get(msg.id)
          if (!pending) return
          this.pending.delete(msg.id)
          if (msg.error) {
            console.warn('[ExportProcess] 调用失败:', {
              id: msg.id,
              requestId: pending.requestId,
              type: pending.type,
              elapsedMs: Date.now() - pending.startedAt,
              error: msg.error,
            })
            pending.reject(new Error(msg.error))
          } else {
            pending.resolve(msg.result)
          }
        }
      })

      worker.on('error', (type, location) => {
        console.error('[ExportProcess] export utility process fatal:', { type, location })
        if (this.worker === worker) this.worker = null
        this.initPromise = null
        this.rejectAllPending(`export utility process fatal (${type})`)
        rejectInitOnce(new Error(`export utility process fatal: ${type}`))
      })

      worker.on('exit', (code) => {
        const pid = worker.pid
        if (this.worker === worker) this.worker = null
        this.initPromise = null
        if (!this.shuttingDown) {
          this.rejectAllPending(`export utility process exited (pid=${pid ?? 'unknown'}, code=${code})`)
        }
        const stderrDetail = stderrTail.trim() ? `，stderr=${stderrTail.trim()}` : ''
        rejectInitOnce(new Error(`export utility process 启动后立即退出，code=${code}${stderrDetail}`))
      })
    })

    try {
      await this.initPromise
    } catch (error) {
      this.initPromise = null
      throw error
    }
  }

  private scheduleIdleExit(): void {
    if (this.idleTimer || this.activeRequestId || this.pending.size > 0) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.activeRequestId || this.pending.size > 0) return
      console.debug('[ExportProcess] export utility process 空闲退出')
      this.killWorker()
    }, IDLE_EXIT_MS)
  }

  private killWorker(): void {
    const worker = this.worker
    this.worker = null
    this.initPromise = null
    if (worker) {
      try { worker.kill() } catch { /* ignore */ }
    }
  }

  private rejectAllPending(reason: string): void {
    if (this.pending.size === 0) return
    const error = new Error(reason)
    for (const { reject } of this.pending.values()) {
      try { reject(error) } catch { /* ignore */ }
    }
    this.pending.clear()
  }

  private rejectPendingByRequestId(requestId: string, reason: string): void {
    const error = new Error(reason)
    for (const [id, pending] of this.pending.entries()) {
      if (pending.requestId !== requestId) continue
      this.pending.delete(id)
      try { pending.reject(error) } catch { /* ignore */ }
    }
  }

  private async handleWcdbCall(
    worker: UtilityProcess,
    payload: { reqId: number; method: string; payload: any },
  ): Promise<void> {
    const reqId = payload?.reqId
    try {
      const { wcdbService } = await import('./wcdbService')
      const result = await wcdbService.runProxiedCall(payload.method, payload.payload)
      worker.postMessage({ type: 'wcdb:result', payload: { reqId, result } })
    } catch (error: any) {
      worker.postMessage({ type: 'wcdb:result', payload: { reqId, error: error?.message || String(error) } })
    }
  }

  private async call<T = any>(type: string, payload: any, requestId?: string): Promise<T> {
    await this.initWorker()
    const worker = this.worker
    if (!worker) throw new Error('export utility process 未就绪')
    const id = ++this.seq

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, type, requestId, startedAt: Date.now() })
      try {
        worker.postMessage({ id, type, payload })
      } catch (error: any) {
        this.pending.delete(id)
        console.error('[ExportProcess] postMessage 失败:', { id, type, requestId, error: error?.message || String(error) })
        reject(new Error(`export postMessage 失败: ${error?.message || String(error)}`))
      }
    })
  }

  private getUtilityPathCandidates(): string[] {
    const appPath = getAppPath()
    const resourcesRoot = process.resourcesPath || appPath
    return isElectronPackaged()
      ? [
          join(resourcesRoot, 'app.asar.unpacked', 'dist-electron', UTILITY_FILE),
          join(resourcesRoot, 'app.asar', 'dist-electron', UTILITY_FILE),
          join(resourcesRoot, 'dist-electron', UTILITY_FILE),
          join(__dirname, UTILITY_FILE),
          join(__dirname, '..', UTILITY_FILE),
        ]
      : [
          join(__dirname, UTILITY_FILE),
          join(__dirname, '..', UTILITY_FILE),
          join(appPath, 'dist-electron', UTILITY_FILE),
        ]
  }

  private resolveUtilityPath(): string | null {
    return this.getUtilityPathCandidates().find((candidate) => existsSync(candidate)) || null
  }
}

export const exportProcessService = new ExportProcessService()
