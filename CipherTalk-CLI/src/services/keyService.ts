import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { invalidArgument, notImplemented, MiyuError } from '../errors.js'
import { patchConfig } from '../config.js'
import { getPlatformNativeDir, getNativeRoot } from '../runtimePaths.js'
import { dataService } from './dataService.js'
import type { KeyService } from './types.js'
import type { RuntimeConfig } from '../types.js'

function assertHexKey(hex: string): void {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw invalidArgument('key 必须是 64 位十六进制字符串')
  }
}

function getDylibPath(): string | null {
  const dylibPath = join(getPlatformNativeDir(),
    process.platform === 'darwin' ? 'libwx_key.dylib' : 'wx_key.dll')
  if (existsSync(dylibPath)) return dylibPath

  // 备选路径
  if (process.platform === 'darwin') {
    const altPath = join(getNativeRoot(), '..', '..', 'resources', 'macos', 'libwx_key.dylib')
    if (existsSync(altPath)) return altPath
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class LocalKeyService implements KeyService {
  async setKey(hex: string): Promise<{ saved: boolean; keyHex: string }> {
    assertHexKey(hex)
    patchConfig({ keyHex: hex.toLowerCase() })
    return { saved: true, keyHex: hex.toLowerCase() }
  }

  async testKey(config: RuntimeConfig): Promise<{ validFormat: boolean; connection?: { attempted: boolean; ok: boolean; sessionCount?: number; error?: string } }> {
    if (config.keyHex) assertHexKey(config.keyHex)
    const status = await dataService.getStatus(config)
    return { validFormat: Boolean(config.keyHex), connection: status.connection }
  }

  async getKey(_config: RuntimeConfig, _options: { save?: boolean } = {}): Promise<{ keyHex: string; saved: boolean }> {
    const dllPath = getDylibPath()
    if (!dllPath) {
      throw notImplemented(`密钥提取库未找到 (libwx_key.dylib / wx_key.dll)`)
    }

    if (process.platform === 'darwin') {
      return await this.tryGetKeyMac(dllPath, _options.save ?? false)
    }

    if (process.platform === 'win32') {
      return await this.tryGetKeyWindows(dllPath, _options.save ?? false)
    }

    throw notImplemented('当前平台不支持自动获取密钥，请使用 miyu key set <64位密钥> 手动设置')
  }

  // ══════════════════════════ macOS ══════════════════════════
  private async tryGetKeyMac(dylibPath: string, shouldSave: boolean): Promise<{ keyHex: string; saved: boolean }> {
    const kf = await this.loadKoffi()
    const lib = kf.load(dylibPath)

    const getDbKey = lib.func('const char* GetDbKey()')
    const raw = getDbKey()

    if (!raw) throw new Error('GetDbKey() 返回空值')

    const text = String(raw).trim()
    if (text.startsWith('ERROR:')) {
      const parts = text.split(':')
      throw new Error(this.mapKeyError(parts[1] || 'UNKNOWN', parts.slice(2).join(':')))
    }

    return this.processKeyString(text, shouldSave)
  }

  // ══════════════════════════ Windows ══════════════════════════
  private async tryGetKeyWindows(dllPath: string, shouldSave: boolean): Promise<{ keyHex: string; saved: boolean }> {
    // 1. 检查微信进程
    const pid = this.getWeChatPid()
    if (!pid) throw new Error('微信 (Weixin.exe) 未运行。请先登录微信，然后重试。')

    const kf = await this.loadKoffi()
    const lib = kf.load(dllPath)

    // 绑定 DLL 函数
    const InitializeHook = lib.func('bool InitializeHook(uint32_t)')
    const PollKeyData = lib.func('bool PollKeyData(char*, int32_t)')
    const CleanupHook = lib.func('bool CleanupHook()')
    let getLastError: (() => string) | null = null
    try {
      getLastError = lib.func('const char* GetLastErrorMsg()')
    } catch { /* optional */ }

    // 2. 安装 Hook
    const hooked = InitializeHook(pid)
    if (!hooked) {
      const errMsg = getLastError ? String(getLastError() || '') : ''
      throw new Error(`Hook 微信进程失败 (PID: ${pid})${errMsg ? ': ' + errMsg : ''}\n请尝试以管理员身份运行。`)
    }

    try {
      // 3. 轮询密钥（超时 60 秒）
      const timeoutMs = 60_000
      const start = Date.now()

      while (Date.now() - start < timeoutMs) {
        const buf = Buffer.alloc(65)
        const ok = PollKeyData(buf, 65)

        if (ok) {
          const key = buf.toString('utf8').replace(/\0/g, '').trim()
          if (key && key.length >= 64) {
            return this.processKeyString(key, shouldSave)
          }
        }

        await sleep(200)
      }

      throw new Error('等待密钥超时 (60s)。请重新登录微信后重试。')
    } finally {
      // 4. 清理
      try { CleanupHook() } catch { /* ignore */ }
    }
  }

  private getWeChatPid(): number | null {
    try {
      const result = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Weixin.exe', '/FO', 'CSV', '/NH'], {
        encoding: 'utf8'
      })
      for (const line of result.trim().split('\n')) {
        if (line.toLowerCase().includes('weixin.exe')) {
          const parts = line.split(',')
          if (parts.length >= 2) {
            const pid = parseInt(parts[1].replace(/"/g, ''), 10)
            if (Number.isFinite(pid) && pid > 0) return pid
          }
        }
      }
    } catch { /* ignore */ }
    return null
  }

  // ══════════════════════════ 共用 ══════════════════════════

  private async loadKoffi(): Promise<any> {
    let mod: any
    try {
      mod = await import('koffi')
    } catch (e: any) {
      throw new Error('koffi 未安装: ' + (e?.message || e))
    }
    return mod.default || mod
  }

  private processKeyString(text: string, shouldSave: boolean): { keyHex: string; saved: boolean } {
    const cleanKey = text.replace(/[^0-9a-fA-F]/g, '').toLowerCase()
    if (cleanKey.length !== 64 || !/^[0-9a-f]{64}$/.test(cleanKey)) {
      throw new Error(`返回的密钥格式不正确 (长度 ${cleanKey.length}/64)`)
    }

    if (shouldSave) {
      patchConfig({ keyHex: cleanKey })
    }

    return { keyHex: cleanKey, saved: shouldSave }
  }

  private mapKeyError(code: string, detail: string): string {
    const msg: Record<string, string> = {
      'PROCESS_NOT_FOUND': '微信主进程未运行。请先登录微信，然后重试。',
      'ATTACH_FAILED': `无法附加微信进程${detail ? ' (' + detail + ')' : ''}。请关闭 SIP 后重试。`,
      'SCAN_FAILED': `内存扫描失败${detail ? ' (' + detail + ')' : ''}`,
      'HOOK_FAILED': '已定位目标但等待超时，请重新登录微信后重试。',
      'HOOK_TARGET_ONLY': '已定位目标但未捕获到密钥，请重新登录微信后重试。'
    }
    return msg[code] || (detail ? `${code}: ${detail}` : `未知错误 (${code})`)
  }
}

export const keyService = new LocalKeyService()
