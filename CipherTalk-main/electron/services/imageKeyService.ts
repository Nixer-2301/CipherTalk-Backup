import * as fs from 'fs'
import * as path from 'path'
import { wxKeyService } from './wxKeyService'

/**
 * 图片密钥服务。
 * Windows AES 密钥只通过 Rust native 内存扫描获取；macOS 走 wxKeyServiceMac。
 */
class ImageKeyService {
  /**
   * 查找模板文件 (_t.dat)
   */
  private findTemplateDatFiles(rootDir: string): string[] {
    const files: string[] = []
    const stack = [rootDir]
    const maxFiles = 32

    while (stack.length && files.length < maxFiles) {
      const dir = stack.pop() as string
      let entries: string[]
      try {
        entries = fs.readdirSync(dir)
      } catch {
        continue
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry)
        let stats: fs.Stats
        try {
          stats = fs.statSync(fullPath)
        } catch {
          continue
        }
        if (stats.isDirectory()) {
          stack.push(fullPath)
        } else if (entry.endsWith('_t.dat')) {
          files.push(fullPath)
          if (files.length >= maxFiles) break
        }
      }
    }

    if (!files.length) return []

    // 按日期排序（优先最新的）
    const dateReg = /(\d{4}-\d{2})/
    files.sort((a, b) => {
      const ma = a.match(dateReg)?.[1]
      const mb = b.match(dateReg)?.[1]
      if (ma && mb) return mb.localeCompare(ma)
      return 0
    })

    return files.slice(0, 16)
  }

  /**
   * 从模板文件获取 XOR 密钥
   */
  private getXorKey(templateFiles: string[]): number | null {
    const counts = new Map<string, number>()

    for (const file of templateFiles) {
      try {
        const bytes = fs.readFileSync(file)
        if (bytes.length < 2) continue
        const x = bytes[bytes.length - 2]
        const y = bytes[bytes.length - 1]
        const key = `${x}_${y}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
      } catch { }
    }

    if (!counts.size) return null

    let mostKey = ''
    let mostCount = 0
    counts.forEach((count, key) => {
      if (count > mostCount) {
        mostCount = count
        mostKey = key
      }
    })

    if (!mostKey) return null

    const [xStr, yStr] = mostKey.split('_')
    const x = Number(xStr)
    const y = Number(yStr)
    const xorKey = x ^ 0xFF
    const check = y ^ 0xD9

    return xorKey === check ? xorKey : null
  }

  /**
   * 从模板文件获取密文（用于验证 AES 密钥）
   * 只从 V2 格式文件中读取密文
   */
  private getCiphertextFromTemplate(templateFiles: string[]): Buffer | null {
    for (const file of templateFiles) {
      try {
        const bytes = fs.readFileSync(file)
        if (bytes.length < 0x1f) continue
        
        // 检查 V2 签名: 0x07, 0x08, 0x56, 0x32, 0x08, 0x07
        if (
          bytes[0] === 0x07 &&
          bytes[1] === 0x08 &&
          bytes[2] === 0x56 &&
          bytes[3] === 0x32 &&
          bytes[4] === 0x08 &&
          bytes[5] === 0x07
        ) {
          console.log(`使用 V2 模板文件: ${file}`)
          return bytes.subarray(0x0f, 0x1f)
        }
      } catch { }
    }
    return null
  }

  /**
   * 从进程内存获取 AES 密钥
   */
  private async getAesKeyFromMemory(ciphertext: Buffer, onProgress?: (msg: string) => void): Promise<string | null> {
    try {
      onProgress?.('正在调用 Rust 内存扫描获取 AES 密钥...')
      const rustKey = wxKeyService.scanImageAesKey(ciphertext)
      if (rustKey) {
        onProgress?.('Rust 内存扫描命中 AES 密钥')
        return rustKey
      }
    } catch (e) {
      console.error('Rust 图片密钥扫描异常:', e)
    }
    onProgress?.('Rust 内存扫描未命中 AES 密钥')
    return null
  }

  /**
   * 获取图片密钥
   */
  async getImageKeys(
    userDir: string,
    onProgress?: (msg: string) => void
  ): Promise<{ success: boolean; xorKey?: number; aesKey?: string; error?: string }> {
    try {
      onProgress?.('正在收集模板文件...')
      
      const templateFiles = this.findTemplateDatFiles(userDir)
      if (templateFiles.length === 0) {
        return { success: false, error: '未找到模板文件，可能该微信账号没有图片缓存' }
      }

      onProgress?.(`找到 ${templateFiles.length} 个模板文件，正在计算 XOR 密钥...`)

      const xorKey = this.getXorKey(templateFiles)
      if (xorKey === null) {
        return { success: false, error: '无法获取 XOR 密钥' }
      }

      onProgress?.(`XOR 密钥: 0x${xorKey.toString(16).padStart(2, '0')}，正在读取加密数据...`)

      const ciphertext = this.getCiphertextFromTemplate(templateFiles)
      if (!ciphertext) {
        // 没有 V2 文件，只返回 XOR 密钥
        onProgress?.('未找到 V2 格式模板文件，仅返回 XOR 密钥')
        return {
          success: true,
          xorKey,
          aesKey: undefined
        }
      }

      // 重试机制：最多尝试 3 次，每次间隔 2 秒
      const maxRetries = 3
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        onProgress?.(`正在扫描微信进程内存获取 AES 密钥... (第 ${attempt}/${maxRetries} 次)`)

        const aesKey = await this.getAesKeyFromMemory(ciphertext, onProgress)
        if (aesKey) {
          return {
            success: true,
            xorKey,
            aesKey: aesKey.substring(0, 16)
          }
        }

        if (attempt < maxRetries) {
          onProgress?.(`未找到密钥，等待 2 秒后重试... 请确保已打开朋友圈图片`)
          await new Promise(resolve => setTimeout(resolve, 2000))
        }
      }

      return { 
        success: false, 
        error: '无法从内存中获取 AES 密钥。\n\n请尝试：\n1. 确保微信已登录\n2. 打开朋友圈查看几张图片\n3. 重新获取密钥' 
      }
    } catch (e) {
      console.error('获取图片密钥失败:', e)
      return { success: false, error: String(e) }
    }
  }
}

export const imageKeyService = new ImageKeyService()
