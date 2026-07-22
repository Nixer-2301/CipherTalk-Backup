import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { dbAdapter } from '../dbAdapter'
import { getDbStoragePath } from '../dbStoragePaths'
import { imageDecryptService } from '../imageDecryptService'
import { quoteIdent } from '../statsSqlHelpers'
import { getAppPath, isElectronPackaged } from '../runtimePaths'
import { cleanAccountDirName } from './accountUtils'
import { coerceRowNumber, decodeMessageContent, extractXmlValue, getRowField } from './rowDecoders'
import { resolveMessageLocalType, resolveRowIsSend, rowToMessage, isMessageVisibleForSession } from './messageMapper'
import {
  parseChatHistory,
  parseEmojiInfo,
  parseFileInfo,
  parseImageDatNameFromRow,
  parseImageInfo,
  parseMessageContent,
  parseQuoteMessage,
  parseVideoDuration,
  parseVideoMd5,
  parseVoiceDuration,
} from './contentParsers'
import { findSessionTables, checkTableExists, resolveMyRowId } from './tableResolver'
import type { Message, ChatRecordItem } from './types'
import type { ChatServiceState } from './state'

/**
 * 查找 media 数据库文件
 */
export function findMediaDbs(): string[] {
  const root = getDbStoragePath()
  if (!root) return []

  const mediaDbFiles: string[] = []

  try {
    const collect = (dir: string, depth = 0) => {
      if (depth > 5) return
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          collect(full, depth + 1)
        } else if (entry.isFile()) {
          const lower = entry.name.toLowerCase()
          if (lower.startsWith('media') && lower.endsWith('.db')) {
            mediaDbFiles.push(full)
          }
        }
      }
    }
    collect(root)
  } catch (e) {
    console.error('[ChatService][Voice] 查找 media 数据库失败:', e)
  }

  return mediaDbFiles
}

/**
 * 获取单条消息
 */
export async function getMessageByLocalId(state: ChatServiceState, sessionId: string, localId: number): Promise<{ success: boolean; message?: Message; error?: string }> {
  const dbTablePairs = await findSessionTables(state, sessionId)
  const myWxid = state.configService.get('myWxid')
  const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''

  for (const { tableName, dbPath } of dbTablePairs) {
    try {
      const hasName2IdTable = await checkTableExists(state, dbPath, 'Name2Id')
      const myRowId = await resolveMyRowId(state, dbPath, myWxid, cleanedMyWxid, hasName2IdTable)

      let row: any
      if (hasName2IdTable && myRowId !== null) {
        row = await dbAdapter.get<any>(
          'message',
          dbPath,
          `SELECT m.*,
                  CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                  n.user_name AS sender_username
                  FROM ${tableName} m
                  LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                  WHERE m.local_id = ?`,
          [myRowId, localId]
        )
      } else if (hasName2IdTable) {
        row = await dbAdapter.get<any>(
          'message',
          dbPath,
          `SELECT m.*, n.user_name AS sender_username
                  FROM ${tableName} m
                  LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                  WHERE m.local_id = ?`,
          [localId]
        )
      } else {
        row = await dbAdapter.get<any>(
          'message',
          dbPath,
          `SELECT * FROM ${tableName} WHERE local_id = ?`,
          [localId]
        )
      }

      if (row) {
        const content = decodeMessageContent(row.message_content, row.compress_content)
        const localType = resolveMessageLocalType(row, 1)
        const isSend = resolveRowIsSend(state, row, row.sender_username || null)

        let emojiCdnUrl: string | undefined
        let emojiMd5: string | undefined
        let emojiProductId: string | undefined
        let quotedContent: string | undefined
        let quotedSender: string | undefined
        let quotedImageMd5: string | undefined
        let quotedEmojiMd5: string | undefined
        let quotedEmojiCdnUrl: string | undefined
        let imageMd5: string | undefined
        let imageDatName: string | undefined
        let isLivePhoto: boolean | undefined
        let videoMd5: string | undefined
        let videoDuration: number | undefined
        let voiceDuration: number | undefined

        if (localType === 47 && content) {
          const emojiInfo = parseEmojiInfo(content)
          emojiCdnUrl = emojiInfo.cdnUrl
          emojiMd5 = emojiInfo.md5
          emojiProductId = emojiInfo.productId
        } else if (localType === 3 && content) {
          const imageInfo = parseImageInfo(content)
          imageMd5 = imageInfo.md5
          imageDatName = parseImageDatNameFromRow(row)
          isLivePhoto = imageInfo.isLivePhoto
        } else if (localType === 43 && content) {
          videoMd5 = parseVideoMd5(content)
          videoDuration = parseVideoDuration(content)
        } else if (localType === 34 && content) {
          voiceDuration = parseVoiceDuration(content)
        } else if (localType === 244813135921 || (content && content.includes('<type>57</type>'))) {
          const quoteInfo = parseQuoteMessage(content)
          quotedContent = quoteInfo.content
          quotedSender = quoteInfo.sender
          quotedImageMd5 = quoteInfo.imageMd5
          quotedEmojiMd5 = quoteInfo.emojiMd5
          quotedEmojiCdnUrl = quoteInfo.emojiCdnUrl
        }

        let fileName: string | undefined
        let fileSize: number | undefined
        let fileExt: string | undefined
        let fileMd5: string | undefined
        if (localType === 49 && content) {
          const fileInfo = parseFileInfo(content)
          fileName = fileInfo.fileName
          fileSize = fileInfo.fileSize
          fileExt = fileInfo.fileExt
          fileMd5 = fileInfo.fileMd5
        }

        let chatRecordList: ChatRecordItem[] | undefined
        if (content) {
          const xmlType = extractXmlValue(content, 'type')
          if (xmlType === '19' || localType === 49) {
            chatRecordList = parseChatHistory(content)
          }
        }

        let transferPayerUsername: string | undefined
        let transferReceiverUsername: string | undefined
        if ((localType === 49 || localType === 8589934592049) && content) {
          const xmlType = extractXmlValue(content, 'type')
          if (xmlType === '2000') {
            transferPayerUsername = extractXmlValue(content, 'payer_username') || undefined
            transferReceiverUsername = extractXmlValue(content, 'receiver_username') || undefined
          }
        }

        return {
          success: true,
          message: {
            localId: row.local_id || 0,
            serverId: row.server_id || 0,
            localType,
            createTime: row.create_time || 0,
            sortSeq: row.sort_seq || 0,
            isSend,
            senderUsername: row.sender_username || null,
            parsedContent: parseMessageContent(content, localType),
            rawContent: content,
            emojiCdnUrl,
            emojiMd5,
            productId: emojiProductId,
            quotedContent,
            quotedSender,
            quotedImageMd5,
            quotedEmojiMd5,
            quotedEmojiCdnUrl,
            imageMd5,
            imageDatName,
            isLivePhoto,
            videoMd5,
            videoDuration,
            voiceDuration,
            fileName,
            fileSize,
            fileExt,
            fileMd5,
            chatRecordList,
            transferPayerUsername,
            transferReceiverUsername
          }
        }
      }
    } catch (e) {
      // 忽略单个表查询错误
    }
  }

  return { success: false, error: 'Message not found' }
}

/**
 * 从指定消息库/表读取消息。
 * randomMomentService 会先在具体表中抽样；这里必须用同一张表还原，避免 local_id 跨库/跨表重复导致消息和会话错配。
 */
export async function getMessageByLocalIdFromTable(
  state: ChatServiceState,
  sessionId: string,
  localId: number,
  tableName: string,
  dbPath: string
): Promise<{ success: boolean; message?: Message; error?: string }> {
  try {
    const hasName2IdTable = await checkTableExists(state, dbPath, 'Name2Id')
    const myWxid = state.configService.get('myWxid')
    const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''
    const myRowId = await resolveMyRowId(state, dbPath, myWxid, cleanedMyWxid, hasName2IdTable)
    const qTable = quoteIdent(tableName)

    let row: any
    if (hasName2IdTable && myRowId !== null) {
      row = await dbAdapter.get<any>(
        'message',
        dbPath,
        `SELECT m.*,
                CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                n.user_name AS sender_username
         FROM ${qTable} m
         LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
         WHERE m.local_id = ?`,
        [myRowId, localId]
      )
    } else if (hasName2IdTable) {
      row = await dbAdapter.get<any>(
        'message',
        dbPath,
        `SELECT m.*, n.user_name AS sender_username
         FROM ${qTable} m
         LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
         WHERE m.local_id = ?`,
        [localId]
      )
    } else {
      row = await dbAdapter.get<any>(
        'message',
        dbPath,
        `SELECT * FROM ${qTable} WHERE local_id = ?`,
        [localId]
      )
    }

    if (!row) {
      return { success: false, error: 'Message not found' }
    }

    const message = rowToMessage(state, row)
    if (!isMessageVisibleForSession(sessionId, message)) {
      return { success: false, error: 'Message does not belong to session' }
    }

    return { success: true, message }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

/**
 * 获取图片数据（base64）。
 * 与 WeFlow 一致，作为聊天页图片渲染的 localId 兜底通道。
 */
export async function getImageData(state: ChatServiceState, sessionId: string, msgId: string, createTime?: number): Promise<{ success: boolean; data?: string; error?: string }> {
  try {
    const localId = parseInt(msgId, 10)
    if (isNaN(localId)) {
      return { success: false, error: '无效的消息ID' }
    }

    const msgResult = await getMessageByLocalId(state, sessionId, localId)
    if (!msgResult.success || !msgResult.message) {
      return { success: false, error: '未找到消息' }
    }

    const msg = msgResult.message
    if (msg.localType !== 3) {
      return { success: false, error: '该消息不是图片' }
    }

    const payload = {
      sessionId,
      imageMd5: msg.imageMd5 || undefined,
      imageDatName: msg.imageDatName || String(msg.localId),
      createTime: createTime || msg.createTime,
      force: false,
      quick: true
    }

    let result = await imageDecryptService.resolveCachedImage(payload)
    if (!result.success || !result.localPath) {
      result = await imageDecryptService.decryptImage(payload)
    }

    if (!result.success || !result.localPath) {
      return { success: false, error: result.error || '图片解密失败' }
    }

    if (result.localPath.startsWith('data:')) {
      const base64Data = result.localPath.split(',')[1]
      return base64Data ? { success: true, data: base64Data } : { success: false, error: '图片数据为空' }
    }

    const filePath = result.localPath.startsWith('file:')
      ? fileURLToPath(result.localPath)
      : result.localPath

    if (!fs.existsSync(filePath)) {
      return { success: false, error: '图片缓存文件不存在' }
    }

    const imageData = fs.readFileSync(filePath)
    return { success: true, data: imageData.toString('base64') }
  } catch (e) {
    console.error('ChatService: getImageData 失败:', e)
    return { success: false, error: String(e) }
  }
}

/**
 * 获取语音数据（解码为 WAV base64）
 * 同一秒内可能有多条语音消息，需用 serverId 精确匹配，缺失时按 rowid 顺序映射兜底
 */
export async function getVoiceData(
  state: ChatServiceState,
  sessionId: string,
  msgId: string,
  createTime?: number,
  serverId?: number
): Promise<{ success: boolean; data?: string; error?: string }> {
  try {
    const localId = parseInt(msgId, 10)
    if (isNaN(localId)) {
      return { success: false, error: '无效的消息ID' }
    }

    // 如果未传入 createTime 或 serverId，从数据库读取
    let msgCreateTime = createTime
    let msgServerId = serverId
    if (!msgCreateTime || !msgServerId) {
      const result = await getMessageByLocalId(state, sessionId, localId)
      if (result.success && result.message) {
        if (!msgCreateTime) msgCreateTime = result.message.createTime
        if (!msgServerId) msgServerId = result.message.serverId
      }
    }

    if (!msgCreateTime) {
      return { success: false, error: '未找到消息时间戳' }
    }

    // 查找 media 数据库
    const mediaDbs = findMediaDbs()

    if (mediaDbs.length === 0) {
      return { success: false, error: '未找到媒体数据库' }
    }

    // 构建查找候选：sessionId, myWxid
    const candidates: string[] = []
    if (sessionId) candidates.push(sessionId)
    const myWxid = state.configService.get('myWxid')
    if (myWxid && !candidates.includes(myWxid)) {
      candidates.push(myWxid)
    }

    // 同时间戳冲突时使用的相对索引：在 MSG_x 中同 createTime 的所有语音消息按 local_id 升序后，当前消息所在位置
    let sameTimeIndex: number | null = null
    const getSameTimeIndex = async (): Promise<number> => {
      if (sameTimeIndex !== null) return sameTimeIndex
      try {
        const dbTablePairs = await findSessionTables(state, sessionId)
        const allLocalIds: number[] = []
        for (const { tableName, dbPath } of dbTablePairs) {
          try {
            const rows = await dbAdapter.all<any>(
              'message', dbPath,
              `SELECT * FROM ${tableName} WHERE create_time = ?`,
              [msgCreateTime]
            )
            for (const r of rows) {
              if (resolveMessageLocalType(r, 1) !== 34) continue
              const lid = coerceRowNumber(getRowField(r, ['local_id', 'localId', 'id', 'ID']), 0)
              if (lid > 0) allLocalIds.push(lid)
            }
          } catch { }
        }
        const uniqueSorted = Array.from(new Set(allLocalIds)).sort((a, b) => a - b)
        const idx = uniqueSorted.indexOf(localId)
        sameTimeIndex = idx >= 0 ? idx : 0
      } catch {
        sameTimeIndex = 0
      }
      return sameTimeIndex
    }

    // 在 media 数据库中查找语音数据
    let silkData: Buffer | null = null

    for (const dbPath of mediaDbs) {
      try {
        // 查找 VoiceInfo 表
        const tables = await dbAdapter.all<any>(
          'message',
          dbPath,
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'VoiceInfo%'"
        )

        if (tables.length === 0) {
          continue
        }

        const voiceTable = tables[0].name

        // 获取表结构
        const columns = await dbAdapter.all<any>('message', dbPath, `PRAGMA table_info('${voiceTable}')`)
        const columnNames = columns.map((c: any) => c.name.toLowerCase())

        // 找到数据列
        const dataColumn = columnNames.find((c: string) =>
          c === 'voice_data' || c === 'buf' || c === 'voicebuf' || c === 'data'
        )
        if (!dataColumn) {
          continue
        }

        // 找到 chat_name_id 列
        const chatNameIdColumn = columnNames.find((c: string) =>
          c === 'chat_name_id' || c === 'chatnameid' || c === 'chat_nameid'
        )

        // 找到时间列
        const timeColumn = columnNames.find((c: string) =>
          c === 'create_time' || c === 'createtime' || c === 'time'
        )

        // 找到 svr_id 列（用于精确匹配，避免同时间戳冲突）
        const svrIdColumn = columnNames.find((c: string) =>
          c === 'msg_svr_id' || c === 'msgsvrid' || c === 'svr_id' || c === 'svrid' ||
          c === 'server_id' || c === 'serverid'
        )

        // 查找 Name2Id 表
        const name2IdTables = await dbAdapter.all<any>(
          'message',
          dbPath,
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Name2Id%'"
        )
        const name2IdTable = name2IdTables.length > 0 ? name2IdTables[0].name : null

        // 策略 A: 用 svr_id 精确匹配（同时间戳消息也能区分）
        if (svrIdColumn && msgServerId && msgServerId > 0) {
          if (chatNameIdColumn && name2IdTable) {
            for (const candidate of candidates) {
              const n2i = await dbAdapter.get<any>(
                'message', dbPath,
                `SELECT rowid FROM ${name2IdTable} WHERE user_name = ?`,
                [candidate]
              )
              if (!n2i?.rowid) continue
              const sql = `SELECT ${dataColumn} AS data FROM ${voiceTable} WHERE ${chatNameIdColumn} = ? AND ${svrIdColumn} = ? LIMIT 1`
              const row = await dbAdapter.get<any>('message', dbPath, sql, [n2i.rowid, msgServerId])
              if (row?.data) {
                silkData = decodeVoiceBlob(row.data)
                if (silkData) break
              }
            }
          }
          if (!silkData) {
            const sql = `SELECT ${dataColumn} AS data FROM ${voiceTable} WHERE ${svrIdColumn} = ? LIMIT 1`
            const row = await dbAdapter.get<any>('message', dbPath, sql, [msgServerId])
            if (row?.data) {
              silkData = decodeVoiceBlob(row.data)
            }
          }
        }

        // 策略 B: chat_name_id + create_time 按 rowid 顺序映射（兼容无 svr_id 列的旧表）
        if (!silkData && chatNameIdColumn && timeColumn && name2IdTable) {
          for (const candidate of candidates) {
            const name2IdRow = await dbAdapter.get<any>(
              'message',
              dbPath,
              `SELECT rowid FROM ${name2IdTable} WHERE user_name = ?`,
              [candidate]
            )

            if (!name2IdRow?.rowid) {
              continue
            }

            const chatNameId = name2IdRow.rowid

            const rows = await dbAdapter.all<any>(
              'message', dbPath,
              `SELECT ${dataColumn} AS data FROM ${voiceTable} WHERE ${chatNameIdColumn} = ? AND ${timeColumn} = ? ORDER BY rowid ASC`,
              [chatNameId, msgCreateTime]
            )

            if (rows.length === 0) continue
            if (rows.length === 1) {
              silkData = decodeVoiceBlob(rows[0].data)
              if (silkData) break
              continue
            }
            const idx = await getSameTimeIndex()
            const pick = rows[Math.min(idx, rows.length - 1)]
            if (pick?.data) {
              silkData = decodeVoiceBlob(pick.data)
              if (silkData) break
            }
          }
        }

        // 策略 C: 仅 create_time 兜底，同样按 rowid 顺序处理多条
        if (!silkData && timeColumn) {
          const rows = await dbAdapter.all<any>(
            'message', dbPath,
            `SELECT ${dataColumn} AS data FROM ${voiceTable} WHERE ${timeColumn} = ? ORDER BY rowid ASC`,
            [msgCreateTime]
          )
          if (rows.length === 1) {
            silkData = decodeVoiceBlob(rows[0].data)
          } else if (rows.length > 1) {
            const idx = await getSameTimeIndex()
            const pick = rows[Math.min(idx, rows.length - 1)]
            if (pick?.data) silkData = decodeVoiceBlob(pick.data)
          }
        }

        if (silkData) break
      } catch (e) {
        // 忽略单个数据库打开失败
      }
    }

    if (!silkData) {
      return { success: false, error: '未找到语音数据' }
    }

    // 使用 silk-wasm 解码
    try {
      const pcmData = await decodeSilkToPcm(silkData, 24000)
      if (!pcmData) {
        return { success: false, error: 'Silk 解码失败' }
      }

      // PCM -> WAV
      const wavData = createWavBuffer(pcmData, 24000)

      return { success: true, data: wavData.toString('base64') }
    } catch (e) {
      return { success: false, error: '语音解码失败: ' + String(e) }
    }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

/**
 * 解码语音 Blob 数据
 */
export function decodeVoiceBlob(raw: any): Buffer | null {
  if (!raw) return null
  if (Buffer.isBuffer(raw)) return raw
  if (raw instanceof Uint8Array) return Buffer.from(raw)
  if (Array.isArray(raw)) return Buffer.from(raw)
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    // 尝试 hex 解码
    if (/^[a-fA-F0-9]+$/.test(trimmed) && trimmed.length % 2 === 0) {
      try {
        return Buffer.from(trimmed, 'hex')
      } catch { }
    }
    // 尝试 base64 解码
    try {
      return Buffer.from(trimmed, 'base64')
    } catch { }
  }
  if (typeof raw === 'object' && Array.isArray(raw.data)) {
    return Buffer.from(raw.data)
  }
  return null
}

/**
 * 解码 Silk 数据为 PCM
 * 使用 silk-wasm（纯 JS/WASM）
 */
export async function decodeSilkToPcm(silkData: Buffer, sampleRate: number): Promise<Buffer | null> {
  try {
    // 找到 silk-wasm 的 WASM 文件
    let wasmPath: string

    if (isElectronPackaged()) {
      // 打包后，WASM 文件在 app.asar.unpacked 中
      wasmPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'silk-wasm', 'lib', 'silk.wasm')
      if (!fs.existsSync(wasmPath)) {
        wasmPath = path.join(process.resourcesPath, 'node_modules', 'silk-wasm', 'lib', 'silk.wasm')
      }
    } else {
      // 开发环境
      wasmPath = path.join(getAppPath(), 'node_modules', 'silk-wasm', 'lib', 'silk.wasm')
    }

    if (!fs.existsSync(wasmPath)) {
      return null
    }

    const silkWasm = require('silk-wasm')
    const result = await silkWasm.decode(silkData, sampleRate)

    return Buffer.from(result.data)
  } catch (e) {
    return null
  }
}


/**
 * 创建 WAV 文件 Buffer
 */
export function createWavBuffer(pcmData: Buffer, sampleRate: number = 24000, channels: number = 1): Buffer {
  const pcmLength = pcmData.length
  const header = Buffer.alloc(44)

  // RIFF header
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcmLength, 4)
  header.write('WAVE', 8)

  // fmt chunk
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)           // chunk size
  header.writeUInt16LE(1, 20)            // audio format (PCM)
  header.writeUInt16LE(channels, 22)     // channels
  header.writeUInt32LE(sampleRate, 24)   // sample rate
  header.writeUInt32LE(sampleRate * channels * 2, 28)  // byte rate
  header.writeUInt16LE(channels * 2, 32) // block align
  header.writeUInt16LE(16, 34)           // bits per sample

  // data chunk
  header.write('data', 36)
  header.writeUInt32LE(pcmLength, 40)

  return Buffer.concat([header, pcmData])
}
