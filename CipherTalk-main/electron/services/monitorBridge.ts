import { EventEmitter } from 'events'
import { basename, join } from 'path'
import { existsSync, readdirSync, statSync, watch } from 'fs'
import type { FSWatcher } from 'fs'
import { ConfigService } from './config'

const DEBOUNCE_MS = 120
// fs.watch 兜底：macOS 的 FSEvents 递归监听在监听其他 App 沙盒容器目录时容易被合并/节流丢事件，
// 用 stat() 轮询 WAL/shm 的 mtime+size 作为独立信号，检测到变化就走同一 scheduleEmit（会与 fs.watch 去重）。
const POLL_INTERVAL_MS = 1500
const POLL_SUBDIRS = ['session', 'message', 'contact']

export type ChangeTable = 'Session' | 'Message' | 'Contact' | 'Sns' | 'Unknown'

export interface MonitorChangePayload {
  table: ChangeTable
  dbPath: string
  walPath: string
}

function classifyByFileName(fileName: string): ChangeTable {
  const lower = fileName.toLowerCase()
  if (/^session\.db-(wal|shm)$/.test(lower)) return 'Session'
  if (/^(msg|message)_.*\.db-(wal|shm)$/.test(lower)) return 'Message'
  if (/^contact\.db-(wal|shm)$/.test(lower)) return 'Contact'
  if (/^sns\.db-(wal|shm)$/.test(lower)) return 'Sns'
  return 'Unknown'
}

function classifyByTableName(raw: string): ChangeTable {
  const t = String(raw || '').trim().toLowerCase()
  if (t === 'session') return 'Session'
  if (t === 'message' || t.startsWith('msg')) return 'Message'
  if (t === 'contact') return 'Contact'
  if (t === 'sns') return 'Sns'
  return 'Unknown'
}

function resolveDbStoragePath(dbPath: string, wxid: string): string | null {
  if (!dbPath) return null
  const normalized = dbPath.replace(/[\\/]+$/, '')
  if (basename(normalized).toLowerCase() === 'db_storage' && existsSync(normalized)) {
    return normalized
  }
  const direct = join(normalized, 'db_storage')
  if (existsSync(direct)) return direct
  if (wxid) {
    const viaWxid = join(normalized, wxid, 'db_storage')
    if (existsSync(viaWxid)) return viaWxid
    try {
      const lowerWxid = wxid.toLowerCase()
      for (const entry of readdirSync(normalized)) {
        const entryPath = join(normalized, entry)
        try {
          if (!statSync(entryPath).isDirectory()) continue
        } catch {
          continue
        }
        const lowerEntry = entry.toLowerCase()
        if (lowerEntry !== lowerWxid && !lowerEntry.startsWith(`${lowerWxid}_`)) continue
        const candidate = join(entryPath, 'db_storage')
        if (existsSync(candidate)) return candidate
      }
    } catch {
      // ignore
    }
  }
  return null
}

export class MonitorBridge extends EventEmitter {
  private watcher: FSWatcher | null = null
  private dbStoragePath: string | null = null
  private timers: Map<string, NodeJS.Timeout> = new Map()
  private pollTimer: NodeJS.Timeout | null = null
  private fileSigs: Map<string, string> = new Map()
  private nativeMode = false
  private nativeRef: any = null
  private nativeHandler: ((type: any, json: any) => void) | null = null

  get isNativeMode(): boolean {
    return this.nativeMode
  }

  async start(): Promise<boolean> {
    if (this.watcher) return true

    let configService: ConfigService | null = null
    try {
      configService = new ConfigService()
      const dbPath = String(configService.get('dbPath') || '').trim()
      const myWxid = String(configService.get('myWxid') || '').trim()
      const resolved = resolveDbStoragePath(dbPath, myWxid)
      if (!resolved) {
        const err = new Error(`未找到 db_storage 目录: dbPath=${dbPath || '(空)'}, wxid=${myWxid || '(空)'}`)
        console.warn('[MonitorBridge] 启动失败:', err.message)
        this.emit('monitorError', err)
        return false
      }
      this.dbStoragePath = resolved

      this.watcher = watch(resolved, { recursive: true, persistent: true }, (_eventType, filename) => {
        if (!filename) return
        const name = typeof filename === 'string' ? filename : String(filename)
        const baseName = basename(name)
        if (!/\.db-(wal|shm)$/i.test(baseName)) return
        this.scheduleEmit(baseName, join(resolved, name))
      })

      this.watcher.on('error', (err) => {
        console.error('[MonitorBridge] watcher error:', err)
        this.emit('monitorError', err instanceof Error ? err : new Error(String(err)))
      })

      this.startPolling(resolved)

      console.log('[MonitorBridge] 启动监听:', resolved)
      return true
    } catch (e: any) {
      const err = e instanceof Error ? e : new Error(String(e))
      console.error('[MonitorBridge] 启动异常:', err.message)
      this.emit('monitorError', err)
      return false
    } finally {
      try { configService?.close() } catch { /* ignore */ }
    }
  }

  private scheduleEmit(baseName: string, walFullPath: string): void {
    const key = walFullPath.toLowerCase()
    const existing = this.timers.get(key)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.timers.delete(key)
      const table = classifyByFileName(baseName)
      const dbPath = walFullPath.replace(/\.db-(wal|shm)$/i, '.db')
      const payload: MonitorChangePayload = { table, dbPath, walPath: walFullPath }
      this.emit('change', payload)
    }, DEBOUNCE_MS)
    this.timers.set(key, timer)
  }

  private startPolling(root: string): void {
    if (this.pollTimer) return
    // 首轮只建立基线（不 emit），之后每轮对比 mtime+size，变化才触发。
    this.pollOnce(root)
    this.pollTimer = setInterval(() => this.pollOnce(root), POLL_INTERVAL_MS)
    this.pollTimer.unref?.()
  }

  private pollOnce(root: string): void {
    for (const sub of POLL_SUBDIRS) {
      const dir = join(root, sub)
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!/\.db-(wal|shm)$/i.test(entry)) continue
        const full = join(dir, entry)
        let sig: string
        try {
          const st = statSync(full)
          sig = `${st.mtimeMs}:${st.size}`
        } catch {
          continue
        }
        const key = full.toLowerCase()
        const prev = this.fileSigs.get(key)
        this.fileSigs.set(key, sig)
        if (prev !== undefined && prev !== sig) {
          this.scheduleEmit(entry, full)
        }
      }
    }
  }

  stop(): void {
    if (this.watcher) {
      try { this.watcher.close() } catch { /* ignore */ }
      this.watcher = null
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.fileSigs.clear()
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    this.dbStoragePath = null
  }

  switchToNativePipe(wcdbServiceRef: any): void {
    if (!wcdbServiceRef || typeof wcdbServiceRef.on !== 'function') {
      console.warn('[MonitorBridge] switchToNativePipe: 无效的 wcdbService 引用')
      return
    }
    void this.start()
    if (this.nativeRef === wcdbServiceRef && this.nativeHandler) return
    if (this.nativeRef && this.nativeHandler && typeof this.nativeRef.off === 'function') {
      try { this.nativeRef.off('change', this.nativeHandler) } catch { /* ignore */ }
    }
    const handler = (_type: any, json: any) => {
      try {
        const data = typeof json === 'string' ? JSON.parse(json) : (json || {})
        const table = classifyByTableName(data.table || _type)
        const dbPath = String(data.dbPath || '')
        const walPath = dbPath ? `${dbPath}-wal` : ''
        this.emit('change', { table, dbPath, walPath } as MonitorChangePayload)
      } catch (e: any) {
        const err = e instanceof Error ? e : new Error(String(e))
        console.error('[MonitorBridge] native 事件解析失败:', err.message)
        this.emit('monitorError', err)
      }
    }
    wcdbServiceRef.on('change', handler)
    this.nativeRef = wcdbServiceRef
    this.nativeHandler = handler
    this.nativeMode = true
    console.log('[MonitorBridge] 已切换到 native 管道')
  }
}

export const monitorBridge = new MonitorBridge()
