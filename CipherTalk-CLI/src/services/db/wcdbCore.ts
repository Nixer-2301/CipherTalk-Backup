import { basename, delimiter, dirname, join } from 'path'
import { existsSync, readdirSync, statSync } from 'fs'
import * as https from 'https'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

// Windows 在加载 DLL 时不会自动把 DLL 自身所在目录加入搜索路径——
// 把 native 目录前置到 PATH，确保 WCDB.dll 的 VC++ 依赖（VCRUNTIME140.dll 等）
// 能在同目录或系统目录里被找到。多次调用会去重。
function ensureDirInPath(dir: string): void {
  if (process.platform !== 'win32') return
  if (!dir) return
  const current = process.env.PATH || ''
  const segments = current.split(delimiter)
  if (segments.some((seg) => seg.toLowerCase() === dir.toLowerCase())) return
  process.env.PATH = `${dir}${delimiter}${current}`
}

/**
 * WcdbCore —— 直连微信加密数据库的底层封装。
 * - 不依赖 Electron `app`，可在 worker_threads 中实例化
 * - 所有资源路径通过 setPaths() 注入
 * - C 符号按需探测，未绑定的新符号不会导致初始化失败（特性可降级）
 */
export class WcdbCore {
  private lib: any = null
  private koffi: any = null
  private initialized = false
  private handle: number | null = null
  private currentPath: string | null = null
  private currentKey: string | null = null
  private currentWxid: string | null = null
  private currentDbStoragePath: string | null = null
  private resourcesPath: string | null = null
  private userDataPath: string | null = null

  // 已暴露的 C 符号
  private wcdbInit: any = null
  private wcdbShutdown: any = null
  private wcdbOpenAccount: any = null
  private wcdbCloseAccount: any = null
  private wcdbFreeString: any = null
  private wcdbGetLogs: any = null
  private wcdbGetSnsTimeline: any = null
  private wcdbExecQuery: any = null

  // 预留的 C 符号（native 未实现则置 null，特性降级）
  private wcdbExecQueryWithParams: any = null
  private wcdbGetMessages: any = null
  private wcdbOpenMessageCursor: any = null
  private wcdbOpenMessageCursorLite: any = null
  private wcdbFetchMessageBatch: any = null
  private wcdbCloseMessageCursor: any = null
  private wcdbStartMonitorPipe: any = null
  private wcdbStopMonitorPipe: any = null
  private wcdbGetMonitorPipeName: any = null
  private wcdbSetMyWxid: any = null
  private wcdbSetTrustedTime: any = null

  // 可信时间同步定时器（防本地改时钟绕过到期）
  private trustedTimeTimer: any = null

  // 管道监控状态
  private monitorPipeClient: any = null
  private monitorCallback: ((type: string, json: string) => void) | null = null
  private monitorReconnectTimer: any = null
  private monitorPipePath: string = ''

  setPaths(resourcesPath: string, userDataPath: string): void {
    this.resourcesPath = resourcesPath
    this.userDataPath = userDataPath
  }

  getUserDataPath(): string | null { return this.userDataPath }

  private getLibraryPath(): string {
    const baseDir = this.resourcesPath || join(process.cwd(), 'resources')
    if (process.platform === 'darwin') return join(baseDir, 'darwin-arm64', 'libwcdb_api.dylib')
    if (process.platform === 'win32') return join(baseDir, 'win32-x64', 'wcdb_api.dll')
    return join(baseDir, `${process.platform}-${process.arch}`, 'libwcdb_api.so')
  }

  private getWindowsCoreLibraryPath(): string {
    const baseDir = this.resourcesPath || join(process.cwd(), 'resources')
    return join(baseDir, 'win32-x64', 'WCDB.dll')
  }

  async initialize(): Promise<{ success: boolean; error?: string }> {
    if (this.initialized) return { success: true }

    try {
      this.koffi = require('koffi')
      const libraryPath = this.getLibraryPath()
      if (!existsSync(libraryPath)) {
        return { success: false, error: `WCDB 原生库不存在: ${libraryPath}` }
      }

      // 让 Windows DLL 加载器能在同目录解析隐式依赖
      ensureDirInPath(dirname(libraryPath))

      if (process.platform === 'win32') {
        const wcdbCorePath = this.getWindowsCoreLibraryPath()
        ensureDirInPath(dirname(wcdbCorePath))
        if (existsSync(wcdbCorePath)) {
          try {
            this.koffi.load(wcdbCorePath)
          } catch (e: any) {
            console.warn('预加载 WCDB.dll 失败:', e.message || e)
          }
        }
      }

      this.lib = this.koffi.load(libraryPath)

      // 绑定已确定暴露的符号
      this.wcdbInit = this.lib.func('int32 wcdb_init()')
      this.wcdbShutdown = this.lib.func('int32 wcdb_shutdown()')
      this.wcdbOpenAccount = this.lib.func('int32 wcdb_open_account(const char* path, const char* key, _Out_ int64* handle)')
      this.wcdbCloseAccount = this.lib.func('int32 wcdb_close_account(int64 handle)')
      this.wcdbFreeString = this.lib.func('void wcdb_free_string(void* ptr)')
      this.wcdbGetLogs = this.lib.func('int32 wcdb_get_logs(_Out_ void** outJson)')
      this.wcdbGetSnsTimeline = this.lib.func('int32 wcdb_get_sns_timeline(int64 handle, int32 limit, int32 offset, const char* username, const char* keyword, int32 startTime, int32 endTime, _Out_ void** outJson)')
      this.wcdbExecQuery = this.lib.func('int32 wcdb_exec_query(int64 handle, const char* kind, const char* path, const char* sql, _Out_ void** outJson)')

      // 预留符号：native 若未实现则保持 null，特性降级
      const tryBind = (decl: string): any => {
        try { return this.lib.func(decl) } catch { return null }
      }
      this.wcdbExecQueryWithParams = tryBind('int32 wcdb_exec_query_with_params(int64 handle, const char* kind, const char* path, const char* sql, const char* argsJson, _Out_ void** outJson)')
      this.wcdbGetMessages = tryBind('int32 wcdb_get_messages(int64 handle, const char* username, int32 limit, int32 offset, _Out_ void** outJson)')
      this.wcdbOpenMessageCursor = tryBind('int32 wcdb_open_message_cursor(int64 handle, const char* sessionId, int32 batchSize, int32 ascending, int32 beginTimestamp, int32 endTimestamp, _Out_ int64* outCursor)')
      this.wcdbOpenMessageCursorLite = tryBind('int32 wcdb_open_message_cursor_lite(int64 handle, const char* sessionId, int32 batchSize, int32 ascending, int32 beginTimestamp, int32 endTimestamp, _Out_ int64* outCursor)')
      this.wcdbFetchMessageBatch = tryBind('int32 wcdb_fetch_message_batch(int64 handle, int64 cursor, _Out_ void** outJson, _Out_ int32* outHasMore)')
      this.wcdbCloseMessageCursor = tryBind('int32 wcdb_close_message_cursor(int64 handle, int64 cursor)')
      this.wcdbStartMonitorPipe = tryBind('int32 wcdb_start_monitor_pipe()')
      this.wcdbStopMonitorPipe = tryBind('int32 wcdb_stop_monitor_pipe()')
      this.wcdbGetMonitorPipeName = tryBind('int32 wcdb_get_monitor_pipe_name(_Out_ void** outName)')
      this.wcdbSetMyWxid = tryBind('int32 wcdb_set_my_wxid(int64 handle, const char* wxid)')
      this.wcdbSetTrustedTime = tryBind('int32 wcdb_set_trusted_time(int64 epochSeconds)')

      let initResult = this.wcdbInit()
      if (initResult === -8 && this.wcdbSetTrustedTime) {
        await this.syncTrustedTime()
        initResult = this.wcdbInit()
      }
      if (initResult !== 0) {
        return { success: false, error: `wcdb_init() 返回错误码: ${initResult}` }
      }

      this.initialized = true
      this.startTrustedTimeSync(false)
      return { success: true }
    } catch (e: any) {
      return { success: false, error: `WCDB 初始化异常: ${e.message || String(e)}` }
    }
  }

  // ============== 可信时间同步（防本地改时钟绕过到期）==============
  // native 维护"高水位 + 联网投影"的有效时间；这里负责从公共时间 API 取可信时间喂进 DLL。
  // 取不到（离线）就静默，DLL 退化为本地时钟 + 历史高水位，离线照常可用。
  private startTrustedTimeSync(syncNow = true): void {
    if (!this.wcdbSetTrustedTime) return
    if (syncNow) void this.syncTrustedTime()
    if (this.trustedTimeTimer) clearInterval(this.trustedTimeTimer)
    this.trustedTimeTimer = setInterval(() => { void this.syncTrustedTime() }, 6 * 60 * 60 * 1000)
    this.trustedTimeTimer?.unref?.()
  }

  private stopTrustedTimeSync(): void {
    if (this.trustedTimeTimer) {
      clearInterval(this.trustedTimeTimer)
      this.trustedTimeTimer = null
    }
  }

  private async syncTrustedTime(): Promise<void> {
    try {
      if (!this.wcdbSetTrustedTime) return
      const epoch = await this.fetchNetworkEpochSeconds()
      if (epoch && this.isPlausibleEpoch(epoch)) {
        this.wcdbSetTrustedTime(epoch)
      }
    } catch {
      // 离线/失败静默，靠 native 本地高水位兜底
    }
  }

  private isPlausibleEpoch(sec: number): boolean {
    return Number.isFinite(sec) && sec > 1700000000 && sec < 4102444800
  }

  private async fetchNetworkEpochSeconds(): Promise<number | null> {
    const sources: Array<{ url: string; parse: (body: string) => number | null }> = [
      {
        url: 'https://worldtimeapi.org/api/timezone/Etc/UTC',
        parse: (b) => { try { const j = JSON.parse(b); return typeof j.unixtime === 'number' ? j.unixtime : null } catch { return null } },
      },
      {
        url: 'https://timeapi.io/api/time/current/zone?timeZone=Etc%2FUTC',
        parse: (b) => { try { const j = JSON.parse(b); const t = Date.parse(String(j.dateTime).replace(/Z?$/, 'Z')); return Number.isFinite(t) ? Math.floor(t / 1000) : null } catch { return null } },
      },
      {
        url: 'https://www.cloudflare.com/cdn-cgi/trace',
        parse: (b) => { const m = /(?:^|\n)ts=([0-9.]+)/.exec(b); return m ? Math.floor(parseFloat(m[1])) : null },
      },
    ]
    for (const s of sources) {
      try {
        const { body, dateHeader } = await this.httpGetText(s.url, 4000)
        let epoch = s.parse(body)
        if ((!epoch || !this.isPlausibleEpoch(epoch)) && dateHeader) {
          const d = Date.parse(dateHeader)
          if (Number.isFinite(d)) epoch = Math.floor(d / 1000)
        }
        if (epoch && this.isPlausibleEpoch(epoch)) return epoch
      } catch {
        // 试下一个源
      }
    }
    return null
  }

  private httpGetText(url: string, timeoutMs: number): Promise<{ body: string; dateHeader?: string }> {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'CipherTalk' } }, (res) => {
        const rawDateHeader = res.headers?.date
        const dateHeader = Array.isArray(rawDateHeader) ? rawDateHeader[0] : rawDateHeader
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => { if (body.length < 8192) body += c })
        res.on('end', () => resolve({ body, dateHeader }))
      })
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', reject)
    })
  }

  // ============== 路径解析 ==============
  private findSessionDbs(dir: string, depth = 0, results: string[] = []): string[] {
    if (depth > 5) return results
    try {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        if (entry.toLowerCase() === 'session.db') {
          const fullPath = join(dir, entry)
          if (statSync(fullPath).isFile() && !results.includes(fullPath)) {
            results.push(fullPath)
          }
        }
      }
      for (const entry of entries) {
        const fullPath = join(dir, entry)
        try {
          if (statSync(fullPath).isDirectory()) {
            this.findSessionDbs(fullPath, depth + 1, results)
          }
        } catch {
          // ignore
        }
      }
    } catch (e) {
      console.error('查找 session.db 失败:', e)
    }
    return results
  }

  private scoreSessionDbPath(filePath: string): number {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase()
    let score = 0
    if (normalized.endsWith('/session/session.db')) score += 40
    if (normalized.includes('/db_storage/session/')) score += 20
    if (normalized.includes('/db_storage/')) score += 10
    return score
  }

  private getCandidateSessionDbs(dbStoragePath: string): string[] {
    return this.findSessionDbs(dbStoragePath)
      .sort((a, b) => this.scoreSessionDbPath(b) - this.scoreSessionDbPath(a) || a.localeCompare(b))
  }

  private resolveDbStoragePath(dbPath: string, wxid: string): string | null {
    if (!dbPath) return null
    const normalizedDbPath = dbPath.replace(/[\\/]+$/, '')
    if (basename(normalizedDbPath).toLowerCase() === 'db_storage' && existsSync(normalizedDbPath)) return normalizedDbPath
    const direct = join(normalizedDbPath, 'db_storage')
    if (existsSync(direct)) return direct
    if (wxid) {
      const viaWxid = join(normalizedDbPath, wxid, 'db_storage')
      if (existsSync(viaWxid)) return viaWxid
      try {
        const lowerWxid = wxid.toLowerCase()
        for (const entry of readdirSync(normalizedDbPath)) {
          const entryPath = join(normalizedDbPath, entry)
          try { if (!statSync(entryPath).isDirectory()) continue } catch { continue }
          const lowerEntry = entry.toLowerCase()
          if (lowerEntry !== lowerWxid && !lowerEntry.startsWith(`${lowerWxid}_`)) continue
          const candidate = join(entryPath, 'db_storage')
          if (existsSync(candidate)) return candidate
        }
      } catch { /* ignore */ }
    }
    return null
  }

  private tryOpenWithCandidates(sessionDbPaths: string[], hexKey: string): { success: boolean; handle?: number; matchedPath?: string; errors: string[] } {
    const errors: string[] = []
    for (const sessionDbPath of sessionDbPaths) {
      const handleOut = [0]
      const result = this.wcdbOpenAccount(sessionDbPath, hexKey, handleOut)
      if (result === 0 && handleOut[0] > 0) {
        return { success: true, handle: handleOut[0], matchedPath: sessionDbPath, errors }
      }
      errors.push(`${sessionDbPath} => ${this.mapStatusCode(result)}`)
    }
    return { success: false, errors }
  }

  // ============== 连接生命周期 ==============
  async open(dbPath: string, hexKey: string, wxid: string): Promise<boolean> {
    try {
      if (
        this.handle !== null &&
        this.currentPath === dbPath &&
        this.currentKey === hexKey &&
        this.currentWxid === wxid
      ) {
        return true
      }

      const initRes = await this.initialize()
      if (!initRes.success) return false

      if (this.handle !== null) {
        this.close()
        const reinitRes = await this.initialize()
        if (!reinitRes.success) return false
      }

      const dbStoragePath = this.resolveDbStoragePath(dbPath, wxid)
      if (!dbStoragePath) {
        console.error('数据库目录不存在:', dbPath)
        return false
      }

      const sessionDbPaths = this.getCandidateSessionDbs(dbStoragePath)
      if (sessionDbPaths.length === 0) {
        console.error('未找到 session.db 文件:', dbStoragePath)
        return false
      }

      const openResult = this.tryOpenWithCandidates(sessionDbPaths, hexKey)
      if (!openResult.success || !openResult.handle) {
        await this.printLogs()
        return false
      }

      const handle = openResult.handle
      if (handle <= 0) return false

      this.handle = handle
      this.currentPath = dbPath
      this.currentKey = hexKey
      this.currentWxid = wxid
      this.currentDbStoragePath = dbStoragePath
      this.initialized = true

      // 可选：若 native 支持，则绑定当前 wxid
      if (this.wcdbSetMyWxid && wxid) {
        try {
          this.wcdbSetMyWxid(this.handle, wxid)
        } catch (e) {
          console.warn('wcdb_set_my_wxid 调用失败（可忽略）:', e)
        }
      }

      return true
    } catch (e) {
      console.error('打开数据库异常:', e)
      return false
    }
  }

  close(): void {
    this.stopTrustedTimeSync()
    if (this.handle !== null && this.wcdbCloseAccount) {
      try { this.wcdbCloseAccount(this.handle) } catch (e) { console.error('关闭 WCDB 句柄失败:', e) }
    }
    if (this.initialized && this.wcdbShutdown) {
      try { this.wcdbShutdown() } catch (e) { console.error('WCDB shutdown 失败:', e) }
    }
    this.handle = null
    this.initialized = false
    this.lib = null
    this.currentPath = null
    this.currentKey = null
    this.currentWxid = null
    this.currentDbStoragePath = null
  }

  shutdown(): void { this.close() }

  isConnected(): boolean { return this.initialized && this.handle !== null }

  async testConnection(dbPath: string, hexKey: string, wxid: string): Promise<{ success: boolean; error?: string; sessionCount?: number }> {
    // 开源版 wcdb_api 在同一进程对同一个 session.db 调用 wcdb_open_account 第二次会
    // 让进程硬退出（C++ 析构留作 no-op，残留资源在第二次 open 时炸锅）。
    // 因此 testConnection 不再独立 open+shutdown，改成走 open() 复用句柄。
    // 后续查询会命中 open() 的缓存命中分支，零代价。
    try {
      const ok = await this.open(dbPath, hexKey, wxid)
      if (!ok) {
        const logs = await this.printLogs()
        return { success: false, error: `数据库打开失败${logs ? ` | logs=${logs}` : ''}` }
      }
      return { success: true, sessionCount: 0 }
    } catch (e) {
      console.error('测试连接异常:', e)
      return { success: false, error: String(e) }
    }
  }

  // ============== 查询接口 ==============
  async execQuery(kind: string, path: string, sql: string): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    if (!this.initialized || this.handle === null) {
      return { success: false, error: 'WCDB 未初始化' }
    }
    try {
      const outJson = [null]
      const result = this.wcdbExecQuery(this.handle, kind, path || '', sql, outJson)
      if (result !== 0 || !outJson[0]) {
        return { success: false, error: this.mapStatusCode(result) }
      }
      const jsonStr = this.koffi.decode(outJson[0], 'char', -1)
      this.wcdbFreeString(outJson[0])
      return { success: true, rows: JSON.parse(jsonStr) }
    } catch (e: any) {
      return { success: false, error: e.message || String(e) }
    }
  }

  /**
   * 参数化查询。
   * 参数数组需序列化为 `[{type:'string'|'int'|'double'|'bytes'|'null', value:any}]`。
   * 若 native 未绑定该符号，将抛出明确错误。
   */
  async execQueryWithParams(kind: string, path: string, sql: string, params?: any[]): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    if (!this.initialized || this.handle === null) {
      return { success: false, error: 'WCDB 未初始化' }
    }
    if (!this.wcdbExecQueryWithParams) {
      return { success: false, error: 'native 未支持参数化查询' }
    }
    try {
      const typed = (params || []).map(this.inferParamDescriptor)
      const argsJson = JSON.stringify(typed)
      const outJson = [null]
      const result = this.wcdbExecQueryWithParams(this.handle, kind, path || '', sql, argsJson, outJson)
      if (result !== 0 || !outJson[0]) {
        return { success: false, error: this.mapStatusCode(result) }
      }
      const jsonStr = this.koffi.decode(outJson[0], 'char', -1)
      this.wcdbFreeString(outJson[0])
      return { success: true, rows: JSON.parse(jsonStr) }
    } catch (e: any) {
      return { success: false, error: e.message || String(e) }
    }
  }

  private inferParamDescriptor(value: any): { type: string; value: any } {
    if (value === null || value === undefined) {
      return { type: 'null', value: null }
    }
    if (typeof value === 'object' && value && typeof (value as any).type === 'string' && 'value' in value) {
      return value as { type: string; value: any }
    }
    if (typeof value === 'number') {
      return Number.isInteger(value) ? { type: 'int', value } : { type: 'double', value }
    }
    if (typeof value === 'bigint') {
      return { type: 'int', value: value.toString() }
    }
    if (typeof value === 'boolean') {
      return { type: 'int', value: value ? 1 : 0 }
    }
    if (Buffer.isBuffer(value)) {
      return { type: 'bytes', value: value.toString('base64') }
    }
    if (value instanceof Uint8Array) {
      return { type: 'bytes', value: Buffer.from(value).toString('base64') }
    }
    return { type: 'string', value: String(value) }
  }

  async getSnsTimeline(limit: number, offset: number, usernames?: string[], keyword?: string, startTime?: number, endTime?: number): Promise<{ success: boolean; timeline?: any[]; error?: string }> {
    if (!this.initialized || this.handle === null) {
      return { success: false, error: 'WCDB 未初始化' }
    }
    try {
      const outJson = [null]
      const usernamesJson = usernames && usernames.length > 0 ? JSON.stringify(usernames) : ''
      const result = this.wcdbGetSnsTimeline(
        this.handle,
        limit,
        offset,
        usernamesJson,
        keyword || '',
        startTime || 0,
        endTime || 0,
        outJson
      )
      if (result !== 0) {
        return { success: false, error: this.mapStatusCode(result) }
      }
      if (!outJson[0]) {
        return { success: true, timeline: [] }
      }
      const jsonStr = this.koffi.decode(outJson[0], 'char', -1)
      this.wcdbFreeString(outJson[0])
      return { success: true, timeline: JSON.parse(jsonStr) }
    } catch (e: any) {
      return { success: false, error: e.message || String(e) }
    }
  }

  private decodeJsonPtr(outPtr: any): string | null {
    if (!outPtr) return null
    try {
      const jsonStr = this.koffi.decode(outPtr, 'char', -1)
      this.wcdbFreeString(outPtr)
      return jsonStr
    } catch {
      try { this.wcdbFreeString(outPtr) } catch { /* ignore */ }
      return null
    }
  }

  private parseMessageJson(jsonStr: string): any[] {
    const raw = String(jsonStr || '')
    if (!raw) return []
    const needsInt64Normalize = /"server_id"\s*:\s*-?\d{16,}/.test(raw)
    const normalized = needsInt64Normalize
      ? raw.replace(/("server_id"\s*:\s*)(-?\d{16,})/g, '$1"$2"')
      : raw
    const parsed = JSON.parse(normalized)
    return Array.isArray(parsed) ? parsed : [parsed]
  }

  async getNativeMessages(sessionId: string, limit: number, offset: number): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    if (!this.initialized || this.handle === null) {
      return { success: false, error: 'WCDB 未初始化' }
    }
    if (!this.wcdbGetMessages) {
      return { success: false, error: 'native 未支持直接消息读取' }
    }

    try {
      const outJson = [null as any]
      const result = this.wcdbGetMessages(
        this.handle,
        sessionId,
        Math.max(1, Math.floor(Number(limit) || 50)),
        Math.max(0, Math.floor(Number(offset) || 0)),
        outJson
      )
      if (result !== 0 || !outJson[0]) {
        return { success: false, error: this.mapCursorStatusCode(result, '直接读取消息失败') }
      }
      const jsonStr = this.decodeJsonPtr(outJson[0])
      if (!jsonStr) return { success: false, error: '解析消息失败' }
      return { success: true, rows: this.parseMessageJson(jsonStr) }
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) }
    }
  }

  async openMessageCursor(
    sessionId: string,
    batchSize: number,
    ascending: boolean,
    beginTimestamp: number,
    endTimestamp: number
  ): Promise<{ success: boolean; cursor?: number; error?: string }> {
    if (!this.initialized || this.handle === null) {
      return { success: false, error: 'WCDB 未初始化' }
    }
    if (!this.wcdbOpenMessageCursor) {
      return { success: false, error: 'native 未支持消息游标' }
    }

    try {
      const outCursor = [0]
      const result = this.wcdbOpenMessageCursor(
        this.handle,
        sessionId,
        Math.max(1, Math.floor(Number(batchSize) || 100)),
        ascending ? 1 : 0,
        Math.max(0, Math.floor(Number(beginTimestamp) || 0)),
        Math.max(0, Math.floor(Number(endTimestamp) || 0)),
        outCursor
      )
      if (result !== 0 || outCursor[0] <= 0) {
        return { success: false, error: this.mapCursorStatusCode(result, '创建游标失败') }
      }
      return { success: true, cursor: outCursor[0] }
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) }
    }
  }

  async openMessageCursorLite(
    sessionId: string,
    batchSize: number,
    ascending: boolean,
    beginTimestamp: number,
    endTimestamp: number
  ): Promise<{ success: boolean; cursor?: number; error?: string }> {
    if (!this.wcdbOpenMessageCursorLite) {
      return this.openMessageCursor(sessionId, batchSize, ascending, beginTimestamp, endTimestamp)
    }
    if (!this.initialized || this.handle === null) {
      return { success: false, error: 'WCDB 未初始化' }
    }

    try {
      const outCursor = [0]
      const result = this.wcdbOpenMessageCursorLite(
        this.handle,
        sessionId,
        Math.max(1, Math.floor(Number(batchSize) || 100)),
        ascending ? 1 : 0,
        Math.max(0, Math.floor(Number(beginTimestamp) || 0)),
        Math.max(0, Math.floor(Number(endTimestamp) || 0)),
        outCursor
      )
      if (result !== 0 || outCursor[0] <= 0) {
        return { success: false, error: this.mapCursorStatusCode(result, '创建轻量游标失败') }
      }
      return { success: true, cursor: outCursor[0] }
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) }
    }
  }

  async fetchMessageBatch(cursor: number): Promise<{ success: boolean; rows?: any[]; hasMore?: boolean; error?: string }> {
    if (!this.initialized || this.handle === null) {
      return { success: false, error: 'WCDB 未初始化' }
    }
    if (!this.wcdbFetchMessageBatch) {
      return { success: false, error: 'native 未支持消息游标批量读取' }
    }

    try {
      const outJson = [null as any]
      const outHasMore = [0]
      const result = this.wcdbFetchMessageBatch(this.handle, cursor, outJson, outHasMore)
      if (result !== 0 || !outJson[0]) {
        return { success: false, error: this.mapCursorStatusCode(result, '获取批次失败') }
      }
      const jsonStr = this.decodeJsonPtr(outJson[0])
      if (!jsonStr) return { success: false, error: '解析批次失败' }
      return { success: true, rows: this.parseMessageJson(jsonStr), hasMore: outHasMore[0] === 1 }
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) }
    }
  }

  async getMessageBatchViaCursor(
    sessionId: string,
    batchSize: number,
    ascending: boolean,
    beginTimestamp: number,
    endTimestamp: number,
    useLite: boolean = true,
    maxBatches: number = 1
  ): Promise<{ success: boolean; rows?: any[]; hasMore?: boolean; error?: string }> {
    const openRes = useLite
      ? await this.openMessageCursorLite(sessionId, batchSize, ascending, beginTimestamp, endTimestamp)
      : await this.openMessageCursor(sessionId, batchSize, ascending, beginTimestamp, endTimestamp)

    if (!openRes.success || !openRes.cursor) {
      return { success: false, error: openRes.error || '创建消息游标失败' }
    }

    try {
      const rows: any[] = []
      let hasMore = false
      const safeMaxBatches = Math.max(1, Math.min(10, Math.floor(Number(maxBatches) || 1)))

      for (let i = 0; i < safeMaxBatches; i++) {
        const batch = await this.fetchMessageBatch(openRes.cursor)
        if (!batch.success) {
          return { success: false, error: batch.error || '获取消息批次失败' }
        }

        const batchRows = Array.isArray(batch.rows) ? batch.rows : []
        rows.push(...batchRows)
        hasMore = batch.hasMore === true

        if (!hasMore || batchRows.length === 0) break
      }

      return { success: true, rows, hasMore }
    } finally {
      await this.closeMessageCursor(openRes.cursor).catch(() => undefined)
    }
  }

  async closeMessageCursor(cursor: number): Promise<{ success: boolean; error?: string }> {
    if (!this.initialized || this.handle === null) {
      return { success: false, error: 'WCDB 未初始化' }
    }
    if (!this.wcdbCloseMessageCursor) {
      return { success: false, error: 'native 未支持关闭消息游标' }
    }

    try {
      const result = this.wcdbCloseMessageCursor(this.handle, cursor)
      if (result !== 0) {
        return { success: false, error: this.mapCursorStatusCode(result, '关闭游标失败') }
      }
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) }
    }
  }

  // ============== 命名管道监控 ==============
  /**
   * 启动 native 侧的命名管道监控并订阅事件回调。
   * 若 native 未导出管道相关符号则返回 false（功能降级）。
   */
  setMonitor(callback: (type: string, json: string) => void): boolean {
    if (!this.wcdbStartMonitorPipe) {
      return false
    }
    this.monitorCallback = callback
    try {
      const result = this.wcdbStartMonitorPipe()
      if (result !== 0) {
        return false
      }

      let pipePath = process.platform === 'win32'
        ? '\\\\.\\pipe\\ciphertalk_monitor'
        : '/tmp/weflow_monitor_pipe'
      if (this.wcdbGetMonitorPipeName) {
        try {
          const namePtr = [null as any]
          if (this.wcdbGetMonitorPipeName(namePtr) === 0 && namePtr[0]) {
            pipePath = this.koffi.decode(namePtr[0], 'char', -1)
            this.wcdbFreeString(namePtr[0])
          }
        } catch {
          // ignore，落回默认管道名
        }
      }
      this.connectMonitorPipe(pipePath)
      return true
    } catch (e) {
      console.error('[wcdbCore] setMonitor exception:', e)
      return false
    }
  }

  private connectMonitorPipe(pipePath: string): void {
    this.monitorPipePath = pipePath
    const net = require('net')

    setTimeout(() => {
      if (!this.monitorCallback) return

      this.monitorPipeClient = net.createConnection(this.monitorPipePath, () => {})

      let buffer = ''
      this.monitorPipeClient.on('data', (data: Buffer) => {
        const rawChunk = data.toString('utf8')
        const normalizedChunk = rawChunk
          .replace(/\u0000/g, '\n')
          .replace(/}\s*{/g, '}\n{')

        buffer += normalizedChunk
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (line.trim()) {
            try {
              const parsed = JSON.parse(line)
              this.monitorCallback?.(parsed.action || 'update', line)
            } catch {
              this.monitorCallback?.('update', line)
            }
          }
        }

        const tail = buffer.trim()
        if (tail.startsWith('{') && tail.endsWith('}')) {
          try {
            const parsed = JSON.parse(tail)
            this.monitorCallback?.(parsed.action || 'update', tail)
            buffer = ''
          } catch {
            // 不可解析则继续等待下一块数据
          }
        }
      })

      this.monitorPipeClient.on('error', () => {
        // 保持静默，交由 close 回调触发重连
      })

      this.monitorPipeClient.on('close', () => {
        this.monitorPipeClient = null
        this.scheduleReconnect()
      })
    }, 100)
  }

  private scheduleReconnect(): void {
    if (this.monitorReconnectTimer || !this.monitorCallback) return
    this.monitorReconnectTimer = setTimeout(() => {
      this.monitorReconnectTimer = null
      if (this.monitorCallback && !this.monitorPipeClient) {
        this.connectMonitorPipe(this.monitorPipePath)
      }
    }, 3000)
  }

  stopMonitor(): void {
    this.monitorCallback = null
    if (this.monitorReconnectTimer) {
      clearTimeout(this.monitorReconnectTimer)
      this.monitorReconnectTimer = null
    }
    if (this.monitorPipeClient) {
      try {
        this.monitorPipeClient.destroy()
      } catch {
        // ignore
      }
      this.monitorPipeClient = null
    }
    if (this.wcdbStopMonitorPipe) {
      try {
        this.wcdbStopMonitorPipe()
      } catch {
        // ignore
      }
    }
  }

  // ============== 日志 / 错误码 ==============
  private async printLogs(): Promise<string> {
    try {
      if (!this.wcdbGetLogs) return ''
      const outPtr = [null as any]
      const result = this.wcdbGetLogs(outPtr)
      if (result === 0 && outPtr[0]) {
        const jsonStr = this.koffi.decode(outPtr[0], 'char', -1)
        console.error('WCDB 内部日志:', jsonStr)
        this.wcdbFreeString(outPtr[0])
        return jsonStr
      }
    } catch (e) {
      console.error('获取 WCDB 日志失败:', e)
    }
    return ''
  }

  private mapStatusCode(code: number): string {
    switch (code) {
      case 0: return '成功'
      case -1: return '参数错误'
      case -2: return '密钥错误'
      case -3:
      case -4: return '数据库打开失败'
      case -5: return '查询执行失败'
      case -6: return 'WCDB 尚未初始化'
      case -7: return 'WCDB 表结构不匹配'
      case -8: return '软件偷来的吧！'
      case -9: return '快提醒作者更新软件了！'
      case -10: return '靠，你从哪搞得软件？'
      default: return `WCDB 错误码: ${code}`
    }
  }

  private mapCursorStatusCode(code: number, prefix: string): string {
    if (code === -7) return 'message schema mismatch：当前账号消息表结构与程序要求不一致'
    if (code === -8) return `${prefix}: ${code}（软件偷来的吧！）`
    if (code === -9) return `${prefix}: ${code}（快提醒作者更新软件了！）`
    if (code === -10) return `${prefix}: ${code}（靠，你从哪搞得软件？）`
    if (code === -3) return `${prefix}: ${code}（消息数据库未找到）`
    return `${prefix}: ${code}`
  }
}
