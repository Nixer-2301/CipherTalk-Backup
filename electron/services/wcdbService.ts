/**
 * WcdbService —— WcdbCore 的 utilityProcess 代理层。
 * 业务层（chatService / snsService / dbAdapter）调用签名保持不变，事件 'change' 来自 native 管道。
 * native/koffi fatal 只会终止 WCDB utility process；主进程会 reject pending 并自动重启。
 */
import { utilityProcess } from 'electron'
import type { UtilityProcess } from 'electron'
import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import { join } from 'path'
import { ConfigService } from './config'
import { getAppPath, getUserDataPath, isElectronPackaged } from './runtimePaths'
import { getElectronWorkerEnv } from './workerEnvironment'

type UtilityRequest = { id: number; type: string; payload?: any }
type UtilityResponse = { id: number; result?: any; error?: string; type?: string; payload?: any }
type Pending = { resolve: (value: any) => void; reject: (reason: any) => void }
type OpenPayload = { dbPath: string; hexKey: string; wxid: string }

const PARAMS_UNSUPPORTED = 'native 未支持参数化查询'

function bufferToHex(buffer: Buffer): string {
  return Array.from(buffer)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function sqlLiteral(value: any): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object' && value && typeof value.type === 'string' && 'value' in value) {
    return sqlLiteral(value.value)
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (Buffer.isBuffer(value)) return `X'${bufferToHex(value)}'`
  if (value instanceof Uint8Array) return `X'${bufferToHex(Buffer.from(value))}'`
  return `'${String(value).replace(/'/g, "''")}'`
}

function inlineParams(sql: string, params: any[]): string {
  let index = 0
  let out = ''
  let quote: '"' | "'" | '`' | null = null

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (quote) {
      out += ch
      if (ch === quote) {
        if (sql[i + 1] === quote) out += sql[++i]
        else quote = null
      }
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ch
      continue
    }
    if (ch === '?' && index < params.length) {
      out += sqlLiteral(params[index++])
      continue
    }
    out += ch
  }

  if (index !== params.length) {
    throw new Error(`参数数量不匹配: expected ${index}, got ${params.length}`)
  }
  return out
}

const UTILITY_FILE = 'wcdbUtilityProcess.js'
const RESTART_DELAY_MS = 2000

function shouldSuppressUtilityLogLine(line: string): boolean {
  if (!line.includes('[wcdbCore] native cursor')) return false
  if (/native cursor (?:lite )?open failed\b.*\brc=-3\b/.test(line)) return true
  if (/native cursor batch open failed\b/.test(line) && line.includes('消息数据库未找到')) return true
  return false
}

function filterUtilityLogText(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !shouldSuppressUtilityLogLine(line))
    .join('\n')
    .trim()
}

export class WcdbService extends EventEmitter {
  private worker: UtilityProcess | null = null
  private pending = new Map<number, Pending>()
  private seq = 0
  private initPromise: Promise<void> | null = null
  private openPromise: Promise<boolean> | null = null
  private lastOpenPayload: OpenPayload | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private shuttingDown = false
  private monitorRequested = false

  // ========= 公共 API（保持与旧实现一致） =========
  async testConnection(dbPath: string, hexKey: string, wxid: string): Promise<{ success: boolean; error?: string; sessionCount?: number }> {
    try {
      return await this.call('testConnection', { dbPath, hexKey, wxid })
    } catch (e) {
      return {
        success: false,
        error: this.formatTestConnectionError(e)
      }
    }
  }

  async open(dbPath: string, hexKey: string, wxid: string): Promise<boolean> {
    this.shuttingDown = false
    const payload = { dbPath, hexKey, wxid }
    this.lastOpenPayload = payload
    this.openPromise = this.call<boolean>('open', payload)
      .finally(() => {
        this.openPromise = null
      })
    return this.openPromise
  }

  close(): void {
    this.lastOpenPayload = null
    if (!this.worker) return
    this.postToUtility(this.worker, { id: ++this.seq, type: 'close', payload: {} })
  }

  shutdown(): void {
    this.shuttingDown = true
    this.monitorRequested = false
    this.lastOpenPayload = null
    this.openPromise = null
    const w = this.worker
    this.worker = null
    this.initPromise = null
    this.rejectAllPending('wcdb utility process shutdown')
    if (w) {
      let exited = false
      let forceKillTimer: NodeJS.Timeout | null = setTimeout(() => {
        forceKillTimer = null
        if (exited) return
        try { w.kill() } catch { /* ignore */ }
      }, 1500)
      w.once('exit', () => {
        exited = true
        if (forceKillTimer) {
          clearTimeout(forceKillTimer)
          forceKillTimer = null
        }
      })
      this.postToUtility(w, { id: ++this.seq, type: 'shutdown', payload: {} })
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  async execQuery(kind: string, path: string, sql: string): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    return this.callWithAutoOpen('execQuery', { kind, path, sql })
  }

  async execQueryWithParams(kind: string, path: string, sql: string, params?: any[]): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    if (!params || params.length === 0) {
      return this.execQuery(kind, path, sql)
    }
    const result = await this.callWithAutoOpen<{ success: boolean; rows?: any[]; error?: string }>('execQueryWithParams', { kind, path, sql, params })
    if (result.success || !result.error?.includes(PARAMS_UNSUPPORTED)) {
      return result
    }
    return this.execQuery(kind, path, inlineParams(sql, params))
  }

  async getSnsTimeline(limit: number, offset: number, usernames?: string[], keyword?: string, startTime?: number, endTime?: number): Promise<{ success: boolean; timeline?: any[]; error?: string }> {
    return this.callWithAutoOpen('getSnsTimeline', { limit, offset, usernames, keyword, startTime, endTime })
  }

  /** 导出专用：在 utility 进程内完成分批查询+解码，按块返回紧凑行（见 WcdbCore.readMessageChunk） */
  async readMessageChunk(
    kind: string,
    path: string,
    tableName: string,
    opts: { afterRid: number; maxRows?: number; startTime?: number; endTime?: number; extraCols?: string[] }
  ): Promise<{ success: boolean; rows?: any[]; lastRid?: number; done?: boolean; error?: string }> {
    return this.callWithAutoOpen('readMessageChunk', { kind, path, tableName, opts })
  }

  async getNativeMessages(sessionId: string, limit: number, offset: number): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    return this.callWithAutoOpen('getNativeMessages', { sessionId, limit, offset })
  }

  async setMonitor(): Promise<boolean> {
    this.monitorRequested = true
    const res = await this.callWithAutoOpen<{ success: boolean }>('setMonitor', {})
    return !!res?.success
  }

  async stopMonitor(): Promise<void> {
    this.monitorRequested = false
    if (!this.worker) return
    await this.call('stopMonitor', {})
  }

  async decryptSnsImage(encryptedData: Buffer, _key: string): Promise<Buffer> {
    return encryptedData
  }

  async decryptSnsVideo(encryptedData: Buffer, _key: string): Promise<Buffer> {
    return encryptedData
  }

  // ========= utilityProcess 管理 =========
  async initWorker(): Promise<void> {
    this.shuttingDown = false
    if (this.worker) return
    if (this.initPromise) return this.initPromise

    this.initPromise = new Promise<void>((resolve, reject) => {
      const utilityPath = this.resolveUtilityPath()
      if (!utilityPath) {
        this.initPromise = null
        reject(new Error(`未找到 ${UTILITY_FILE}`))
        return
      }

      let worker: UtilityProcess
      try {
        worker = utilityProcess.fork(utilityPath, [], {
          serviceName: 'CipherTalk WCDB',
          stdio: 'pipe',
          env: getElectronWorkerEnv(),
          allowLoadingUnsignedLibraries: process.platform === 'darwin'
        })
      } catch (e: any) {
        this.initPromise = null
        reject(new Error(`启动 WCDB utility process 失败: ${e?.message || String(e)}`))
        return
      }

      this.worker = worker
      let readyFired = false

      const rejectInitOnce = (err: Error) => {
        if (!readyFired) {
          readyFired = true
          reject(err)
        }
      }

      worker.on('spawn', () => {
        console.info(`[wcdbService] utility process spawned pid=${worker.pid ?? 'unknown'}`)
      })

      worker.stdout?.on('data', (chunk: Buffer) => {
        const text = filterUtilityLogText(chunk.toString().trim())
        if (text) console.log(`[wcdbUtility:${worker.pid ?? 'unknown'}] ${text}`)
      })

      worker.stderr?.on('data', (chunk: Buffer) => {
        const text = filterUtilityLogText(chunk.toString().trim())
        if (text) console.error(`[wcdbUtility:${worker.pid ?? 'unknown'}] ${text}`)
      })

      worker.on('message', (msg: UtilityResponse) => {
        if (msg?.id === -1 && msg.type === 'monitor') {
          const p = msg.payload || {}
          this.emit('change', p.type, p.json)
          return
        }

        if (msg?.id === 0 && msg.type === 'ready') {
          const appPath = getAppPath()
          const resourcesRoot = process.resourcesPath || appPath
          const resourcesPath = isElectronPackaged()
            ? join(resourcesRoot, 'resources')
            : join(appPath, 'resources')
          const userDataPath = getUserDataPath()
          const id = ++this.seq
          this.pending.set(id, {
            resolve: () => {
              if (!readyFired) {
                readyFired = true
                resolve()
              }
            },
            reject: (err) => {
              rejectInitOnce(err instanceof Error ? err : new Error(String(err)))
            }
          })
          this.postToUtility(worker, { id, type: 'setPaths', payload: { resourcesPath, userDataPath } })
          return
        }

        if (typeof msg?.id === 'number') {
          const pending = this.pending.get(msg.id)
          if (!pending) return
          this.pending.delete(msg.id)
          if (msg.error) pending.reject(new Error(msg.error))
          else pending.resolve(msg.result)
        }
      })

      worker.on('error', (type, location, report) => {
        console.error('[wcdbService] utility process fatal:', {
          pid: worker.pid,
          type,
          location,
          reportLength: report?.length || 0
        })
        if (this.worker === worker) this.worker = null
        this.initPromise = null
        this.openPromise = null
        this.rejectAllPending(`wcdb utility process fatal (${type}${location ? ` at ${location}` : ''})`)
        rejectInitOnce(new Error(`WCDB utility process fatal: ${type}`))
      })

      worker.on('exit', (code) => {
        const pid = worker.pid
        if (this.worker === worker) this.worker = null
        this.initPromise = null
        this.openPromise = null
        this.rejectAllPending(`wcdb utility process exited (pid=${pid ?? 'unknown'}, code=${code})`)
        rejectInitOnce(new Error(`WCDB utility process 启动后立即退出，code=${code}`))
        if (!this.shuttingDown) {
          console.warn(`[wcdbService] utility process 退出 pid=${pid ?? 'unknown'} code=${code}，${RESTART_DELAY_MS}ms 后自动重启`)
          this.scheduleRestart()
        }
      })
    })

    try {
      await this.initPromise
    } catch (e) {
      this.initPromise = null
      throw e
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.shuttingDown) return
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.shuttingDown) return
      this.initWorker()
        .then(() => this.restoreStateAfterRestart())
        .catch((e) => {
          console.error('[wcdbService] 自动重启失败:', e?.message || e)
        })
    }, RESTART_DELAY_MS)
  }

  private async restoreStateAfterRestart(): Promise<void> {
    if (this.shuttingDown || !this.worker) return

    const reopened = await this.ensureOpen().catch((e) => {
      console.error('[wcdbService] 自动重启后 reopen 失败:', e?.message || e)
      return false
    })
    if (!reopened || !this.monitorRequested) return

    try {
      const res = await this.call<{ success: boolean }>('setMonitor', {})
      if (!res?.success) {
        console.warn('[wcdbService] 自动重启后重新注册 native monitor 失败')
      }
    } catch (e: any) {
      console.warn('[wcdbService] 自动重启后重新注册 native monitor 异常:', e?.message || e)
    }
  }

  private rejectAllPending(reason: string): void {
    if (this.pending.size === 0) return
    const err = new Error(reason)
    for (const { reject } of this.pending.values()) {
      try { reject(err) } catch { /* ignore */ }
    }
    this.pending.clear()
  }

  private postToUtility(worker: UtilityProcess, msg: UtilityRequest): void {
    try { worker.postMessage(msg) } catch { /* ignore */ }
  }

  private async call<T = any>(type: string, payload: any): Promise<T> {
    await this.initWorker()
    if (!this.worker) {
      throw new Error('WCDB utility process 未就绪')
    }
    const id = ++this.seq
    const w = this.worker
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        w.postMessage({ id, type, payload } as UtilityRequest)
      } catch (e: any) {
        this.pending.delete(id)
        reject(new Error(`utility postMessage 失败: ${e?.message || String(e)}`))
      }
    })
  }

  /**
   * 供 AI agent 子进程经代理通道复用本进程已打开的 wcdb 连接（仅在主进程侧执行）。
   * 子进程把 callWithAutoOpen 转发过来，主进程原样走一遍。
   */
  runProxiedCall<T extends { success?: boolean; error?: string }>(type: string, payload: any): Promise<T> {
    return this.callWithAutoOpen<T>(type, payload)
  }

  private async callWithAutoOpen<T extends { success?: boolean; error?: string }>(type: string, payload: any): Promise<T> {
    // AI agent 子进程：不直连原微信库，转发给主进程已打开的连接（见 agent/wcdbProxyClient.ts）。
    if (process.env.CT_AGENT_WCDB_PROXY === '1') {
      const { proxyWcdbCall } = await import('./agent/wcdbProxyClient')
      return proxyWcdbCall<T>(type, payload)
    }
    let result: T
    try {
      result = await this.call<T>(type, payload)
    } catch (e) {
      if (!this.isRecoverableUtilityExit(e)) throw e
      const reopened = await this.recoverAfterUtilityExit()
      if (!reopened) throw e
      return this.call<T>(type, payload)
    }
    if (!this.isUninitializedResult(result)) return result

    const reopened = await this.ensureOpen()
    if (!reopened) return result

    result = await this.call<T>(type, payload)
    return result
  }

  private isUninitializedResult(result: any): boolean {
    return result?.success === false && typeof result?.error === 'string' && result.error.includes('WCDB 未初始化')
  }

  private isRecoverableUtilityExit(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return (
      message.includes('wcdb utility process exited') ||
      message.includes('WCDB utility process 未就绪') ||
      message.includes('utility postMessage 失败')
    )
  }

  private formatTestConnectionError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    if (!this.isRecoverableUtilityExit(error)) return message

    return [
      'WCDB 验证进程异常退出，未能完成账号目录验证。',
      '请确认选择的是微信账号数据目录，解密密钥为 64 位十六进制；',
      '如仍失败，请检查系统权限、杀毒软件或安全软件是否拦截 WCDB 组件，并重启软件后重试。',
      `原始错误: ${message}`
    ].join('')
  }

  private async recoverAfterUtilityExit(): Promise<boolean> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    return this.ensureOpen()
  }

  private async ensureOpen(): Promise<boolean> {
    if (this.openPromise) return this.openPromise

    let payload = this.lastOpenPayload
    if (!payload) {
      payload = this.readConfiguredOpenPayload()
      if (payload) this.lastOpenPayload = payload
    }
    if (!payload) return false

    this.openPromise = this.call<boolean>('open', payload)
      .finally(() => {
        this.openPromise = null
      })
    return this.openPromise
  }

  private readConfiguredOpenPayload(): OpenPayload | null {
    let configService: ConfigService | null = null
    try {
      configService = new ConfigService()
      const dbPath = String(configService.get('dbPath') || '').trim()
      const hexKey = String(configService.get('decryptKey') || '').trim()
      const wxid = String(configService.get('myWxid') || '').trim()
      if (!dbPath || !hexKey || !wxid) return null
      return { dbPath, hexKey, wxid }
    } catch {
      return null
    } finally {
      try { configService?.close() } catch { /* ignore */ }
    }
  }

  /**
   * 解析 wcdbUtilityProcess.js 路径。packaged 模式优先使用 asar.unpacked，避免子进程加载原生依赖时踩到 asar 边界。
   */
  private resolveUtilityPath(): string | null {
    const appPath = getAppPath()
    const resourcesRoot = process.resourcesPath || appPath
    const candidates = isElectronPackaged()
      ? [
          join(resourcesRoot, 'app.asar.unpacked', 'dist-electron', UTILITY_FILE),
          join(resourcesRoot, 'app.asar', 'dist-electron', UTILITY_FILE),
          join(resourcesRoot, 'dist-electron', UTILITY_FILE),
          join(__dirname, UTILITY_FILE),
          join(__dirname, '..', UTILITY_FILE)
        ]
      : [
          join(__dirname, UTILITY_FILE),
          join(__dirname, '..', UTILITY_FILE),
          join(appPath, 'dist-electron', UTILITY_FILE)
        ]
    return candidates.find((c) => existsSync(c)) || null
  }
}

export const wcdbService = new WcdbService()
