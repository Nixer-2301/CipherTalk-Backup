import type { ChatRecordItem } from './types'
import {
  cleanString,
  cleanSystemMessage,
  decodeHtmlEntities,
  decodePackedInfo,
  extractXmlAttribute,
  extractXmlValue,
  getRowField,
  looksLikeWxid,
  stripSenderPrefix,
} from './rowDecoders'

export function getMessageTypeLabel(localType: number): string {
  const labels: Record<number, string> = {
    1: '[文本]',
    3: '[图片]',
    34: '[语音]',
    42: '[名片]',
    43: '[视频]',
    47: '[表情]',
    48: '[位置]',
    49: '[链接]',
    50: '[通话]',
    10000: '[系统消息]'
  }
  return labels[localType] || '[消息]'
}

export function parseVoipMessage(content: string): string {
  const msg = extractXmlValue(content, 'msg')
  return msg || '通话'
}

export function parseType49(content: string, rawContent: string = content): string {
  // title / type 可能被「正文里粘贴的 XML」污染（内层自带 <title>/<type>）。
  // 必须在未解码的原始内容上提取：此时内层标签仍是 &lt;title&gt; 转义态，
  // 非贪婪正则不会误命中内层闭合标签，提取后再对 title 单独解码。
  const title = decodeHtmlEntities(extractXmlValue(rawContent, 'title'))
  const type = extractXmlValue(rawContent, 'type')

  // 群公告消息（type 87）特殊处理
  if (type === '87') {
    const textAnnouncement = extractXmlValue(content, 'textannouncement')
    if (textAnnouncement) {
      return `[群公告] ${textAnnouncement}`
    }
    return '[群公告]'
  }

  // 转账消息特殊处理
  if (type === '2000') {
    const feedesc = extractXmlValue(content, 'feedesc')
    const payMemo = extractXmlValue(content, 'pay_memo')
    if (feedesc) {
      return payMemo ? `[转账] ${feedesc} ${payMemo}` : `[转账] ${feedesc}`
    }
    return '[转账]'
  }

  // 红包消息
  if (type === '2001') {
    const greeting = extractXmlValue(content, 'receivertitle') || extractXmlValue(content, 'sendertitle')
    return greeting ? `[红包] ${greeting}` : '[红包]'
  }

  // 微信礼物
  if (type === '115') {
    const wish = extractXmlValue(content, 'wishmessage')
    const skutitle = extractXmlValue(content, 'skutitle')
    return skutitle ? `[微信礼物] ${wish || '送你一份心意'} - ${skutitle}` : `[微信礼物] ${wish || '送你一份心意'}`
  }

  // 音乐分享
  if (type === '3') {
    const des = extractXmlValue(content, 'des')
    return title ? `[音乐] ${title}${des ? ` - ${des}` : ''}` : '[音乐]'
  }

  if (title) {
    switch (type) {
      case '5':
      case '49':
        return `[链接] ${title}`
      case '6':
        return `[文件] ${title}`
      case '19':
        return `[聊天记录] ${title}`
      case '33':
      case '36':
        return `[小程序] ${title}`
      case '57':
        // 引用消息，title 就是回复的内容
        return title
      default:
        return title
    }
  }
  return '[消息]'
}

export function parseMessageContent(content: string, localType: number): string {
  if (!content) {
    return getMessageTypeLabel(localType)
  }

  // 尝试解码 Buffer
  if (Buffer.isBuffer(content)) {
    content = content.toString('utf-8')
  }

  // 保留未解码内容：appmsg 的 title/type 可能被正文内嵌的转义 XML 污染，
  // 需在解码前提取（见 parseType49）。
  const rawContent = content
  content = decodeHtmlEntities(content)

  // 检查 XML type，用于识别引用消息等（从未解码内容提取，避免内嵌 XML 污染）
  const xmlType = extractXmlValue(rawContent, 'type')

  switch (localType) {
    case 1:
      return stripSenderPrefix(content)
    case 3:
      return '[图片]'
    case 34:
      return '[语音消息]'
    case 42: {
      const nickname = content.match(/nickname="([^"]*)"/)?.[1]
      return nickname ? `[名片] ${nickname}` : '[名片]'
    }
    case 43:
      return '[视频]'
    case 47:
      return '[动画表情]'
    case 48: {
      const poiname = content.match(/poiname="([^"]*)"/)?.[1]
      const label = content.match(/label="([^"]*)"/)?.[1]
      return poiname ? `[位置] ${poiname}` : label ? `[位置] ${label}` : '[位置]'
    }
    case 49:
      return parseType49(content, rawContent)
    case 50:
      return parseVoipMessage(content)
    case 10000:
      return cleanSystemMessage(content)
    case 244813135921:
      // 引用消息，提取 title（从未解码内容提取后再解码，避免内嵌 XML 污染）
      const title = decodeHtmlEntities(extractXmlValue(rawContent, 'title'))
      return title || '[引用消息]'
    default:
      // 对于未知的 localType，检查 XML type 来判断消息类型
      if (xmlType) {
        // type=87 群公告消息
        if (xmlType === '87') {
          const textAnnouncement = extractXmlValue(content, 'textannouncement')
          if (textAnnouncement) {
            return `[群公告] ${textAnnouncement}`
          }
          return '[群公告]'
        }
        // 如果有 XML type，尝试按 type 49 的逻辑解析
        if (xmlType === '2000' || xmlType === '5' || xmlType === '6' || xmlType === '19' ||
            xmlType === '33' || xmlType === '36' || xmlType === '49' || xmlType === '57') {
          return parseType49(content, rawContent)
        }
        // type=57 的引用消息
        if (xmlType === '57') {
          const title = decodeHtmlEntities(extractXmlValue(rawContent, 'title'))
          return title || '[引用消息]'
        }
      }
      // 其他情况
      if (content.length > 200) {
        return getMessageTypeLabel(localType)
      }
      return stripSenderPrefix(content) || getMessageTypeLabel(localType)
  }
}

/**
 * 解析合并转发的聊天记录 (Type 19)
 */
export function parseChatHistory(content: string): ChatRecordItem[] | undefined {
  try {
    const type = extractXmlValue(content, 'type')
    if (type !== '19') return undefined

    // 提取 recorditem 中的 CDATA
    // CDATA 格式: <recorditem><![CDATA[ ... ]]></recorditem>
    const match = /<recorditem>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>[\s\S]*?<\/recorditem>/.exec(content)
    if (!match) return undefined

    const innerXml = match[1]

    const items: ChatRecordItem[] = []
    // 使用更宽松的正则匹配 dataitem
    const itemRegex = /<dataitem\s+(.*?)>([\s\S]*?)<\/dataitem>/g
    let itemMatch

    while ((itemMatch = itemRegex.exec(innerXml)) !== null) {
      const attrs = itemMatch[1]
      const body = itemMatch[2]

      const datatypeMatch = /datatype="(\d+)"/.exec(attrs)
      const datatype = datatypeMatch ? parseInt(datatypeMatch[1]) : 0

      const sourcename = extractXmlValue(body, 'sourcename')
      const sourcetime = extractXmlValue(body, 'sourcetime')
      const sourceheadurl = extractXmlValue(body, 'sourceheadurl')
      const datadesc = extractXmlValue(body, 'datadesc')
      const datatitle = extractXmlValue(body, 'datatitle')
      const fileext = extractXmlValue(body, 'fileext')
      const datasize = parseInt(extractXmlValue(body, 'datasize') || '0')
      const messageuuid = extractXmlValue(body, 'messageuuid')

      // 提取媒体信息
      const dataurl = extractXmlValue(body, 'dataurl')
      const datathumburl = extractXmlValue(body, 'datathumburl') || extractXmlValue(body, 'thumburl')
      const datacdnurl = extractXmlValue(body, 'datacdnurl') || extractXmlValue(body, 'cdnurl')
      const aeskey = extractXmlValue(body, 'aeskey') || extractXmlValue(body, 'qaeskey')
      const md5 = extractXmlValue(body, 'md5') || extractXmlValue(body, 'datamd5')
      const imgheight = parseInt(extractXmlValue(body, 'imgheight') || '0')
      const imgwidth = parseInt(extractXmlValue(body, 'imgwidth') || '0')
      const duration = parseInt(extractXmlValue(body, 'duration') || '0')

      items.push({
        datatype,
        sourcename,
        sourcetime,
        sourceheadurl,
        datadesc: decodeHtmlEntities(datadesc),
        datatitle: decodeHtmlEntities(datatitle),
        fileext,
        datasize,
        messageuuid,
        dataurl: decodeHtmlEntities(dataurl),
        datathumburl: decodeHtmlEntities(datathumburl),
        datacdnurl: decodeHtmlEntities(datacdnurl),
        aeskey: decodeHtmlEntities(aeskey),
        md5,
        imgheight,
        imgwidth,
        duration
      })
    }

    return items.length > 0 ? items : undefined
  } catch (e) {
    console.error('ChatService: 解析聊天记录失败:', e)
    return undefined
  }
}

/**
 * 解析表情包信息
 */
export function parseEmojiInfo(content: string): { cdnUrl?: string; md5?: string; productId?: string } {
  try {
    // 提取 cdnurl (增强正则表达式以适配多种格式)
    let cdnUrl: string | undefined
    const cdnUrlMatch = /cdnurl\s*=\s*['"]([^'"]+)['"]/i.exec(content) || /cdnurl\s*=\s*([^'"]+?)(?=\s|\/|>)/i.exec(content)
    if (cdnUrlMatch) {
      cdnUrl = cdnUrlMatch[1].replace(/&amp;/g, '&')
      if (cdnUrl.includes('%')) {
        try { cdnUrl = decodeURIComponent(cdnUrl) } catch { }
      }
    }

    // 如果没有 cdnurl，尝试 thumburl
    if (!cdnUrl) {
      const thumbUrlMatch = /thumburl\s*=\s*['"]([^'"]+)['"]/i.exec(content) || /thumburl\s*=\s*([^'"]+?)(?=\s|\/|>)/i.exec(content)
      if (thumbUrlMatch) {
        cdnUrl = thumbUrlMatch[1].replace(/&amp;/g, '&')
        if (cdnUrl.includes('%')) {
          try { cdnUrl = decodeURIComponent(cdnUrl) } catch { }
        }
      }
    }

    // 提取 md5 (适配有引号、无引号以及标签形式)
    const md5Match = /md5\s*=\s*['"]([a-fA-F0-9]+)['"]/i.exec(content) ||
      /md5\s*=\s*([a-fA-F0-9]+)/i.exec(content) ||
      /<md5>([^<]+)<\/md5>/i.exec(content)
    const md5 = md5Match ? md5Match[1] : undefined

    // 提取 productid
    const idMatch = /productid\s*=\s*['"]([^'"]+)['"]/i.exec(content) || /productid\s*=\s*([^'"]+?)(?=\s|\/|>)/i.exec(content)
    const productId = idMatch ? idMatch[1] : undefined

    return { cdnUrl, md5, productId }
  } catch (e) {
    console.error('[ChatService] 表情包解析异常:', e)
    return {}
  }
}

/**
 * 解析图片信息
 */
export function parseImageInfo(content: string): { md5?: string; aesKey?: string; isLivePhoto?: boolean } {
  try {
    // 检查是否有实况照片（只要有 <live> 标签就是实况）
    const isLivePhoto = /<live>/i.test(content)

    // 提取图片 md5 时，先去掉 <live> 段避免误匹配
    const contentNoLive = content.replace(/<live>[\s\S]*?<\/live>/gi, '')
    const md5 =
      extractXmlValue(contentNoLive, 'md5') ||
      extractXmlAttribute(contentNoLive, 'img', 'md5') ||
      extractXmlAttribute(contentNoLive, 'img', 'cdnthumbmd5') ||
      extractXmlAttribute(contentNoLive, 'img', 'thumbfullmd5') ||
      extractXmlAttribute(contentNoLive, 'img', 'fullmd5') ||
      undefined
    const aesKey = extractXmlAttribute(content, 'img', 'aeskey') || undefined

    return { md5: md5?.toLowerCase(), aesKey, isLivePhoto: isLivePhoto || undefined }
  } catch {
    return {}
  }
}

/**
 * 解析视频时长
 */
export function parseVideoDuration(content: string): number | undefined {
  if (!content) return undefined
  try {
    const match = /playlength\s*=\s*['"](\d+)['"]/i.exec(content)
    return match ? parseInt(match[1], 10) : undefined
  } catch {
    return undefined
  }
}

export function parseVideoMd5(content: string): string | undefined {
  if (!content) return undefined

  try {
    // 尝试从XML中提取md5
    // 格式可能是: <md5>xxx</md5> 或 md5="xxx"
    const md5 =
      extractXmlValue(content, 'md5') ||
      extractXmlAttribute(content, 'videomsg', 'md5') ||
      extractXmlValue(content, 'newmd5') ||
      extractXmlAttribute(content, 'videomsg', 'newmd5') ||
      extractXmlValue(content, 'rawmd5') ||
      extractXmlAttribute(content, 'videomsg', 'rawmd5') ||
      undefined

    return md5?.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * 解析文件消息信息
 * 从 type=6 的文件消息 XML 中提取文件信息
 */
export function parseFileInfo(content: string): { fileName?: string; fileSize?: number; fileExt?: string; fileMd5?: string } {
  if (!content) return {}

  try {
    // 检查是否是文件消息 (type=6)
    const type = extractXmlValue(content, 'type')
    if (type !== '6') return {}

    // 提取文件名 (title)
    const fileName = extractXmlValue(content, 'title')

    // 提取文件大小 (totallen)
    const totallenStr = extractXmlValue(content, 'totallen')
    const fileSize = totallenStr ? parseInt(totallenStr, 10) : undefined

    // 提取文件扩展名 (fileext)
    const fileExt = extractXmlValue(content, 'fileext')

    // 提取文件 MD5
    const fileMd5 = extractXmlValue(content, 'md5')?.toLowerCase()

    return { fileName, fileSize, fileExt, fileMd5 }
  } catch {
    return {}
  }
}

/**
 * 从数据库行中解析图片 dat 文件名
 */
export function parseImageDatNameFromRow(row: Record<string, any>): string | undefined {
  const packed = getRowField(row, [
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
  ])
  const buffer = decodePackedInfo(packed)
  if (!buffer || buffer.length === 0) return undefined
  const printable: number[] = []
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i]
    if (byte >= 0x20 && byte <= 0x7e) {
      printable.push(byte)
    } else {
      printable.push(0x20)
    }
  }
  const text = Buffer.from(printable).toString('utf-8')
  const match = /([0-9a-fA-F]{8,})(?:\.t)?\.dat/.exec(text)
  if (match?.[1]) return match[1].toLowerCase()
  const hexMatch = /([0-9a-fA-F]{16,})/.exec(text)
  return hexMatch?.[1]?.toLowerCase()
}

/**
 * 清理引用内容中的 wxid
 */
export function sanitizeQuotedContent(content: string): string {
  if (!content) return ''
  let result = content
  // 去掉 wxid_xxx
  result = result.replace(/wxid_[A-Za-z0-9_-]{3,}/g, '')
  // 去掉开头的分隔符
  result = result.replace(/^[\s:：\-]+/, '')
  // 折叠重复分隔符
  result = result.replace(/[:：]{2,}/g, ':')
  result = result.replace(/^[\s:：\-]+/, '')
  // 标准化空白
  result = result.replace(/\s+/g, ' ').trim()
  return result
}

/**
 * 解析引用消息
 */
export function parseQuoteMessage(content: string): { content?: string; sender?: string; imageMd5?: string; emojiMd5?: string; emojiCdnUrl?: string } {
  try {
    // 提取 refermsg 部分
    const referMsgStart = content.indexOf('<refermsg>')
    const referMsgEnd = content.indexOf('</refermsg>')

    if (referMsgStart === -1 || referMsgEnd === -1) {
      return {}
    }

    const referMsgXml = content.substring(referMsgStart, referMsgEnd + 11)

    // 提取发送者名称
    let displayName = extractXmlValue(referMsgXml, 'displayname')
    // 过滤掉 wxid
    if (displayName && looksLikeWxid(displayName)) {
      displayName = ''
    }

    // 提取引用内容并解码
    let referContent = extractXmlValue(referMsgXml, 'content')
    referContent = decodeHtmlEntities(referContent)
    const referType = extractXmlValue(referMsgXml, 'type')
    let imageMd5: string | undefined

    // 根据类型渲染引用内容
    let displayContent = referContent
    switch (referType) {
      case '1':
        // 文本消息，清理可能的 wxid
        displayContent = sanitizeQuotedContent(referContent)
        break
      case '3':
        displayContent = '[图片]'
        // 尝试从引用的内容 XML 中提取图片 MD5（标签或属性）
        const innerMd5 = extractXmlValue(referContent, 'md5') ||
          (referContent.match(/\bmd5="([a-f0-9]+)"/i)?.[1])
        imageMd5 = innerMd5 || undefined
        break
      case '34':
        displayContent = '[语音]'
        break
      case '43':
        displayContent = '[视频]'
        break
      case '47':
        displayContent = '[动画表情]'
        // 提取表情包信息用于引用显示
        const emojiInfo = parseEmojiInfo(referContent)
        return {
          content: displayContent,
          sender: displayName,
          emojiMd5: emojiInfo.md5,
          emojiCdnUrl: emojiInfo.cdnUrl
        }
      case '49':
        const appTitle = extractXmlValue(referContent, 'title')
        displayContent = appTitle || '[链接]'
        break
      case '42':
        displayContent = '[名片]'
        break
      case '48':
        displayContent = '[位置]'
        break
      default:
        if (!referContent || referContent.includes('wxid_')) {
          displayContent = '[消息]'
        } else {
          displayContent = sanitizeQuotedContent(referContent)
        }
    }

    return {
      content: displayContent,
      sender: displayName || undefined,
      imageMd5
    }
  } catch {
    return {}
  }
}

/**
 * 处理会话摘要，如果为空则根据消息类型生成默认摘要
 */
export function processSummary(summary: string, lastMsgType: number): string {
  const cleaned = cleanString(summary)

  // 如果摘要不为空且不是纯空白，直接返回
  if (cleaned && cleaned.trim()) {
    return cleaned
  }

  // 如果摘要为空，根据最后一条消息类型生成默认摘要
  return getMessageTypeLabel(lastMsgType)
}

export function parseVoiceDuration(content: string): number | undefined {
  if (!content) return undefined
  // 匹配 voicelength, length, time, playlength 等字段（毫秒）
  const match = /(voicelength|length|time|playlength)\s*=\s*['"]?([0-9]+(?:\.[0-9]+)?)['"]?/i.exec(content)
  if (!match) return undefined
  const ms = parseFloat(match[2])
  if (isNaN(ms) || ms <= 0) return undefined
  // 转换为秒，保留1位小数
  return Math.round(ms / 100) / 10
}
