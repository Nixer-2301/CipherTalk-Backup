import { cleanAccountDirName } from './accountUtils'
import { compareMessageCursorDesc, messageIdentityKey } from './types'
import type { Message, ChatRecordItem } from './types'
import {
  coerceRowNumber,
  coerceRowString,
  decodeMessageContent,
  extractXmlValue,
  getRowField,
} from './rowDecoders'
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
import type { ChatServiceState } from './state'

export function buildIdentityKeys(raw: string): string[] {
  const value = String(raw || '').trim()
  if (!value) return []
  const lowerRaw = value.toLowerCase()
  const cleaned = cleanAccountDirName(value).toLowerCase()
  return cleaned && cleaned !== lowerRaw ? [cleaned, lowerRaw] : [lowerRaw]
}

export function resolveRowIsSend(state: ChatServiceState, row: any, senderUsername?: string | null): number | null {
  const rawIsSend = row?.is_send ?? row?.isSend ?? row?.is_sender ?? row?.isSender ?? row?.WCDB_CT_is_send ?? null
  const computedIsSend = row?.computed_is_send ?? row?.computedIsSend ?? null
  if (Number(rawIsSend) === 1 || Number(computedIsSend) === 1) return 1

  const senderKeys = buildIdentityKeys(String(senderUsername || row?.sender_username || row?.senderUsername || row?.sender || row?.talker || row?.src || ''))
  const myWxid = String(state.configService.get('myWxid') || '').trim()
  const selfKeys = buildIdentityKeys(myWxid)
  if (senderKeys.length > 0 && selfKeys.length > 0) {
    const matched = senderKeys.some(senderKey =>
      selfKeys.some(selfKey =>
        senderKey === selfKey ||
        senderKey.startsWith(`${selfKey}_`) ||
        selfKey.startsWith(`${senderKey}_`)
      )
    )
    if (matched) return 1
  }

  if (rawIsSend !== null && rawIsSend !== undefined) {
    const parsed = Number(rawIsSend)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (computedIsSend !== null && computedIsSend !== undefined) {
    const parsed = Number(computedIsSend)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function resolveMessageLocalType(row: Record<string, any>, fallback = 1): number {
  const fieldNames = [
    'local_type',
    'localType',
    'type',
    'Type',
    'msg_type',
    'msgType',
    'MsgType',
    'message_type',
    'messageType',
    'WCDB_CT_local_type'
  ]
  let zeroCandidate: number | undefined

  for (const fieldName of fieldNames) {
    const value = getRowField(row, [fieldName])
    if (value === null || value === undefined || value === '') continue
    const parsed = coerceRowNumber(value, Number.NaN)
    if (!Number.isFinite(parsed)) continue
    if (parsed > 0) return parsed
    if (parsed === 0 && zeroCandidate === undefined) {
      zeroCandidate = parsed
    }
  }

  return zeroCandidate ?? fallback
}

export function isMessageVisibleForSession(sessionId: string, msg: Message): boolean {
  const target = String(sessionId || '').trim()
  if (!target) return true
  if (target.includes('@chatroom')) return true
  const sender = String(msg.senderUsername || '').trim()
  if (!sender || sender === target) return true
  if (msg.isSend === 1) return true
  console.warn(`[ChatService] 过滤疑似串会话消息: sessionId=${target}, sender=${sender}, localId=${msg.localId}, createTime=${msg.createTime}`)
  return false
}

export function normalizeMessagesForUi(messages: Message[], sessionId: string, limit?: number): { messages: Message[]; hasExtra: boolean } {
  const seen = new Set<string>()
  const normalized = messages
    .filter(msg => isMessageVisibleForSession(sessionId, msg))
    .sort(compareMessageCursorDesc)
    .filter(msg => {
      const key = messageIdentityKey(msg)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

  const takeLimit = limit && limit > 0 ? limit : normalized.length
  const page = normalized.slice(0, takeLimit).reverse()
  return { messages: page, hasExtra: normalized.length > takeLimit }
}

export function updateSessionCursorFromPage(state: ChatServiceState, sessionId: string, page: Message[]): void {
  if (page.length === 0) return
  const latestMsg = page[page.length - 1]
  const currentCursor = state.sessionCursor.get(sessionId) || 0
  if (latestMsg.sortSeq > currentCursor) {
    state.sessionCursor.set(sessionId, latestMsg.sortSeq)
  }
}

export function rowToMessage(state: ChatServiceState, row: any): Message {
  const content = decodeMessageContent(
    getRowField(row, ['message_content', 'messageContent', 'rawContent', 'raw_content', 'content', 'Content']),
    getRowField(row, ['compress_content', 'compressContent', 'compressedContent', 'CompressContent'])
  )
  const localType = resolveMessageLocalType(row, 1)
  const senderUsername = coerceRowString(
    getRowField(row, ['sender_username', 'senderUsername', 'sender', 'talker', 'src'])
  ) || null
  const isSend = resolveRowIsSend(state, row, senderUsername)

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
    imageMd5 = coerceRowString(getRowField(row, [
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
    imageDatName = coerceRowString(getRowField(row, [
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
    localId: coerceRowNumber(getRowField(row, ['local_id', 'localId', 'id', 'ID']), 0),
    serverId: coerceRowNumber(getRowField(row, ['server_id', 'serverId', 'MsgSvrID', 'msgSvrId']), 0),
    localType,
    createTime: coerceRowNumber(getRowField(row, ['create_time', 'createTime', 'CreateTime']), 0),
    sortSeq: coerceRowNumber(getRowField(row, ['sort_seq', 'sortSeq', 'sequence', 'Sequence']), 0),
    isSend,
    senderUsername,
    parsedContent: coerceRowString(getRowField(row, ['parsedContent', 'parsed_content'])) || parseMessageContent(content, localType),
    rawContent: content,
    emojiCdnUrl: row.emojiCdnUrl || emojiCdnUrl,
    emojiMd5: row.emojiMd5 || emojiMd5,
    productId: row.productId || emojiProductId,
    quotedContent: row.quotedContent || quotedContent,
    quotedSender: row.quotedSender || quotedSender,
    quotedImageMd5: row.quotedImageMd5 || quotedImageMd5,
    quotedEmojiMd5: row.quotedEmojiMd5 || quotedEmojiMd5,
    quotedEmojiCdnUrl: row.quotedEmojiCdnUrl || quotedEmojiCdnUrl,
    imageMd5,
    imageDatName,
    isLivePhoto: row.isLivePhoto ?? isLivePhoto,
    videoMd5: row.videoMd5 || videoMd5,
    videoDuration: row.videoDuration || videoDuration,
    voiceDuration: row.voiceDuration || voiceDuration,
    fileName: row.fileName || fileName,
    fileSize: row.fileSize || fileSize,
    fileExt: row.fileExt || fileExt,
    fileMd5: row.fileMd5 || fileMd5,
    chatRecordList: row.chatRecordList || chatRecordList,
    transferPayerUsername: row.transferPayerUsername || transferPayerUsername,
    transferReceiverUsername: row.transferReceiverUsername || transferReceiverUsername
  }
}
