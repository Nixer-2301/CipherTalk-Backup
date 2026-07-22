import { utilityProcess } from 'electron'
import type { UtilityProcess } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { getAppPath, isElectronPackaged } from '../runtimePaths'
import { getElectronWorkerEnv } from '../workerEnvironment'
import type { AiExportChatArgs, AiExportChatResult, AiExportProgress } from './aiExportTypes'

const UTILITY_FILE = 'aiExportUtilityProcess.js'
const IDLE_EXIT_MS = 180_000

type Pending = {
  resolve: (value: any) => void
  reject: (reason: any) => void
  type: string
  requestId?: string
  startedAt: number
}

type AgentProcessLogger = {
  debug?(category: string, message: string, data?: any): void
  info(category: string, message: string, data?: any): void
  warn(category: string, message: string, data?: any): void
  error(category: string, message: string, data?: any): void
}

function errorToLogData(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack }
  }
  return { message: String(error) }
}

function busyResult(): AiExportChatResult {
  return {
    canExport: false,
    requiresConfirmation: false,
    missingFields: [],
    followUpQuestions: [],
    success: false,
    error: 'EXPORT_BUSY',
    message: '已有导出任务正在进行，请等待完成后再试。',
  }
}

export class AiExportProcessService {
  private worker: UtilityProcess | null = null
  private pending = new Map<number, Pending>()
  private progressHandlers = new Map<string, (progress: AiExportProgress) => void>()
  private seq = 0
  private initPromise: Promise<void> | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private activeRequestId: string | null = null
  private shuttingDown = false
  private logger: AgentProcessLogger | null = null

  setLogger(logger: AgentProcessLogger | null): void {
    this.logger = logger
  }

  async exportChat(
    requestId: string,
    args: AiExportChatArgs,
    onProgress?: (progress: AiExportProgress) => void,
  ): Promise<AiExportChatResult> {
    if (this.activeRequestId && this.activeRequestId !== requestId) {
      return busyResult()
    }

    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }

    this.activeRequestId = requestId
    if (onProgress) this.progressHandlers.set(requestId, onProgress)

    try {
      return await this.call<AiExportChatResult>('exportChat', { requestId, args }, requestId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        canExport: false,
        requiresConfirmation: false,
        missingFields: [],
        followUpQuestions: [],
        success: false,
        error: message.includes('EXPORT_ABORTED') ? 'EXPORT_ABORTED' : message,
        message: message.includes('EXPORT_ABORTED') ? '导出已取消。' : message,
      }
    } finally {
      if (this.activeRequestId === requestId) this.activeRequestId = null
      this.progressHandlers.delete(requestId)
      this.scheduleIdleExit()
    }
  }

  abort(requestId: string): void {
    if (!requestId || this.activeRequestId !== requestId) return
    this.logger?.warn('AIExportProcess', '收到 AI 导出取消请求，终止导出子进程', { requestId })
    this.rejectPendingByRequestId(requestId, 'EXPORT_ABORTED')
    this.progressHandlers.delete(requestId)
    this.activeRequestId = null
    this.killWorker()
  }

  shutdown(): void {
    this.shuttingDown = true
    this.rejectAllPending('AI export utility process shutdown')
    this.progressHandlers.clear()
    this.activeRequestId = null
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    this.killWorker()
  }

  private async initWorker(): Promise<void> {
    this.shuttingDown = false
    if (this.worker) return
    if (this.initPromise) return this.initPromise

    this.initPromise = new Promise<void>((resolve, reject) => {
      const utilityPath = this.resolveUtilityPath()
      if (!utilityPath) {
        this.initPromise = null
        this.logger?.error('AIExportProcess', `未找到 ${UTILITY_FILE}`, {
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
        this.logger?.warn('AIExportProcess', '准备启动 AI Export utility process', {
          utilityPath,
          packaged: isElectronPackaged(),
        })
        worker = utilityProcess.fork(utilityPath, [], {
          serviceName: 'CipherTalk AI Export',
          stdio: 'pipe',
          env: { ...getElectronWorkerEnv(), CT_AGENT_WCDB_PROXY: '1' },
        })
      } catch (error: any) {
        this.initPromise = null
        this.logger?.error('AIExportProcess', '启动 AI Export utility process 失败', errorToLogData(error))
        reject(new Error(`启动 AI export utility process 失败: ${error?.message || String(error)}`))
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
        this.logger?.warn('AIExportProcess', 'AI Export utility process 已启动', {
          pid: worker.pid ?? null,
        })
      })

      worker.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim()
        if (text) this.logger?.debug?.('AIExportProcess', 'AI Export utility stdout', { pid: worker.pid ?? null, text })
      })
      worker.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim()
        if (text) {
          stderrTail = `${stderrTail}\n${text}`.slice(-4000)
          this.logger?.warn('AIExportProcess', 'AI Export utility stderr', { pid: worker.pid ?? null, text })
        }
      })

      worker.on('message', (msg: any) => {
        if (msg?.type === 'wcdb:call') {
          void this.handleWcdbCall(worker, msg.payload)
          return
        }

        if (msg?.id === 0 && msg.type === 'ready') {
          if (!readyFired) {
            readyFired = true
            this.logger?.warn('AIExportProcess', 'AI Export utility process 已就绪', {
              pid: worker.pid ?? null,
            })
            resolve()
          }
          return
        }

        if (msg?.id === -1 && msg.type === 'progress') {
          const { requestId, progress } = msg.payload || {}
          this.progressHandlers.get(requestId)?.(progress)
          return
        }

        if (typeof msg?.id === 'number') {
          const pending = this.pending.get(msg.id)
          if (!pending) return
          this.pending.delete(msg.id)
          if (msg.error) {
            this.logger?.warn('AIExportProcess', 'AI Export utility 调用失败', {
              id: msg.id,
              requestId: pending.requestId,
              type: pending.type,
              elapsedMs: Date.now() - pending.startedAt,
              error: msg.error,
            })
            pending.reject(new Error(msg.error))
          } else {
            this.logger?.debug?.('AIExportProcess', 'AI Export utility 调用完成', {
              id: msg.id,
              requestId: pending.requestId,
              type: pending.type,
              elapsedMs: Date.now() - pending.startedAt,
            })
            pending.resolve(msg.result)
          }
        }
      })

      worker.on('error', (type, location) => {
        this.logger?.error('AIExportProcess', 'AI Export utility process fatal', {
          pid: worker.pid ?? null,
          type,
          location,
        })
        if (this.worker === worker) this.worker = null
        this.initPromise = null
        this.rejectAllPending(`AI export utility process fatal (${type})`)
        rejectInitOnce(new Error(`AI export utility process fatal: ${type}`))
      })

      worker.on('exit', (code) => {
        const pid = worker.pid
        if (this.worker === worker) this.worker = null
        this.initPromise = null
        if (!this.shuttingDown) {
          this.rejectAllPending(`AI export utility process exited (pid=${pid ?? 'unknown'}, code=${code})`)
        }
        const stderrDetail = stderrTail.trim() ? `，stderr=${stderrTail.trim()}` : ''
        rejectInitOnce(new Error(`AI export utility process 启动后立即退出，code=${code}${stderrDetail}`))
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
      this.logger?.debug?.('AIExportProcess', 'AI Export utility process 空闲退出')
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
      const { wcdbService } = await import('../wcdbService')
      const result = await wcdbService.runProxiedCall(payload.method, payload.payload)
      worker.postMessage({ type: 'wcdb:result', payload: { reqId, result } })
    } catch (error: any) {
      worker.postMessage({ type: 'wcdb:result', payload: { reqId, error: error?.message || String(error) } })
    }
  }

  private async call<T = any>(type: string, payload: any, requestId?: string): Promise<T> {
    await this.initWorker()
    const worker = this.worker
    if (!worker) throw new Error('AI export utility process 未就绪')
    const id = ++this.seq

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, type, requestId, startedAt: Date.now() })
      try {
        worker.postMessage({ id, type, payload })
      } catch (error: any) {
        this.pending.delete(id)
        this.logger?.error('AIExportProcess', 'AI export postMessage 失败', {
          id,
          type,
          requestId,
          ...errorToLogData(error),
        })
        reject(new Error(`AI export postMessage 失败: ${error?.message || String(error)}`))
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

export const aiExportProcessService = new AiExportProcessService()
