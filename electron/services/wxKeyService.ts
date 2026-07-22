import { spawn, execSync } from 'child_process'
import { join } from 'path'
import { app } from 'electron'
import { existsSync, readdirSync, statSync } from 'fs'
import * as crypto from 'crypto'

/** 内存扫描诊断结果 */
export interface WxScanDiag {
  key: string | null
  auth: boolean
  dbOk: boolean
  pids: number
  opened: number
  bytes: number
  markers: number
  candidates: number
}

/** 一次性从内存提取的完整账号信息（含 db_key 与明文字段） */
export interface WxAccountInfo {
  /** 64 位十六进制数据库密钥，未取到为 null */
  dbKey: string | null
  wxid: string
  /** 昵称 */
  name: string
  /** 微信号 */
  number: string
  /** 绑定手机号 */
  phone: string
  seed: number
}

export class WxKeyService {
  /**
   * 检查微信进程是否运行 (仅微信4.x Weixin.exe)
   */
  isWeChatRunning(): boolean {
    try {
      const result = execSync('tasklist /FI "IMAGENAME eq Weixin.exe" /NH', { encoding: 'utf8', windowsHide: true })
      return result.toLowerCase().includes('weixin.exe')
    } catch {
      return false
    }
  }

  /**
   * 获取微信进程 PID (仅微信4.x Weixin.exe)
   */
  getWeChatPid(): number | null {
    try {
      const result = execSync('tasklist /FI "IMAGENAME eq Weixin.exe" /FO CSV /NH', { encoding: 'utf8', windowsHide: true })
      const lines = result.trim().split('\n')

      for (const line of lines) {
        if (line.toLowerCase().includes('weixin.exe')) {
          const parts = line.split(',')
          if (parts.length >= 2) {
            const pid = parseInt(parts[1].replace(/"/g, ''), 10)
            if (!isNaN(pid)) {
              return pid
            }
          }
        }
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * 关闭微信进程 (仅微信4.x Weixin.exe)
   */
  killWeChat(): boolean {
    try {
      execSync('taskkill /F /IM Weixin.exe', { encoding: 'utf8', windowsHide: true })
      return true
    } catch {
      return false
    }
  }

  /**
   * 获取微信安装路径 (仅微信4.x Weixin.exe)
   */
  getWeChatPath(): string | null {
    // 从注册表查找
    try {
      // 查找 Uninstall 注册表
      const regPaths = [
        'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
      ]

      for (const regPath of regPaths) {
        try {
          const result = execSync(`reg query "${regPath}" /s /f "WeChat" 2>nul`, { encoding: 'utf8', windowsHide: true })
          const match = result.match(/InstallLocation\s+REG_SZ\s+(.+)/i)
          if (match) {
            const installPath = match[1].trim()
            // 只查找 Weixin.exe (微信4.x)
            const weixinPath = join(installPath, 'Weixin.exe')
            if (existsSync(weixinPath)) {
              return weixinPath
            }
          }
        } catch {
          continue
        }
      }

      // 查找 Tencent 注册表
      const tencentKeys = [
        'HKCU\\Software\\Tencent\\WeChat',
        'HKCU\\Software\\Tencent\\Weixin',
        'HKLM\\Software\\Tencent\\WeChat'
      ]

      for (const key of tencentKeys) {
        try {
          const result = execSync(`reg query "${key}" /v InstallPath 2>nul`, { encoding: 'utf8', windowsHide: true })
          const match = result.match(/InstallPath\s+REG_SZ\s+(.+)/i)
          if (match) {
            const installPath = match[1].trim()
            const weixinPath = join(installPath, 'Weixin.exe')
            if (existsSync(weixinPath)) {
              return weixinPath
            }
          }
        } catch {
          continue
        }
      }
    } catch { }

    // 常见路径 - 只查找 Weixin.exe
    const drives = ['C', 'D', 'E', 'F']
    const pathPatterns = [
      '\\Program Files\\Tencent\\WeChat\\Weixin.exe',
      '\\Program Files (x86)\\Tencent\\WeChat\\Weixin.exe'
    ]

    for (const drive of drives) {
      for (const pattern of pathPatterns) {
        const fullPath = `${drive}:${pattern}`
        if (existsSync(fullPath)) {
          return fullPath
        }
      }
    }

    return null
  }

  /**
   * 启动微信
   */
  async launchWeChat(customPath?: string): Promise<boolean> {
    const wechatPath = customPath || this.getWeChatPath()
    if (!wechatPath) {
      return false
    }

    try {
      spawn(wechatPath, [], { detached: true, stdio: 'ignore' }).unref()

      // 等待微信启动
      await new Promise(resolve => setTimeout(resolve, 2000))

      return this.isWeChatRunning()
    } catch {
      return false
    }
  }

  /**
   * 等待微信窗口出现
   */
  async waitForWeChatWindow(maxWaitSeconds = 15): Promise<boolean> {
    for (let i = 0; i < maxWaitSeconds * 2; i++) {
      await new Promise(resolve => setTimeout(resolve, 500))

      // 检查 Weixin.exe 或 WeChat.exe 进程
      const pid = this.getWeChatPid()
      if (pid !== null) {
        return true
      }
    }
    return false
  }

  // ===== Windows 内存扫描方案（Rust DLL wechat_key_tool.dll，Ed25519 强验证） =====

  private scanLib: any = null

  /** 内存扫描 DLL 路径 */
  getScanDllPath(): string {
    const resourcesPath = app.isPackaged
      ? join(process.resourcesPath, 'resources')
      : join(app.getAppPath(), 'resources')
    return join(resourcesPath, 'wechat_key_tool.dll')
  }

  /** 加载内存扫描 DLL */
  initScanLib(): boolean {
    if (this.scanLib) return true
    try {
      const koffi = require('koffi')
      const dllPath = this.getScanDllPath()
      if (!existsSync(dllPath)) {
        console.error('内存扫描 DLL 不存在:', dllPath)
        return false
      }
      this.scanLib = koffi.load(dllPath)
      return true
    } catch (e) {
      console.error('加载内存扫描 DLL 失败:', e)
      return false
    }
  }

  /** 还原内嵌私钥（XOR 混淆，配对 DLL 内嵌公钥） */
  private getScanPrivateKey(): crypto.KeyObject {
    const obf = '6a74585b5a6a5f5c59713f2a5e785e7a168e0e9425838c437f0b1274d114f59457f436c936b80178da1848856b58eef3'
    const der = Buffer.from(Buffer.from(obf, 'hex').map(v => v ^ 0x5a))
    return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  }

  /**
   * 内存扫描获取数据库密钥（诊断版，Ed25519 挑战-应答鉴权）。
   * 取挑战 → 私钥签名 → 验签通过后 DLL 扫描 crypt_key 邻域，返回密钥与读取诊断，
   * 供调用方区分“权限不足读到 0 字节” vs “读到了但没找到密钥”。
   * @param contactDbPath contact.db 完整路径（决定校验用的 salt）
   */
  scanDbKeyDiag(contactDbPath: string): WxScanDiag | null {
    if (!this.initScanLib()) return null
    try {
      const koffi = require('koffi')
      const wktChallenge = this.scanLib.func('int wkt_challenge(uint8_t*, size_t)')
      const wktDiag = this.scanLib.func('void* wkt_scan_diag_auth(uint8_t*, size_t, str)')
      const wktFree = this.scanLib.func('void wkt_free(void*)')

      const nonce = Buffer.alloc(32)
      if (wktChallenge(nonce, 32) !== 32) return null

      const sig = crypto.sign(null, nonce, this.getScanPrivateKey()) // Ed25519，64 字节
      const ptr = wktDiag(sig, sig.length, contactDbPath)
      if (!ptr) return null

      const jsonStr = koffi.decode(ptr, 'char', -1)
      wktFree(ptr)

      const d = JSON.parse(String(jsonStr || '{}').replace(/\0/g, ''))
      const rawKey = typeof d.key === 'string' ? d.key.trim() : ''
      return {
        key: rawKey.length === 64 ? rawKey : null,
        auth: d.auth !== false,
        dbOk: d.db_ok !== false,
        pids: Number(d.pids) || 0,
        opened: Number(d.opened) || 0,
        bytes: Number(d.bytes) || 0,
        markers: Number(d.markers) || 0,
        candidates: Number(d.candidates) || 0,
      }
    } catch (e) {
      console.error('内存扫描获取密钥失败:', e)
      return null
    }
  }

  /** 仅取密钥（诊断版的薄封装）。 */
  scanDbKey(contactDbPath: string): string | null {
    return this.scanDbKeyDiag(contactDbPath)?.key ?? null
  }

  /**
   * 一次性提取完整账号信息（Ed25519 鉴权）。
   * 走 weixin.dll keystream 推导 + global_config 结构游走，直接读出
   * db_key 与 wxid / name(昵称) / number(微信号) / phone(手机号)。
   * 该路径不依赖 contact.db，命中即返回；失败/未授权返回 null。
   */
  scanAccount(): WxAccountInfo | null {
    if (!this.initScanLib()) return null
    try {
      const koffi = require('koffi')
      const wktChallenge = this.scanLib.func('int wkt_challenge(uint8_t*, size_t)')
      const wktScanAccount = this.scanLib.func('void* wkt_scan_account_auth(uint8_t*, size_t)')
      const wktFree = this.scanLib.func('void wkt_free(void*)')

      const nonce = Buffer.alloc(32)
      if (wktChallenge(nonce, 32) !== 32) return null

      const sig = crypto.sign(null, nonce, this.getScanPrivateKey()) // Ed25519，64 字节
      const ptr = wktScanAccount(sig, sig.length)
      if (!ptr) return null

      const jsonStr = koffi.decode(ptr, 'char', -1)
      wktFree(ptr)

      const d = JSON.parse(String(jsonStr || '{}').replace(/\0/g, ''))
      const dbKey = typeof d.db_key === 'string' ? d.db_key.trim() : ''
      return {
        dbKey: dbKey.length === 64 ? dbKey : null,
        wxid: String(d.wxid || '').trim(),
        name: String(d.name || '').trim(),
        number: String(d.number || '').trim(),
        phone: String(d.phone || '').trim(),
        seed: Number(d.seed) || 0,
      }
    } catch (e) {
      console.error('账号信息扫描失败:', e)
      return null
    }
  }

  /**
   * 内存扫描图片 AES 密钥（Ed25519 鉴权）。传入模板密文(16B)，
   * 返回 32 字符密钥串（调用方取前 16 字符作 AES-128 密钥），失败返回 null。
   */
  scanImageAesKey(ciphertext: Buffer): string | null {
    if (!ciphertext || ciphertext.length < 16) return null
    if (!this.initScanLib()) return null
    try {
      const koffi = require('koffi')
      const wktChallenge = this.scanLib.func('int wkt_challenge(uint8_t*, size_t)')
      const wktScanImg = this.scanLib.func('void* wkt_scan_image_key_auth(uint8_t*, size_t, uint8_t*, size_t)')
      const wktFree = this.scanLib.func('void wkt_free(void*)')

      const nonce = Buffer.alloc(32)
      if (wktChallenge(nonce, 32) !== 32) return null

      const sig = crypto.sign(null, nonce, this.getScanPrivateKey())
      const ptr = wktScanImg(sig, sig.length, ciphertext, ciphertext.length)
      if (!ptr) return null

      const key = koffi.decode(ptr, 'char', -1)
      wktFree(ptr)

      const trimmed = String(key || '').replace(/\0/g, '').trim()
      return trimmed.length >= 16 ? trimmed : null
    } catch (e) {
      console.error('内存扫描图片密钥失败:', e)
      return null
    }
  }

  /** 释放 Rust 扫描库引用。 */
  dispose(): void {
    this.scanLib = null
  }

  /**
   * 检测当前登录的微信账号
   * 通过扫描数据库目录下的账号目录，根据最近修改时间判断当前活跃账号
   * @param dbPath 数据库根路径
   * @param maxTimeDiffMinutes 最大时间差（分钟），默认5分钟
   */
  detectCurrentAccount(dbPath?: string, maxTimeDiffMinutes: number = 5): { wxid: string; dbPath: string } | null {
    try {
      if (!dbPath) {
        return null
      }

      if (!existsSync(dbPath)) {
        return null
      }

      const now = Date.now()
      const maxTimeDiffMs = maxTimeDiffMinutes * 60 * 1000
      let bestMatch: { wxid: string; dbPath: string; timeDiff: number } | null = null
      let fallbackMatch: { wxid: string; dbPath: string; timeDiff: number } | null = null

      // 遍历数据库目录下的所有账号目录
      const entries = readdirSync(dbPath, { withFileTypes: true })

      for (const entry of entries) {
        if (!entry.isDirectory()) continue

        const accountDirName = entry.name
        const accountDir = join(dbPath, accountDirName)

        // 检查是否是有效的账号目录（包含 db_storage）
        const dbStorageDir = join(accountDir, 'db_storage')
        if (!existsSync(dbStorageDir)) continue

        // 过滤掉系统目录
        if (this.isSystemDirectory(accountDirName)) continue

        // 获取账号目录的最近活动时间
        const modifiedTime = this.getAccountModifiedTime(accountDir)
        const timeDiff = Math.abs(now - modifiedTime)

        // 检查是否在时间范围内
        if (timeDiff <= maxTimeDiffMs) {
          if (!bestMatch || timeDiff < bestMatch.timeDiff) {
            bestMatch = {
              wxid: accountDirName,
              dbPath: accountDir,
              timeDiff
            }
          }
        }

        // 记录最近的账号作为备选（即使超过时间限制）
        if (!fallbackMatch || timeDiff < fallbackMatch.timeDiff) {
          fallbackMatch = {
            wxid: accountDirName,
            dbPath: accountDir,
            timeDiff
          }
        }
      }

      if (bestMatch) {
        return { wxid: bestMatch.wxid, dbPath: bestMatch.dbPath }
      }

      // 如果没有在时间范围内的账号，但有备选账号，询问用户是否使用
      if (fallbackMatch) {
        // 如果只有一个有效账号，直接使用（不管时间差）
        if (entries.filter(e => e.isDirectory() &&
          existsSync(join(dbPath, e.name, 'db_storage')) &&
          !this.isSystemDirectory(e.name)).length === 1) {
          return { wxid: fallbackMatch.wxid, dbPath: fallbackMatch.dbPath }
        }

        // 如果时间差在24小时内，自动使用这个账号
        if (fallbackMatch.timeDiff <= 24 * 60 * 60 * 1000) {
          return { wxid: fallbackMatch.wxid, dbPath: fallbackMatch.dbPath }
        }
      }

      return null
    } catch (e) {
      return null
    }
  }

  /**
   * 判断是否为系统目录
   */
  private isSystemDirectory(name: string): boolean {
    const lower = name.toLowerCase()
    const systemDirs = ['all', 'applet', 'backup', 'wmpf', 'system', 'temp', 'cache']
    return systemDirs.some(dir => lower.startsWith(dir))
  }

  /**
   * 获取账号目录的最近修改时间
   * 直接返回账号目录本身的修改时间
   */
  private getAccountModifiedTime(accountDir: string): number {
    try {
      const stats = statSync(accountDir)
      return stats.mtimeMs
    } catch {
      return 0
    }
  }
}

// 单例
export const wxKeyService = new WxKeyService()
