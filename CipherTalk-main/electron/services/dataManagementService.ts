import * as fs from 'fs'
import * as path from 'path'
import { BrowserWindow } from 'electron'
import { ConfigService } from './config'
import { imageDecryptService } from './imageDecryptService'
import { getDefaultCachePath as getPlatformDefaultCachePath } from './platformService'

/**
 * 数据管理服务（Direct DB 迁移后精简版）
 *
 * 已废弃：
 * - 数据库落地解密（decryptAll / decryptSingleDatabase）
 * - 增量同步 / 文件监听（incrementalUpdate / autoIncrementalUpdate
 *   / enableAutoUpdate / disableAutoUpdate / checkForUpdates 等）
 * - 缓存迁移（migrateCache）
 *
 * 这些方法对外保留签名作为 no-op，打印 warn 日志，以避免 IPC/启动流程 TS 编译失败，
 * 真正的删除由后续波次统一处理。
 *
 * 保留：图片解密 / 扫描、路径诊断、账号目录识别。
 */

export interface DatabaseFileInfo {
  fileName: string
  filePath: string
  fileSize: number
  wxid: string
  isDecrypted: boolean
  decryptedPath?: string
  /** Direct DB 迁移后恒为 false */
  needsUpdate: boolean
  originalModified?: number
  /** Direct DB 迁移后恒为 null */
  decryptedModified?: number | null
}

export interface ImageFileInfo {
  fileName: string
  filePath: string
  fileSize: number
  isDecrypted: boolean
  decryptedPath?: string
  version: number // 0=V3, 1=V4-V1, 2=V4-V2
}

class DataManagementService {
  private configService: ConfigService

  constructor() {
    this.configService = new ConfigService()
  }

  // ---------------------------------------------------------------------------
  // 数据库扫描（只读诊断）
  // ---------------------------------------------------------------------------

  /**
   * 扫描数据库文件。Direct DB 迁移后仅用于路径诊断：
   * 每项 needsUpdate 恒为 false，decryptedModified 恒为 null。
   */
  async scanDatabases(): Promise<{ success: boolean; databases?: DatabaseFileInfo[]; error?: string }> {
    try {
      const databases: DatabaseFileInfo[] = []

      const dbPath = this.configService.get('dbPath')
      if (!dbPath) {
        return { success: false, error: '请先在设置页面配置数据库路径' }
      }

      const wxid = this.configService.get('myWxid')
      if (!wxid) {
        return { success: false, error: '请先在设置页面配置 wxid' }
      }

      let cipherTalkDir = this.configService.get('cachePath')
      if (!cipherTalkDir) {
        cipherTalkDir = this.getDefaultCachePath()
      }

      if (!fs.existsSync(dbPath)) {
        return { success: false, error: `数据库路径不存在: ${dbPath}` }
      }

      const pathParts = dbPath.split(path.sep)
      const lastPart = pathParts[pathParts.length - 1]

      if (lastPart === 'db_storage') {
        const accountName = pathParts.length >= 2 ? this.cleanAccountDirName(pathParts[pathParts.length - 2]) : 'unknown'
        this.scanDbStorageDirectory(dbPath, accountName, cipherTalkDir, databases)
      } else {
        const actualAccountDir = this.findAccountDir(dbPath, wxid)
        if (!actualAccountDir) {
          return { success: false, error: `未找到账号目录: ${wxid}` }
        }
        const cleanedAccountName = this.cleanAccountDirName(actualAccountDir)
        const dbStoragePath = path.join(dbPath, actualAccountDir, 'db_storage')
        if (fs.existsSync(dbStoragePath)) {
          this.scanDbStorageDirectory(dbStoragePath, cleanedAccountName, cipherTalkDir, databases)
        } else {
          return { success: false, error: `账号目录下不存在 db_storage: ${dbStoragePath}` }
        }
      }

      databases.sort((a, b) => a.fileSize - b.fileSize)
      return { success: true, databases }
    } catch (e) {
      console.error('扫描数据库失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 扫描 db_storage 目录（只读诊断）。每项 needsUpdate 恒为 false。
   */
  private scanDbStorageDirectory(
    dbStoragePath: string,
    accountName: string,
    cipherTalkDir: string,
    databases: DatabaseFileInfo[],
  ): void {
    const dbFiles = this.findAllDbFiles(dbStoragePath)

    for (const filePath of dbFiles) {
      const fileName = path.basename(filePath)
      const stats = fs.statSync(filePath)
      const fileSize = stats.size
      const originalModified = stats.mtimeMs

      // 兼容旧逻辑：仍提供 decryptedPath（给诊断/日志使用），但不再据此判断需要更新
      const decryptedFileName = fileName.replace(/\.db$/, '') + '.db'
      const decryptedPath = path.join(cipherTalkDir, accountName, decryptedFileName)
      const isDecrypted = fs.existsSync(decryptedPath)

      databases.push({
        fileName,
        filePath,
        fileSize,
        wxid: accountName,
        isDecrypted,
        decryptedPath,
        needsUpdate: false,
        originalModified,
        decryptedModified: null,
      })
    }
  }

  /**
   * 递归查找所有 .db 文件
   */
  private findAllDbFiles(dir: string): string[] {
    const dbFiles: string[] = []
    const scan = (currentDir: string) => {
      try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = path.join(currentDir, entry.name)
          if (entry.isDirectory()) {
            scan(fullPath)
          } else if (entry.isFile() && entry.name.endsWith('.db')) {
            dbFiles.push(fullPath)
          }
        }
      } catch {
        // 忽略无法访问的目录
      }
    }
    scan(dir)
    return dbFiles
  }

  // ---------------------------------------------------------------------------
  // 账号目录识别（共享给其它调用方）
  // ---------------------------------------------------------------------------

  /**
   * 清理账号目录名。wxid_ 开头只保留主要部分，其它格式保持原样。
   */
  private cleanAccountDirName(dirName: string): string {
    const trimmed = dirName.trim()
    if (!trimmed) return trimmed

    if (trimmed.toLowerCase().startsWith('wxid_')) {
      const match = trimmed.match(/^(wxid_[a-zA-Z0-9]+)/i)
      if (match) return match[1]
      return trimmed
    }
    return trimmed
  }

  /**
   * 查找账号对应的实际目录名
   */
  private findAccountDir(baseDir: string, wxid: string): string | null {
    if (!fs.existsSync(baseDir)) return null

    const cleanedWxid = this.cleanAccountDirName(wxid)

    const directPath = path.join(baseDir, wxid)
    if (fs.existsSync(directPath)) return wxid

    if (cleanedWxid !== wxid) {
      const cleanedPath = path.join(baseDir, cleanedWxid)
      if (fs.existsSync(cleanedPath)) return cleanedWxid
    }

    try {
      const entries = fs.readdirSync(baseDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const dirName = entry.name
        const dirNameLower = dirName.toLowerCase()
        const wxidLower = wxid.toLowerCase()
        const cleanedWxidLower = cleanedWxid.toLowerCase()

        if (dirNameLower === wxidLower || dirNameLower === cleanedWxidLower) return dirName
        if (dirNameLower.startsWith(wxidLower + '_') || dirNameLower.startsWith(cleanedWxidLower + '_')) return dirName
        if (wxidLower.startsWith(dirNameLower + '_') || cleanedWxidLower.startsWith(dirNameLower + '_')) return dirName

        const cleanedDirName = this.cleanAccountDirName(dirName)
        if (cleanedDirName.toLowerCase() === wxidLower || cleanedDirName.toLowerCase() === cleanedWxidLower) {
          return dirName
        }
      }
    } catch (e) {
      console.error('查找账号目录失败:', e)
    }
    return null
  }

  // ---------------------------------------------------------------------------
  // 废弃兼容层：Direct DB 迁移后这些方法不再执行任何副作用，仅打印 warn。
  // 调用方迁移完成后，这些 stub 将在 Wave D 移除。
  // ---------------------------------------------------------------------------

  async decryptAll(): Promise<{ success: boolean; successCount?: number; failCount?: number; error?: string; skipped?: boolean }> {
    console.warn('[dataManagementService] decryptAll has been removed. Direct DB migration is in effect.')
    return { success: true, successCount: 0, failCount: 0, skipped: true }
  }

  async decryptSingleDatabase(_filePath: string): Promise<{ success: boolean; error?: string; skipped?: boolean }> {
    console.warn('[dataManagementService] decryptSingleDatabase has been removed. Direct DB migration is in effect.')
    return { success: true, skipped: true }
  }

  async incrementalUpdate(_silent: boolean = false): Promise<{ success: boolean; successCount?: number; failCount?: number; error?: string; skipped?: boolean }> {
    console.warn('[dataManagementService] incrementalUpdate has been removed. Direct DB migration is in effect.')
    return { success: true, successCount: 0, failCount: 0, skipped: true }
  }

  async migrateCache(_newCachePath: string): Promise<{ success: boolean; movedCount?: number; error?: string; skipped?: boolean }> {
    console.warn('[dataManagementService] migrateCache has been removed. Direct DB migration is in effect.')
    return { success: true, movedCount: 0, skipped: true }
  }

  async autoIncrementalUpdate(_silent: boolean = false): Promise<{ success: boolean; updated: boolean; error?: string; skipped?: boolean }> {
    console.warn('[dataManagementService] autoIncrementalUpdate has been removed. Direct DB migration is in effect.')
    return { success: true, updated: false, skipped: true }
  }

  async checkForUpdates(): Promise<{ hasUpdate: boolean; updateCount?: number; error?: string }> {
    console.warn('[dataManagementService] checkForUpdates has been removed. Direct DB migration is in effect.')
    return { hasUpdate: false, updateCount: 0 }
  }

  enableAutoUpdate(_intervalSeconds?: number): void {
    console.warn('[dataManagementService] enableAutoUpdate has been removed. Direct DB migration is in effect.')
  }

  disableAutoUpdate(): void {
    console.warn('[dataManagementService] disableAutoUpdate has been removed. Direct DB migration is in effect.')
  }

  /**
   * 订阅数据库更新事件。Direct DB 迁移后永不触发，仅返回一个空 unsubscribe。
   */
  onUpdateAvailable(_listener: (hasUpdate: boolean) => void): () => void {
    return () => {
      /* no-op */
    }
  }

  pauseForAi(): void {
    /* no-op after Direct DB migration */
  }

  resumeFromAi(): void {
    /* no-op after Direct DB migration */
  }

  get isAiPaused(): boolean {
    return false
  }

  // ---------------------------------------------------------------------------
  // 缓存路径
  // ---------------------------------------------------------------------------

  getCurrentCachePath(): string {
    const cachePath = this.configService.get('cachePath')
    if (cachePath) return cachePath
    return this.getDefaultCachePath()
  }

  getDefaultCachePath(): string {
    return getPlatformDefaultCachePath()
  }

  // ---------------------------------------------------------------------------
  // 进度事件（图片解密仍在使用）
  // ---------------------------------------------------------------------------

  private sendProgress(data: any) {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send('dataManagement:progress', data)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 图片扫描 / 解密（与数据库流水线正交，继续保留）
  // ---------------------------------------------------------------------------

  /**
   * 扫描图片文件（扫描已解密的图片，而不是 .dat 文件）
   */
  async scanImages(imagesDir: string): Promise<{ success: boolean; images?: ImageFileInfo[]; error?: string }> {
    try {
      if (!fs.existsSync(imagesDir)) {
        return { success: false, error: `目录不存在: ${imagesDir}` }
      }

      const images: ImageFileInfo[] = []
      const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']

      let batchImages: ImageFileInfo[] = []
      const BATCH_SIZE = 100

      const flushBatch = () => {
        if (batchImages.length > 0) {
          this.sendProgress({ type: 'imageBatch', images: [...batchImages] })
          batchImages = []
        }
      }

      const yieldToMain = () => new Promise<void>(resolve => setImmediate(resolve))

      const scanDir = async (dir: string): Promise<void> => {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true })
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name)
            if (entry.isDirectory()) {
              await scanDir(fullPath)
            } else if (entry.isFile()) {
              const ext = path.extname(entry.name).toLowerCase()
              if (!imageExtensions.includes(ext)) continue

              try {
                const stats = fs.statSync(fullPath)
                if (stats.size < 100) continue

                const imageInfo: ImageFileInfo = {
                  fileName: entry.name,
                  filePath: fullPath,
                  fileSize: stats.size,
                  isDecrypted: true,
                  decryptedPath: fullPath,
                  version: 0,
                }

                images.push(imageInfo)
                batchImages.push(imageInfo)

                if (batchImages.length >= BATCH_SIZE) {
                  flushBatch()
                  await yieldToMain()
                }
              } catch {
                // 忽略无法访问的文件
              }
            }
          }
        } catch {
          // 忽略无法访问的目录
        }
      }

      await scanDir(imagesDir)
      flushBatch()

      images.sort((a, b) => a.fileSize - b.fileSize)
      this.sendProgress({ type: 'imageScanComplete', total: images.length })

      return { success: true, images }
    } catch (e) {
      console.error('扫描图片失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 静默扫描图片（不发送事件，供批量解密内部使用）
   */
  private async scanImagesQuiet(accountDir: string): Promise<ImageFileInfo[]> {
    const images: ImageFileInfo[] = []
    const cachePath = this.getCurrentCachePath()
    const imageOutputDir = path.join(cachePath, 'images')
    const imageSuffixes = ['.b', '.h', '.t', '.c', '.w', '.l', '_b', '_h', '_t', '_c', '_w', '_l']

    const scanDir = (dir: string): void => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name)

          if (entry.isDirectory()) {
            if (entry.name === 'db_storage' || entry.name === 'database') continue
            scanDir(fullPath)
          } else if (entry.name.endsWith('.dat')) {
            const baseName = path.basename(entry.name, '.dat').toLowerCase()
            const isImageFile = imageSuffixes.some(suffix => baseName.endsWith(suffix))
            if (!isImageFile) continue

            try {
              const stats = fs.statSync(fullPath)
              if (stats.size < 100) continue

              const version = imageDecryptService.getDatVersion(fullPath)
              const relativePath = path.relative(accountDir, fullPath)
              const outputRelativePath = relativePath.replace(/\.dat$/, '')

              let isDecrypted = false
              for (const ext of ['.jpg', '.png', '.gif', '.bmp', '.webp']) {
                const possiblePath = path.join(imageOutputDir, outputRelativePath + ext)
                if (fs.existsSync(possiblePath)) {
                  isDecrypted = true
                  break
                }
              }

              if (!isDecrypted) {
                images.push({
                  fileName: entry.name,
                  filePath: fullPath,
                  fileSize: stats.size,
                  isDecrypted: false,
                  version,
                })
              }
            } catch {
              // 忽略
            }
          }
        }
      } catch {
        // 忽略
      }
    }

    scanDir(accountDir)
    return images
  }

  /**
   * 批量解密图片
   */
  async decryptImages(accountDir: string): Promise<{ success: boolean; successCount?: number; failCount?: number; error?: string }> {
    try {
      const xorKeyStr = this.configService.get('imageXorKey')
      const aesKeyStr = this.configService.get('imageAesKey')

      if (!xorKeyStr) {
        return { success: false, error: '请先在设置页面配置图片 XOR 密钥' }
      }
      const xorKey = parseInt(String(xorKeyStr), 16)
      if (isNaN(xorKey)) {
        return { success: false, error: 'XOR 密钥格式错误' }
      }

      console.log('开始扫描待解密图片...')
      const pendingImages = await this.scanImagesQuiet(accountDir)
      console.log(`找到 ${pendingImages.length} 个待解密图片`)

      if (pendingImages.length === 0) {
        return { success: true, successCount: 0, failCount: 0 }
      }

      const cachePath = this.getCurrentCachePath()
      const imageOutputDir = path.join(cachePath, 'images')
      if (!fs.existsSync(imageOutputDir)) {
        fs.mkdirSync(imageOutputDir, { recursive: true })
      }

      let successCount = 0
      let failCount = 0
      const totalFiles = pendingImages.length
      const aesKeyText = aesKeyStr ? String(aesKeyStr) : undefined
      const BATCH_SIZE = 50

      for (let i = 0; i < pendingImages.length; i++) {
        const img = pendingImages[i]

        if (i % 10 === 0 || i === pendingImages.length - 1) {
          this.sendProgress({
            type: 'image',
            current: i,
            total: totalFiles,
            fileName: img.fileName,
            fileProgress: Math.round(((i + 1) / totalFiles) * 100),
          })
        }

        try {
          const relativePath = path.relative(accountDir, img.filePath)
          const outputRelativePath = relativePath.replace(/\.dat$/, '')

          const decrypted = imageDecryptService.decryptDatFile(img.filePath, xorKey, aesKeyText)
          const ext = this.detectImageFormat(decrypted)
          const outputPath = path.join(imageOutputDir, outputRelativePath + ext)

          const outputDir = path.dirname(outputPath)
          if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true })
          }

          fs.writeFileSync(outputPath, decrypted)
          successCount++
        } catch {
          failCount++
        }

        if ((i + 1) % BATCH_SIZE === 0) {
          await new Promise(resolve => setImmediate(resolve))
        }
      }

      this.sendProgress({ type: 'complete' })
      console.log(`批量解密完成: 成功 ${successCount}, 失败 ${failCount}`)
      return { success: true, successCount, failCount }
    } catch (e) {
      console.error('批量解密图片失败:', e)
      this.sendProgress({ type: 'error', error: String(e) })
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取图片目录（返回解密后的图片缓存目录）
   */
  getImageDirectories(): { success: boolean; directories?: { wxid: string; path: string }[]; error?: string } {
    try {
      const dbPath = this.configService.get('dbPath')
      const wxid = this.configService.get('myWxid')

      if (!dbPath || !wxid) {
        return { success: false, error: '请先在设置页面配置数据库路径和账号' }
      }

      const cachePath = this.getCurrentCachePath()
      if (!fs.existsSync(cachePath)) {
        return { success: false, error: '缓存目录不存在，请先解密数据库' }
      }

      const directories: { wxid: string; path: string }[] = []

      const imagesDir = path.join(cachePath, 'images')
      if (fs.existsSync(imagesDir)) {
        directories.push({ wxid, path: imagesDir })
      }

      const emojisDir = path.join(cachePath, 'Emojis')
      if (fs.existsSync(emojisDir)) {
        directories.push({ wxid, path: emojisDir })
      }

      if (directories.length === 0) {
        return { success: false, error: '图片目录不存在，请先解密数据库' }
      }

      return { success: true, directories }
    } catch (e) {
      console.error('获取图片目录失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 单个图片解密
   */
  async decryptSingleImage(filePath: string): Promise<{ success: boolean; outputPath?: string; error?: string }> {
    try {
      const xorKeyStr = this.configService.get('imageXorKey')
      const aesKeyStr = this.configService.get('imageAesKey')

      if (!xorKeyStr) {
        return { success: false, error: '请先在设置页面配置图片 XOR 密钥' }
      }
      const xorKey = parseInt(String(xorKeyStr), 16)
      if (isNaN(xorKey)) {
        return { success: false, error: 'XOR 密钥格式错误' }
      }

      if (!fs.existsSync(filePath)) {
        return { success: false, error: '文件不存在' }
      }

      const dbPath = this.configService.get('dbPath')
      if (!dbPath) {
        return { success: false, error: '请先配置数据库路径' }
      }

      // 找到账号根目录
      const pathParts = dbPath.split(path.sep)
      const lastPart = pathParts[pathParts.length - 1]
      let accountDir: string

      if (lastPart === 'db_storage') {
        accountDir = path.dirname(dbPath)
      } else {
        const filePathParts = filePath.split(path.sep)
        const dbPathIndex = filePathParts.findIndex((_, i) =>
          i > 0 && filePathParts.slice(0, i).join(path.sep) === dbPath
        )
        if (dbPathIndex > 0) {
          accountDir = filePathParts.slice(0, dbPathIndex + 1).join(path.sep)
        } else {
          accountDir = path.dirname(filePath)
          while (accountDir !== path.dirname(accountDir)) {
            if (fs.existsSync(path.join(accountDir, 'db_storage'))) break
            accountDir = path.dirname(accountDir)
          }
        }
      }

      const cachePath = this.getCurrentCachePath()
      const imageOutputDir = path.join(cachePath, 'images')

      const relativePath = path.relative(accountDir, filePath)
      const outputRelativePath = relativePath.replace(/\.dat$/, '')

      const aesKeyText = aesKeyStr ? String(aesKeyStr) : undefined
      const decrypted = imageDecryptService.decryptDatFile(filePath, xorKey, aesKeyText)

      const ext = this.detectImageFormat(decrypted)
      const outputPath = path.join(imageOutputDir, outputRelativePath + ext)

      const outputDir = path.dirname(outputPath)
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true })
      }

      fs.writeFileSync(outputPath, decrypted)
      return { success: true, outputPath }
    } catch (e) {
      console.error('解密单个图片失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 检测图片格式
   */
  private detectImageFormat(data: Buffer): string {
    if (data.length < 4) return '.bin'

    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return '.jpg'
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return '.png'
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return '.gif'
    if (data[0] === 0x42 && data[1] === 0x4d) return '.bmp'
    if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) {
      if (data.length >= 12 && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) {
        return '.webp'
      }
    }
    return '.bin'
  }
}

export const dataManagementService = new DataManagementService()
