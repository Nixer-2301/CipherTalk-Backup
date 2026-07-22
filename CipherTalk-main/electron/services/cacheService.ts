import { join } from 'path'
import { existsSync, rmSync, promises as fsp } from 'fs'
import { app } from 'electron'
import { ConfigService } from './config'
import { getUserDataPath } from './runtimePaths'
import type { AccountProfile } from '../../src/types/account'

/**
 * 缓存清理服务（Direct DB 迁移后版本）
 *
 * 已废弃的数据库落地/解密相关方法（clearDatabases / clearAccountDatabases /
 * clearCurrentAccount(deleteLocalData=true) 等）保留签名仅作为 no-op 兼容层，
 * 以免 IPC handler / 前端编译失败。真正的删除由后续波次统一处理。
 *
 * 目前真正生效的能力：
 * - 清理图片缓存 / 表情包缓存 / 日志
 * - 清理 AI 功能生成的本地数据库和生成文件缓存
 * - 读取缓存体积概览（数据库项固定为 0）
 * - 账号配置清理
 */
export class CacheService {
  constructor(private configService: ConfigService) {}

  /**
   * 获取有效的缓存路径
   * - 如果配置了 cachePath，使用配置的路径
   * - 开发环境：使用文档目录
   * - 生产环境：
   *   - C 盘安装：使用文档目录
   *   - 其他盘安装：使用软件安装目录
   */
  getEffectiveCachePath(): string {
    const cachePath = this.configService.get('cachePath')
    if (cachePath) return cachePath

    // 开发环境使用文档目录
    if (process.env.VITE_DEV_SERVER_URL) {
      const documentsPath = app.getPath('documents')
      return join(documentsPath, 'CipherTalkData')
    }

    // 生产环境
    const exePath = app.getPath('exe')
    const installDir = require('path').dirname(exePath)

    // 检查是否安装在 C 盘
    const isOnCDrive = /^[cC]:/i.test(installDir) || installDir.startsWith('\\\\')

    if (isOnCDrive) {
      const documentsPath = app.getPath('documents')
      return join(documentsPath, 'CipherTalkData')
    }

    return join(installDir, 'CipherTalkData')
  }

  /**
   * 获取图片缓存目录（兼容旧的 CipherTalk/Images 路径）
   */
  private getImagesCachePaths(): string[] {
    const cachePath = this.configService.get('cachePath')
    const documentsPath = app.getPath('documents')

    const paths: string[] = []

    if (cachePath) {
      paths.push(join(cachePath, 'Images'))
      paths.push(join(cachePath, 'images'))
    }

    const defaultPath = this.getEffectiveCachePath()
    paths.push(join(defaultPath, 'Images'))
    paths.push(join(defaultPath, 'images'))

    // 兼容旧的 CipherTalk/Images 路径
    paths.push(join(documentsPath, 'CipherTalk', 'Images'))

    return Array.from(new Set(paths))
  }

  /**
   * 清除图片缓存
   */
  async clearImages(): Promise<{ success: boolean; error?: string }> {
    try {
      for (const imagesDir of this.getImagesCachePaths()) {
        if (existsSync(imagesDir)) {
          rmSync(imagesDir, { recursive: true, force: true })
        }
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 清除表情包缓存
   */
  async clearEmojis(): Promise<{ success: boolean; error?: string }> {
    try {
      const cachePath = this.getEffectiveCachePath()
      const documentsPath = app.getPath('documents')
      const emojiPaths = [
        join(cachePath, 'Emojis'),
        join(documentsPath, 'CipherTalk', 'Emojis'),
      ]
      for (const emojiPath of emojiPaths) {
        if (existsSync(emojiPath)) {
          rmSync(emojiPath, { recursive: true, force: true })
        }
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * @deprecated Direct DB 迁移后不再落地 .db 缓存。保留为 no-op 兼容调用方。
   */
  async clearDatabases(): Promise<{ success: boolean; error?: string }> {
    console.warn('[cacheService] clearDatabases is a no-op after Direct DB migration')
    return { success: true }
  }

  async clearAIData(): Promise<{ success: boolean; error?: string; deletedFiles?: string[]; failedFiles?: Array<{ path: string; error: string }> }> {
    const deletedFiles: string[] = []
    const failedFiles: Array<{ path: string; error: string }> = []

    try {
      await this.closeAIDataStores()

      for (const dbPath of this.getAIDataDbPaths()) {
        for (const filePath of this.getSqliteFileSet(dbPath)) {
          if (!existsSync(filePath)) continue
          try {
            rmSync(filePath, { force: true })
            deletedFiles.push(filePath)
          } catch (e) {
            failedFiles.push({ path: filePath, error: String(e) })
          }
        }
      }

      for (const dirPath of this.getAIDataDirs()) {
        if (!existsSync(dirPath)) continue
        try {
          rmSync(dirPath, { recursive: true, force: true })
          deletedFiles.push(dirPath)
        } catch (e) {
          failedFiles.push({ path: dirPath, error: String(e) })
        }
      }

      if (failedFiles.length > 0) {
        return {
          success: false,
          error: `部分 AI 数据库清理失败：${failedFiles.map(item => item.path).join(', ')}`,
          deletedFiles,
          failedFiles
        }
      }

      return { success: true, deletedFiles, failedFiles }
    } catch (e) {
      return { success: false, error: String(e), deletedFiles, failedFiles }
    }
  }

  /**
   * 清除所有缓存（图片 / 表情包 / 日志 / AI 数据；不含微信原始数据库）
   */
  async clearAll(): Promise<{ success: boolean; error?: string }> {
    try {
      const cachePath = this.getEffectiveCachePath()

      if (!existsSync(cachePath)) {
        // 同时清理旧 CipherTalk 目录下可能的图片/表情残留
        const documentsPath = app.getPath('documents')
        const oldCipherTalkDir = join(documentsPath, 'CipherTalk')
        if (existsSync(oldCipherTalkDir)) {
          for (const sub of ['Images', 'images', 'Emojis', 'logs']) {
            const p = join(oldCipherTalkDir, sub)
            if (existsSync(p)) {
              try {
                rmSync(p, { recursive: true, force: true })
              } catch (e) {
                console.warn('[cacheService] clearAll 清理旧目录失败:', sub, e)
              }
            }
          }
        }
        const aiResult = await this.clearAIData()
        if (!aiResult.success) return { success: false, error: aiResult.error }
        return { success: true }
      }

      // 清除指定的缓存目录（不含数据库目录）
      const dirsToRemove = ['images', 'Images', 'Emojis', 'logs']

      for (const dir of dirsToRemove) {
        const dirPath = join(cachePath, dir)
        if (existsSync(dirPath)) {
          rmSync(dirPath, { recursive: true, force: true })
        }
      }

      const aiResult = await this.clearAIData()
      if (!aiResult.success) return { success: false, error: aiResult.error }

      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 清除配置
   */
  async clearConfig(): Promise<{ success: boolean; error?: string }> {
    try {
      this.configService.clearAllAccountsAndAccountConfig()
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * @deprecated Direct DB 迁移后不再落地 .db 缓存；保留 no-op。
   */
  async clearAccountDatabases(_account: Pick<AccountProfile, 'wxid' | 'cachePath'>): Promise<{ success: boolean; error?: string }> {
    console.warn('[cacheService] clearAccountDatabases is a no-op after Direct DB migration')
    return { success: true }
  }

  /**
   * 清除当前账号配置。deleteLocalData 参数在 Direct DB 迁移后已无效，
   * 仅保留以兼容既有 IPC 调用。
   */
  async clearCurrentAccount(deleteLocalData = false): Promise<{ success: boolean; error?: string }> {
    try {
      const active = this.configService.getActiveAccount()
      if (!active) {
        return { success: false, error: '当前没有可清除的账号' }
      }

      if (deleteLocalData) {
        console.warn('[cacheService] clearCurrentAccount(deleteLocalData=true) is a no-op after Direct DB migration')
      }

      this.configService.clearCurrentAccount()
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async clearAllAccountConfigs(): Promise<{ success: boolean; error?: string }> {
    try {
      this.configService.clearAllAccountsAndAccountConfig()
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取缓存大小。数据库项在 Direct DB 迁移后固定为 0。
   */
  async getCacheSize(): Promise<{
    success: boolean
    error?: string
    size?: {
      images: number
      emojis: number
      databases: number
      aiData: number
      logs: number
      total: number
    }
  }> {
    try {
      const cachePath = this.getEffectiveCachePath()
      const documentsPath = app.getPath('documents')

      // 图片（所有可能路径）
      let imagesSize = 0
      for (const imgPath of this.getImagesCachePaths()) {
        imagesSize += await this.getFolderSize(imgPath)
      }

      // 表情包（新目录 + 旧 CipherTalk 目录）
      let emojisSize = await this.getFolderSize(join(cachePath, 'Emojis'))
      emojisSize += await this.getFolderSize(join(documentsPath, 'CipherTalk', 'Emojis'))

      // 日志
      const logsSize = await this.getFolderSize(join(cachePath, 'logs'))

      // 数据库项不再统计
      const databasesSize = 0
      const aiDataSize = await this.getAIDataSize()

      const size = {
        images: imagesSize,
        emojis: emojisSize,
        databases: databasesSize,
        aiData: aiDataSize,
        logs: logsSize,
        total: imagesSize + emojisSize + databasesSize + aiDataSize + logsSize,
      }

      return { success: true, size }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取文件夹大小（递归，异步）。
   * 用 fs/promises 让出事件循环，避免同步遍历大目录（图片/表情/AI 缓存可达数 GB）时阻塞主进程。
   */
  private async getFolderSize(folderPath: string): Promise<number> {
    let entries
    try {
      entries = await fsp.readdir(folderPath, { withFileTypes: true })
    } catch {
      return 0 // 目录不存在或无权限
    }
    const sizes = await Promise.all(entries.map(async (entry) => {
      const filePath = join(folderPath, entry.name)
      try {
        if (entry.isDirectory()) return await this.getFolderSize(filePath)
        return (await fsp.stat(filePath)).size
      } catch {
        return 0 // 忽略权限错误等
      }
    }))
    return sizes.reduce((sum, size) => sum + size, 0)
  }

  private getAIDataDbPaths(): string[] {
    const configuredCachePath = String(this.configService.get('cachePath') || '').trim()
    const basePaths = [
      configuredCachePath,
      this.getEffectiveCachePath(),
      this.configService.getCacheBasePath()
    ].filter(Boolean)

    const dbNames = [
      'ai_summary.db',
      'chat_search_index.db',
      'chat_vectors.db',
      'agent_conversations.db',
      'tts-cache.db'
    ]

    return Array.from(new Set(
      basePaths.flatMap(basePath => dbNames.map(dbName => join(basePath, dbName)))
    ))
  }

  private getSqliteFileSet(dbPath: string): string[] {
    return [
      dbPath,
      `${dbPath}-wal`,
      `${dbPath}-shm`,
      `${dbPath}-journal`
    ]
  }

  private async getAIDataSize(): Promise<number> {
    let total = 0
    for (const dbPath of this.getAIDataDbPaths()) {
      for (const filePath of this.getSqliteFileSet(dbPath)) {
        try {
          total += (await fsp.stat(filePath)).size
        } catch {
          // 文件不存在/无权限：忽略
        }
      }
    }
    for (const dirPath of this.getAIDataDirs()) {
      total += await this.getFolderSize(dirPath)
    }
    return total
  }

  private getAIDataDirs(): string[] {
    const configuredCachePath = String(this.configService.get('cachePath') || '').trim()
    const basePaths = [
      configuredCachePath,
      this.getEffectiveCachePath(),
      this.configService.getCacheBasePath()
    ].filter(Boolean)

    return Array.from(new Set(
      [
        ...basePaths.flatMap(basePath => [
          join(basePath, 'memory-bank'),
          join(basePath, 'tts-audio'),
          join(basePath, 'ai-images')
        ]),
        // 兼容旧版本：AI 作图曾保存到 userData/ai-images。
        join(getUserDataPath(), 'ai-images')
      ]
    ))
  }

  private async closeAIDataStores(): Promise<void> {
    await Promise.all([
      import('./memory/memoryDatabase')
        .then(({ memoryDatabase }) => memoryDatabase.close())
        .catch(() => undefined),
      import('./search/chatSearchIndexService')
        .then(({ chatSearchIndexService }) => chatSearchIndexService.close?.())
        .catch(() => undefined),
      import('./search/messageVectorService')
        .then(({ messageVectorService }) => messageVectorService.close())
        .catch(() => undefined),
      import('./agent/conversationStore')
        .then(({ agentConversationStore }) => agentConversationStore.close())
        .catch(() => undefined),
      import('./ai/ttsService')
        .then(({ closeTtsCache }) => closeTtsCache())
        .catch(() => undefined)
    ])
  }
}
