import * as fs from 'fs'
import * as path from 'path'
import * as https from 'https'
import * as http from 'http'
import * as fzstd from 'fzstd'
import { getDocumentsPath, getExePath } from '../runtimePaths'
import { dbAdapter } from '../dbAdapter'
import { findAccountDir } from './accountUtils'
import { decodeMessageContent } from './rowDecoders'
import { parseEmojiInfo } from './contentParsers'
import { emojiCache, emojiDownloading } from './constants'
import { getUinFromMiscDb } from './contactQueries'
import { findMessageDbs } from './tableResolver'
import type { ChatServiceState } from './state'

/**
 * 获取解密后的数据库目录（仅用于表情包/文件路径解析等非数据库场景）
 */
export function getDecryptedDbDir(state: ChatServiceState): string {
  const cachePath = state.configService.get('cachePath')
  if (cachePath) return cachePath

  if (process.env.VITE_DEV_SERVER_URL) {
    const documentsPath = getDocumentsPath()
    return path.join(documentsPath, 'CipherTalkData')
  }

  const exePath = getExePath()
  const installDir = path.dirname(exePath)

  const isOnCDrive = /^[cC]:/i.test(installDir) || installDir.startsWith('\\')

  if (isOnCDrive) {
    const documentsPath = getDocumentsPath()
    return path.join(documentsPath, 'CipherTalkData')
  }

  return path.join(installDir, 'CipherTalkData')
}

/**
 * 获取表情包缓存解密所需的 UIN 和 keyString
 * - UIN: 从 misc.db 获取，或从配置读取
 * - keyString: 使用 myWxid（已在配置中）
 */
export async function getEmoticonDecryptionParams(state: ChatServiceState): Promise<{ uin: string | null; keyString: string | null }> {
  try {
    // 优先从 misc.db 自动获取 UIN
    let uin = await getUinFromMiscDb()

    // 如果自动获取失败，尝试从配置读取
    if (!uin) {
      uin = state.configService.get('emoticonUin') || null
    }

    // keyString 使用 myWxid
    const keyString = state.configService.get('myWxid') || null

    return { uin, keyString }
  } catch (e) {
    console.error('ChatService: 获取表情包解密参数失败:', e)
    return { uin: null, keyString: null }
  }
}

/**
 * 解密表情包缓存文件
 * 使用 AES-128-CBC (IV=Key) + XOR 掩码
 * 密钥派生: MD5(str(UIN) + keyString + "EMOTICON") → 小写十六进制 → 前16字符
 */
export async function decryptEmoticonCache(state: ChatServiceState, filePath: string): Promise<Buffer | null> {
  try {
    if (!fs.existsSync(filePath)) {
      return null
    }

    // 获取解密参数
    const params = await getEmoticonDecryptionParams(state)
    if (!params.uin || !params.keyString) {
      console.warn('ChatService: 缺少表情包解密参数 (UIN 或 keyString)')
      return null
    }

    // 读取加密文件
    const encryptedBuffer = fs.readFileSync(filePath)
    if (encryptedBuffer.length === 0) {
      return null
    }

    const crypto = require('crypto')

    // 密钥派生: MD5(str(UIN) + keyString + "EMOTICON")
    const keyMaterial = String(params.uin) + params.keyString + 'EMOTICON'
    const keyHash = crypto.createHash('md5').update(keyMaterial).digest('hex').toLowerCase()
    const keyHex = keyHash.substring(0, 16)
    const key = Buffer.from(keyHex, 'utf8')

    // 复制缓冲区以便修改
    const workBuffer = Buffer.from(encryptedBuffer)

    // 应用 XOR 掩码到前32字节
    // XOR 掩码是密钥的重复
    const xorMask = Buffer.alloc(32)
    for (let i = 0; i < 32; i++) {
      xorMask[i] = key[i % key.length]
    }

    for (let i = 0; i < Math.min(32, workBuffer.length); i++) {
      workBuffer[i] ^= xorMask[i]
    }

    // AES-128-CBC 解密，IV = Key
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, key)
    decipher.setAutoPadding(true)

    const decrypted = Buffer.concat([
      decipher.update(workBuffer),
      decipher.final()
    ])

    return decrypted
  } catch (e) {
    console.error('ChatService: 表情包缓存解密失败:', e)
    return null
  }
}

/**
 * 获取商店表情包的备选 URL 列表
 * 尝试不同的域名和扩展名组合
 */
export function getAlternativeStoreEmojiUrls(productId: string, md5: string): string[] {
  const urls: string[] = []

  try {
    const prefix = 'com.tencent.xin.emoticon.'
    if (!productId.startsWith(prefix)) {
      return urls
    }

    const productPath = productId.substring(prefix.length)

    // 多个可能的域名
    const baseUrls = [
      'https://emoji.qpic.cn/resource/emoticon',
      'https://mmbiz.qpic.cn/mmemoticon',
      'https://emoji.weixin.qq.com/resource/emoticon',
    ]

    // 多个可能的扩展名
    const extensions = ['webp', 'png', 'jpg']

    // 生成所有组合
    for (const baseUrl of baseUrls) {
      for (const ext of extensions) {
        urls.push(`${baseUrl}/${productPath}/${md5}.${ext}`)
      }
    }
  } catch (e) {
    // 忽略错误
  }

  return urls
}

/**
 * 构造商店表情包的 URL
 * 根据 productId 和 MD5 拼接微信表情资源 CDN 链接
 * 
 * 规则来源：iWeChat 项目的表情解析逻辑
 * URL 格式：https://emoji.weixin.qq.com/resource/emoticon/{product_path}/{md5}.{ext}
 */
export function constructStoreEmojiUrl(productId: string, md5: string): string | null {
  try {
    // 移除前缀 "com.tencent.xin.emoticon."
    const prefix = 'com.tencent.xin.emoticon.'
    if (!productId.startsWith(prefix)) {
      return null
    }

    const productPath = productId.substring(prefix.length)

    // 尝试多种可能的扩展名和域名
    const baseUrls = [
      'https://emoji.weixin.qq.com/resource/emoticon',
      'https://emoji.qpic.cn/resource/emoticon',
      'https://mmbiz.qpic.cn/mmemoticon',
    ]

    const extensions = ['gif', 'webp', 'png']

    // 返回第一个可能的 URL（后续会尝试下载）
    // 优先使用 gif 格式
    return `${baseUrls[0]}/${productPath}/${md5}.gif`
  } catch (e) {
    return null
  }
}

/**
 * 从本地文件系统查找表情包文件
 * 用于商店表情包，当消息中没有 CDN URL 时
 */
export async function findLocalEmojiFile(state: ChatServiceState, md5: string, productId: string): Promise<string | null> {
  try {
    const dbPath = state.configService.get('dbPath')
    const myWxid = state.configService.get('myWxid')

    if (!dbPath || !myWxid || !fs.existsSync(dbPath)) {
      return null
    }

    const accountDirName = findAccountDir(dbPath, myWxid)
    if (!accountDirName) {
      return null
    }

    const accountRootDir = path.join(dbPath, accountDirName)
    const md5Lower = md5.toLowerCase()

    // 商店表情包可能的路径
    const candidatePaths: string[] = [
      // 路径 1: All Users/Emoji/<package_id>/<md5>
      path.join(dbPath, 'All Users', 'Emoji', productId, md5Lower),
      path.join(dbPath, 'All Users', 'Emoji', productId, md5),

      // 路径 2: <wxid>/FileStorage/Stickers/<package_id>/<md5>
      path.join(accountRootDir, 'FileStorage', 'Stickers', productId, md5Lower),
      path.join(accountRootDir, 'FileStorage', 'Stickers', productId, md5),

      // 路径 3: <wxid>/business/emoticon/<package_id>/<md5>
      path.join(accountRootDir, 'business', 'emoticon', productId, md5Lower),
      path.join(accountRootDir, 'business', 'emoticon', productId, md5),

      // 路径 4: <wxid>/Stickers/<package_id>/<md5>
      path.join(accountRootDir, 'Stickers', productId, md5Lower),
      path.join(accountRootDir, 'Stickers', productId, md5),
    ]

    // 路径 5: 搜索 cache 目录下的 Emoticon 子目录（微信缓存，按月份分组）
    const cacheDir = path.join(accountRootDir, 'cache')
    if (fs.existsSync(cacheDir)) {
      try {
        const cacheDirs = fs.readdirSync(cacheDir)
        for (const subDir of cacheDirs) {
          const emoticonDir = path.join(cacheDir, subDir, 'Emoticon')
          if (fs.existsSync(emoticonDir)) {
            candidatePaths.push(path.join(emoticonDir, md5Lower))
            candidatePaths.push(path.join(emoticonDir, md5))
          }
        }
      } catch (e) {
        // 忽略 cache 目录读取错误
      }
    }

    // 检查每个候选路径
    for (const candidatePath of candidatePaths) {
      if (fs.existsSync(candidatePath)) {
        const stat = fs.statSync(candidatePath)
        if (stat.isFile() && stat.size > 0) {
          return candidatePath
        }
      }
    }

    // 如果直接路径不存在，尝试在目录中查找（可能有扩展名）
    for (const candidatePath of candidatePaths) {
      const dir = path.dirname(candidatePath)
      if (fs.existsSync(dir)) {
        try {
          const files = fs.readdirSync(dir)
          const baseName = path.basename(candidatePath)

          // 查找匹配的文件（可能有 .gif, .png 等扩展名）
          for (const file of files) {
            if (file.toLowerCase().startsWith(baseName.toLowerCase())) {
              const fullPath = path.join(dir, file)
              const stat = fs.statSync(fullPath)
              if (stat.isFile() && stat.size > 0) {
                return fullPath
              }
            }
          }
        } catch (e) {
          // 忽略目录读取错误
        }
      }
    }

    // 尝试从打包文件中提取
    const extractedFile = await extractEmojiFromPackage(state, md5, productId)
    if (extractedFile) {
      return extractedFile
    }

    return null
  } catch (e) {
    return null
  }
}

/**
 * 从打包文件中提取表情包
 * 商店表情包通常打包存储，需要使用 offset 和 size 提取
 */
export async function extractEmojiFromPackage(state: ChatServiceState, md5: string, productId: string): Promise<string | null> {
  try {
    // 从数据库获取 offset 和 size
    const row = await dbAdapter.get<any>(
      'emoticon',
      '',
      `SELECT emoticon_offset_, emoticon_size_
       FROM kStoreEmoticonFilesTable
       WHERE LOWER(md5_) = LOWER(?) AND package_id_ = ?`,
      [md5, productId]
    )

    if (!row || !row.emoticon_offset_ || !row.emoticon_size_) {
      return null
    }

    const offset = row.emoticon_offset_
    const size = row.emoticon_size_

    // 查找打包文件
    const dbPath = state.configService.get('dbPath')
    const myWxid = state.configService.get('myWxid')

    if (!dbPath || !myWxid) {
      return null
    }

    const accountDirName = findAccountDir(dbPath, myWxid)
    if (!accountDirName) {
      return null
    }

    const accountRootDir = path.join(dbPath, accountDirName)

    // 打包文件可能的路径
    const packagePaths = [
      path.join(accountRootDir, 'FileStorage', 'Stickers', productId),
      path.join(accountRootDir, 'business', 'emoticon', productId),
      path.join(accountRootDir, 'Stickers', productId),
      path.join(dbPath, 'All Users', 'Emoji', productId),
    ]

    let packageFile: string | null = null

    // 查找打包文件（可能是目录中的某个文件）
    for (const packageDir of packagePaths) {
      if (!fs.existsSync(packageDir)) continue

      try {
        const stat = fs.statSync(packageDir)

        // 如果是文件，直接使用
        if (stat.isFile()) {
          packageFile = packageDir
          break
        }

        // 如果是目录，查找可能的打包文件
        if (stat.isDirectory()) {
          const files = fs.readdirSync(packageDir)

          // 查找可能的打包文件（通常是最大的文件或特定名称）
          for (const file of files) {
            const filePath = path.join(packageDir, file)
            const fileStat = fs.statSync(filePath)

            if (fileStat.isFile()) {
              // 检查文件大小是否足够包含我们要提取的数据
              if (fileStat.size >= offset + size) {
                packageFile = filePath
                break
              }
            }
          }

          if (packageFile) break
        }
      } catch (e) {
        // 忽略错误
      }
    }

    if (!packageFile) {
      return null
    }

    const buffer = fs.readFileSync(packageFile)

    if (buffer.length < offset + size) {
      return null
    }

    const emojiData = buffer.slice(offset, offset + size)

    // 保存到缓存目录
    const cacheDir = getEmojiCacheDir(state)
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true })
    }

    // 检测文件格式
    const ext = detectImageExtension(emojiData) || '.gif'
    const outputPath = path.join(cacheDir, `${md5}${ext}`)

    fs.writeFileSync(outputPath, emojiData)

    return outputPath
  } catch (e) {
    return null
  }
}

/**
 * 从消息数据库中查找表情包 CDN URL
 * 用于商店表情包，因为它们的完整 URL（包含 filekey）只存在于消息内容中
 */
export async function findEmojiUrlFromMessages(state: ChatServiceState, md5: string, createTime?: number): Promise<string | null> {
  try {
    // 查找所有消息数据库
    const { allDbs } = findMessageDbs(state)

    if (allDbs.length === 0) return null

    // 遍历所有消息数据库，查找匹配的表情消息
    for (const dbPath of allDbs) {
      try {
        // 查找所有消息表
        const tables = await dbAdapter.all<any>(
          'message',
          dbPath,
          "SELECT name FROM sqlite_master WHERE type='table' AND lower(name) LIKE 'msg_%'"
        )

        for (const table of tables) {
          const tableName = table.name as string

          try {
            let rows: any[]

            // 如果有 createTime，使用时间范围查询（更精确）
            if (createTime) {
              const timeStart = createTime - 5
              const timeEnd = createTime + 5

              rows = await dbAdapter.all<any>(
                'message',
                dbPath,
                `SELECT local_id, create_time, message_content, compress_content
                 FROM ${tableName}
                 WHERE local_type = 47
                 AND create_time >= ?
                 AND create_time <= ?
                 LIMIT 100`,
                [timeStart, timeEnd]
              )
            } else {
              // 没有 createTime，查询最近的表情消息（按时间倒序）
              rows = await dbAdapter.all<any>(
                'message',
                dbPath,
                `SELECT local_id, create_time, message_content, compress_content
                 FROM ${tableName}
                 WHERE local_type = 47
                 ORDER BY create_time DESC
                 LIMIT 200`
              )
            }

            for (const row of rows) {
              const content = decodeMessageContent(row.message_content, row.compress_content)
              if (!content) continue

              // 解析表情信息
              const emojiInfo = parseEmojiInfo(content)

              // 检查 MD5 是否匹配（不区分大小写）
              if (emojiInfo.md5 && emojiInfo.md5.toLowerCase() === md5.toLowerCase()) {
                if (emojiInfo.cdnUrl) {
                  return emojiInfo.cdnUrl
                }
              }
            }
          } catch (e: any) {
            // 忽略单个表查询错误（静默处理损坏的表）
          }
        }
      } catch (e: any) {
        // 忽略损坏的数据库（静默处理）
      }
    }

    return null
  } catch (e) {
    return null
  }
}

/**
 * 获取表情包缓存目录
 */
export function getEmojiCacheDir(state: ChatServiceState): string {
  const cachePath = state.configService.get('cachePath')
  if (cachePath) {
    return path.join(cachePath, 'Emojis')
  }
  // 回退到默认目录
  return path.join(getDecryptedDbDir(state), 'Emojis')
}

/**
 * 下载或获取表情包本地缓存
 * 如果 cdnUrl 为空但 md5 存在，则尝试通过本地存储或多种拼接规则下载
 */
export async function downloadEmoji(state: ChatServiceState, cdnUrl: string, md5?: string, productId?: string, createTime?: number, encryptUrl?: string, aesKey?: string): Promise<{ success: boolean; localPath?: string; cachePath?: string; error?: string }> {
  // 如果没有 cdnUrl 也没有 md5，无法处理
  if (!cdnUrl && !md5) {
    return { success: false, error: '无效的 CDN URL 和 MD5' }
  }

  // 生成缓存 key
  const cacheKey = md5 || hashString(cdnUrl)

  // 检查内存缓存
  const cached = emojiCache.get(cacheKey)
  if (cached && fs.existsSync(cached)) {
    const dataUrl = fileToDataUrl(state, cached)
    if (dataUrl) {
      return { success: true, localPath: dataUrl, cachePath: cached }
    }
  }

  // 检查是否正在下载
  const downloading = emojiDownloading.get(cacheKey)
  if (downloading) {
    const result = await downloading
    if (result) {
      const dataUrl = fileToDataUrl(state, result)
      if (dataUrl) {
        return { success: true, localPath: dataUrl, cachePath: result }
      }
    }
    return { success: false, error: '下载失败' }
  }

  // 确保缓存目录存在
  const cacheDir = getEmojiCacheDir(state)
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true })
  }

  // 检查本地是否已有缓存文件
  const extensions = ['.gif', '.png', '.webp', '.jpg', '.jpeg']
  for (const ext of extensions) {
    const filePath = path.join(cacheDir, `${cacheKey}${ext}`)
    if (fs.existsSync(filePath)) {
      emojiCache.set(cacheKey, filePath)
      const dataUrl = fileToDataUrl(state, filePath)
      if (dataUrl) {
        return { success: true, localPath: dataUrl, cachePath: filePath }
      }
    }
  }

  // [精简] 基础 ID 与链接获取
  let effectiveProductId = productId
  let finalCdnUrl = cdnUrl

  // 尝试从本地数据库补充 productId (商店表情包)
  if (!effectiveProductId && md5) {
    try {
      const row = await dbAdapter.get<any>(
        'emoticon',
        '',
        'SELECT package_id_ FROM kStoreEmoticonFilesTable WHERE LOWER(md5_) = LOWER(?)',
        [md5]
      )
      if (row?.package_id_) {
        effectiveProductId = row.package_id_
      }
    } catch (e) { }
  }

  // [New] 尝试从本地数据库查找 CDN URL (修复: 增强匹配逻辑、不区分大小写)
  if (!finalCdnUrl && md5) {
    const targetKinds: string[] = ['emoticon', 'emotion']

    // 优先查询 kNonStoreEmoticonTable (非商店表情包，最常用)
    const priorityTables = [
      { name: 'kNonStoreEmoticonTable', md5Col: 'md5', urlCols: ['cdn_url', 'encrypt_url', 'extern_url'] },
      { name: 'kStoreEmoticonFilesTable', md5Col: 'md5_', urlCols: [] }, // 商店表情包需要通过 package_id 构建
    ]

    // 备用表名（兼容旧版本）
    const candidateTables = ['CustomEmoticon', 'Emoticon', 'EmojiInfo', 'SmileyInfo', 'EmoticonInfo']
    let found = false

    for (const kind of targetKinds) {
      // 1. 优先查询已知表结构
      for (const tableInfo of priorityTables) {
        try {
          const tableExists = await dbAdapter.get<any>(
            kind,
            '',
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            [tableInfo.name]
          )
          if (!tableExists) continue

          if (tableInfo.urlCols.length > 0) {
            // kNonStoreEmoticonTable: 尝试多个 URL 字段
            for (const urlCol of tableInfo.urlCols) {
              try {
                const row = await dbAdapter.get<any>(
                  kind,
                  '',
                  `SELECT ${urlCol} as url FROM ${tableInfo.name} WHERE LOWER(${tableInfo.md5Col}) = LOWER(?) LIMIT 1`,
                  [md5]
                )
                if (row?.url) {
                  finalCdnUrl = row.url
                  found = true
                  break
                }
              } catch (err) { }
            }
          }

          if (found) break
        } catch (err) { }
      }

      if (found) break

      // 2. 备用：动态查询未知表结构
      for (const tableName of candidateTables) {
        try {
          // 检查表是否存在
          const tableExists = await dbAdapter.get<any>(
            kind,
            '',
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            [tableName]
          )
          if (!tableExists) continue

          // 动态获取列名以适配不同版本 (md5 vs md5_, cdnUrl vs cdn_url)
          const columns = await dbAdapter.all<any>(kind, '', `PRAGMA table_info(${tableName})`)
          const colNames = columns.map((c: any) => c.name)
          const md5Col = colNames.find((c: string) => ['md5', 'md5_'].includes(c.toLowerCase()))
          const urlCol = colNames.find((c: string) => ['cdnurl', 'cdn_url', 'cdnurl_', 'url', 'encrypturl', 'encrypt_url'].includes(c.toLowerCase()))

          if (md5Col && urlCol) {
            // 使用 LOWER 确保 MD5 大小写不一致也能匹配 (微信数据库中 MD5 有时是大写)
            const row = await dbAdapter.get<any>(
              kind,
              '',
              `SELECT ${urlCol} as url FROM ${tableName} WHERE LOWER(${md5Col}) = LOWER(?) LIMIT 1`,
              [md5]
            )
            if (row?.url) {
              finalCdnUrl = row.url
              found = true
              break
            }
          }
        } catch (err) { }
      }
      if (found) break
    }
  }

  // [Critical] 如果仍然没有 CDN URL，尝试从消息数据库中提取（商店表情包的关键）
  if (!finalCdnUrl && md5) {
    try {
      const emojiUrl = await findEmojiUrlFromMessages(state, md5, createTime)
      if (emojiUrl) {
        finalCdnUrl = emojiUrl
      }
    } catch (e) {
      // 忽略错误
    }
  }

  // [New] 如果仍然没有 URL，尝试通过 productId 构造 URL（商店表情包）
  if (!finalCdnUrl && md5 && effectiveProductId) {
    try {
      const constructedUrl = constructStoreEmojiUrl(effectiveProductId, md5)
      if (constructedUrl) {
        finalCdnUrl = constructedUrl
      }
    } catch (e) {
      // 忽略构造 URL 失败
    }
  }

  // [New] 如果仍然没有 URL，尝试从本地文件系统查找（商店表情包）
  if (!finalCdnUrl && md5 && effectiveProductId) {
    try {
      const localFile = await findLocalEmojiFile(state, md5, effectiveProductId)
      if (localFile) {
        const dataUrl = fileToDataUrl(state, localFile)
        if (dataUrl) {
          emojiCache.set(cacheKey, localFile)
          return { success: true, localPath: dataUrl, cachePath: localFile }
        }
      }
    } catch (e) {
      // 忽略查找本地文件失败
    }
  }

  if (!finalCdnUrl && !effectiveProductId) {
    // 非商店表情包，尝试备选 URL
    const fallbackUrls: string[] = [
      `https://emoji.qpic.cn/wx_emoji/${md5}/0`,
      `https://emoji.qpic.cn/wx_emoji/${md5}/126`
    ]

    for (const url of fallbackUrls) {
      try {
        const localPath = await doDownloadEmoji(url, cacheKey, cacheDir)
        if (localPath) {
          const dataUrl = fileToDataUrl(state, localPath)
          if (dataUrl) {
            emojiCache.set(cacheKey, localPath)
            return { success: true, localPath: dataUrl, cachePath: localPath }
          }
        }
      } catch (e) { }
    }

    return { success: false, error: '表情包不可用：未找到 CDN URL，本地文件也不存在' }
  }

  if (!finalCdnUrl) {
    return { success: false, error: '商店表情包暂不可用：需要从微信重新下载' }
  }

  // 普通 CDN 下载流程
  try {
    const localPath = await doDownloadEmoji(finalCdnUrl, cacheKey, cacheDir)
    if (localPath) {
      emojiCache.set(cacheKey, localPath)
      const dataUrl = fileToDataUrl(state, localPath)
      if (dataUrl) return { success: true, localPath: dataUrl, cachePath: localPath }
    }
  } catch (e) {
    // 忽略下载失败
  }

  // 如果是商店表情包且下载失败，尝试其他扩展名和域名
  if (effectiveProductId && md5) {
    const alternativeUrls = getAlternativeStoreEmojiUrls(effectiveProductId, md5)

    for (const altUrl of alternativeUrls) {
      try {
        const localPath = await doDownloadEmoji(altUrl, cacheKey, cacheDir)
        if (localPath) {
          emojiCache.set(cacheKey, localPath)
          const dataUrl = fileToDataUrl(state, localPath)
          if (dataUrl) {
            return { success: true, localPath: dataUrl, cachePath: localPath }
          }
        }
      } catch (e) {
        // 继续尝试下一个
      }
    }
  }

  // encryptUrl fallback: 下载加密表情并用 AES 解密
  if (encryptUrl && aesKey) {
    try {
      const encLocalPath = await doDownloadEmoji(encryptUrl.replace(/&amp;/g, '&'), cacheKey + '_enc', cacheDir)
      if (encLocalPath) {
        const encData = fs.readFileSync(encLocalPath)
        const crypto = require('crypto')
        const keyBuf = Buffer.from(crypto.createHash('md5').update(aesKey).digest('hex').slice(0, 16), 'utf8')
        const decipher = crypto.createDecipheriv('aes-128-ecb', keyBuf, null)
        decipher.setAutoPadding(true)
        const decrypted = Buffer.concat([decipher.update(encData), decipher.final()])
        const ext = detectImageExtension(decrypted) || '.gif'
        const outputPath = path.join(cacheDir, `${cacheKey}${ext}`)
        fs.writeFileSync(outputPath, decrypted)
        try { fs.unlinkSync(encLocalPath) } catch { }
        emojiCache.set(cacheKey, outputPath)
        const dataUrl = fileToDataUrl(state, outputPath)
        if (dataUrl) return { success: true, localPath: dataUrl, cachePath: outputPath }
      }
    } catch (e) {
      console.warn('[ChatService] encryptUrl fallback 失败:', e)
    }
  }

  return { success: false, error: '下载失败' }
}

/**
 * 将文件转为 data URL (带 ZSTD 解压与 XOR 解密)
 */
export function fileToDataUrl(state: ChatServiceState, filePath: string): string | null {
  try {
    let buffer = fs.readFileSync(filePath)
    if (!buffer || buffer.length === 0) return null

    // 1. ZSTD 解压缩
    const zstdMagic = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])
    const zstdIndex = buffer.indexOf(zstdMagic)
    if (zstdIndex !== -1 && zstdIndex < 256) {
      try {
        const decompressed = Buffer.from(fzstd.decompress(buffer.slice(zstdIndex)))
        if (decompressed.length > 0) buffer = decompressed
      } catch (e) { }
    }

    // 2. 格式识别与 XOR 解密
    let mimeType = detectMimeType(buffer)
    let decryptedBuffer = buffer

    if (!mimeType) {
      const xorKeyHex = state.configService.get('imageXorKey')
      const xorKey = xorKeyHex ? parseInt(xorKeyHex, 16) : null

      // 尝试偏移 0 和 16
      for (const offset of [0, 16]) {
        if (buffer.length <= offset) continue
        const part = buffer.slice(offset)

        // 尝试配置的 XOR Key
        if (xorKey !== null && !isNaN(xorKey)) {
          const temp = Buffer.alloc(part.length)
          for (let i = 0; i < part.length; i++) temp[i] = part[i] ^ xorKey
          const m = detectMimeType(temp)
          if (m) {
            decryptedBuffer = temp
            mimeType = m
            break
          }
        }

        // 简单暴力破解单字节 XOR (仅常用图片头)
        const heads = [0x47, 0x89, 0xFF] // GIF, PNG, JPG
        for (const head of heads) {
          const key = part[0] ^ head
          const temp = Buffer.alloc(part.length)
          for (let i = 0; i < part.length; i++) temp[i] = part[i] ^ key
          const m = detectMimeType(temp)
          if (m) {
            decryptedBuffer = temp
            mimeType = m
            break
          }
        }
        if (mimeType) break
      }
    }

    if (!mimeType) mimeType = 'image/gif' // 兜底

    return `data:${mimeType};base64,${decryptedBuffer.toString('base64')}`
  } catch (e) {
    return null
  }
}

/**
 * 辅助：探测 Buffer 是哪种图片格式
 */
export function detectMimeType(buffer: Buffer): string | null {
  if (buffer.length < 4) return null
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif'
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png'
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg'
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return 'image/webp'
  return null
}

/**
 * 执行表情包下载 (深度模拟微信环境)
 */
export function doDownloadEmoji(url: string, cacheKey: string, cacheDir: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      // 强制升级 http 到 https (解决 ECONNRESET)
      if (url.startsWith('http://') && (url.includes('qq.com') || url.includes('wechat.com'))) {
        url = url.replace('http://', 'https://')
      }

      const urlObj = new URL(url)
      const protocol = url.startsWith('https') ? https : http

      // 使用真实微信 PC 端 Headers
      const options = {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x67001431) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/3.9.11.17(0x63090b11) XWEB/1158',
          'Accept': '*/*',
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Connection': 'keep-alive'
        },
        // [Fix] 针对腾讯/微信 CDN 域名跳过证书验证
        rejectUnauthorized: false,
        timeout: 10000
      }

      const request = protocol.get(url, options, (response) => {
        // 处理重定向 (支持多级跳转)
        if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 303 || response.statusCode === 307) {
          const redirectUrl = response.headers.location
          if (redirectUrl) {
            const fullRedirectUrl = redirectUrl.startsWith('http') ? redirectUrl : `${urlObj.protocol}//${urlObj.host}${redirectUrl}`
            doDownloadEmoji(fullRedirectUrl, cacheKey, cacheDir).then(resolve)
            return
          }
        }

        if (response.statusCode !== 200) {
          resolve(null)
          return
        }

        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const buffer = Buffer.concat(chunks)
          if (buffer.length === 0) {
            resolve(null)
            return
          }

          // 根据二进制内容自动纠正文件后缀
          const ext = detectImageExtension(buffer) || getExtFromUrl(url) || '.gif'
          const filePath = path.join(cacheDir, `${cacheKey}${ext}`)

          try {
            if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })
            fs.writeFileSync(filePath, buffer)
            resolve(filePath)
          } catch (err) {
            resolve(null)
          }
        })
        response.on('error', () => resolve(null))
      })

      request.on('error', (err) => {
        resolve(null)
      })
      request.setTimeout(15000, () => {
        request.destroy()
        resolve(null)
      })
    } catch (e) {
      resolve(null)
    }
  })
}

/**
 * 检测图片格式
 */
export function detectImageExtension(buffer: Buffer): string | null {
  if (buffer.length < 12) return null

  // GIF
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return '.gif'
  }
  // PNG
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return '.png'
  }
  // JPEG
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return '.jpg'
  }
  // WEBP
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return '.webp'
  }

  return null
}

/**
 * 从 URL 获取扩展名
 */
export function getExtFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname
    const ext = path.extname(pathname).toLowerCase()
    if (['.gif', '.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
      return ext
    }
  } catch { }
  return null
}

/**
 * 简单的字符串哈希
 */
export function hashString(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(16)
}
