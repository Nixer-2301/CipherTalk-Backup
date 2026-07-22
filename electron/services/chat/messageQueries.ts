import { dbAdapter } from '../dbAdapter'
import { cleanAccountDirName } from './accountUtils'
import { findSessionTables, checkTableExists, resolveMyRowId, refreshMessageDbCache } from './tableResolver'
import {
  rowToMessage,
  normalizeMessagesForUi,
  updateSessionCursorFromPage,
  resolveMessageLocalType,
  resolveRowIsSend,
  isMessageVisibleForSession,
} from './messageMapper'
import { compareMessageCursorAsc, compareMessageCursorDesc, messageIdentityKey } from './types'
import { coerceRowString, decodeMessageContent, extractXmlValue, getRowField } from './rowDecoders'
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
import type { Message, ChatLabSourceMessage, ChatRecordItem } from './types'
import type { ChatServiceState } from './state'

function hasUsableSortSeqCursor(cursorSortSeq: number): boolean {
  const value = Number(cursorSortSeq || 0)
  return Number.isFinite(value) && value > 0
}

/**
 * 获取消息列表（支持跨多个数据库合并，已优化）
 */
export async function getMessages(state: ChatServiceState, 
  sessionId: string,
  offset: number = 0,
  limit: number = 50
): Promise<{ success: boolean; messages?: Message[]; hasMore?: boolean; error?: string }> {
  try {
    // 消费预加载缓存（仅首页且缓存中有该会话）
    if (!offset && state.preloadCache.builtAt > 0 &&
        Date.now() - state.preloadCache.builtAt < state.PRELOAD_CACHE_TTL &&
        state.preloadCache.messages.has(sessionId)) {
      const cached = state.preloadCache.messages.get(sessionId)!
      state.preloadCache.messages.delete(sessionId)
      return cached
    }

    // 获取当前用户的 wxid
    const myWxid = state.configService.get('myWxid')
    const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''

    // 使用缓存查找会话对应的数据库和表
    const dbTablePairs = await findSessionTables(state, sessionId)
    if (dbTablePairs.length === 0) {
      return { success: false, error: '未找到该会话的消息表' }
    }

    // 从所有数据库收集消息
    let allMessages: Message[] = []
    const minFetchPerDb = Math.max(offset + limit + 1, 100)

    for (const { tableName, dbPath } of dbTablePairs) {
      try {
        const hasName2IdTable = await checkTableExists(state, dbPath, 'Name2Id')

        // 获取当前用户的 rowid（使用缓存）
        const myRowId = await resolveMyRowId(state, dbPath, myWxid, cleanedMyWxid, hasName2IdTable)

        // 构造查询 SQL（与原 getPreparedStatement 语义一致）
        let sql: string
        let params: any[]
        if (hasName2IdTable && myRowId !== null) {
          sql = `SELECT m.*,
                 CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                 n.user_name AS sender_username
                 FROM ${tableName} m
                 LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                 ORDER BY m.sort_seq DESC, m.create_time DESC, m.local_id DESC
                 LIMIT ? OFFSET ?`
          params = [myRowId, minFetchPerDb, 0]
        } else if (hasName2IdTable) {
          sql = `SELECT m.*, n.user_name AS sender_username
                 FROM ${tableName} m
                 LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                 ORDER BY m.sort_seq DESC, m.create_time DESC, m.local_id DESC
                 LIMIT ? OFFSET ?`
          params = [minFetchPerDb, 0]
        } else {
          sql = `SELECT * FROM ${tableName} ORDER BY sort_seq DESC, create_time DESC, local_id DESC LIMIT ? OFFSET ?`
          params = [minFetchPerDb, 0]
        }

        const rows = await dbAdapter.all<any>('message', dbPath, sql, params)

        // 批量处理消息
        for (const row of rows) {
          const content = decodeMessageContent(row.message_content, row.compress_content)
          const localType = resolveMessageLocalType(row, 1)
          const isSend = resolveRowIsSend(state, row, row.sender_username || null)

          // 只在需要时解析表情包和引用消息
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

          const parsedContent = parseMessageContent(content, localType)

          allMessages.push({
            localId: row.local_id || 0,
            serverId: row.server_id || 0,
            localType,
            createTime: row.create_time || 0,
            sortSeq: row.sort_seq || 0,
            isSend,
            senderUsername: row.sender_username || null,
            parsedContent,
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
          })
        }
      } catch (e: any) {
        // 检测数据库损坏错误
        if (e?.code === 'SQLITE_CORRUPT' || e?.message?.includes('malformed')) {
          console.error(`[ChatService] 数据库损坏: ${dbPath}`, e)
          // 刷新缓存，强制重新解密
          refreshMessageDbCache(state)
        } else {
          console.error('ChatService: 查询消息失败:', e)
        }
      }
    }

    // 按 sort_seq 降序排序（最新的在前）
    allMessages.sort(compareMessageCursorDesc)

    // 去重（同一条消息可能在多个数据库中）
    const seen = new Set<string>()
    allMessages = allMessages.filter(msg => {
      if (!isMessageVisibleForSession(sessionId, msg)) return false
      const key = messageIdentityKey(msg)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    // 应用 offset 和 limit
    const hasMore = allMessages.length > offset + limit
    const messages = allMessages.slice(offset, offset + limit)

    // 反转使最新消息在最后（UI 显示顺序）
    messages.reverse()

    // 更新增量游标（仅在拉取最新一页时）
    if (offset === 0 && messages.length > 0) {
      const latestMsg = messages[messages.length - 1]
      const currentCursor = state.sessionCursor.get(sessionId) || 0
      if (latestMsg.sortSeq > currentCursor) {
        state.sessionCursor.set(sessionId, latestMsg.sortSeq)
      }
    }

    return { success: true, messages, hasMore }
  } catch (e) {
    console.error('ChatService: 获取消息失败:', e)
    return { success: false, error: String(e) }
  }
}

/**
 * 获取指定时间之后的新消息。
 * （native 游标已移除）直接取最新页并按时间过滤。
 */
export async function getNewMessages(state: ChatServiceState,
  sessionId: string,
  minTime: number,
  limit: number = 1000
): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
  const normalizedMinTime = Number(minTime) > 1e12
    ? Math.floor(Number(minTime) / 1000)
    : Math.max(0, Math.floor(Number(minTime) || 0))
  const normalizedLimit = Math.max(1, Math.min(2000, Math.floor(Number(limit) || 1000)))

  try {
    const fallback = await getMessages(state, sessionId, 0, Math.min(normalizedLimit, 200))
    if (!fallback.success || !fallback.messages) {
      return { success: false, error: fallback.error || '获取新消息失败' }
    }
    return {
      success: true,
      messages: fallback.messages.filter(msg => Number(msg.createTime || 0) >= normalizedMinTime)
    }
  } catch (e) {
    console.error('ChatService: 获取新消息失败:', e)
    return { success: false, error: String(e) }
  }
}

/**
 * 摘要专用：按精确时间范围读取消息，并优先保留范围内最新消息。
 */
export async function getMessagesByTimeRangeForSummary(state: ChatServiceState, 
  sessionId: string,
  options: {
    startTime?: number
    endTime: number
    limit: number
  }
): Promise<{ success: boolean; messages?: Message[]; hasMore?: boolean; error?: string }> {
  try {
    const normalizedLimit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : 50
    const startTime = Number.isFinite(options.startTime) && Number(options.startTime) > 0
      ? Math.floor(Number(options.startTime))
      : undefined
    const endTime = Number.isFinite(options.endTime) && Number(options.endTime) > 0
      ? Math.floor(Number(options.endTime))
      : Math.floor(Date.now() / 1000)

    if (startTime !== undefined && startTime > endTime) {
      return { success: true, messages: [], hasMore: false }
    }

    const myWxid = state.configService.get('myWxid')
    const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''
    const dbTablePairs = await findSessionTables(state, sessionId)

    if (dbTablePairs.length === 0) {
      return { success: false, error: '未找到该会话的消息表' }
    }

    let allMessages: Message[] = []
    const fetchLimitPerDb = normalizedLimit + 1

    for (const { tableName, dbPath } of dbTablePairs) {
      try {
        const hasName2IdTable = await checkTableExists(state, dbPath, 'Name2Id')
        const myRowId = await resolveMyRowId(state, dbPath, myWxid, cleanedMyWxid, hasName2IdTable)

        const whereParts: string[] = []
        const params: Array<number> = []

        if (startTime !== undefined) {
          whereParts.push(hasName2IdTable ? 'm.create_time >= ?' : 'create_time >= ?')
          params.push(startTime)
        }

        whereParts.push(hasName2IdTable ? 'm.create_time <= ?' : 'create_time <= ?')
        params.push(endTime)

        const whereClause = `WHERE ${whereParts.join(' AND ')}`

        let sql: string
        let rows: any[]

        if (hasName2IdTable && myRowId !== null) {
          sql = `SELECT m.*,
                 CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                 n.user_name AS sender_username
                 FROM ${tableName} m
                 LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                 ${whereClause}
                 ORDER BY m.sort_seq DESC, m.create_time DESC, m.local_id DESC
                 LIMIT ?`
          rows = await dbAdapter.all<any>('message', dbPath, sql, [myRowId, ...params, fetchLimitPerDb])
        } else if (hasName2IdTable) {
          sql = `SELECT m.*, n.user_name AS sender_username
                 FROM ${tableName} m
                 LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                 ${whereClause}
                 ORDER BY m.sort_seq DESC, m.create_time DESC, m.local_id DESC
                 LIMIT ?`
          rows = await dbAdapter.all<any>('message', dbPath, sql, [...params, fetchLimitPerDb])
        } else {
          sql = `SELECT *
                 FROM ${tableName}
                 ${whereClause}
                 ORDER BY sort_seq DESC, create_time DESC, local_id DESC
                 LIMIT ?`
          rows = await dbAdapter.all<any>('message', dbPath, sql, [...params, fetchLimitPerDb])
        }

        for (const row of rows) {
          const content = decodeMessageContent(row.message_content, row.compress_content)
          const localType = resolveMessageLocalType(row, 1)
          const isSend = resolveRowIsSend(state, row, row.sender_username || null)
          const parsedContent = parseMessageContent(content, localType)
          const xmlType = content ? extractXmlValue(content, 'type') : undefined
          const chatRecordList = content && (xmlType === '19' || localType === 49)
            ? parseChatHistory(content)
            : undefined

          allMessages.push({
            localId: row.local_id || 0,
            serverId: row.server_id || 0,
            localType,
            createTime: row.create_time || 0,
            sortSeq: row.sort_seq || 0,
            isSend,
            senderUsername: row.sender_username || null,
            parsedContent: parsedContent || '',
            rawContent: content,
            chatRecordList
          })
        }
      } catch (e: any) {
        if (e?.code === 'SQLITE_CORRUPT' || e?.message?.includes('malformed')) {
          console.error(`[ChatService] 摘要查询遇到损坏数据库: ${dbPath}`, e)
          refreshMessageDbCache(state)
        } else {
          console.error('ChatService: 摘要时间范围查询失败:', e)
        }
      }
    }

    allMessages.sort(compareMessageCursorDesc)

    const seen = new Set<string>()
    const uniqueMessages = allMessages.filter((msg) => {
      const key = `${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    const hasMore = uniqueMessages.length > normalizedLimit
    const messages = uniqueMessages.slice(0, normalizedLimit)
    messages.reverse()

    return { success: true, messages, hasMore }
  } catch (e) {
    console.error('ChatService: 摘要时间范围查询失败:', e)
    return { success: false, error: String(e) }
  }
}

/**
 * 基于 sortSeq 游标，获取更早的消息（严格小于 cursorSortSeq）
 */
export async function getMessagesBefore(state: ChatServiceState, 
  sessionId: string,
  cursorSortSeq: number,
  limit: number = 50,
  cursorCreateTime?: number,
  cursorLocalId?: number
): Promise<{ success: boolean; messages?: Message[]; hasMore?: boolean; error?: string }> {
  try {
    const myWxid = state.configService.get('myWxid')
    const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''

    const dbTablePairs = await findSessionTables(state, sessionId)
    if (dbTablePairs.length === 0) {
      return { success: false, error: '未找到该会话的消息表' }
    }

    let allMessages: Message[] = []
    // 每库只多捞 1 行用于判断 hasMore；避免捞 50 行只用 25 行的浪费（解析成本随行数线性）
    const fetchLimitPerDb = limit + 1
    const effectiveCursorCreateTime = cursorCreateTime ?? Number.MAX_SAFE_INTEGER
    const effectiveCursorLocalId = cursorLocalId ?? Number.MAX_SAFE_INTEGER
    const useSortSeqCursor = hasUsableSortSeqCursor(cursorSortSeq)

    for (const { tableName, dbPath } of dbTablePairs) {
      try {
        const hasName2IdTable = await checkTableExists(state, dbPath, 'Name2Id')
        const myRowId = await resolveMyRowId(state, dbPath, myWxid, cleanedMyWxid, hasName2IdTable)

        let sql: string
        let rows: any[]

        if (hasName2IdTable && myRowId !== null) {
          if (useSortSeqCursor) {
            sql = `SELECT m.*,
                   CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                   n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE (
                     m.sort_seq < ?
                     OR (m.sort_seq = ? AND m.create_time < ?)
                     OR (m.sort_seq = ? AND m.create_time = ? AND m.local_id < ?)
                   )
                   ORDER BY m.sort_seq DESC, m.create_time DESC, m.local_id DESC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [
              myRowId,
              cursorSortSeq,
              cursorSortSeq,
              effectiveCursorCreateTime,
              cursorSortSeq,
              effectiveCursorCreateTime,
              effectiveCursorLocalId,
              fetchLimitPerDb
            ])
          } else {
            sql = `SELECT m.*,
                   CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                   n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE (
                     m.create_time < ?
                     OR (m.create_time = ? AND m.local_id < ?)
                   )
                   ORDER BY m.create_time DESC, m.local_id DESC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [
              myRowId,
              effectiveCursorCreateTime,
              effectiveCursorCreateTime,
              effectiveCursorLocalId,
              fetchLimitPerDb
            ])
          }
        } else if (hasName2IdTable) {
          if (useSortSeqCursor) {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE (
                     m.sort_seq < ?
                     OR (m.sort_seq = ? AND m.create_time < ?)
                     OR (m.sort_seq = ? AND m.create_time = ? AND m.local_id < ?)
                   )
                   ORDER BY m.sort_seq DESC, m.create_time DESC, m.local_id DESC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [
              cursorSortSeq,
              cursorSortSeq,
              effectiveCursorCreateTime,
              cursorSortSeq,
              effectiveCursorCreateTime,
              effectiveCursorLocalId,
              fetchLimitPerDb
            ])
          } else {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE (
                     m.create_time < ?
                     OR (m.create_time = ? AND m.local_id < ?)
                   )
                   ORDER BY m.create_time DESC, m.local_id DESC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [
              effectiveCursorCreateTime,
              effectiveCursorCreateTime,
              effectiveCursorLocalId,
              fetchLimitPerDb
            ])
          }
        } else {
          if (useSortSeqCursor) {
            sql = `SELECT * FROM ${tableName}
                   WHERE (
                     sort_seq < ?
                     OR (sort_seq = ? AND create_time < ?)
                     OR (sort_seq = ? AND create_time = ? AND local_id < ?)
                   )
                   ORDER BY sort_seq DESC, create_time DESC, local_id DESC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [
              cursorSortSeq,
              cursorSortSeq,
              effectiveCursorCreateTime,
              cursorSortSeq,
              effectiveCursorCreateTime,
              effectiveCursorLocalId,
              fetchLimitPerDb
            ])
          } else {
            sql = `SELECT * FROM ${tableName}
                   WHERE (
                     create_time < ?
                     OR (create_time = ? AND local_id < ?)
                   )
                   ORDER BY create_time DESC, local_id DESC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [
              effectiveCursorCreateTime,
              effectiveCursorCreateTime,
              effectiveCursorLocalId,
              fetchLimitPerDb
            ])
          }
        }

        for (const row of rows) {
          allMessages.push(rowToMessage(state, row))
        }
      } catch (e: any) {
        if (e?.code === 'SQLITE_CORRUPT' || e?.message?.includes('malformed')) {
          console.error(`[ChatService] 数据库损坏: ${dbPath}`, e)
          refreshMessageDbCache(state)
        } else {
          console.error('ChatService: 查询更早消息失败:', e)
        }
      }
    }

    allMessages.sort(compareMessageCursorDesc)

    const seen = new Set<string>()
    allMessages = allMessages.filter(msg => {
      const key = `${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    const hasMore = allMessages.length > limit
    const messages = allMessages.slice(0, limit)
    messages.reverse()

    return { success: true, messages, hasMore }
  } catch (e) {
    console.error('ChatService: 获取更早消息失败:', e)
    return { success: false, error: String(e) }
  }
}

/**
 * 基于 sortSeq 游标，获取更新的消息（严格大于 cursorSortSeq）
 */
export async function getMessagesAfter(state: ChatServiceState, 
  sessionId: string,
  cursorSortSeq: number,
  limit: number = 50,
  cursorCreateTime?: number,
  cursorLocalId?: number
): Promise<{ success: boolean; messages?: Message[]; hasMore?: boolean; error?: string }> {
  try {
    const myWxid = state.configService.get('myWxid')
    const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''

    const dbTablePairs = await findSessionTables(state, sessionId)
    if (dbTablePairs.length === 0) {
      return { success: false, error: '未找到该会话的消息表' }
    }

    let allMessages: Message[] = []
    // 每库只多捞 1 行用于判断 hasMore（解析成本随行数线性）
    const fetchLimitPerDb = limit + 1
    const effectiveCursorCreateTime = cursorCreateTime ?? Number.MIN_SAFE_INTEGER
    const effectiveCursorLocalId = cursorLocalId ?? Number.MIN_SAFE_INTEGER
    const useSortSeqCursor = hasUsableSortSeqCursor(cursorSortSeq)

    for (const { tableName, dbPath } of dbTablePairs) {
      try {
        const hasName2IdTable = await checkTableExists(state, dbPath, 'Name2Id')
        const myRowId = await resolveMyRowId(state, dbPath, myWxid, cleanedMyWxid, hasName2IdTable)

        let sql: string
        let rows: any[]

        if (hasName2IdTable && myRowId !== null) {
          if (useSortSeqCursor) {
            sql = `SELECT m.*,
                   CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                   n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE (
                     m.sort_seq > ?
                     OR (m.sort_seq = ? AND m.create_time > ?)
                     OR (m.sort_seq = ? AND m.create_time = ? AND m.local_id > ?)
                   )
                   ORDER BY m.sort_seq ASC, m.create_time ASC, m.local_id ASC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [
              myRowId,
              cursorSortSeq,
              cursorSortSeq,
              effectiveCursorCreateTime,
              cursorSortSeq,
              effectiveCursorCreateTime,
              effectiveCursorLocalId,
              fetchLimitPerDb
            ])
          } else {
            sql = `SELECT m.*,
                   CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                   n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE (
                     m.create_time > ?
                     OR (m.create_time = ? AND m.local_id > ?)
                   )
                   ORDER BY m.create_time ASC, m.local_id ASC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [
              myRowId,
              effectiveCursorCreateTime,
              effectiveCursorCreateTime,
              effectiveCursorLocalId,
              fetchLimitPerDb
            ])
          }
        } else if (hasName2IdTable) {
          if (useSortSeqCursor) {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE (
                     m.sort_seq > ?
                     OR (m.sort_seq = ? AND m.create_time > ?)
                     OR (m.sort_seq = ? AND m.create_time = ? AND m.local_id > ?)
                   )
                   ORDER BY m.sort_seq ASC, m.create_time ASC, m.local_id ASC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [
              cursorSortSeq,
              cursorSortSeq,
              effectiveCursorCreateTime,
              cursorSortSeq,
              effectiveCursorCreateTime,
              effectiveCursorLocalId,
              fetchLimitPerDb
            ])
          } else {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE (
                     m.create_time > ?
                     OR (m.create_time = ? AND m.local_id > ?)
                   )
                   ORDER BY m.create_time ASC, m.local_id ASC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [
              effectiveCursorCreateTime,
              effectiveCursorCreateTime,
              effectiveCursorLocalId,
              fetchLimitPerDb
            ])
          }
        } else {
          if (useSortSeqCursor) {
            sql = `SELECT * FROM ${tableName}
                   WHERE (
                     sort_seq > ?
                     OR (sort_seq = ? AND create_time > ?)
                     OR (sort_seq = ? AND create_time = ? AND local_id > ?)
                   )
                   ORDER BY sort_seq ASC, create_time ASC, local_id ASC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [
              cursorSortSeq,
              cursorSortSeq,
              effectiveCursorCreateTime,
              cursorSortSeq,
              effectiveCursorCreateTime,
              effectiveCursorLocalId,
              fetchLimitPerDb
            ])
          } else {
            sql = `SELECT * FROM ${tableName}
                   WHERE (
                     create_time > ?
                     OR (create_time = ? AND local_id > ?)
                   )
                   ORDER BY create_time ASC, local_id ASC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [
              effectiveCursorCreateTime,
              effectiveCursorCreateTime,
              effectiveCursorLocalId,
              fetchLimitPerDb
            ])
          }
        }

        for (const row of rows) {
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

          const parsedContent = parseMessageContent(content, localType)

          allMessages.push({
            localId: row.local_id || 0,
            serverId: row.server_id || 0,
            localType,
            createTime: row.create_time || 0,
            sortSeq: row.sort_seq || 0,
            isSend,
            senderUsername: row.sender_username || null,
            parsedContent,
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
          })
        }
      } catch (e: any) {
        if (e?.code === 'SQLITE_CORRUPT' || e?.message?.includes('malformed')) {
          console.error(`[ChatService] 数据库损坏: ${dbPath}`, e)
          refreshMessageDbCache(state)
        } else {
          console.error('ChatService: 查询更新消息失败:', e)
        }
      }
    }

    allMessages.sort(compareMessageCursorAsc)

    const seen = new Set<string>()
    allMessages = allMessages.filter(msg => {
      const key = `${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    const hasMore = allMessages.length > limit
    const messages = allMessages.slice(0, limit)

    return { success: true, messages, hasMore }
  } catch (e) {
    console.error('ChatService: 获取更新消息失败:', e)
    return { success: false, error: String(e) }
  }
}

/**
 * ChatLab Pull 轻量消息查询。
 * 只返回协议组装所需的最小字段，避免媒体路径解析和富结构展开。
 */
export async function getMessagesForChatLab(state: ChatServiceState, 
  sessionId: string,
  options?: {
    startTime?: number
    endTime?: number
    watermark?: number
    offset?: number
    limit?: number
  }
): Promise<{ success: boolean; messages?: ChatLabSourceMessage[]; hasMore?: boolean; error?: string }> {
  try {
    const normalizedOffset = Number.isFinite(options?.offset) ? Math.max(0, Math.floor(options?.offset || 0)) : 0
    const normalizedLimit = Number.isFinite(options?.limit) ? Math.max(1, Math.min(500, Math.floor(options?.limit || 100))) : 100
    const startTime = Number.isFinite(options?.startTime) && Number(options?.startTime) > 0
      ? Math.floor(Number(options?.startTime))
      : undefined
    const endTime = Number.isFinite(options?.endTime) && Number(options?.endTime) > 0
      ? Math.floor(Number(options?.endTime))
      : undefined
    const watermark = Number.isFinite(options?.watermark) && Number(options?.watermark) > 0
      ? Math.floor(Number(options?.watermark))
      : undefined
    const effectiveEndTime = endTime !== undefined && watermark !== undefined
      ? Math.min(endTime, watermark)
      : (endTime ?? watermark)

    const myWxid = state.configService.get('myWxid')
    const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''
    const dbTablePairs = await findSessionTables(state, sessionId)

    if (dbTablePairs.length === 0) {
      return { success: false, error: '未找到该会话的消息表' }
    }

    const allMessages: ChatLabSourceMessage[] = []
    const fetchLimitPerDb = Math.max(normalizedOffset + normalizedLimit + 1, 100)

    for (const { tableName, dbPath } of dbTablePairs) {
      try {
        const hasName2IdTable = await checkTableExists(state, dbPath, 'Name2Id')
        const myRowId = await resolveMyRowId(state, dbPath, myWxid, cleanedMyWxid, hasName2IdTable)

        const whereParts: string[] = []
        const params: Array<number> = []

        if (startTime) {
          whereParts.push(hasName2IdTable ? 'm.create_time >= ?' : 'create_time >= ?')
          params.push(startTime)
        }
        if (effectiveEndTime) {
          whereParts.push(hasName2IdTable ? 'm.create_time <= ?' : 'create_time <= ?')
          params.push(effectiveEndTime)
        }

        const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : ''

        let sql: string
        let rows: any[]

        if (hasName2IdTable && myRowId !== null) {
          sql = `SELECT m.*,
                 CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                 n.user_name AS sender_username
                 FROM ${tableName} m
                 LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                 ${whereClause}
                 ORDER BY m.sort_seq ASC, m.create_time ASC, m.local_id ASC
                 LIMIT ?`
          rows = await dbAdapter.all<any>('message', dbPath, sql, [myRowId, ...params, fetchLimitPerDb])
        } else if (hasName2IdTable) {
          sql = `SELECT m.*, n.user_name AS sender_username
                 FROM ${tableName} m
                 LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                 ${whereClause}
                 ORDER BY m.sort_seq ASC, m.create_time ASC, m.local_id ASC
                 LIMIT ?`
          rows = await dbAdapter.all<any>('message', dbPath, sql, [...params, fetchLimitPerDb])
        } else {
          sql = `SELECT *
                 FROM ${tableName}
                 ${whereClause}
                 ORDER BY sort_seq ASC, create_time ASC, local_id ASC
                 LIMIT ?`
          rows = await dbAdapter.all<any>('message', dbPath, sql, [...params, fetchLimitPerDb])
        }

        for (const row of rows) {
          const content = decodeMessageContent(row.message_content, row.compress_content)
          const localType = resolveMessageLocalType(row, 1)
          const isSend = resolveRowIsSend(state, row, row.sender_username || null)
          const parsedContent = parseMessageContent(content, localType)
          const xmlType = content ? extractXmlValue(content, 'type') : undefined
          const chatRecordList = content && (xmlType === '19' || localType === 49)
            ? parseChatHistory(content)
            : undefined

          allMessages.push({
            localId: row.local_id || 0,
            serverId: row.server_id || 0,
            localType,
            createTime: row.create_time || 0,
            sortSeq: row.sort_seq || 0,
            isSend,
            senderUsername: row.sender_username || null,
            parsedContent: parsedContent || '',
            rawContent: content,
            chatRecordList
          })
        }
      } catch (e: any) {
        if (e?.code === 'SQLITE_CORRUPT' || e?.message?.includes('malformed')) {
          console.error(`[ChatService] ChatLab 查询遇到损坏数据库: ${dbPath}`, e)
          refreshMessageDbCache(state)
        } else {
          console.error('ChatService: ChatLab 轻量查询失败:', e)
        }
      }
    }

    allMessages.sort(compareMessageCursorAsc)

    const seen = new Set<string>()
    const uniqueMessages = allMessages.filter((msg) => {
      const key = `${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    const hasMore = uniqueMessages.length > normalizedOffset + normalizedLimit
    const messages = uniqueMessages.slice(normalizedOffset, normalizedOffset + normalizedLimit)

    return { success: true, messages, hasMore }
  } catch (e) {
    console.error('ChatService: ChatLab 轻量查询失败:', e)
    return { success: false, error: String(e) }
  }
}

/**
 * 获取会话的所有语音消息（用于批量转写）
 * 复用 getMessages 的查询逻辑，只查询语音消息类型
 */
export async function getAllVoiceMessages(state: ChatServiceState, 
  sessionId: string
): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
  try {
    const myWxid = state.configService.get('myWxid')
    const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''

    // 使用与 getMessages 相同的方法查找会话对应的表
    const dbTablePairs = await findSessionTables(state, sessionId)
    if (dbTablePairs.length === 0) {
      return { success: false, error: '未找到该会话的消息表' }
    }

    let allVoiceMessages: Message[] = []

    for (const { tableName, dbPath } of dbTablePairs) {
      try {
        const hasName2IdTable = await checkTableExists(state, dbPath, 'Name2Id')
        const myRowId = await resolveMyRowId(state, dbPath, myWxid, cleanedMyWxid, hasName2IdTable)

        // 查询所有语音消息 (localType = 34)
        // 检查表结构
        const columns = await dbAdapter.all<any>('message', dbPath, `PRAGMA table_info('${tableName}')`)
        const columnNames = columns.map((c: any) => c.name.toLowerCase())
        const hasTypeColumn = columnNames.includes('type')
        const hasLocalTypeColumn = columnNames.includes('local_type')

        // 构建 WHERE 条件
        let typeCondition = ''
        if (hasLocalTypeColumn && hasTypeColumn) {
          typeCondition = '(local_type = 34 OR type = 34)'
        } else if (hasLocalTypeColumn) {
          typeCondition = 'local_type = 34'
        } else if (hasTypeColumn) {
          typeCondition = 'type = 34'
        } else {
          console.warn(`[ChatService] 表 ${tableName} 没有 local_type 或 type 列，跳过`)
          continue
        }

        // 构建完整的 SQL 查询
        let sql: string
        let rows: any[]

        if (hasName2IdTable && myRowId !== null) {
          sql = `SELECT m.*,
                 CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                 n.user_name AS sender_username
                 FROM ${tableName} m
                 LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                 WHERE ${typeCondition}
                 ORDER BY m.sort_seq DESC`
          rows = await dbAdapter.all<any>('message', dbPath, sql, [myRowId])
        } else if (hasName2IdTable) {
          sql = `SELECT m.*, n.user_name AS sender_username
                 FROM ${tableName} m
                 LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                 WHERE ${typeCondition}
                 ORDER BY m.sort_seq DESC`
          rows = await dbAdapter.all<any>('message', dbPath, sql)
        } else {
          sql = `SELECT * FROM ${tableName}
                 WHERE ${typeCondition}
                 ORDER BY sort_seq DESC`
          rows = await dbAdapter.all<any>('message', dbPath, sql)
        }

        // 处理查询结果
        for (const row of rows) {
          const content = decodeMessageContent(row.message_content, row.compress_content)
          const localType = resolveMessageLocalType(row, 1)
          const isSend = resolveRowIsSend(state, row, row.sender_username || null)
          const voiceDuration = parseVoiceDuration(content)

          allVoiceMessages.push({
            localId: row.local_id || 0,
            serverId: row.server_id || 0,
            localType,
            createTime: row.create_time || 0,
            sortSeq: row.sort_seq || 0,
            isSend,
            senderUsername: row.sender_username || null,
            parsedContent: '',
            rawContent: content,
            voiceDuration
          })
        }
      } catch (e: any) {
        console.error(`[ChatService] 查询语音消息失败 (${dbPath}):`, e)
      }
    }

    // 按 sort_seq 降序排序
    allVoiceMessages.sort(compareMessageCursorDesc)

    // 去重
    const seen = new Set<string>()
    allVoiceMessages = allVoiceMessages.filter(msg => {
      const key = `${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    console.log(`[ChatService] 共找到 ${allVoiceMessages.length} 条语音消息（去重后）`)

    return { success: true, messages: allVoiceMessages }
  } catch (e) {
    console.error('[ChatService] 获取所有语音消息失败:', e)
    return { success: false, error: String(e) }
  }
}

/**
 * 获取会话的所有图片消息（用于批量解密）
 */
export async function getAllImageMessages(state: ChatServiceState, 
  sessionId: string
): Promise<{ success: boolean; images?: { imageMd5?: string; imageDatName?: string; createTime?: number }[]; error?: string }> {
  try {
    const dbTablePairs = await findSessionTables(state, sessionId)
    if (dbTablePairs.length === 0) {
      return { success: false, error: '未找到该会话的消息表' }
    }

    const images: { imageMd5?: string; imageDatName?: string; createTime?: number }[] = []

    for (const { tableName, dbPath } of dbTablePairs) {
      try {
        const columns = await dbAdapter.all<any>('message', dbPath, `PRAGMA table_info('${tableName}')`)
        const columnNames = columns.map((c: any) => c.name.toLowerCase())
        const hasLocalTypeColumn = columnNames.includes('local_type')
        const hasTypeColumn = columnNames.includes('type')

        let typeCondition = ''
        if (hasLocalTypeColumn && hasTypeColumn) {
          typeCondition = '(local_type = 3 OR type = 3)'
        } else if (hasLocalTypeColumn) {
          typeCondition = 'local_type = 3'
        } else if (hasTypeColumn) {
          typeCondition = 'type = 3'
        } else {
          continue
        }

        const selectCandidates = [
          'message_content',
          'compress_content',
          'create_time',
          'imageMd5',
          'image_md5',
          'md5',
          'MD5',
          'cdnthumbmd5',
          'cdnThumbMd5',
          'thumbfullmd5',
          'thumbFullMd5',
          'fullmd5',
          'fullMd5',
          'imageDatName',
          'image_dat_name',
          'datName',
          'dat_name',
          'fileName',
          'file_name',
          'filename',
          'path',
          'filePath',
          'packed_info_data',
          'packed_info',
          'packedInfoData',
          'packedInfo',
          'PackedInfoData',
          'PackedInfo',
          'packed_info_blob',
          'packedInfoBlob',
          'BytesExtra',
          'bytes_extra',
          'reserved0',
          'Reserved0',
          'WCDB_CT_packed_info_data',
          'WCDB_CT_packed_info',
          'WCDB_CT_PackedInfoData',
          'WCDB_CT_PackedInfo',
          'WCDB_CT_Reserved0'
        ]
        const actualByLower = new Map<string, string>()
        columns.forEach((c: any) => actualByLower.set(String(c.name).toLowerCase(), String(c.name)))
        const selectColumns = Array.from(new Set(
          selectCandidates
            .map(name => actualByLower.get(name.toLowerCase()))
            .filter((name): name is string => Boolean(name))
        ))
        const selectSql = selectColumns.length > 0
          ? selectColumns.map(name => `"${name.replace(/"/g, '""')}"`).join(', ')
          : '*'

        const rows = await dbAdapter.all<any>(
          'message',
          dbPath,
          `SELECT ${selectSql} FROM ${tableName} WHERE ${typeCondition}`
        )

        for (const row of rows) {
          const content = decodeMessageContent(
            getRowField(row, ['message_content', 'messageContent', 'MessageContent']),
            getRowField(row, ['compress_content', 'compressContent', 'CompressContent'])
          )
          const imageInfo = parseImageInfo(content)
          const imageMd5 = coerceRowString(getRowField(row, [
            'imageMd5',
            'image_md5',
            'md5',
            'MD5',
            'cdnthumbmd5',
            'cdnThumbMd5',
            'thumbfullmd5',
            'thumbFullMd5',
            'fullmd5',
            'fullMd5'
          ])) || imageInfo.md5
          const datName = coerceRowString(getRowField(row, [
            'imageDatName',
            'image_dat_name',
            'datName',
            'dat_name',
            'fileName',
            'file_name',
            'filename',
            'path',
            'filePath'
          ])) || parseImageDatNameFromRow(row)
          if (imageMd5 || datName) {
            images.push({
              imageMd5,
              imageDatName: datName,
              createTime: Number(getRowField(row, ['create_time', 'createTime', 'CreateTime'])) || undefined
            })
          }
        }
      } catch (e: any) {
        console.error(`[ChatService] 查询图片消息失败:`, e)
      }
    }

    // 去重
    const seen = new Set<string>()
    const unique = images.filter(img => {
      const key = img.imageMd5 || img.imageDatName || ''
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })

    console.log(`[ChatService] 共找到 ${unique.length} 条图片消息（去重后）`)
    return { success: true, images: unique }
  } catch (e) {
    console.error('[ChatService] 获取所有图片消息失败:', e)
    return { success: false, error: String(e) }
  }
}

/**
 * 根据日期获取消息（用于日期跳转）
 * @param sessionId 会话ID
 * @param targetTimestamp 目标日期的 Unix 时间戳（秒）
 * @param limit 返回消息数量
 * @returns 返回目标日期当天或之后最近的消息列表
 */
export async function getMessagesByDate(state: ChatServiceState, 
  sessionId: string,
  targetTimestamp: number,
  limit: number = 50
): Promise<{ success: boolean; messages?: Message[]; targetIndex?: number; error?: string }> {
  try {
    const myWxid = state.configService.get('myWxid')
    const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''

    const dbTablePairs = await findSessionTables(state, sessionId)
    if (dbTablePairs.length === 0) {
      return { success: false, error: '未找到该会话的消息表' }
    }

    // 计算目标日期的开始时间戳（当天 00:00:00）
    const targetDate = new Date(targetTimestamp * 1000)
    targetDate.setHours(0, 0, 0, 0)
    const dayStartTimestamp = Math.floor(targetDate.getTime() / 1000)

    // 从所有数据库查找目标日期或之后的第一条消息
    let allMessages: Message[] = []

    for (const { tableName, dbPath } of dbTablePairs) {
      try {
        const hasName2IdTable = await checkTableExists(state, dbPath, 'Name2Id')
        const myRowId = await resolveMyRowId(state, dbPath, myWxid, cleanedMyWxid, hasName2IdTable)

        // 查询目标日期或之后的消息，按时间升序获取
        let sql: string
        let rows: any[]

        if (hasName2IdTable && myRowId !== null) {
          sql = `SELECT m.*,
                 CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                 n.user_name AS sender_username
                 FROM ${tableName} m
                 LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                 WHERE m.create_time >= ?
                 ORDER BY m.create_time ASC, m.sort_seq ASC
                 LIMIT ?`
          rows = await dbAdapter.all<any>('message', dbPath, sql, [myRowId, dayStartTimestamp, limit * 2])
        } else if (hasName2IdTable) {
          sql = `SELECT m.*, n.user_name AS sender_username
                 FROM ${tableName} m
                 LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                 WHERE m.create_time >= ?
                 ORDER BY m.create_time ASC, m.sort_seq ASC
                 LIMIT ?`
          rows = await dbAdapter.all<any>('message', dbPath, sql, [dayStartTimestamp, limit * 2])
        } else {
          sql = `SELECT * FROM ${tableName}
                 WHERE create_time >= ?
                 ORDER BY create_time ASC, sort_seq ASC
                 LIMIT ?`
          rows = await dbAdapter.all<any>('message', dbPath, sql, [dayStartTimestamp, limit * 2])
        }

        // 处理消息
        for (const row of rows) {
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

          const parsedContent = parseMessageContent(content, localType)

          allMessages.push({
            localId: row.local_id || 0,
            serverId: row.server_id || 0,
            localType,
            createTime: row.create_time || 0,
            sortSeq: row.sort_seq || 0,
            isSend,
            senderUsername: row.sender_username || null,
            parsedContent,
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
          })
        }
      } catch (e) {
        console.error('ChatService: 按日期查询消息失败:', e)
      }
    }

    // 按时间升序排序
    allMessages.sort((a, b) => a.createTime - b.createTime || a.sortSeq - b.sortSeq)

    // 去重
    const seen = new Set<string>()
    allMessages = allMessages.filter(msg => {
      const key = `${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    // 取前 limit 条
    const messages = allMessages.slice(0, limit)

    if (messages.length === 0) {
      return { success: true, messages: [], targetIndex: -1 }
    }

    return { success: true, messages, targetIndex: 0 }
  } catch (e) {
    console.error('ChatService: 按日期获取消息失败:', e)
    return { success: false, error: String(e) }
  }
}

/**
 * 获取指定月份中有消息的日期列表
 * @param sessionId 会话ID
 * @param year 年份
 * @param month 月份 (1-12)
 * @returns 有消息的日期字符串列表 (YYYY-MM-DD)
 */
export async function getDatesWithMessages(state: ChatServiceState, 
  sessionId: string,
  year: number,
  month: number
): Promise<{ success: boolean; dates?: string[]; error?: string }> {
  try {
    const dbTablePairs = await findSessionTables(state, sessionId)
    if (dbTablePairs.length === 0) {
      return { success: true, dates: [] }
    }

    // 计算该月的起止时间戳
    // 注意：month 参数是 1-12，但 Date 构造函数用 0-11
    const startDate = new Date(year, month - 1, 1, 0, 0, 0)
    const endDate = new Date(year, month, 0, 23, 59, 59, 999) // 下个月第0天即本月最后一天

    const startTimestamp = Math.floor(startDate.getTime() / 1000)
    const endTimestamp = Math.floor(endDate.getTime() / 1000)

    const datesSet = new Set<string>()

    for (const { tableName, dbPath } of dbTablePairs) {
      try {
        // 只查询 create_time 字段以优化性能
        const sql = `SELECT create_time FROM ${tableName}
                     WHERE create_time BETWEEN ? AND ?`

        const rows = await dbAdapter.all<{ create_time: number }>('message', dbPath, sql, [startTimestamp, endTimestamp])

        for (const row of rows) {
          const date = new Date(row.create_time * 1000)
          const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
          datesSet.add(dateStr)
        }
      } catch (e) {
        console.error(`ChatService: 查询表 ${tableName} 日期失败`, e)
      }
    }

    // 排序
    const sortedDates = Array.from(datesSet).sort()

    return { success: true, dates: sortedDates }
  } catch (e) {
    console.error('ChatService: 获取有消息的日期失败:', e)
    return { success: false, error: String(e) }
  }
}
