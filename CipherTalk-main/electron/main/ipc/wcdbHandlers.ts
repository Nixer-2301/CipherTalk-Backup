import { ipcMain, webContents } from 'electron'
import { existsSync } from 'fs'
import { basename, join } from 'path'
import { dbPathService } from '../../services/dbPathService'
import { wcdbService } from '../../services/wcdbService'
import { monitorBridge } from '../../services/monitorBridge'
import type { MainProcessContext } from '../context'

let monitorBroadcastWired = false

type WcdbConnectionInput = {
  dbPath: string
  hexKey: string
  wxid: string
}

function normalizeConnectionInput(dbPath: string, hexKey: string, wxid: string): WcdbConnectionInput {
  return {
    dbPath: String(dbPath || '').trim(),
    hexKey: String(hexKey || '').trim(),
    wxid: String(wxid || '').trim()
  }
}

function isValidHexKey(hexKey: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(hexKey)
}

function isDbStoragePath(dbPath: string): boolean {
  return basename(dbPath).toLowerCase() === 'db_storage'
}

function hasDbStorageChild(dbPath: string): boolean {
  return existsSync(join(dbPath, 'db_storage'))
}

function isSameOrDerivedWxid(candidate: string, wxid: string): boolean {
  const left = candidate.toLowerCase()
  const right = wxid.toLowerCase()
  return left === right || left.startsWith(`${right}_`) || right.startsWith(`${left}_`)
}

function validateConnectionInput(input: WcdbConnectionInput): string | null {
  if (!input.dbPath) return '请选择微信数据目录'
  if (!existsSync(input.dbPath)) return `微信数据目录不存在: ${input.dbPath}`
  if (!input.hexKey) return '缺少解密密钥'
  if (!isValidHexKey(input.hexKey)) return '解密密钥格式不正确，应为 64 位十六进制字符串'
  if (!input.wxid) return '请选择账号目录'

  const wxids = dbPathService.scanWxids(input.dbPath)
  if (wxids.length === 0) {
    if (isDbStoragePath(input.dbPath)) return null
    return '未检测到账号目录，请选择 WeChat Files、xwechat_files 或具体 wxid 账号目录'
  }

  if (hasDbStorageChild(input.dbPath)) return null

  if (!wxids.some((candidate) => isSameOrDerivedWxid(candidate, input.wxid))) {
    const preview = wxids.slice(0, 5).join('、')
    const suffix = wxids.length > 5 ? ` 等 ${wxids.length} 个` : ''
    return `账号目录 ${input.wxid} 不在当前数据目录中，可选账号: ${preview}${suffix}`
  }

  return null
}

function validateResolveInput(dbPath: string, hexKey: string): { dbPath: string; hexKey: string; error?: string } {
  const normalizedDbPath = String(dbPath || '').trim()
  const normalizedHexKey = String(hexKey || '').trim()

  if (!normalizedDbPath) return { dbPath: normalizedDbPath, hexKey: normalizedHexKey, error: '请选择微信数据目录' }
  if (!existsSync(normalizedDbPath)) return { dbPath: normalizedDbPath, hexKey: normalizedHexKey, error: `微信数据目录不存在: ${normalizedDbPath}` }
  if (!normalizedHexKey) return { dbPath: normalizedDbPath, hexKey: normalizedHexKey, error: '缺少解密密钥' }
  if (!isValidHexKey(normalizedHexKey)) return { dbPath: normalizedDbPath, hexKey: normalizedHexKey, error: '解密密钥格式不正确，应为 64 位十六进制字符串' }

  return { dbPath: normalizedDbPath, hexKey: normalizedHexKey }
}

function setupMonitorBroadcast(ctx: MainProcessContext): void {
  if (monitorBroadcastWired) return
  monitorBroadcastWired = true
  monitorBridge.on('change', (payload) => {
    try {
      for (const wc of webContents.getAllWebContents()) {
        if (!wc.isDestroyed()) wc.send('wcdb:change', payload)
      }
    } catch (e) {
      ctx.getLogService()?.warn('WCDB', 'wcdb:change broadcast failed', { error: String(e) })
    }
  })
}

/**
 * WCDB 连接与解密 IPC。
 * 自动连接失败使用 warn，手动测试失败使用 error，便于日志侧区分场景。
 */
export function registerWcdbHandlers(ctx: MainProcessContext): void {
  setupMonitorBroadcast(ctx)

  ipcMain.handle('wcdb:testConnection', async (_, dbPath: string, hexKey: string, wxid: string, isAutoConnect = false) => {
    const logPrefix = isAutoConnect ? '自动连接' : '手动测试'
    const input = normalizeConnectionInput(dbPath, hexKey, wxid)
    ctx.getLogService()?.info('WCDB', `${logPrefix}数据库连接`, { dbPath: input.dbPath, wxid: input.wxid, isAutoConnect })

    const validationError = validateConnectionInput(input)
    if (validationError) {
      const result = { success: false, error: validationError }
      const logLevel = isAutoConnect ? 'warn' : 'error'
      const errorInfo = {
        error: validationError,
        dbPath: input.dbPath,
        wxid: input.wxid,
        keyLength: input.hexKey.length,
        isAutoConnect
      }
      if (logLevel === 'warn') {
        ctx.getLogService()?.warn('WCDB', `${logPrefix}数据库连接参数无效`, errorInfo)
      } else {
        ctx.getLogService()?.error('WCDB', `${logPrefix}数据库连接参数无效`, errorInfo)
      }
      return result
    }

    const result = await wcdbService.testConnection(input.dbPath, input.hexKey, input.wxid)
    if (result.success) {
      ctx.getLogService()?.info('WCDB', `${logPrefix}数据库连接成功`, { sessionCount: result.sessionCount })
    } else {
      // 自动连接失败使用WARN级别，手动测试失败使用ERROR级别
      const logLevel = isAutoConnect ? 'warn' : 'error'
      const errorInfo = {
        error: result.error || '未知错误',
        dbPath: input.dbPath,
        wxid: input.wxid,
        keyLength: input.hexKey.length,
        isAutoConnect
      }

      if (logLevel === 'warn') {
        ctx.getLogService()?.warn('WCDB', `${logPrefix}数据库连接失败`, errorInfo)
      } else {
        ctx.getLogService()?.error('WCDB', `${logPrefix}数据库连接失败`, errorInfo)
      }
    }
    return result
  })

  ipcMain.handle('wcdb:resolveValidWxid', async (_, dbPath: string, hexKey: string) => {
    try {
      const input = validateResolveInput(dbPath, hexKey)
      if (input.error) {
        return { success: false, error: input.error }
      }

      const wxids = dbPathService.scanWxids(input.dbPath)
      if (wxids.length === 0) {
        return { success: false, error: '未检测到账号目录' }
      }

      for (const wxid of wxids) {
        const result = await wcdbService.testConnection(input.dbPath, input.hexKey, wxid)
        if (result.success) {
          return { success: true, wxid }
        }
      }

      return { success: false, error: '未找到可通过当前密钥验证的账号目录' }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('wcdb:open', async (_, dbPath: string, hexKey: string, wxid: string) => {
    return wcdbService.open(dbPath, hexKey, wxid)
  })

  ipcMain.handle('wcdb:close', async () => {
    wcdbService.close()
    return true
  })

  // 数据库解密（已废弃）
  // Direct DB 迁移后，解密落地链路已下线。保留 channel 以兼容前端旧调用，
  // 直接返回"已废弃"语义的空结果。
  ipcMain.handle('wcdb:decryptDatabase', async (_event, _dbPath: string, _hexKey: string, _wxid: string) => {
    console.warn('[ipc] wcdb:decryptDatabase is deprecated after direct-db migration')
    ctx.getLogService()?.warn('Decrypt', 'wcdb:decryptDatabase 已废弃，Direct DB 模式下无需解密落地')
    return {
      success: true,
      totalFiles: 0,
      successCount: 0,
      failCount: 0,
      skipped: true
    }
  })
}
