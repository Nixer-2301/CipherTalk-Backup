import * as fs from 'fs'
import * as path from 'path'
import * as https from 'https'
import * as http from 'http'
import { ConfigService } from './config'
import { voiceTranscribeService } from './voiceTranscribeService'
import * as ExcelJS from 'exceljs'
import { HtmlExportGenerator } from './htmlExportGenerator'
import { imageDecryptService } from './imageDecryptService'
import { videoService } from './videoService'
import { dbAdapter } from './dbAdapter'
import { wcdbService } from './wcdbService'
import { findMessageDbPaths, findDbByName, getDbStoragePath } from './dbStoragePaths'
import { snsService, isVideoUrl, type SnsPost, type SnsShareInfo } from './snsService'
import { parseQuoteMessage } from './chat/contentParsers'

// ChatLab 0.0.2 格式类型定义
export interface ChatLabHeader {
  version: string
  exportedAt: number
  generator: string
  description?: string
}

export interface ChatLabMeta {
  name: string
  platform: string
  type: 'group' | 'private'
  groupId?: string
  groupAvatar?: string
  ownerId?: string
}

export interface MemberRole {
  id: string
  name?: string
}

export interface ChatLabMember {
  platformId: string
  accountName: string
  groupNickname?: string
  avatar?: string
  roles?: MemberRole[]
}

export interface ChatLabMessage {
  sender: string
  accountName: string
  groupNickname?: string
  timestamp: number
  type: number
  content: string | null
  platformMessageId?: string
  replyToMessageId?: string
  chatRecords?: ChatRecordItem[]  // 嵌套的聊天记录
}

export interface ChatRecordItem {
  sender: string
  accountName: string
  timestamp: number
  type: number
  content: string
  avatar?: string
}

export interface ChatLabExport {
  chatlab: ChatLabHeader
  meta: ChatLabMeta
  members: ChatLabMember[]
  messages: ChatLabMessage[]
}

// 消息类型映射：微信 localType -> ChatLab type
// ===== 导出诊断日志 =====
// expStep 只做变量赋值可高频调用；看门狗每 10s 检查，同一步骤停留 >10s 打"疑似卡住"，
// 卡死时日志直接指向具体消息/下载。日志经 utility process stdout 转发到主进程控制台。
let __expStep = ''
let __expStepAt = 0
let __expWatchdog: ReturnType<typeof setInterval> | null = null

function expStep(step: string): void {
  __expStep = step
  __expStepAt = Date.now()
}

function expLog(msg: string): void {
  console.log(`[Export] ${msg}`)
}

function expWatchdogStart(): void {
  if (__expWatchdog) return
  expStep('开始导出')
  __expWatchdog = setInterval(() => {
    const stuckMs = Date.now() - __expStepAt
    if (stuckMs > 10_000) {
      expLog(`⚠ 疑似卡住: "${__expStep}" 已停留 ${Math.round(stuckMs / 1000)}s`)
    }
  }, 10_000)
}

function expWatchdogStop(): void {
  if (__expWatchdog) { clearInterval(__expWatchdog); __expWatchdog = null }
}

const MESSAGE_TYPE_MAP: Record<number, number> = {
  1: 0,      // 文本 -> TEXT
  3: 1,      // 图片 -> IMAGE
  34: 2,     // 语音 -> VOICE
  43: 3,     // 视频 -> VIDEO
  49: 7,     // 链接/文件 -> LINK (需要进一步判断)
  47: 5,     // 表情包 -> EMOJI
  48: 8,     // 位置 -> LOCATION
  42: 27,    // 名片 -> CONTACT
  50: 23,    // 通话 -> CALL
  10000: 80, // 系统消息 -> SYSTEM
}

export interface ExportOptions {
  format: 'chatlab' | 'chatlab-jsonl' | 'json' | 'html' | 'txt' | 'excel' | 'sql'
  dateRange?: { start: number; end: number } | null
  exportMedia?: boolean
  exportAvatars?: boolean
  exportImages?: boolean
  exportVideos?: boolean
  exportEmojis?: boolean
  exportVoices?: boolean
  mediaPathMap?: Map<number, string>
  // 语音独立映射表：同一秒可能存在多条语音，必须按 localId 索引
  voicePathMap?: Map<number, string>
}

export interface ContactExportOptions {
  format: 'json' | 'csv' | 'vcf'
  exportAvatars: boolean
  contactTypes: {
    friends: boolean
    groups: boolean
    officials: boolean
  }
  selectedUsernames?: string[]
}

export interface MomentsExportOptions {
  format: 'json' | 'html' | 'excel'
  dateRange?: { start: number; end: number } | null
  usernames?: string[]
}

export interface MomentExportItem {
  id: string
  username: string
  nickname: string
  createTime: number
  formattedTime: string
  content: string
  media: { type: 'image' | 'video'; url: string; thumb: string }[]
  mediaCount: number
  shareInfo?: SnsShareInfo
  likes: string[]
  likeCount: number
  comments: { nickname: string; content: string; replyTo?: string }[]
  commentCount: number
}

export interface ExportProgress {
  current: number
  total: number
  currentSession: string
  phase: 'preparing' | 'exporting' | 'writing' | 'complete'
  detail?: string
}

class ExportService {
  private configService: ConfigService
  private dbDir: string | null = null
  private contactColumnsCache: { hasBigHeadUrl: boolean; hasSmallHeadUrl: boolean; selectCols: string[] } | null = null
  private contactDbAvailable: boolean = false
  private headImageDbAvailable: boolean = false
  // username -> 联系人信息缓存，避免导出时逐条消息重复查 contact/head_image 库
  private contactInfoCache: Map<string, { displayName: string; avatarUrl?: string }> = new Map()

  constructor() {
    this.configService = new ConfigService()
  }

  private cleanAccountDirName(dirName: string): string {
    const trimmed = dirName.trim()
    if (!trimmed) return trimmed

    // wxid_ 开头的标准格式: wxid_xxx_yyyy -> wxid_xxx
    if (trimmed.toLowerCase().startsWith('wxid_')) {
      const match = trimmed.match(/^(wxid_[a-zA-Z0-9]+)/i)
      if (match) return match[1]
      return trimmed
    }

    // 自定义微信号格式: xxx_yyyy (4位后缀) -> xxx
    const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
    if (suffixMatch) return suffixMatch[1]

    return trimmed
  }

  /**
   * 查找账号对应的实际目录名
   * 支持多种匹配方式以兼容不同版本的目录命名
   */
  // findAccountDir 已被 dbStoragePaths.getDbStoragePath() 取代，不再需要本地实现

  // getDecryptedDbDir 已被 dbStoragePaths.getDbStoragePath() 取代，不再需要本地实现

  async connect(): Promise<{ success: boolean; error?: string }> {
    try {
      const wxid = this.configService.get('myWxid')
      if (!wxid) {
        return { success: false, error: '请先在设置页面配置微信ID' }
      }

      const dbStorage = getDbStoragePath()
      if (!dbStorage) {
        return { success: false, error: '未找到 db_storage 目录，请先配置数据库路径' }
      }
      this.dbDir = dbStorage

      this.contactDbAvailable = !!findDbByName('contact.db')
      this.headImageDbAvailable = !!findDbByName('head_image.db')
      this.contactInfoCache.clear()

      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  close(): void {
    this.dbDir = null
    this.contactColumnsCache = null
    this.contactDbAvailable = false
    this.headImageDbAvailable = false
    this.contactInfoCache.clear()
  }

  private findMessageDbs(): string[] {
    return findMessageDbPaths()
  }

  private getTableNameHash(sessionId: string): string {
    const crypto = require('crypto')
    return crypto.createHash('md5').update(sessionId).digest('hex')
  }

  private async findMessageTable(dbPath: string, sessionId: string): Promise<string | null> {
    try {
      const tables = await dbAdapter.all<any>(
        'message',
        dbPath,
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"
      )
      const hash = this.getTableNameHash(sessionId).toLowerCase()
      // 1. 精确哈希提取匹配（大小写无关）：从表名中提取 32 位 hex 片段后比对
      for (const table of tables) {
        const name = table.name as string
        const hexMatch = name.match(/[0-9a-fA-F]{32}/)
        if (hexMatch && hexMatch[0].toLowerCase() === hash) {
          return name
        }
      }
      // 2. 包含匹配（大小写无关）
      for (const table of tables) {
        const name = table.name as string
        if (name.toLowerCase().includes(hash)) {
          return name
        }
      }
    } catch { }
    // 匹配失败时返回 null，不回退到第一个表（避免数据串）
    return null
  }

  private async findSessionTables(sessionId: string): Promise<{ tableName: string; dbPath: string }[]> {
    const dbs = this.findMessageDbs()
    const result: { tableName: string; dbPath: string }[] = []

    for (const dbPath of dbs) {
      const tableName = await this.findMessageTable(dbPath, sessionId)
      if (tableName) {
        result.push({ tableName, dbPath })
      }
    }
    return result
  }

  /**
   * 快速批量读取消息：keyset 分批、列裁剪、时间下推与内容解码全部在 wcdb 子进程内完成，
   * 主进程每 5000 行收一次已解码的紧凑行（content/localType 已就绪），避免逐批搬运
   * SELECT m.* 的原始大对象。向调用方按 2000 行切片并让出事件循环，保持窗口响应。
   */
  private async *readMessagesFast(
    dbTablePairs: { tableName: string; dbPath: string }[],
    dateRange?: { start: number; end: number } | null,
    extraCols?: string[]
  ): AsyncGenerator<any[]> {
    for (const { tableName, dbPath } of dbTablePairs) {
      try {
        let afterRid = -1
        while (true) {
          // ponytail: 5000/次是队列占用与 IPC 次数的折中——utility 进程按请求串行，
          // 单次 chunk 太大导出期间会饿死聊天界面的 wcdb 查询
          const chunk = await wcdbService.readMessageChunk('message', dbPath, tableName, {
            afterRid,
            maxRows: 5000,
            startTime: dateRange?.start,
            endTime: dateRange?.end,
            extraCols
          })
          if (!chunk.success) throw new Error(chunk.error || '读取消息失败')
          const rows = chunk.rows || []
          for (let i = 0; i < rows.length; i += 2000) {
            yield rows.slice(i, i + 2000)
            await new Promise(resolve => setImmediate(resolve))
          }
          if (chunk.done || typeof chunk.lastRid !== 'number') break
          afterRid = chunk.lastRid
        }
      } catch (e) {
        console.error(`读取消息表 ${tableName} 失败:`, e)
      }
    }
  }

  /**
   * 统计会话消息总数（跨分片，含时间过滤），用于媒体导出进度条的分母。
   * COUNT 走 rowid 主键计数，代价可忽略。
   */
  private async countMessages(
    dbTablePairs: { tableName: string; dbPath: string }[],
    dateRange?: { start: number; end: number } | null
  ): Promise<number> {
    let total = 0
    const where = dateRange
      ? ` WHERE create_time >= ${Math.floor(dateRange.start)} AND create_time <= ${Math.floor(dateRange.end)}`
      : ''
    for (const { tableName, dbPath } of dbTablePairs) {
      try {
        const row = await dbAdapter.get<any>('message', dbPath, `SELECT COUNT(*) AS c FROM ${tableName}${where}`)
        total += Number(row?.c || 0)
      } catch { /* 单表计数失败不影响导出，仅进度分母略偏 */ }
    }
    return total
  }

  /**
   * 获取联系人信息
   */
  private async getContactInfo(username: string): Promise<{ displayName: string; avatarUrl?: string }> {
    const cached = this.contactInfoCache.get(username)
    if (cached) return cached

    if (!this.contactDbAvailable) {
      const fallback = { displayName: username }
      this.contactInfoCache.set(username, fallback)
      return fallback
    }

    try {
      if (!this.contactColumnsCache) {
        const columns = await dbAdapter.all<any>('contact', '', "PRAGMA table_info(contact)")
        const columnNames = columns.map((c: any) => c.name)
        const hasBigHeadUrl = columnNames.includes('big_head_url')
        const hasSmallHeadUrl = columnNames.includes('small_head_url')
        const selectCols = ['username', 'remark', 'nick_name', 'alias']
        if (hasBigHeadUrl) selectCols.push('big_head_url')
        if (hasSmallHeadUrl) selectCols.push('small_head_url')
        this.contactColumnsCache = { hasBigHeadUrl, hasSmallHeadUrl, selectCols }
      }

      const { hasBigHeadUrl, hasSmallHeadUrl, selectCols } = this.contactColumnsCache
      const contact = await dbAdapter.get<any>(
        'contact',
        '',
        `SELECT ${selectCols.join(', ')} FROM contact WHERE username = ?`,
        [username]
      )

      if (contact) {
        const displayName = contact.remark || contact.nick_name || contact.alias || username
        let avatarUrl: string | undefined

        // 优先使用 URL 头像
        if (hasBigHeadUrl && contact.big_head_url) {
          avatarUrl = contact.big_head_url
        } else if (hasSmallHeadUrl && contact.small_head_url) {
          avatarUrl = contact.small_head_url
        }

        // 如果没有 URL 头像，尝试从 head_image.db 获取 base64
        if (!avatarUrl) {
          avatarUrl = await this.getAvatarFromHeadImageDb(username)
        }

        const result = { displayName, avatarUrl }
        this.contactInfoCache.set(username, result)
        return result
      }
    } catch { }
    const fallback = { displayName: username }
    this.contactInfoCache.set(username, fallback)
    return fallback
  }

  /**
   * 从 head_image.db 获取头像（转换为 base64 data URL）
   */
  private async getAvatarFromHeadImageDb(username: string): Promise<string | undefined> {
    if (!this.headImageDbAvailable || !username) return undefined

    try {
      const row = await dbAdapter.get<any>(
        'head_image',
        '',
        'SELECT image_buffer FROM head_image WHERE username = ?',
        [username]
      )

      if (!row || !row.image_buffer) return undefined

      const buffer = Buffer.from(row.image_buffer)
      const base64 = buffer.toString('base64')
      return `data:image/jpeg;base64,${base64}`
    } catch {
      return undefined
    }
  }

  /**
   * 从转账消息 XML 中提取并解析 "谁转账给谁" 描述
   */
  private async resolveTransferDesc(
    content: string,
    myWxid: string,
    groupNicknamesMap: Map<string, string>,
    getContactName: (username: string) => Promise<string>
  ): Promise<string | null> {
    const xmlType = this.extractXmlValue(content, 'type')
    if (xmlType !== '2000') return null

    const payerUsername = this.extractXmlValue(content, 'payer_username')
    const receiverUsername = this.extractXmlValue(content, 'receiver_username')
    if (!payerUsername || !receiverUsername) return null

    const cleanedMyWxid = myWxid ? this.cleanAccountDirName(myWxid) : ''

    const resolveName = async (username: string): Promise<string> => {
      if (myWxid && (username === myWxid || username === cleanedMyWxid)) {
        const groupNick = groupNicknamesMap.get(username) || groupNicknamesMap.get(username.toLowerCase())
        if (groupNick) return groupNick
        return '我'
      }
      const groupNick = groupNicknamesMap.get(username) || groupNicknamesMap.get(username.toLowerCase())
      if (groupNick) return groupNick
      return getContactName(username)
    }

    const [payerName, receiverName] = await Promise.all([
      resolveName(payerUsername),
      resolveName(receiverUsername)
    ])

    return `${payerName} 转账给 ${receiverName}`
  }

  /**
   * 转换微信消息类型到 ChatLab 类型
   */
  private convertMessageType(localType: number, content: string): number {
    // 检查 XML 中的 type 标签（支持大 localType 的情况）
    const xmlTypeText = this.extractXmlValue(content, 'type')
    const xmlType = xmlTypeText ? parseInt(xmlTypeText, 10) : null

    // 特殊处理 type 49 或 XML type
    if (localType === 49 || xmlType) {
      const subType = xmlType || 0
      switch (subType) {
        case 6: return 4   // 文件 -> FILE
        case 19: return 7  // 聊天记录 -> LINK (ChatLab 没有专门的聊天记录类型)
        case 33:
        case 36: return 24 // 小程序 -> SHARE
        case 57: return 25 // 引用回复 -> REPLY
        case 2000: return 99 // 转账 -> OTHER (ChatLab 没有转账类型)
        case 2001: return 99 // 红包 -> OTHER (ChatLab 没有红包类型)
        case 5:
        case 49: return 7  // 链接 -> LINK
        default:
          if (xmlType) return 7 // 有 XML type 但未知，默认为链接
      }
    }
    return MESSAGE_TYPE_MAP[localType] ?? 99 // 未知类型 -> OTHER
  }

  /**
   * 解析消息内容为可读文本
   */
  private parseMessageContent(content: string, localType: number, sessionId?: string, createTime?: number, mediaPathMap?: Map<number, string>, localId?: number, voicePathMap?: Map<number, string>): string | null {
    if (!content) return null

    // 检查 XML 中的 type 标签（支持大 localType 的情况）
    const xmlType = this.extractXmlValue(content, 'type') || null
    const isAppMsgXml = /<appmsg[\s\S]*?>/i.test(content)

    if (xmlType && isAppMsgXml) {
      return this.parseType49(content)
    }

    switch (localType) {
      case 1: // 文本
        return this.stripSenderPrefix(content)
      case 3: {
        // 图片消息：如果有媒体映射表，返回相对路径
        if (mediaPathMap && createTime && mediaPathMap.has(createTime)) {
          return `[图片] ${mediaPathMap.get(createTime)}`
        }
        return '[图片]'
      }
      case 34: {
        // 语音消息：优先用 localId 在 voicePathMap 查找（避免同时间戳冲突）
        const transcript = (sessionId && createTime) ? voiceTranscribeService.getCachedTranscript(sessionId, createTime, localId) : null
        if (voicePathMap && localId && voicePathMap.has(localId)) {
          return `[语音消息] ${voicePathMap.get(localId)}${transcript ? ' ' + transcript : ''}`
        }
        if (mediaPathMap && createTime && mediaPathMap.has(createTime)) {
          return `[语音消息] ${mediaPathMap.get(createTime)}${transcript ? ' ' + transcript : ''}`
        }
        if (transcript) {
          return `[语音消息] ${transcript}`
        }
        return '[语音消息]'
      }
      case 42: {
        const nickname = content.match(/nickname="([^"]*)"/)?.[1]
        return nickname ? `[名片] ${nickname}` : '[名片]'
      }
      case 43: {
        if (mediaPathMap && createTime && mediaPathMap.has(createTime)) {
          return `[视频] ${mediaPathMap.get(createTime)}`
        }
        return '[视频]'
      }
      case 47: {
        if (mediaPathMap && createTime && mediaPathMap.has(createTime)) {
          return `[动画表情] ${mediaPathMap.get(createTime)}`
        }
        // 未导出本地文件时，回退用表情 XML 里的 cdnurl 直接显示（明文直连地址）
        const emojiCdnUrl = content.match(/cdnurl\s*=\s*"([^"]+)"/i)?.[1]
        if (emojiCdnUrl) {
          return `[动画表情] ${this.decodeHtmlEntities(emojiCdnUrl)}`
        }
        return '[动画表情]'
      }
      case 48: {
        const poiname = content.match(/poiname="([^"]*)"/)?.[1]
        const label = content.match(/label="([^"]*)"/)?.[1]
        return poiname ? `[位置] ${poiname}` : label ? `[位置] ${label}` : '[位置]'
      }
      case 49:
        return this.parseType49(content)
      case 50: {
        const msg = this.extractXmlValue(content, 'msg')
        return msg ? `[通话] ${msg}` : '[通话]'
      }
      case 10000: return this.cleanSystemMessage(content)
      case 244813135921: {
        // 引用消息（title 从原始内容提取后解码，避免内嵌 XML 污染并还原可读文本）
        const title = this.decodeHtmlEntities(this.extractXmlValue(content, 'title'))
        return title || '[引用消息]'
      }
      default:
        // 对于未知的 localType，若带 XML type 则按 appmsg（type 49）逻辑解析
        if (xmlType) {
          return this.parseType49(content)
        }
        // 最后尝试提取文本内容
        return this.stripSenderPrefix(content) || null
    }
  }

  /**
   * 解析 appmsg（type 49）消息：转账、红包、礼物、音乐、链接、文件、小程序等
   */
  private parseType49(content: string): string {
    // content 为未解码的原始 XML：title 可能内嵌正文粘贴的转义 XML，
    // 在原始内容上提取可正确命中外层闭合标签，提取后再解码 title 还原可读文本
    const title = this.decodeHtmlEntities(this.extractXmlValue(content, 'title'))
    const type = this.extractXmlValue(content, 'type')

    // 群公告消息（type 87）
    if (type === '87') {
      const textAnnouncement = this.extractXmlValue(content, 'textannouncement')
      return textAnnouncement ? `[群公告] ${textAnnouncement}` : '[群公告]'
    }

    // 转账消息（type 2000）
    if (type === '2000') {
      const feedesc = this.extractXmlValue(content, 'feedesc')
      const payMemo = this.extractXmlValue(content, 'pay_memo')
      if (feedesc) {
        return payMemo ? `[转账] ${feedesc} ${payMemo}` : `[转账] ${feedesc}`
      }
      return '[转账]'
    }

    // 红包消息（type 2001）
    if (type === '2001') {
      const greeting = this.extractXmlValue(content, 'receivertitle') || this.extractXmlValue(content, 'sendertitle')
      return greeting ? `[红包] ${greeting}` : '[红包]'
    }

    // 微信礼物（type 115）
    if (type === '115') {
      const wish = this.extractXmlValue(content, 'wishmessage')
      const skutitle = this.extractXmlValue(content, 'skutitle')
      return skutitle
        ? `[微信礼物] ${wish || '送你一份心意'} - ${skutitle}`
        : `[微信礼物] ${wish || '送你一份心意'}`
    }

    // 音乐分享（type 3）
    if (type === '3') {
      const des = this.extractXmlValue(content, 'des')
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

  private stripSenderPrefix(content: string): string {
    return content.replace(/^[\s]*([a-zA-Z0-9_-]+):(?!\/\/)\s*/, '')
  }

  /**
   * 从撤回消息内容中提取撤回者的 wxid
   * @returns { isRevoke: true, isSelfRevoke: true } - 是自己撤回的消息
   * @returns { isRevoke: true, revokerWxid: string } - 是别人撤回的消息，提取到撤回者
   * @returns { isRevoke: false } - 不是撤回消息
   */
  private extractRevokerInfo(content: string): { isRevoke: boolean; isSelfRevoke?: boolean; revokerWxid?: string } {
    if (!content) return { isRevoke: false }

    // 检查是否是撤回消息
    if (!content.includes('revokemsg') && !content.includes('撤回')) {
      return { isRevoke: false }
    }

    // 检查是否是 "你撤回了" - 自己撤回
    if (content.includes('你撤回')) {
      return { isRevoke: true, isSelfRevoke: true }
    }

    // 尝试从 <session> 标签提取（格式: wxid_xxx）
    const sessionMatch = /<session>([^<]+)<\/session>/i.exec(content)
    if (sessionMatch) {
      const session = sessionMatch[1].trim()
      // 如果 session 是 wxid 格式，返回它
      if (session.startsWith('wxid_') || /^[a-zA-Z][a-zA-Z0-9_-]+$/.test(session)) {
        return { isRevoke: true, revokerWxid: session }
      }
    }

    // 尝试从 <fromusername> 提取
    const fromUserMatch = /<fromusername>([^<]+)<\/fromusername>/i.exec(content)
    if (fromUserMatch) {
      return { isRevoke: true, revokerWxid: fromUserMatch[1].trim() }
    }

    // 是撤回消息但无法提取撤回者
    return { isRevoke: true }
  }

  private extractXmlValue(xml: string, tagName: string): string {
    const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i')
    const match = regex.exec(xml)
    if (match) {
      return match[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim()
    }
    return ''
  }

  private cleanSystemMessage(content: string): string {
    // 移除 XML 声明
    let cleaned = content.replace(/<\?xml[^?]*\?>/gi, '')
    // 移除所有 XML/HTML 标签
    cleaned = cleaned.replace(/<[^>]+>/g, '')
    // 移除尾部的数字（如撤回消息后的时间戳）
    cleaned = cleaned.replace(/\d+\s*$/, '')
    // 清理多余空白
    cleaned = cleaned.replace(/\s+/g, ' ').trim()
    return cleaned || '[系统消息]'
  }

  /**
   * 导出单个会话为 ChatLab 格式
   */
  async exportSessionToChatLab(
    sessionId: string,
    outputPath: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.dbDir) {
        const connectResult = await this.connect()
        if (!connectResult.success) return connectResult
      }

      const myWxid = this.configService.get('myWxid') || ''
      const cleanedMyWxid = this.cleanAccountDirName(myWxid)
      const isGroup = sessionId.includes('@chatroom')

      // 获取会话信息
      const sessionInfo = await this.getContactInfo(sessionId)

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'preparing',
        detail: '正在准备导出...'
      })

      // 查找消息表
      const dbTablePairs = await this.findSessionTables(sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息' }
      }

      // 收集所有消息
      const allMessages: any[] = []
      const memberSet = new Map<string, ChatLabMember>()
      // 群昵称缓存 (platformId -> groupNickname)
      const groupNicknameCache = new Map<string, string>()

      // 读取+解码在 wcdb 子进程内完成（列裁剪/时间下推/keyset 分批），主进程只收紧凑行
      for await (const rows of this.readMessagesFast(dbTablePairs, options.dateRange)) {
          for (const row of rows) {
            const createTime = row.create_time || 0

            // 时间范围过滤
            if (options.dateRange) {
              if (createTime < options.dateRange.start || createTime > options.dateRange.end) {
                continue
              }
            }

            const content = row.content || ''
            const localType = row.localType || 1
            const senderUsername = row.sender_username || ''

            // 判断是否是自己发送
            const isSend = row.is_send === 1 || senderUsername === cleanedMyWxid

            // 确定实际发送者
            let actualSender: string
            if (localType === 10000 || localType === 266287972401) {
              // 系统消息特殊处理
              const revokeInfo = this.extractRevokerInfo(content)
              if (revokeInfo.isRevoke) {
                // 撤回消息
                if (revokeInfo.isSelfRevoke) {
                  // "你撤回了" - 发送者是当前用户
                  actualSender = cleanedMyWxid
                } else if (revokeInfo.revokerWxid) {
                  // 提取到了撤回者的 wxid
                  actualSender = revokeInfo.revokerWxid
                } else {
                  // 无法确定撤回者，使用 sessionId
                  actualSender = sessionId
                }
              } else {
                // 普通系统消息（如"xxx加入群聊"），发送者是群聊ID
                actualSender = sessionId
              }
            } else {
              actualSender = isSend ? cleanedMyWxid : senderUsername
            }

            // 提取消息ID (local_id 或 server_id)
            const platformMessageId = row.server_id ? String(row.server_id) : (row.local_id ? String(row.local_id) : undefined)

            // 提取引用消息ID (从 type 57 的 XML 中解析)
            let replyToMessageId: string | undefined
            if (localType === 49 && content.includes('<type>57</type>')) {
              const svridMatch = /<svrid>(\d+)<\/svrid>/i.exec(content)
              if (svridMatch) {
                replyToMessageId = svridMatch[1]
              }
            }

            // 提取群昵称 (从消息内容中解析)
            let groupNickname: string | undefined
            if (isGroup && actualSender) {
              // 尝试从缓存获取
              if (groupNicknameCache.has(actualSender)) {
                groupNickname = groupNicknameCache.get(actualSender)
              } else {
                // 尝试从消息内容中提取群昵称
                const nicknameFromContent = this.extractGroupNickname(content, actualSender)
                if (nicknameFromContent) {
                  groupNickname = nicknameFromContent
                  groupNicknameCache.set(actualSender, nicknameFromContent)
                }
              }
            }

            // 检查是否是聊天记录消息（type=19）
            const xmlType = this.extractXmlValue(content, 'type')
            let chatRecordList: any[] | undefined
            if (xmlType === '19' || localType === 49) {
              chatRecordList = this.parseChatHistory(content)
            }

            allMessages.push({
              createTime,
              localId: row.local_id,
              localType,
              content,
              senderUsername: actualSender,
              isSend,
              platformMessageId,
              replyToMessageId,
              groupNickname,
              chatRecordList
            })

            // 收集成员信息
            if (actualSender && !memberSet.has(actualSender)) {
              const memberInfo = await this.getContactInfo(actualSender)
              memberSet.set(actualSender, {
                platformId: actualSender,
                accountName: memberInfo.displayName,
                ...(groupNickname && { groupNickname }),
                ...(options.exportAvatars && memberInfo.avatarUrl && { avatar: memberInfo.avatarUrl })
              })
            } else if (actualSender && groupNickname && !memberSet.get(actualSender)?.groupNickname) {
              // 更新已有成员的群昵称
              const existing = memberSet.get(actualSender)!
              memberSet.set(actualSender, { ...existing, groupNickname })
            }
          }
      }

      // 按时间排序
      allMessages.sort((a, b) => a.createTime - b.createTime)

      onProgress?.({
        current: 50,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'exporting',
        detail: '正在读取消息...'
      })

      // 构建 ChatLab 格式消息
      const chatLabMessages: ChatLabMessage[] = []

      let __msgTick = 0
      for (const msg of allMessages) {
        if ((++__msgTick & 0xff) === 0) await new Promise(resolve => setImmediate(resolve))
        const memberInfo = memberSet.get(msg.senderUsername) || { platformId: msg.senderUsername, accountName: msg.senderUsername }
        let parsedContent = this.parseMessageContent(msg.content, msg.localType, sessionId, msg.createTime, options.mediaPathMap, msg.localId, options.voicePathMap)

        // 转账消息：追加 "谁转账给谁" 信息
        if (parsedContent && parsedContent.startsWith('[转账]') && msg.content) {
          const transferDesc = await this.resolveTransferDesc(
            msg.content,
            myWxid,
            new Map<string, string>(),
            async (username) => {
              const info = await this.getContactInfo(username)
              return info.displayName || username
            }
          )
          if (transferDesc) {
            parsedContent = parsedContent.replace('[转账]', `[转账] (${transferDesc})`)
          }
        }

        const message: ChatLabMessage = {
          sender: msg.senderUsername,
          accountName: memberInfo.accountName,
          timestamp: msg.createTime,
          type: this.convertMessageType(msg.localType, msg.content),
          content: parsedContent
        }

        // 添加可选字段
        if (msg.groupNickname) message.groupNickname = msg.groupNickname
        if (msg.platformMessageId) message.platformMessageId = msg.platformMessageId
        if (msg.replyToMessageId) message.replyToMessageId = msg.replyToMessageId

        // 如果有聊天记录，添加为嵌套字段
        if (msg.chatRecordList && msg.chatRecordList.length > 0) {
          const chatRecords: ChatRecordItem[] = []

          for (const record of msg.chatRecordList) {
            // 解析时间戳 (格式: "YYYY-MM-DD HH:MM:SS")
            let recordTimestamp = msg.createTime
            if (record.sourcetime) {
              try {
                const timeParts = record.sourcetime.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/)
                if (timeParts) {
                  const date = new Date(
                    parseInt(timeParts[1]),
                    parseInt(timeParts[2]) - 1,
                    parseInt(timeParts[3]),
                    parseInt(timeParts[4]),
                    parseInt(timeParts[5]),
                    parseInt(timeParts[6])
                  )
                  recordTimestamp = Math.floor(date.getTime() / 1000)
                }
              } catch (e) {
                console.error('解析聊天记录时间失败:', e)
              }
            }

            // 转换消息类型
            let recordType = 0 // TEXT
            let recordContent = record.datadesc || record.datatitle || ''

            switch (record.datatype) {
              case 1:
                recordType = 0 // TEXT
                break
              case 3:
                recordType = 1 // IMAGE
                recordContent = '[图片]'
                break
              case 8:
              case 49:
                recordType = 4 // FILE
                recordContent = record.datatitle ? `[文件] ${record.datatitle}` : '[文件]'
                break
              case 34:
                recordType = 2 // VOICE
                recordContent = '[语音消息]'
                break
              case 43:
                recordType = 3 // VIDEO
                recordContent = '[视频]'
                break
              case 47:
                recordType = 5 // EMOJI
                recordContent = '[动画表情]'
                break
              default:
                recordType = 0
                recordContent = record.datadesc || record.datatitle || '[消息]'
            }

            const chatRecord: ChatRecordItem = {
              sender: record.sourcename || 'unknown',
              accountName: record.sourcename || 'unknown',
              timestamp: recordTimestamp,
              type: recordType,
              content: recordContent
            }

            // 添加头像（如果启用导出头像）
            if (options.exportAvatars && record.sourceheadurl) {
              chatRecord.avatar = record.sourceheadurl
            }

            chatRecords.push(chatRecord)

            // 添加成员信息
            if (record.sourcename && !memberSet.has(record.sourcename)) {
              memberSet.set(record.sourcename, {
                platformId: record.sourcename,
                accountName: record.sourcename,
                ...(options.exportAvatars && record.sourceheadurl && { avatar: record.sourceheadurl })
              })
            }
          }

          message.chatRecords = chatRecords
        }

        chatLabMessages.push(message)
      }

      // 构建 meta
      const meta: ChatLabMeta = {
        name: sessionInfo.displayName,
        platform: 'wechat',
        type: isGroup ? 'group' : 'private',
        ownerId: cleanedMyWxid
      }
      if (isGroup) {
        meta.groupId = sessionId
        // 添加群头像
        if (options.exportAvatars && sessionInfo.avatarUrl) {
          meta.groupAvatar = sessionInfo.avatarUrl
        }
      }

      const chatLabExport: ChatLabExport = {
        chatlab: {
          version: '0.0.2',
          exportedAt: Math.floor(Date.now() / 1000),
          generator: 'CipherTalk'
        },
        meta,
        members: Array.from(memberSet.values()),
        messages: chatLabMessages
      }

      onProgress?.({
        current: 80,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'writing',
        detail: '正在写入文件...'
      })

      // 写入文件
      if (options.format === 'chatlab-jsonl') {
        // JSONL 格式
        const lines: string[] = []
        lines.push(JSON.stringify({
          _type: 'header',
          chatlab: chatLabExport.chatlab,
          meta: chatLabExport.meta
        }))
        for (const member of chatLabExport.members) {
          lines.push(JSON.stringify({ _type: 'member', ...member }))
        }
        for (const message of chatLabExport.messages) {
          lines.push(JSON.stringify({ _type: 'message', ...message }))
        }
        fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8')
      } else {
        // JSON 格式
        fs.writeFileSync(outputPath, JSON.stringify(chatLabExport, null, 2), 'utf-8')
      }

      onProgress?.({
        current: 100,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'complete',
        detail: '导出完成'
      })

      return { success: true }
    } catch (e) {
      console.error('ExportService: 导出失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 从消息内容中提取群昵称
   */
  private extractGroupNickname(content: string, senderUsername: string): string | undefined {
    // 尝试从 msgsource 中提取
    const msgsourceMatch = /<msgsource>[\s\S]*?<\/msgsource>/i.exec(content)
    if (msgsourceMatch) {
      // 提取 <atuserlist> 或其他可能包含昵称的字段
      const displaynameMatch = /<displayname>([^<]+)<\/displayname>/i.exec(msgsourceMatch[0])
      if (displaynameMatch) {
        return displaynameMatch[1]
      }
    }
    return undefined
  }

  /**
   * 解析合并转发的聊天记录 (Type 19)
   */
  private parseChatHistory(content: string): any[] | undefined {
    try {
      const type = this.extractXmlValue(content, 'type')
      if (type !== '19') return undefined

      // 提取 recorditem 中的 CDATA
      const match = /<recorditem>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>[\s\S]*?<\/recorditem>/.exec(content)
      if (!match) return undefined

      const innerXml = match[1]
      const items: any[] = []
      const itemRegex = /<dataitem\s+(.*?)>([\s\S]*?)<\/dataitem>/g
      let itemMatch

      while ((itemMatch = itemRegex.exec(innerXml)) !== null) {
        const attrs = itemMatch[1]
        const body = itemMatch[2]

        const datatypeMatch = /datatype="(\d+)"/.exec(attrs)
        const datatype = datatypeMatch ? parseInt(datatypeMatch[1]) : 0

        const sourcename = this.extractXmlValue(body, 'sourcename')
        const sourcetime = this.extractXmlValue(body, 'sourcetime')
        const sourceheadurl = this.extractXmlValue(body, 'sourceheadurl')
        const datadesc = this.extractXmlValue(body, 'datadesc')
        const datatitle = this.extractXmlValue(body, 'datatitle')
        const fileext = this.extractXmlValue(body, 'fileext')
        const datasize = parseInt(this.extractXmlValue(body, 'datasize') || '0')

        // 过滤红包（2001）和群收款（2002）消息，不在导出中显示
        if (datatype === 2001 || datatype === 2002) continue

        items.push({
          datatype,
          sourcename,
          sourcetime,
          sourceheadurl,
          datadesc: this.decodeHtmlEntities(datadesc),
          datatitle: this.decodeHtmlEntities(datatitle),
          fileext,
          datasize
        })
      }

      return items.length > 0 ? items : undefined
    } catch (e) {
      console.error('ExportService: 解析聊天记录失败:', e)
      return undefined
    }
  }

  /**
   * 解码 HTML 实体
   */
  private decodeHtmlEntities(text: string): string {
    if (!text) return ''
    return text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      // 常见十六进制数字实体
      .replace(/&#x20;/gi, ' ')
      .replace(/&#x0A;/gi, '\n')
      .replace(/&#x09;/gi, '\t')
      .replace(/&#xD;/gi, '\r')
      // 通用十六进制实体 &#xHH;
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      // 通用十进制实体 &#NN;
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
  }

  /**
   * 格式化聊天记录为 JSON 导出格式
   */
  private formatChatRecordsForJson(chatRecordList: any[], options: ExportOptions): any[] {
    return chatRecordList.map(record => {
      // 解析时间戳
      let timestamp = 0
      if (record.sourcetime) {
        try {
          const timeParts = record.sourcetime.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/)
          if (timeParts) {
            const date = new Date(
              parseInt(timeParts[1]),
              parseInt(timeParts[2]) - 1,
              parseInt(timeParts[3]),
              parseInt(timeParts[4]),
              parseInt(timeParts[5]),
              parseInt(timeParts[6])
            )
            timestamp = Math.floor(date.getTime() / 1000)
          }
        } catch (e) {
          console.error('解析聊天记录时间失败:', e)
        }
      }

      // 转换消息类型名称
      let typeName = '文本消息'
      let content = record.datadesc || record.datatitle || ''

      switch (record.datatype) {
        case 1:
          typeName = '文本消息'
          break
        case 3:
          typeName = '图片消息'
          content = '[图片]'
          break
        case 8:
        case 49:
          typeName = '文件消息'
          content = record.datatitle ? `[文件] ${record.datatitle}` : '[文件]'
          break
        case 34:
          typeName = '语音消息'
          content = '[语音消息]'
          break
        case 43:
          typeName = '视频消息'
          content = '[视频]'
          break
        case 47:
          typeName = '动画表情'
          content = '[动画表情]'
          break
        default:
          typeName = '其他消息'
          content = record.datadesc || record.datatitle || '[消息]'
      }

      // 对关键字段进行 HTML 实体解码，防止导出时出现 &#x20; 等转义字符
      content = this.decodeHtmlEntities(content)
      const senderDisplayName = this.decodeHtmlEntities(record.sourcename || 'unknown')
      const formattedTime = this.decodeHtmlEntities(
        timestamp > 0 ? this.formatTimestamp(timestamp) : (record.sourcetime || '')
      )

      const chatRecord: any = {
        sender: record.sourcename || 'unknown',
        senderDisplayName,
        timestamp,
        formattedTime,
        type: typeName,
        datatype: record.datatype,
        content
      }

      // 添加头像
      if (options.exportAvatars && record.sourceheadurl) {
        chatRecord.senderAvatar = record.sourceheadurl
      }

      // 添加文件信息
      if (record.fileext) {
        chatRecord.fileExt = record.fileext
      }
      if (record.datasize > 0) {
        chatRecord.fileSize = record.datasize
      }

      return chatRecord
    })
  }

  /**
   * 从 extra_buffer 中提取手机号
   * 微信的 extra_buffer 是 protobuf 格式的二进制数据
   * 手机号通常存储在特定的 tag 字段中
   */
  private extractPhoneFromExtraBuf(extraBuffer: any): string | undefined {
    if (!extraBuffer) return undefined

    try {
      let data: Buffer
      if (Buffer.isBuffer(extraBuffer)) {
        data = extraBuffer
      } else if (typeof extraBuffer === 'string') {
        // 可能是 hex 或 base64 编码
        if (/^[0-9a-fA-F]+$/.test(extraBuffer)) {
          data = Buffer.from(extraBuffer, 'hex')
        } else {
          data = Buffer.from(extraBuffer, 'base64')
        }
      } else {
        return undefined
      }

      if (data.length === 0) return undefined

      // 方法1: 尝试解析微信的 protobuf-like 格式
      // 微信 extra_buffer 格式: [tag(1byte)][length(1-2bytes)][data]
      // 手机号可能在 tag 0x42 (66) 或其他位置
      const phoneFromProtobuf = this.parseWechatExtraBuffer(data)
      if (phoneFromProtobuf) return phoneFromProtobuf

      // 方法2: 转为字符串尝试匹配
      const str = data.toString('utf-8')

      // 尝试匹配手机号格式（中国大陆手机号）
      const phoneRegex = /1[3-9]\d{9}/g
      const matches = str.match(phoneRegex)
      if (matches && matches.length > 0) {
        return matches[0]
      }

      // 尝试匹配带国际区号的手机号 +86
      const intlRegex = /\+86\s*1[3-9]\d{9}/g
      const intlMatches = str.match(intlRegex)
      if (intlMatches && intlMatches.length > 0) {
        return intlMatches[0].replace(/\s+/g, '')
      }

      // 方法3: 在二进制数据中查找手机号模式
      const hexStr = data.toString('hex')
      // 手机号 ASCII: 31 (1) 后跟 3-9 的数字
      const hexPhoneRegex = /31[33-39][30-39]{9}/gi
      const hexMatches = hexStr.match(hexPhoneRegex)
      if (hexMatches && hexMatches.length > 0) {
        const phone = Buffer.from(hexMatches[0], 'hex').toString('ascii')
        if (/^1[3-9]\d{9}$/.test(phone)) {
          return phone
        }
      }

      // 方法4: 尝试 latin1 编码
      const latin1Str = data.toString('latin1')
      const latin1Matches = latin1Str.match(phoneRegex)
      if (latin1Matches && latin1Matches.length > 0) {
        return latin1Matches[0]
      }
    } catch (e) {
      // 解析失败，忽略
    }

    return undefined
  }

  /**
   * 解析微信 extra_buffer 的 protobuf-like 格式
   * 格式: 连续的 [tag][length][value] 结构
   */
  private parseWechatExtraBuffer(data: Buffer): string | undefined {
    try {
      let offset = 0
      const results: { tag: number; value: string }[] = []

      while (offset < data.length - 2) {
        const tag = data[offset]
        offset++

        // 读取长度 (可能是 1 或 2 字节)
        let length = data[offset]
        offset++

        // 如果长度字节的高位为1，可能是变长编码
        if (length > 127 && offset < data.length) {
          // 简单处理：跳过这个字段
          length = length & 0x7f
        }

        if (length === 0 || offset + length > data.length) {
          // 无效长度，尝试下一个位置
          continue
        }

        // 读取值
        const valueBytes = data.slice(offset, offset + length)
        offset += length

        // 尝试解码为字符串
        const valueStr = valueBytes.toString('utf-8')

        // 检查是否是手机号
        const phoneMatch = valueStr.match(/^1[3-9]\d{9}$/)
        if (phoneMatch) {
          return phoneMatch[0]
        }

        // 检查是否包含手机号
        const containsPhone = valueStr.match(/1[3-9]\d{9}/)
        if (containsPhone) {
          return containsPhone[0]
        }

        results.push({ tag, value: valueStr })
      }

      // 在所有解析出的值中查找手机号
      for (const item of results) {
        const phoneMatch = item.value.match(/1[3-9]\d{9}/)
        if (phoneMatch) {
          return phoneMatch[0]
        }
      }
    } catch (e) {
      // 解析失败
    }

    return undefined
  }

  /**
   * 获取消息类型名称
   */
  private getMessageTypeName(localType: number, content?: string): string {
    // 检查 XML 中的 type 标签（支持大 localType 的情况）
    if (content) {
      const xmlType = this.extractXmlValue(content, 'type') || null

      if (xmlType) {
        switch (xmlType) {
          case '87': return '群公告'
          case '2000': return '转账消息'
          case '2001': return '红包消息'
          case '115': return '微信礼物'
          case '3': return '音乐分享'
          case '5': return '链接消息'
          case '6': return '文件消息'
          case '19': return '聊天记录'
          case '33':
          case '36': return '小程序消息'
          case '57': return '引用消息'
        }
      }
    }

    const typeNames: Record<number, string> = {
      1: '文本消息',
      3: '图片消息',
      34: '语音消息',
      42: '名片消息',
      43: '视频消息',
      47: '动画表情',
      48: '位置消息',
      49: '链接消息',
      50: '通话消息',
      10000: '系统消息'
    }
    return typeNames[localType] || '其他消息'
  }

  /**
   * 格式化时间戳为可读字符串
   */
  private formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp * 1000)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    const seconds = String(date.getSeconds()).padStart(2, '0')
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
  }

  /**
   * 导出单个会话为详细 JSON 格式（原项目格式）
   */
  async exportSessionToDetailedJson(
    sessionId: string,
    outputPath: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.dbDir) {
        const connectResult = await this.connect()
        if (!connectResult.success) return connectResult
      }

      const myWxid = this.configService.get('myWxid') || ''
      const cleanedMyWxid = this.cleanAccountDirName(myWxid)
      const isGroup = sessionId.includes('@chatroom')

      // 获取会话信息
      const sessionInfo = await this.getContactInfo(sessionId)
      const myInfo = await this.getContactInfo(cleanedMyWxid)

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'preparing',
        detail: '正在准备导出...'
      })

      // 查找消息表
      const dbTablePairs = await this.findSessionTables(sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息' }
      }

      // 收集所有消息
      const allMessages: any[] = []
      let firstMessageTime: number | null = null
      let lastMessageTime: number | null = null

      // 读取+解码在 wcdb 子进程内完成（列裁剪/时间下推/keyset 分批），主进程只收紧凑行
      for await (const rows of this.readMessagesFast(dbTablePairs, options.dateRange)) {
          for (const row of rows) {
            const createTime = row.create_time || 0

            if (options.dateRange) {
              if (createTime < options.dateRange.start || createTime > options.dateRange.end) {
                continue
              }
            }

            const content = row.content || ''
            const localType = row.localType || 1
            const senderUsername = row.sender_username || ''
            const isSend = row.is_send === 1 || senderUsername === cleanedMyWxid

            // 确定实际发送者
            let actualSender: string
            if (localType === 10000 || localType === 266287972401) {
              // 系统消息特殊处理
              const revokeInfo = this.extractRevokerInfo(content)
              if (revokeInfo.isRevoke) {
                if (revokeInfo.isSelfRevoke) {
                  actualSender = cleanedMyWxid
                } else if (revokeInfo.revokerWxid) {
                  actualSender = revokeInfo.revokerWxid
                } else {
                  actualSender = sessionId
                }
              } else {
                actualSender = sessionId
              }
            } else {
              actualSender = isSend ? cleanedMyWxid : (senderUsername || sessionId)
            }
            const senderInfo = await this.getContactInfo(actualSender)

            // 提取 source（msgsource）
            let source = ''
            const msgsourceMatch = /<msgsource>[\s\S]*?<\/msgsource>/i.exec(content)
            if (msgsourceMatch) {
              source = msgsourceMatch[0]
            }

            // 提取消息ID
            const platformMessageId = row.server_id ? String(row.server_id) : (row.local_id ? String(row.local_id) : undefined)

            // 提取引用消息ID
            let replyToMessageId: string | undefined
            if (localType === 49 && content.includes('<type>57</type>')) {
              const svridMatch = /<svrid>(\d+)<\/svrid>/i.exec(content)
              if (svridMatch) {
                replyToMessageId = svridMatch[1]
              }
            }

            // 提取群昵称
            const groupNickname = isGroup ? this.extractGroupNickname(content, actualSender) : undefined

            // 检查是否是聊天记录消息（type=19）
            const xmlType = this.extractXmlValue(content, 'type')
            let chatRecordList: any[] | undefined
            if (xmlType === '19' || localType === 49) {
              chatRecordList = this.parseChatHistory(content)
            }

            allMessages.push({
              localId: row.local_id || allMessages.length + 1,
              platformMessageId,
              createTime,
              formattedTime: this.formatTimestamp(createTime),
              type: this.getMessageTypeName(localType, content),
              localType,
              chatLabType: this.convertMessageType(localType, content),
              content: this.parseMessageContent(content, localType, sessionId, createTime, options.mediaPathMap, row.local_id || 0, options.voicePathMap),
              rawContent: content, // 保留原始内容（用于转账描述解析）
              isSend: isSend ? 1 : 0,
              senderUsername: actualSender,
              senderDisplayName: senderInfo.displayName,
              ...(groupNickname && { groupNickname }),
              ...(replyToMessageId && { replyToMessageId }),
              ...(options.exportAvatars && senderInfo.avatarUrl && { senderAvatar: senderInfo.avatarUrl }),
              ...(chatRecordList && { chatRecords: this.formatChatRecordsForJson(chatRecordList, options) }),
              source
            })

            // 更新时间范围
            if (firstMessageTime === null || createTime < firstMessageTime) {
              firstMessageTime = createTime
            }
            if (lastMessageTime === null || createTime > lastMessageTime) {
              lastMessageTime = createTime
            }
          }
      }

      // 按时间排序
      allMessages.sort((a, b) => a.createTime - b.createTime)

      onProgress?.({
        current: 70,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'writing',
        detail: '正在写入文件...'
      })

      // 转账消息：追加 "谁转账给谁" 信息
      let __msgTick = 0
      for (const msg of allMessages) {
        if ((++__msgTick & 0xff) === 0) await new Promise(resolve => setImmediate(resolve))
        if (msg.content && msg.content.startsWith('[转账]') && msg.rawContent) {
          const transferDesc = await this.resolveTransferDesc(
            msg.rawContent,
            myWxid,
            new Map<string, string>(),
            async (username: string) => {
              const info = await this.getContactInfo(username)
              return info.displayName || username
            }
          )
          if (transferDesc) {
            msg.content = msg.content.replace('[转账]', `[转账] (${transferDesc})`)
          }
        }
      }

      // 构建详细 JSON 格式（包含 ChatLab 元信息）
      const detailedExport = {
        // ChatLab 兼容的元信息
        exportInfo: {
          version: '0.0.2',
          exportedAt: Math.floor(Date.now() / 1000),
          generator: 'CipherTalk',
          format: 'detailed-json'
        },
        session: {
          wxid: sessionId,
          nickname: sessionInfo.displayName,
          remark: sessionInfo.displayName,
          displayName: sessionInfo.displayName,
          type: isGroup ? '群聊' : '私聊',
          platform: 'wechat',
          isGroup,
          ownerId: cleanedMyWxid,
          ...(isGroup && { groupId: sessionId }),
          ...(options.exportAvatars && sessionInfo.avatarUrl && { avatar: sessionInfo.avatarUrl }),
          firstTimestamp: firstMessageTime,
          lastTimestamp: lastMessageTime,
          messageCount: allMessages.length
        },
        messages: allMessages
      }

      fs.writeFileSync(outputPath, JSON.stringify(detailedExport, null, 2), 'utf-8')

      onProgress?.({
        current: 100,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'complete',
        detail: '导出完成'
      })

      return { success: true }
    } catch (e) {
      console.error('ExportService: 导出失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 导出单个会话为 Excel 格式
   */
  async exportSessionToExcel(
    sessionId: string,
    outputPath: string,
    options: ExportOptions
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.dbDir) {
        return { success: false, error: '数据库未连接' }
      }

      const sessionInfo = await this.getContactInfo(sessionId)
      const cleanedMyWxid = (this.configService.get('myWxid') || '').replace(/^wxid_/, '')
      const fullMyWxid = `wxid_${cleanedMyWxid}`

      // 查找消息数据库和表
      const dbTablePairs = await this.findSessionTables(sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息' }
      }

      // 收集所有消息
      const allMessages: any[] = []

      // 读取+解码在 wcdb 子进程内完成（列裁剪/时间下推/keyset 分批），主进程只收紧凑行
      for await (const rows of this.readMessagesFast(dbTablePairs, options.dateRange)) {
          for (const row of rows) {
            const createTime = row.create_time || 0

            if (options.dateRange) {
              if (createTime < options.dateRange.start || createTime > options.dateRange.end) {
                continue
              }
            }

            const content = row.content || ''
            const localType = row.localType || 1
            const senderUsername = row.sender_username || ''

            // 判断是否是自己发送的消息
            const isSend = row.is_send === 1 ||
              senderUsername === cleanedMyWxid ||
              senderUsername === fullMyWxid

            // 确定实际发送者
            let actualSender: string
            if (localType === 10000 || localType === 266287972401) {
              // 系统消息特殊处理
              const revokeInfo = this.extractRevokerInfo(content)
              if (revokeInfo.isRevoke) {
                if (revokeInfo.isSelfRevoke) {
                  actualSender = cleanedMyWxid
                } else if (revokeInfo.revokerWxid) {
                  actualSender = revokeInfo.revokerWxid
                } else {
                  actualSender = sessionId
                }
              } else {
                actualSender = sessionId
              }
            } else {
              actualSender = isSend ? cleanedMyWxid : (senderUsername || sessionId)
            }
            const senderInfo = await this.getContactInfo(actualSender)

            // 检查是否是聊天记录消息（type=19）
            const xmlType = this.extractXmlValue(content, 'type')
            let chatRecordList: any[] | undefined
            if (xmlType === '19' || localType === 49) {
              chatRecordList = this.parseChatHistory(content)
            }

            allMessages.push({
              createTime,
              localId: row.local_id,
              talker: actualSender,
              type: localType,
              content,
              senderName: senderInfo.displayName,
              senderAvatar: options.exportAvatars ? senderInfo.avatarUrl : undefined,
              isSend,
              chatRecordList
            })
          }
      }

      if (allMessages.length === 0) {
        return { success: false, error: '没有消息可导出' }
      }

      // 按时间排序
      allMessages.sort((a, b) => a.createTime - b.createTime)

      // 准备 Excel 数据
      const excelData: any[] = []

      for (let index = 0; index < allMessages.length; index++) {
        if ((index & 0xff) === 0) await new Promise(resolve => setImmediate(resolve))
        const msg = allMessages[index]
        const msgType = this.getMessageTypeName(msg.type, msg.content)
        const time = new Date(msg.createTime * 1000)

        // 获取消息内容（使用统一的解析方法）
        let messageContent = this.parseMessageContent(msg.content, msg.type, sessionId, msg.createTime, options.mediaPathMap, msg.localId, options.voicePathMap)

        // 转账消息：追加 "谁转账给谁" 信息
        if (messageContent && messageContent.startsWith('[转账]') && msg.content) {
          const transferDesc = await this.resolveTransferDesc(
            msg.content,
            fullMyWxid,
            new Map<string, string>(),
            async (username: string) => {
              const info = await this.getContactInfo(username)
              return info.displayName || username
            }
          )
          if (transferDesc) {
            messageContent = messageContent.replace('[转账]', `[转账] (${transferDesc})`)
          }
        }

        const row: any = {
          '序号': index + 1,
          '时间': time.toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          }),
          '日期': time.toLocaleDateString('zh-CN'),
          '时刻': time.toLocaleTimeString('zh-CN'),
          '星期': ['日', '一', '二', '三', '四', '五', '六'][time.getDay()],
          '发送者': msg.senderName,
          '微信ID': msg.talker,
          '消息类型': msgType,
          '消息内容': messageContent || '',
          '原始类型代码': msg.type,
          '时间戳': msg.createTime
        }

        // 只有勾选导出头像时才添加头像链接列
        if (options.exportAvatars && msg.senderAvatar) {
          row['头像链接'] = msg.senderAvatar
        }

        // 如果有聊天记录，添加聊天记录详情列
        if (msg.chatRecordList && msg.chatRecordList.length > 0) {
          const recordDetails = msg.chatRecordList.map((record: any, idx: number) => {
            const recordType = this.getChatRecordTypeName(record.datatype)
            const recordContent = this.getChatRecordContent(record)
            return `${idx + 1}. [${record.sourcename}] ${record.sourcetime} ${recordType}: ${recordContent}`
          }).join('\n')
          row['聊天记录详情'] = recordDetails
        }

        excelData.push(row)
      }

      // 添加工作表（工作表名称最多31个字符，且不能包含特殊字符）
      const sheetName = sessionInfo.displayName
        .substring(0, 31)
        .replace(/[:\\\/\?\*\[\]]/g, '_')

      // 检查是否有聊天记录消息
      const hasChatRecords = allMessages.some(msg => msg.chatRecordList && msg.chatRecordList.length > 0)

      // 创建工作簿，并设置列宽（根据是否导出头像和聊天记录动态调整）
      const workbook = new ExcelJS.Workbook()
      const worksheet = workbook.addWorksheet(sheetName)
      const columns: Partial<ExcelJS.Column>[] = [
        { header: '序号', key: '序号', width: 6 },
        { header: '时间', key: '时间', width: 20 },
        { header: '日期', key: '日期', width: 12 },
        { header: '时刻', key: '时刻', width: 10 },
        { header: '星期', key: '星期', width: 6 },
        { header: '发送者', key: '发送者', width: 15 },
        { header: '微信ID', key: '微信ID', width: 25 },
        { header: '消息类型', key: '消息类型', width: 12 },
        { header: '消息内容', key: '消息内容', width: 50 },
        { header: '原始类型代码', key: '原始类型代码', width: 8 },
        { header: '时间戳', key: '时间戳', width: 12 }
      ]

      if (options.exportAvatars) {
        columns.push({ header: '头像链接', key: '头像链接', width: 50 })
      }

      if (hasChatRecords) {
        columns.push({ header: '聊天记录详情', key: '聊天记录详情', width: 80 })
      }

      worksheet.columns = columns
      worksheet.addRows(excelData)
      worksheet.getRow(1).font = { bold: true }
      worksheet.getColumn('消息内容').alignment = { wrapText: true, vertical: 'top' }
      if (hasChatRecords) {
        worksheet.getColumn('聊天记录详情').alignment = { wrapText: true, vertical: 'top' }
      }

      // 写入文件（使用 buffer 方式，避免直接写文件时被文件句柄占用影响）
      try {
        const workbookBuffer = await workbook.xlsx.writeBuffer()
        fs.writeFileSync(outputPath, Buffer.from(workbookBuffer))
      } catch (writeError) {
        console.error('写入文件失败:', writeError)
        return { success: false, error: `文件写入失败: ${String(writeError)}` }
      }

      return { success: true }
    } catch (e) {
      console.error('ExportService: Excel 导出失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 导出单个会话为 HTML 格式（数据内嵌版本）
   */
  async exportSessionToHtml(
    sessionId: string,
    outputPath: string,
    options: ExportOptions
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.dbDir) {
        return { success: false, error: '数据库未连接' }
      }

      const sessionInfo = await this.getContactInfo(sessionId)
      const myWxid = this.configService.get('myWxid') || ''
      const cleanedMyWxid = this.cleanAccountDirName(myWxid)
      const isGroup = sessionId.includes('@chatroom')

      // 查找消息数据库和表
      const dbTablePairs = await this.findSessionTables(sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息' }
      }

      // 收集所有消息
      const allMessages: any[] = []
      const memberSet = new Map<string, any>()

      // 读取+解码在 wcdb 子进程内完成（列裁剪/时间下推/keyset 分批），主进程只收紧凑行
      expStep('HTML: 读取会话消息(首页)')
      const __tRead = Date.now()
      for await (const rows of this.readMessagesFast(dbTablePairs, options.dateRange)) {
          expStep(`HTML: 解析消息行 (已 ${allMessages.length} 条)`)
          for (const row of rows) {
            const createTime = row.create_time || 0

            if (options.dateRange) {
              if (createTime < options.dateRange.start || createTime > options.dateRange.end) {
                continue
              }
            }

            const content = row.content || ''
            const localType = row.localType || 1
            const senderUsername = row.sender_username || ''
            const isSend = row.is_send === 1 || senderUsername === cleanedMyWxid

            // 确定实际发送者
            let actualSender: string
            if (localType === 10000 || localType === 266287972401) {
              // 系统消息特殊处理
              const revokeInfo = this.extractRevokerInfo(content)
              if (revokeInfo.isRevoke) {
                if (revokeInfo.isSelfRevoke) {
                  actualSender = cleanedMyWxid
                } else if (revokeInfo.revokerWxid) {
                  actualSender = revokeInfo.revokerWxid
                } else {
                  actualSender = sessionId
                }
              } else {
                actualSender = sessionId
              }
            } else {
              actualSender = isSend ? cleanedMyWxid : (senderUsername || sessionId)
            }
            const senderInfo = await this.getContactInfo(actualSender)

            // 检查是否是聊天记录消息
            const xmlType = this.extractXmlValue(content, 'type')
            let chatRecordList: any[] | undefined
            if (xmlType === '19' || localType === 49) {
              chatRecordList = this.parseChatHistory(content)
            }

            let parsedContent = this.parseMessageContent(content, localType, sessionId, createTime, options.mediaPathMap, row.local_id || 0, options.voicePathMap)

            // 转账消息：追加 "谁转账给谁" 信息
            if (parsedContent && parsedContent.startsWith('[转账]')) {
              const transferDesc = await this.resolveTransferDesc(
                content,
                myWxid,
                new Map<string, string>(),
                async (username) => {
                  const info = await this.getContactInfo(username)
                  return info.displayName || username
                }
              )
              if (transferDesc) {
                parsedContent = parsedContent.replace('[转账]', `[转账] (${transferDesc})`)
              }
            }

            // 引用消息：解析被引用的原消息（发送者 + 内容）
            let quote: { sender?: string; content: string } | undefined
            if (content && content.includes('<refermsg>')) {
              const q = parseQuoteMessage(content)
              if (q.content) {
                quote = { sender: q.sender, content: q.content }
              }
            }

            allMessages.push({
              timestamp: createTime,
              sender: actualSender,
              senderName: senderInfo.displayName,
              type: localType,
              content: parsedContent,
              rawContent: content,
              isSend,
              quote,
              chatRecords: chatRecordList ? this.formatChatRecordsForJson(chatRecordList, options) : undefined
            })

            // 收集成员信息
            if (!memberSet.has(actualSender)) {
              memberSet.set(actualSender, {
                id: actualSender,
                name: senderInfo.displayName,
                avatar: options.exportAvatars ? senderInfo.avatarUrl : undefined
              })
            }

            // 收集聊天记录中的成员
            if (chatRecordList) {
              for (const record of chatRecordList) {
                if (record.sourcename && !memberSet.has(record.sourcename)) {
                  memberSet.set(record.sourcename, {
                    id: record.sourcename,
                    name: record.sourcename,
                    avatar: options.exportAvatars ? record.sourceheadurl : undefined
                  })
                }
              }
            }
          }
          expStep('HTML: 读取会话消息(下一页)')
      }
      expLog(`HTML: 消息读取完成 ${allMessages.length} 条，耗时 ${((Date.now() - __tRead) / 1000).toFixed(1)}s`)

      if (allMessages.length === 0) {
        return { success: false, error: '没有消息可导出' }
      }

      // 按时间排序
      allMessages.sort((a, b) => a.timestamp - b.timestamp)

      // 准备导出数据
      const exportData = {
        meta: {
          sessionId,
          sessionName: sessionInfo.displayName,
          sessionAvatar: sessionInfo.avatarUrl || undefined,
          isGroup,
          exportTime: Date.now(),
          messageCount: allMessages.length,
          dateRange: options.dateRange ? {
            start: options.dateRange.start,
            end: options.dateRange.end
          } : null
        },
        members: Array.from(memberSet.values()),
        messages: allMessages
      }

      // 直接写入单文件 HTML（CSS/JS/数据全部内联）
      const outputDir = path.dirname(outputPath)
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true })
      }

      expStep('HTML: 生成并写入文件')
      const __tGen = Date.now()
      const htmlContent = HtmlExportGenerator.generateHtmlWithData(exportData)
      fs.writeFileSync(outputPath, htmlContent, 'utf-8')
      expLog(`HTML: 生成+写盘完成 ${(htmlContent.length / 1024 / 1024).toFixed(1)}MB，耗时 ${((Date.now() - __tGen) / 1000).toFixed(1)}s`)

      return { success: true }
    } catch (e) {
      console.error('ExportService: HTML 导出失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取聊天记录消息的类型名称
   */
  private getChatRecordTypeName(datatype: number): string {
    const typeNames: Record<number, string> = {
      1: '文本',
      3: '图片',
      8: '文件',
      34: '语音',
      43: '视频',
      47: '表情',
      49: '文件'
    }
    return typeNames[datatype] || '其他'
  }

  /**
   * 获取聊天记录消息的内容
   */
  private getChatRecordContent(record: any): string {
    switch (record.datatype) {
      case 1:
        return record.datadesc || record.datatitle || ''
      case 3:
        return '[图片]'
      case 8:
      case 49:
        return record.datatitle ? `[文件] ${record.datatitle}` : '[文件]'
      case 34:
        return '[语音消息]'
      case 43:
        return '[视频]'
      case 47:
        return '[动画表情]'
      default:
        return record.datadesc || record.datatitle || '[消息]'
    }
  }

  /**
   * 导出会话为 PostgreSQL SQL 脚本
   */
  async exportSessionToSql(
    sessionId: string,
    outputPath: string,
    options: ExportOptions
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.dbDir) {
        return { success: false, error: '数据库未连接' }
      }

      const sessionInfo = await this.getContactInfo(sessionId)
      const myWxid = this.configService.get('myWxid') || ''
      const cleanedMyWxid = this.cleanAccountDirName(myWxid)
      const isGroup = sessionId.includes('@chatroom')

      // 查找消息数据库和表
      const dbTablePairs = await this.findSessionTables(sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息' }
      }

      // 收集所有消息
      const allMessages: any[] = []
      let firstMessageTime: number | null = null
      let lastMessageTime: number | null = null

      // 读取+解码在 wcdb 子进程内完成（列裁剪/时间下推/keyset 分批），主进程只收紧凑行
      for await (const rows of this.readMessagesFast(dbTablePairs, options.dateRange)) {
          for (const row of rows) {
            const createTime = row.create_time || 0

            if (options.dateRange) {
              if (createTime < options.dateRange.start || createTime > options.dateRange.end) {
                continue
              }
            }

            const content = row.content || ''
            const localType = row.localType || 1
            const senderUsername = row.sender_username || ''
            const isSend = row.is_send === 1 || senderUsername === cleanedMyWxid

            // 确定实际发送者
            let actualSender: string
            if (localType === 10000 || localType === 266287972401) {
              const revokeInfo = this.extractRevokerInfo(content)
              if (revokeInfo.isRevoke) {
                if (revokeInfo.isSelfRevoke) {
                  actualSender = cleanedMyWxid
                } else if (revokeInfo.revokerWxid) {
                  actualSender = revokeInfo.revokerWxid
                } else {
                  actualSender = sessionId
                }
              } else {
                actualSender = sessionId
              }
            } else {
              actualSender = isSend ? cleanedMyWxid : (senderUsername || sessionId)
            }

            const senderInfo = await this.getContactInfo(actualSender)
            const groupNickname = isGroup ? this.extractGroupNickname(content, actualSender) : undefined

            // 提取引用消息ID
            let replyToMessageId: string | undefined
            if (localType === 49 && content.includes('<type>57</type>')) {
              const svridMatch = /<svrid>(\d+)<\/svrid>/i.exec(content)
              if (svridMatch) {
                replyToMessageId = svridMatch[1]
              }
            }

            // 解析消息内容
            const parsedContent = this.parseMessageContent(content, localType, sessionId, createTime, options.mediaPathMap, row.local_id || 0, options.voicePathMap)
            const contentText = parsedContent !== null ? parsedContent : ''

            allMessages.push({
              localId: row.local_id || allMessages.length + 1,
              createTime,
              formattedTime: this.formatTimestamp(createTime),
              msgType: this.getMessageLocalTypeName(localType),
              localType,
              content: contentText,
              isSend: isSend ? 1 : 0,
              senderUsername: actualSender,
              senderDisplayName: senderInfo.displayName,
              groupNickname,
              replyToMessageId
            })

            if (firstMessageTime === null || createTime < firstMessageTime) {
              firstMessageTime = createTime
            }
            if (lastMessageTime === null || createTime > lastMessageTime) {
              lastMessageTime = createTime
            }
          }
      }

      // 按时间排序
      allMessages.sort((a, b) => a.createTime - b.createTime)

      // 生成 SQL
      const now = Math.floor(Date.now() / 1000)
      const timestamp = new Date().toISOString().replace('T', ' ').replace(/\..+/, '')
      const displayName = sessionInfo.displayName || sessionId
      const sessionType = isGroup ? 'group' : 'private'

      const lines: string[] = []

      // 文件头注释
      lines.push('-- ============================================================')
      lines.push('-- 密语 CipherTalk - 聊天记录导出')
      lines.push(`-- 生成时间: ${timestamp}`)
      lines.push(`-- 会话: ${displayName}`)
      lines.push(`-- 类型: ${isGroup ? '群聊' : '私聊'}`)
      lines.push(`-- 消息数: ${allMessages.length}`)
      lines.push('-- PostgreSQL 兼容 SQL 脚本')
      lines.push('-- ============================================================')
      lines.push('')

      // 建表
      lines.push('-- 清空旧数据（如有）')
      lines.push(`DELETE FROM messages WHERE session_wxid = ${this.escapeSql(sessionId)};`)
      lines.push(`DELETE FROM sessions WHERE wxid = ${this.escapeSql(sessionId)};`)
      lines.push('')

      lines.push('-- 创建会话表')
      lines.push('CREATE TABLE IF NOT EXISTS sessions (')
      lines.push('  wxid TEXT PRIMARY KEY,')
      lines.push('  display_name TEXT NOT NULL,')
      lines.push('  session_type TEXT NOT NULL,')
      lines.push('  owner_id TEXT,')
      lines.push('  message_count INTEGER DEFAULT 0,')
      lines.push('  first_message_time BIGINT,')
      lines.push('  last_message_time BIGINT,')
      lines.push('  exported_at BIGINT')
      lines.push(');')
      lines.push('')

      lines.push('-- 创建消息表')
      lines.push('CREATE TABLE IF NOT EXISTS messages (')
      lines.push('  id SERIAL PRIMARY KEY,')
      lines.push('  session_wxid TEXT NOT NULL REFERENCES sessions(wxid),')
      lines.push('  local_id INTEGER,')
      lines.push('  create_time BIGINT NOT NULL,')
      lines.push('  formatted_time TEXT,')
      lines.push('  msg_type TEXT,')
      lines.push('  content TEXT,')
      lines.push('  is_send SMALLINT DEFAULT 0,')
      lines.push('  sender_username TEXT,')
      lines.push('  sender_display_name TEXT,')
      lines.push('  group_nickname TEXT,')
      lines.push('  reply_to_message_id TEXT')
      lines.push(');')
      lines.push('')

      // 索引
      lines.push('-- 创建索引')
      lines.push('CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_wxid);')
      lines.push('CREATE INDEX IF NOT EXISTS idx_messages_create_time ON messages(create_time);')
      lines.push('CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_username);')
      lines.push('')

      // 插入会话
      lines.push('-- 插入会话信息')
      const sessCols = ['wxid', 'display_name', 'session_type', 'owner_id', 'message_count', 'first_message_time', 'last_message_time', 'exported_at']
      const sessVals = [
        this.escapeSql(sessionId),
        this.escapeSql(displayName),
        this.escapeSql(sessionType),
        this.escapeSql(cleanedMyWxid),
        String(allMessages.length),
        firstMessageTime !== null ? String(firstMessageTime) : 'NULL',
        lastMessageTime !== null ? String(lastMessageTime) : 'NULL',
        String(now)
      ]
      lines.push(`INSERT INTO sessions (${sessCols.join(', ')}) VALUES (${sessVals.join(', ')});`)
      lines.push('')

      if (allMessages.length > 0) {
        lines.push('-- 插入消息')
        lines.push(`-- 共 ${allMessages.length} 条消息，分批插入`)
        lines.push('')

        const msgCols = ['session_wxid', 'local_id', 'create_time', 'formatted_time', 'msg_type', 'content', 'is_send', 'sender_username', 'sender_display_name', 'group_nickname', 'reply_to_message_id']
        const BATCH_SIZE = 500

        for (let i = 0; i < allMessages.length; i += BATCH_SIZE) {
          await new Promise(resolve => setImmediate(resolve))
          const batch = allMessages.slice(i, i + BATCH_SIZE)
          const valueRows = batch.map(msg => {
            const vals = [
              this.escapeSql(sessionId),
              String(msg.localId),
              String(msg.createTime),
              this.escapeSql(msg.formattedTime),
              this.escapeSql(msg.msgType),
              this.escapeSql(msg.content),
              String(msg.isSend),
              this.escapeSql(msg.senderUsername),
              this.escapeSql(msg.senderDisplayName),
              msg.groupNickname ? this.escapeSql(msg.groupNickname) : 'NULL',
              msg.replyToMessageId ? this.escapeSql(msg.replyToMessageId) : 'NULL'
            ]
            return `(${vals.join(', ')})`
          })

          lines.push(`INSERT INTO messages (${msgCols.join(', ')}) VALUES`)
          lines.push(valueRows.join(',\n') + ';')
          lines.push('')
        }
      }

      // 末尾注释
      lines.push('-- 导出完成')
      lines.push(`-- 会话: ${displayName} | ${allMessages.length} 条消息`)

      fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8')

      return { success: true }
    } catch (e) {
      console.error('ExportService: SQL 导出失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * SQL 字符串转义（单引号加倍）
   */
  private escapeSql(value: string | number | undefined | null): string {
    if (value === undefined || value === null) return 'NULL'
    const str = String(value).replace(/'/g, "''")
    return `'${str}'`
  }

  /**
   * 获取聊天记录消息的中文类型名
   */
  private getMessageLocalTypeName(localType: number): string {
    const typeNames: Record<number, string> = {
      1: '文本消息',
      3: '图片消息',
      34: '语音消息',
      43: '视频消息',
      47: '表情消息',
      49: '引用/文件/链接消息',
      10000: '系统消息',
      436207665: '红包消息',
      419430449: '转账消息',
      268445553: '拍一拍消息',
      266287972401: '消息撤回'
    }
    return typeNames[localType] || `其他消息(${localType})`
  }

  /**
   * 批量导出多个会话
   */
  async exportSessions(
    sessionIds: string[],
    outputDir: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{ success: boolean; successCount: number; failCount: number; error?: string; outputPaths?: string[] }> {
    let successCount = 0
    let failCount = 0
    const outputPathSet = new Set<string>()

    expWatchdogStart()
    try {
      if (!this.dbDir) {
        const connectResult = await this.connect()
        if (!connectResult.success) {
          return { success: false, successCount: 0, failCount: sessionIds.length, error: connectResult.error }
        }
      }

      // 确保输出目录存在
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true })
      }

      for (let i = 0; i < sessionIds.length; i++) {
        const sessionId = sessionIds[i]
        const sessionInfo = await this.getContactInfo(sessionId)

        onProgress?.({
          current: i,
          total: sessionIds.length,
          currentSession: sessionInfo.displayName,
          phase: 'exporting',
          detail: '正在读取消息...'
        })

        // 生成文件名（清理非法字符，移除末尾的"."以避免Windows无法识别文件夹）
        const safeName = sessionInfo.displayName.replace(/[<>:"\/\\|?*]/g, '_').replace(/\.+$/, '').trim()
        let ext = '.json'
        if (options.format === 'chatlab-jsonl') ext = '.jsonl'
        else if (options.format === 'excel') ext = '.xlsx'
        else if (options.format === 'html') ext = '.html'
        else if (options.format === 'sql') ext = '.sql'

        // 当导出媒体时，创建会话子文件夹，把文件和媒体都放进去
        const hasMedia = options.exportImages || options.exportVideos || options.exportEmojis || options.exportVoices
        const sessionOutputDir = hasMedia ? path.join(outputDir, safeName) : outputDir
        if (hasMedia && !fs.existsSync(sessionOutputDir)) {
          fs.mkdirSync(sessionOutputDir, { recursive: true })
        }

        const outputPath = path.join(sessionOutputDir, `${safeName}${ext}`)

        expLog(`会话 ${i + 1}/${sessionIds.length} "${safeName}" 开始导出 (format=${options.format}, media=${hasMedia})`)

        // 先导出媒体文件，收集路径映射表
        let mediaPathMap: Map<number, string> | undefined
        let voicePathMap: Map<number, string> | undefined
        const __tMedia = Date.now()
        if (hasMedia) {
          try {
            const mediaResult = await this.exportMediaFiles(sessionId, safeName, sessionOutputDir, options, (fraction, detail) => {
              // 统一总进度：每个会话占 1/N，会话内媒体 fraction 填充该会话的贡献
              onProgress?.({
                current: i + Math.min(Math.max(fraction, 0), 0.999),
                total: sessionIds.length,
                currentSession: sessionInfo.displayName,
                phase: 'exporting',
                detail
              })
            })
            mediaPathMap = mediaResult.mediaPathMap
            voicePathMap = mediaResult.voicePathMap
            for (const relativePath of new Set([...mediaPathMap.values(), ...voicePathMap.values()])) {
              outputPathSet.add(path.join(sessionOutputDir, relativePath))
            }
          } catch (e) {
            console.error(`导出 ${sessionId} 媒体文件失败:`, e)
          }
        }

        // 将媒体路径映射表附加到 options 上
        const exportOpts = (mediaPathMap || voicePathMap)
          ? { ...options, ...(mediaPathMap ? { mediaPathMap } : {}), ...(voicePathMap ? { voicePathMap } : {}) }
          : options

        if (hasMedia) {
          expLog(`媒体阶段结束，耗时 ${((Date.now() - __tMedia) / 1000).toFixed(1)}s`)
        }

        let result: { success: boolean; error?: string }
        expStep(`写出 ${options.format} 文件`)
        const __tWrite = Date.now()

        // 根据格式选择导出方法
        if (options.format === 'json') {
          result = await this.exportSessionToDetailedJson(sessionId, outputPath, exportOpts)
        } else if (options.format === 'chatlab' || options.format === 'chatlab-jsonl') {
          result = await this.exportSessionToChatLab(sessionId, outputPath, exportOpts)
        } else if (options.format === 'excel') {
          result = await this.exportSessionToExcel(sessionId, outputPath, exportOpts)
        } else if (options.format === 'html') {
          result = await this.exportSessionToHtml(sessionId, outputPath, exportOpts)
        } else if (options.format === 'sql') {
          result = await this.exportSessionToSql(sessionId, outputPath, exportOpts)
        } else {
          result = { success: false, error: `不支持的格式: ${options.format}` }
        }

        expLog(`${options.format} 文件写出${result.success ? '完成' : `失败: ${result.error}`}，耗时 ${((Date.now() - __tWrite) / 1000).toFixed(1)}s`)

        if (result.success) {
          successCount++
          outputPathSet.add(outputPath)
        } else {
          failCount++
          console.error(`导出 ${sessionId} 失败:`, result.error)
        }

        onProgress?.({
          current: i + 1,
          total: sessionIds.length,
          currentSession: sessionInfo.displayName,
          phase: 'exporting',
          detail: result.success ? '已完成当前会话' : `当前会话导出失败: ${result.error || '未知错误'}`
        })

        // 让出事件循环，避免阻塞主进程
        await new Promise(resolve => setImmediate(resolve))
      }

      onProgress?.({
        current: sessionIds.length,
        total: sessionIds.length,
        currentSession: '',
        phase: 'complete',
        detail: '导出完成'
      })

      return { success: true, successCount, failCount, outputPaths: Array.from(outputPathSet) }
    } catch (e) {
      return { success: false, successCount, failCount, error: String(e), outputPaths: Array.from(outputPathSet) }
    } finally {
      expWatchdogStop()
    }
  }

  /**
   * 导出朋友圈
   */
  async exportMoments(
    outputDir: string,
    options: MomentsExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{ success: boolean; successCount: number; failCount: number; error?: string }> {
    try {
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true })
      }

      onProgress?.({ current: 0, total: 100, currentSession: '朋友圈', phase: 'preparing', detail: '正在读取朋友圈数据...' })

      const startTime = options.dateRange?.start
      const endTime = options.dateRange?.end
      const usernames = options.usernames && options.usernames.length > 0 ? options.usernames : undefined

      // 分页拉取全部朋友圈
      const allPosts: SnsPost[] = []
      const seenIds = new Set<string>()
      const BATCH = 200
      let offset = 0
      while (true) {
        const res = await snsService.getTimeline(BATCH, offset, usernames, undefined, startTime, endTime)
        if (!res.success || !res.timeline || res.timeline.length === 0) break
        for (const post of res.timeline) {
          const key = post.id || `${post.username}_${post.createTime}`
          if (seenIds.has(key)) continue
          seenIds.add(key)
          allPosts.push(post)
        }
        onProgress?.({ current: 50, total: 100, currentSession: '朋友圈', phase: 'exporting', detail: `已读取 ${allPosts.length} 条朋友圈...` })
        if (res.timeline.length < BATCH) break
        offset += BATCH
        await new Promise(resolve => setImmediate(resolve))
      }

      if (allPosts.length === 0) {
        return { success: false, successCount: 0, failCount: 0, error: '未找到符合条件的朋友圈数据' }
      }

      // 按时间倒序
      allPosts.sort((a, b) => b.createTime - a.createTime)

      onProgress?.({ current: 95, total: 100, currentSession: '朋友圈', phase: 'writing', detail: '正在写入文件...' })

      const timestamp = this.formatTimestamp(Math.floor(Date.now() / 1000)).replace(/[: ]/g, '-')
      let ext = '.json'
      if (options.format === 'html') ext = '.html'
      else if (options.format === 'excel') ext = '.xlsx'
      const outputPath = path.join(outputDir, `朋友圈导出_${timestamp}${ext}`)

      // 统一处理：所有格式都消费同一份处理过的数据
      const items = allPosts.map(p => this.buildMomentExportItem(p))

      if (options.format === 'json') {
        const data = {
          generator: 'CipherTalk',
          exportedAt: Math.floor(Date.now() / 1000),
          total: items.length,
          moments: items
        }
        fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf-8')
      } else if (options.format === 'html') {
        fs.writeFileSync(outputPath, this.buildMomentsHtml(items), 'utf-8')
      } else {
        await this.writeMomentsExcel(items, outputPath)
      }

      onProgress?.({ current: 100, total: 100, currentSession: '朋友圈', phase: 'complete', detail: '导出完成' })
      return { success: true, successCount: allPosts.length, failCount: 0 }
    } catch (e) {
      console.error('ExportService: 朋友圈导出失败:', e)
      return { success: false, successCount: 0, failCount: 0, error: String(e) }
    }
  }

  private buildMomentExportItem(p: SnsPost): MomentExportItem {
    return {
      id: p.id,
      username: p.username,
      nickname: this.decodeHtmlEntities(p.nickname || p.username),
      createTime: p.createTime,
      formattedTime: this.formatTimestamp(p.createTime),
      content: this.decodeHtmlEntities(p.contentDesc || ''),
      media: (p.media || []).map(m => ({
        type: isVideoUrl(m.url) ? 'video' as const : 'image' as const,
        url: m.url,
        thumb: m.thumb
      })),
      mediaCount: p.media?.length || 0,
      shareInfo: p.shareInfo,
      likes: (p.likes || []).map(l => this.decodeHtmlEntities(l)),
      likeCount: p.likes?.length || 0,
      comments: (p.comments || []).map(c => ({
        nickname: this.decodeHtmlEntities(c.nickname || ''),
        content: this.decodeHtmlEntities(c.content || ''),
        replyTo: c.refNickname ? this.decodeHtmlEntities(c.refNickname) : undefined
      })),
      commentCount: p.comments?.length || 0
    }
  }

  private escapeHtmlText(text: string): string {
    if (!text) return ''
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  private buildMomentsHtml(items: MomentExportItem[]): string {
    const cards = items.map(p => {
      const time = this.escapeHtmlText(p.formattedTime)
      const nickname = this.escapeHtmlText(p.nickname)
      const content = this.escapeHtmlText(p.content).replace(/\n/g, '<br>')

      const mediaHtml = p.media.map(m => {
        if (m.type === 'video') {
          return `<video class="m-media" controls src="${this.escapeHtmlText(m.url)}"></video>`
        }
        return `<img class="m-media" loading="lazy" src="${this.escapeHtmlText(m.url || m.thumb)}" alt="">`
      }).join('')

      let shareHtml = ''
      if (p.shareInfo && (p.shareInfo.title || p.shareInfo.description)) {
        shareHtml = `<div class="m-share"><div class="m-share-title">${this.escapeHtmlText(p.shareInfo.title || '')}</div><div class="m-share-desc">${this.escapeHtmlText(p.shareInfo.description || '')}</div></div>`
      }

      const likesHtml = p.likes.length > 0
        ? `<div class="m-likes">❤ ${this.escapeHtmlText(p.likes.join('、'))}</div>`
        : ''

      const commentsHtml = p.comments.length > 0
        ? `<div class="m-comments">${p.comments.map(c => {
            const who = this.escapeHtmlText(c.nickname)
            const ref = c.replyTo ? ` 回复 ${this.escapeHtmlText(c.replyTo)}` : ''
            return `<div class="m-comment"><b>${who}</b>${ref}：${this.escapeHtmlText(c.content)}</div>`
          }).join('')}</div>`
        : ''

      return `<div class="m-card">
  <div class="m-head"><span class="m-name">${nickname}</span><span class="m-time">${time}</span></div>
  ${content ? `<div class="m-content">${content}</div>` : ''}
  ${mediaHtml ? `<div class="m-medias">${mediaHtml}</div>` : ''}
  ${shareHtml}
  ${likesHtml}
  ${commentsHtml}
</div>`
    }).join('\n')

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>朋友圈导出 - CipherTalk</title>
<style>
  body { margin:0; background:#f0f2f5; font-family:-apple-system,"Microsoft YaHei",sans-serif; color:#1a1a1a; }
  .m-wrap { max-width:600px; margin:0 auto; padding:24px 16px; }
  .m-title { text-align:center; font-size:18px; font-weight:600; margin-bottom:4px; }
  .m-sub { text-align:center; color:#888; font-size:13px; margin-bottom:20px; }
  .m-card { background:#fff; border-radius:12px; padding:16px; margin-bottom:14px; box-shadow:0 1px 4px rgba(0,0,0,.06); }
  .m-head { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px; }
  .m-name { font-weight:600; color:#576b95; }
  .m-time { font-size:12px; color:#999; }
  .m-content { font-size:15px; line-height:1.6; white-space:pre-wrap; margin-bottom:10px; }
  .m-medias { display:flex; flex-wrap:wrap; gap:6px; }
  .m-media { width:calc(33.33% - 4px); border-radius:6px; object-fit:cover; aspect-ratio:1; }
  .m-share { background:#f7f7f7; border-radius:8px; padding:10px; margin-top:8px; }
  .m-share-title { font-weight:600; font-size:14px; }
  .m-share-desc { color:#888; font-size:13px; margin-top:4px; }
  .m-likes { margin-top:10px; padding-top:8px; border-top:1px solid #eee; color:#576b95; font-size:13px; }
  .m-comments { margin-top:8px; background:#f7f7f7; border-radius:8px; padding:8px 10px; }
  .m-comment { font-size:13px; line-height:1.7; }
  .m-comment b { color:#576b95; }
</style>
</head>
<body>
<div class="m-wrap">
  <div class="m-title">朋友圈导出</div>
  <div class="m-sub">CipherTalk · 共 ${items.length} 条 · ${this.escapeHtmlText(this.formatTimestamp(Math.floor(Date.now() / 1000)))}</div>
  ${cards}
</div>
</body>
</html>`
  }

  private async writeMomentsExcel(items: MomentExportItem[], outputPath: string): Promise<void> {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('朋友圈')
    sheet.columns = [
      { header: '时间', key: 'time', width: 20 },
      { header: '昵称', key: 'nickname', width: 18 },
      { header: 'wxid', key: 'username', width: 24 },
      { header: '内容', key: 'content', width: 50 },
      { header: '媒体数', key: 'mediaCount', width: 8 },
      { header: '媒体链接', key: 'media', width: 40 },
      { header: '点赞数', key: 'likeCount', width: 8 },
      { header: '点赞人', key: 'likes', width: 30 },
      { header: '评论数', key: 'commentCount', width: 8 },
      { header: '评论详情', key: 'comments', width: 50 }
    ]

    for (const p of items) {
      sheet.addRow({
        time: p.formattedTime,
        nickname: p.nickname,
        username: p.username,
        content: p.content,
        mediaCount: p.mediaCount,
        media: p.media.map(m => m.url).join('\n'),
        likeCount: p.likeCount,
        likes: p.likes.join('、'),
        commentCount: p.commentCount,
        comments: p.comments.map(c => `${c.nickname}${c.replyTo ? '回复' + c.replyTo : ''}：${c.content}`).join('\n')
      })
    }

    sheet.eachRow(row => { row.alignment = { vertical: 'top', wrapText: true } })
    sheet.getRow(1).font = { bold: true }

    await workbook.xlsx.writeFile(outputPath)
  }

  /**
   * 导出会话的媒体文件（图片和视频）
   */
  private async exportMediaFiles(
    sessionId: string,
    safeName: string,
    outputDir: string,
    options: ExportOptions,
    onProgress?: (fraction: number, detail: string) => void
  ): Promise<{ mediaPathMap: Map<number, string>; voicePathMap: Map<number, string> }> {
    // mediaPathMap：图片/视频/表情用 createTime → 相对路径
    // voicePathMap：语音用 localId → 相对路径（避免同时间戳冲突）
    const mediaPathMap = new Map<number, string>()
    const voicePathMap = new Map<number, string>()

    const dbTablePairs = await this.findSessionTables(sessionId)
    if (dbTablePairs.length === 0) return { mediaPathMap, voicePathMap }

    // 创建媒体输出目录（直接在会话文件夹下创建子目录）
    const imageOutDir = options.exportImages ? path.join(outputDir, 'images') : ''
    const videoOutDir = options.exportVideos ? path.join(outputDir, 'videos') : ''
    const emojiOutDir = options.exportEmojis ? path.join(outputDir, 'emojis') : ''

    if (options.exportImages && !fs.existsSync(imageOutDir)) {
      fs.mkdirSync(imageOutDir, { recursive: true })
    }
    if (options.exportVideos && !fs.existsSync(videoOutDir)) {
      fs.mkdirSync(videoOutDir, { recursive: true })
    }
    if (options.exportEmojis && !fs.existsSync(emojiOutDir)) {
      fs.mkdirSync(emojiOutDir, { recursive: true })
    }

    let imageCount = 0
    let videoCount = 0
    let emojiCount = 0
    // 表情按 cacheKey 去重下载（缓存 Promise，失败也记住）：
    // 输出文件名带 createTime，同一表情发 N 次 destPath 全 miss，
    // 死链 CDN 每次要等 15s×2 超时，不去重会把整场导出拖死
    const emojiFetchCache = new Map<string, Promise<string | null>>()

    // 是否需要处理图片/视频/表情
    const needMedia = options.exportImages || options.exportVideos || options.exportEmojis

    // 进度分母：图片/视频/表情按扫描到的消息行推进；启用语音时给语音留后 15% 区间
    expStep('统计消息总数')
    const __tCount = Date.now()
    const totalMsgs = await this.countMessages(dbTablePairs, options.dateRange)
    expLog(`媒体阶段开始: 消息总数 ${totalMsgs} (统计耗时 ${Date.now() - __tCount}ms)`)
    const mediaWeight = needMedia ? (options.exportVoices ? 0.85 : 1.0) : 0
    let mediaScanned = 0
    const reportMedia = (extra: number) => {
      if (!totalMsgs) return
      const frac = Math.min(1, (mediaScanned + extra) / totalMsgs) * mediaWeight
      onProgress?.(frac, `导出媒体 图片${imageCount} · 视频${videoCount} · 表情${emojiCount}`)
    }

    // 图片/视频/表情循环（语音在后面独立处理）
    if (needMedia) {
      onProgress?.(0, '正在导出媒体...')
      // 流式分批读取媒体消息行：每批 2000 行、批内 MEDIA_CONCURRENCY 路并发，
      // 处理完即释放，避免一次性吞整表导致 OOM。图片/视频/表情解密下载都是 I/O 密集，并发收益最大。
      // 图片解密以 wcdb 代理 IPC + 磁盘 IO 为主，12 路仍吃不满 CPU
      const MEDIA_CONCURRENCY = 12
      // 媒体行同样走子进程快速通道；packed_info 系列列透传给 parseImageDatName
      expStep('读取媒体消息(首页)')
      let __tPage = Date.now()
      for await (const pageRows of this.readMessagesFast(dbTablePairs, options.dateRange, [
        'packed_info_data', 'packed_info', 'packedInfoData', 'packedInfo',
        'PackedInfoData', 'PackedInfo',
        'WCDB_CT_packed_info_data', 'WCDB_CT_packed_info',
        'WCDB_CT_PackedInfoData', 'WCDB_CT_PackedInfo'
      ])) {
          // 工作池代替按组 Promise.all 栅栏：单个慢项（如触发索引构建的图片）不再拖住同组其余通道
          let __mediaCursor = 0
          let __mediaDone = 0
          const __mediaWorker = async () => {
            while (__mediaCursor < pageRows.length) {
              const row: any = pageRows[__mediaCursor++]
              await (async () => {
        try {
          {
            const createTime = row.create_time || 0

            // 时间范围过滤
            if (options.dateRange) {
              if (createTime < options.dateRange.start || createTime > options.dateRange.end) {
                return
              }
            }

            const localType = row.localType || 1
            const content = row.content || ''

            // 导出图片
            if (options.exportImages && localType === 3) {
              try {
                // 从 XML 提取 md5
                const imageMd5 = this.extractXmlValue(content, 'md5') ||
                  (/\<img[^>]*\smd5\s*=\s*['"]([^'"]+)['"]/i.exec(content))?.[1] ||
                  undefined

                // 从 packed_info_data 解析 dat 文件名（缓存文件以此命名）
                const imageDatName = this.parseImageDatName(row)

                if (imageMd5 || imageDatName) {
                  expStep(`图片解密 ${imageMd5 || imageDatName} (localId=${row.local_id})`)
                  const __tImg = Date.now()
                  const cacheResult = await imageDecryptService.decryptImage({
                    sessionId,
                    imageMd5,
                    imageDatName,
                    createTime
                  })
                  const __dtImg = Date.now() - __tImg
                  if (__dtImg > 1000) expLog(`慢图片 ${imageMd5 || imageDatName}: ${__dtImg}ms (success=${cacheResult.success})`)

                  if (cacheResult.success && cacheResult.localPath) {
                    // localPath 是 file:///path?v=xxx 格式，转为本地路径
                    let filePath = cacheResult.localPath
                      .replace(/\?v=\d+$/, '')
                      .replace(/^file:\/\/\//i, '')
                    filePath = decodeURIComponent(filePath)

                    if (fs.existsSync(filePath)) {
                      const ext = path.extname(filePath) || '.jpg'
                      const fileName = `${createTime}_${imageMd5 || imageDatName}${ext}`
                      const df = this.dateFolder(createTime)
                      const dayDir = path.join(imageOutDir, df)
                      if (!fs.existsSync(dayDir)) fs.mkdirSync(dayDir, { recursive: true })
                      const destPath = path.join(dayDir, fileName)
                      if (!fs.existsSync(destPath)) {
                        fs.copyFileSync(filePath, destPath)
                        imageCount++
                        mediaPathMap.set(createTime, `images/${df}/${fileName}`)
                      }
                    }
                  }
                }
              } catch (e) {
                // 跳过单张图片的错误
              }
            }

            // 导出视频
            if (options.exportVideos && localType === 43) {
              try {
                const videoMd5 = videoService.parseVideoMd5(content)
                if (videoMd5) {
                  expStep(`视频查找 ${videoMd5} (localId=${row.local_id})`)
                  const __tVid = Date.now()
                  const videoInfo = await videoService.getVideoInfo(videoMd5, content)
                  const __dtVid = Date.now() - __tVid
                  if (__dtVid > 1000) expLog(`慢视频 ${videoMd5}: ${__dtVid}ms (exists=${videoInfo.exists})`)
                  if (videoInfo.exists && videoInfo.videoUrl) {
                    const videoPath = videoInfo.videoUrl.replace(/^file:\/\/\//i, '').replace(/\//g, path.sep)
                    if (fs.existsSync(videoPath)) {
                      const fileName = `${createTime}_${videoMd5}.mp4`
                      const df = this.dateFolder(createTime)
                      const dayDir = path.join(videoOutDir, df)
                      if (!fs.existsSync(dayDir)) fs.mkdirSync(dayDir, { recursive: true })
                      const destPath = path.join(dayDir, fileName)
                      if (!fs.existsSync(destPath)) {
                        fs.copyFileSync(videoPath, destPath)
                        videoCount++
                        mediaPathMap.set(createTime, `videos/${df}/${fileName}`)
                      }
                    }
                  }
                }
              } catch (e) {
                // 跳过单个视频的错误
              }
            }

            // 导出表情包
            if (options.exportEmojis && localType === 47) {
              try {
                // 从 XML 提取 cdnUrl 和 md5
                const cdnUrlMatch = /cdnurl\s*=\s*['"]([^'"]+)['"]/i.exec(content)
                const thumbUrlMatch = /thumburl\s*=\s*['"]([^'"]+)['"]/i.exec(content)
                const md5Match = /(?:emoticon)?md5\s*=\s*['"]([a-fA-F0-9]+)['"]/i.exec(content) ||
                  /<md5>([^<]+)<\/md5>/i.exec(content)
                const encryptUrlMatch = /encrypturl\s*=\s*['"]([^'"]+)['"]/i.exec(content)
                const aesKeyMatch = /aeskey\s*=\s*['"]([a-zA-Z0-9]+)['"]/i.exec(content)

                let cdnUrl = cdnUrlMatch?.[1] || thumbUrlMatch?.[1] || ''
                const emojiMd5 = md5Match?.[1] || ''
                let encryptUrl = encryptUrlMatch?.[1] || ''
                const aesKey = aesKeyMatch?.[1] || ''

                if (cdnUrl) cdnUrl = cdnUrl.replace(/&amp;/g, '&')
                if (encryptUrl) encryptUrl = encryptUrl.replace(/&amp;/g, '&')

                if (emojiMd5 || cdnUrl) {
                  const cacheKey = emojiMd5 || this.hashString(cdnUrl)
                  // 确定文件扩展名
                  const ext = cdnUrl.includes('.gif') || content.includes('type="2"') ? '.gif' : '.png'
                  const fileName = `${createTime}_${cacheKey}${ext}`
                  const df = this.dateFolder(createTime)
                  const dayDir = path.join(emojiOutDir, df)
                  if (!fs.existsSync(dayDir)) fs.mkdirSync(dayDir, { recursive: true })
                  const destPath = path.join(dayDir, fileName)

                  if (!fs.existsSync(destPath)) {
                    // 本地缓存 → CDN 下载 → encryptUrl+AES，整链按 cacheKey 去重，同一表情只走一次
                    let fetchTask = emojiFetchCache.get(cacheKey)
                    if (!fetchTask) {
                      fetchTask = (async () => {
                        const __tEmoji = Date.now()
                        let f = this.findLocalEmoji(cacheKey)
                        let src = f ? '本地缓存' : ''
                        if (!f && cdnUrl) {
                          f = await this.downloadEmojiFile(cdnUrl, cacheKey)
                          if (f) src = 'CDN'
                        }
                        if (!f && encryptUrl && aesKey) {
                          f = await this.downloadAndDecryptEmoji(encryptUrl, aesKey, cacheKey)
                          if (f) src = 'encryptUrl'
                        }
                        expLog(`表情 ${cacheKey}: ${f ? src : '全部失败'} ${Date.now() - __tEmoji}ms`)
                        return f
                      })()
                      emojiFetchCache.set(cacheKey, fetchTask)
                    }
                    expStep(`表情下载 ${cacheKey}`)
                    const sourceFile = await fetchTask

                    if (sourceFile && fs.existsSync(sourceFile)) {
                      fs.copyFileSync(sourceFile, destPath)
                      emojiCount++
                      mediaPathMap.set(createTime, `emojis/${df}/${fileName}`)
                    }
                  } else {
                    mediaPathMap.set(createTime, `emojis/${df}/${fileName}`)
                  }
                }
              } catch (e) {
                // 跳过单个表情的错误
              }
            }
          }
        } catch (e) {
          // 跳过单行消息的错误
        }
              })()
              __mediaDone++
              if ((__mediaDone & 31) === 0) {
                reportMedia(__mediaDone)
                await new Promise(resolve => setImmediate(resolve))
              }
            }
          }
          await Promise.all(Array.from(
            { length: Math.min(MEDIA_CONCURRENCY, pageRows.length) },
            () => __mediaWorker()
          ))
          reportMedia(pageRows.length)
          mediaScanned += pageRows.length
          expLog(`媒体扫描 ${mediaScanned}/${totalMsgs} · 图${imageCount} 视${videoCount} 表${emojiCount} · 本页 ${pageRows.length} 行耗时 ${((Date.now() - __tPage) / 1000).toFixed(1)}s`)
          expStep('读取媒体消息(下一页)')
          __tPage = Date.now()
      }
    } // 结束 needMedia

    // === 语音导出（独立流程：需要从 MediaDb 读取） ===
    let voiceCount = 0
    if (options.exportVoices) {
      const voiceOutDir = path.join(outputDir, 'voices')
      if (!fs.existsSync(voiceOutDir)) {
        fs.mkdirSync(voiceOutDir, { recursive: true })
      }

      onProgress?.(mediaWeight, '正在导出语音消息...')
      expStep('收集语音消息')
      const __tVoiceCollect = Date.now()

      // 1. 收集所有语音消息（createTime + localId + serverId，按 localId 升序以稳定同时间戳顺序）
      interface VoiceMsgRef {
        createTime: number
        localId: number
        serverId: number
      }
      const voiceMessages: VoiceMsgRef[] = []
      for await (const rows of this.readMessagesFast(dbTablePairs, options.dateRange)) {
        for (const row of rows) {
          if ((row.localType || 1) !== 34) continue
          const createTime = row.create_time || 0
          if (!createTime) continue
          if (options.dateRange && (createTime < options.dateRange.start || createTime > options.dateRange.end)) {
            continue
          }
          const localId = Number(row.local_id || 0)
          const serverId = Number(row.server_id || 0)
          voiceMessages.push({ createTime, localId, serverId })
        }
      }
      // 稳定排序：createTime 升序，相同时间内按 localId 升序（与 VoiceInfo.rowid 顺序对齐）
      voiceMessages.sort((a, b) => a.createTime - b.createTime || a.localId - b.localId)

      // 每个 createTime 下当前消息所处索引，便于策略 B 按 rowid 顺序映射
      const sameTimeIndexMap = new Map<number, Map<number, number>>()
      for (const m of voiceMessages) {
        let g = sameTimeIndexMap.get(m.createTime)
        if (!g) { g = new Map(); sameTimeIndexMap.set(m.createTime, g) }
        if (!g.has(m.localId)) g.set(m.localId, g.size)
      }

      expLog(`语音消息收集完成: ${voiceMessages.length} 条，耗时 ${((Date.now() - __tVoiceCollect) / 1000).toFixed(1)}s`)

      if (voiceMessages.length > 0) {
        // 2. 查找 MediaDb
        expStep('枚举 MediaDb (递归扫描 db_storage)')
        const __tFindDb = Date.now()
        const mediaDbs = this.findMediaDbs()
        expLog(`MediaDb 枚举: ${mediaDbs.length} 个，耗时 ${Date.now() - __tFindDb}ms`)

        if (mediaDbs.length > 0) {
          // 3. 只初始化一次 silk-wasm
          let silkWasm: any = null
          try {
            silkWasm = require('silk-wasm')
          } catch (e) {
            console.error('[Export] silk-wasm 加载失败:', e)
          }

          if (silkWasm) {
            // 4. 枚举所有 MediaDb，预先记录 VoiceInfo 表结构
            interface VoiceDbInfo {
              dbPath: string
              voiceTable: string
              dataColumn: string
              timeColumn: string
              chatNameIdColumn: string | null
              svrIdColumn: string | null
              name2IdTable: string | null
            }
            const voiceDbs: VoiceDbInfo[] = []

            expStep('探测 VoiceInfo 表结构')
            const __tProbe = Date.now()
            for (const dbPath of mediaDbs) {
              try {
                const tables = await dbAdapter.all<any>(
                  'message',
                  dbPath,
                  "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'VoiceInfo%'"
                )
                if (tables.length === 0) continue

                const voiceTable = tables[0].name
                const columns = await dbAdapter.all<any>(
                  'message',
                  dbPath,
                  `PRAGMA table_info('${voiceTable}')`
                )
                const colNames = columns.map((c: any) => String(c.name).toLowerCase())

                const dataColumn = colNames.find((c: string) => ['voice_data', 'buf', 'voicebuf', 'data'].includes(c))
                const timeColumn = colNames.find((c: string) => ['create_time', 'createtime', 'time'].includes(c))
                if (!dataColumn || !timeColumn) continue

                const chatNameIdColumn = colNames.find((c: string) => ['chat_name_id', 'chatnameid', 'chat_nameid'].includes(c)) || null
                const svrIdColumn = colNames.find((c: string) =>
                  ['msg_svr_id', 'msgsvrid', 'svr_id', 'svrid', 'server_id', 'serverid'].includes(c)
                ) || null
                const n2iTables = await dbAdapter.all<any>(
                  'message',
                  dbPath,
                  "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Name2Id%'"
                )
                const name2IdTable = n2iTables.length > 0 ? n2iTables[0].name : null

                voiceDbs.push({ dbPath, voiceTable, dataColumn, timeColumn, chatNameIdColumn, svrIdColumn, name2IdTable })
              } catch { }
            }
            expLog(`VoiceInfo 表探测: ${voiceDbs.length}/${mediaDbs.length} 个可用，耗时 ${Date.now() - __tProbe}ms`)

            // 5. 3 路并发处理语音：I/O（MediaDb 查询、writeFileSync）与 WASM 解码错开重叠；
            //    silk-wasm 每次调用新建实例且同步阻塞事件循环，无 CPU 并行——并发仅获 I/O 重叠收益。
            //    单条峰值 < 6MB（SILK + PCM + WAV 三段），3 路可控
            const myWxid = this.configService.get('myWxid')
            const candidates = [sessionId]
            if (myWxid && myWxid !== sessionId) candidates.push(myWxid)

            const VOICE_CONCURRENCY = 3
            const total = voiceMessages.length
            let done = 0  // 共享完成计数器（JS 单线程，++done 原子，无需锁）
            for (let start = 0; start < total; start += VOICE_CONCURRENCY) {
              const slice = voiceMessages.slice(start, start + VOICE_CONCURRENCY)
              await Promise.all(slice.map((m) => (async () => {
                const __tVoiceItem = Date.now()
                try {
                  const { createTime, localId, serverId } = m
                  expStep(`语音查找 localId=${localId}`)
                  const fileName = localId > 0 ? `${createTime}_${localId}.wav` : `${createTime}.wav`
                  const df = this.dateFolder(createTime)
                  const dayDir = path.join(voiceOutDir, df)
                  if (!fs.existsSync(dayDir)) fs.mkdirSync(dayDir, { recursive: true })
                  const destPath = path.join(dayDir, fileName)

                  // 已存在则跳过
                  if (fs.existsSync(destPath)) {
                    voicePathMap.set(localId, `voices/${df}/${fileName}`)
                    if (!mediaPathMap.has(createTime)) {
                      mediaPathMap.set(createTime, `voices/${df}/${fileName}`)
                    }
                    return
                  }

                  // 在 MediaDb 中查找 SILK 数据
                  let silkData: Buffer | null = null
                  const targetIdx = sameTimeIndexMap.get(createTime)?.get(localId) ?? 0
                  for (const vdb of voiceDbs) {
                    try {
                      // 策略 A: svr_id 精确匹配
                      if (vdb.svrIdColumn && serverId > 0) {
                        if (vdb.chatNameIdColumn && vdb.name2IdTable) {
                          for (const cand of candidates) {
                            const n2i = await dbAdapter.get<any>(
                              'message', vdb.dbPath,
                              `SELECT rowid FROM ${vdb.name2IdTable} WHERE user_name = ?`,
                              [cand]
                            )
                            if (n2i?.rowid) {
                              const row = await dbAdapter.get<any>(
                                'message', vdb.dbPath,
                                `SELECT ${vdb.dataColumn} AS data FROM ${vdb.voiceTable} WHERE ${vdb.chatNameIdColumn} = ? AND ${vdb.svrIdColumn} = ? LIMIT 1`,
                                [n2i.rowid, serverId]
                              )
                              if (row?.data) {
                                silkData = this.decodeVoiceBlob(row.data)
                                if (silkData) break
                              }
                            }
                          }
                        }
                        if (!silkData) {
                          const row = await dbAdapter.get<any>(
                            'message', vdb.dbPath,
                            `SELECT ${vdb.dataColumn} AS data FROM ${vdb.voiceTable} WHERE ${vdb.svrIdColumn} = ? LIMIT 1`,
                            [serverId]
                          )
                          if (row?.data) silkData = this.decodeVoiceBlob(row.data)
                        }
                      }

                      // 策略 B: chatNameId + createTime 按 rowid 顺序选第 N 条
                      if (!silkData && vdb.chatNameIdColumn && vdb.name2IdTable) {
                        for (const cand of candidates) {
                          const n2i = await dbAdapter.get<any>(
                            'message', vdb.dbPath,
                            `SELECT rowid FROM ${vdb.name2IdTable} WHERE user_name = ?`,
                            [cand]
                          )
                          if (!n2i?.rowid) continue
                          const rows = await dbAdapter.all<any>(
                            'message', vdb.dbPath,
                            `SELECT ${vdb.dataColumn} AS data FROM ${vdb.voiceTable} WHERE ${vdb.chatNameIdColumn} = ? AND ${vdb.timeColumn} = ? ORDER BY rowid ASC`,
                            [n2i.rowid, createTime]
                          )
                          if (rows.length === 0) continue
                          const pick = rows[Math.min(targetIdx, rows.length - 1)]
                          if (pick?.data) {
                            silkData = this.decodeVoiceBlob(pick.data)
                            if (silkData) break
                          }
                        }
                      }

                      // 策略 C: 仅 createTime 兜底
                      if (!silkData) {
                        const rows = await dbAdapter.all<any>(
                          'message', vdb.dbPath,
                          `SELECT ${vdb.dataColumn} AS data FROM ${vdb.voiceTable} WHERE ${vdb.timeColumn} = ? ORDER BY rowid ASC`,
                          [createTime]
                        )
                        if (rows.length > 0) {
                          const pick = rows[Math.min(targetIdx, rows.length - 1)]
                          if (pick?.data) silkData = this.decodeVoiceBlob(pick.data)
                        }
                      }
                      if (silkData) break
                    } catch { }
                  }

                  if (!silkData) return

                  try {
                    // SILK → PCM → WAV
                    expStep(`语音解码 localId=${m.localId}`)
                    const result = await silkWasm.decode(silkData, 24000)
                    silkData = null // 释放 SILK 数据
                    if (!result?.data) return
                    const pcmData = Buffer.from(result.data)
                    const wavData = this.createWavBuffer(pcmData, 24000)
                    fs.writeFileSync(destPath, wavData)
                    voiceCount++
                    voicePathMap.set(localId, `voices/${df}/${fileName}`)
                    if (!mediaPathMap.has(createTime)) {
                      mediaPathMap.set(createTime, `voices/${df}/${fileName}`)
                    }
                  } catch { }
                } finally {
                  const __dtVoice = Date.now() - __tVoiceItem
                  if (__dtVoice > 2000) expLog(`慢语音 localId=${m.localId}: ${__dtVoice}ms`)
                  // 进度：语音占 [mediaWeight, 1] 区间
                  // finally 确保跳过/异常也计数，done 单调推进到 total（修复原串行版本跳过项导致进度卡 <100%）
                  const n = ++done
                  if (n % 10 === 0 || n === total) {
                    const voiceFrac = mediaWeight + (total > 0 ? n / total : 1) * (1 - mediaWeight)
                    onProgress?.(voiceFrac, `语音导出: ${n}/${total}`)
                  }
                }
              })()))
            }

            // 6. dbAdapter 无持久 handle，无需关闭
          }
        }
      }
    }

    const parts: string[] = []
    if (imageCount > 0) parts.push(`${imageCount} 张图片`)
    if (videoCount > 0) parts.push(`${videoCount} 个视频`)
    if (emojiCount > 0) parts.push(`${emojiCount} 个表情`)
    if (voiceCount > 0) parts.push(`${voiceCount} 条语音`)
    const summary = parts.length > 0 ? `媒体导出完成: ${parts.join(', ')}` : '无媒体文件'
    onProgress?.(1, summary)
    console.log(`[Export] ${sessionId} ${summary}`)
    return { mediaPathMap, voicePathMap }
  }

  private dateFolder(ts: number): string {
    const d = new Date(ts * 1000)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}${m}${day}`
  }

  /**
   * 从数据库行的 packed_info_data 中解析图片 dat 文件名
   * 复制自 chatService.parseImageDatNameFromRow 逻辑
   */
  private parseImageDatName(row: Record<string, any>): string | undefined {
    // 尝试多种可能的字段名
    const fieldNames = [
      'packed_info_data', 'packed_info', 'packedInfoData', 'packedInfo',
      'PackedInfoData', 'PackedInfo',
      'WCDB_CT_packed_info_data', 'WCDB_CT_packed_info',
      'WCDB_CT_PackedInfoData', 'WCDB_CT_PackedInfo'
    ]
    let packed: any = undefined
    for (const name of fieldNames) {
      if (row[name] !== undefined && row[name] !== null) {
        packed = row[name]
        break
      }
    }

    // 解码为 Buffer
    let buffer: Buffer | null = null
    if (!packed) return undefined
    if (Buffer.isBuffer(packed)) {
      buffer = packed
    } else if (packed instanceof Uint8Array) {
      buffer = Buffer.from(packed)
    } else if (Array.isArray(packed)) {
      buffer = Buffer.from(packed)
    } else if (typeof packed === 'string') {
      const trimmed = packed.trim()
      if (/^[a-fA-F0-9]+$/.test(trimmed) && trimmed.length % 2 === 0) {
        try { buffer = Buffer.from(trimmed, 'hex') } catch { }
      }
      if (!buffer) {
        try { buffer = Buffer.from(trimmed, 'base64') } catch { }
      }
    } else if (typeof packed === 'object' && Array.isArray(packed.data)) {
      buffer = Buffer.from(packed.data)
    }

    if (!buffer || buffer.length === 0) return undefined

    // 提取可打印字符
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

    // 匹配 dat 文件名
    const match = /([0-9a-fA-F]{8,})(?:\.t)?\.dat/.exec(text)
    if (match?.[1]) return match[1].toLowerCase()
    const hexMatch = /([0-9a-fA-F]{16,})/.exec(text)
    return hexMatch?.[1]?.toLowerCase()
  }

  /**
   * 简单字符串哈希（用于无 md5 时生成缓存 key）
   */
  private hashString(str: string): string {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const chr = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + chr
      hash |= 0
    }
    return Math.abs(hash).toString(16)
  }

  /**
   * 查找本地缓存的表情包文件
   */
  private findLocalEmoji(cacheKey: string): string | null {
    try {
      const cachePath = this.configService.get('cachePath')
      if (!cachePath) return null

      const emojiCacheDir = path.join(cachePath, 'Emojis')
      if (!fs.existsSync(emojiCacheDir)) return null

      // 检查各种扩展名
      const extensions = ['.gif', '.png', '.webp', '.jpg', '.jpeg', '']
      for (const ext of extensions) {
        const filePath = path.join(emojiCacheDir, `${cacheKey}${ext}`)
        if (fs.existsSync(filePath)) {
          const stat = fs.statSync(filePath)
          if (stat.isFile() && stat.size > 0) return filePath
        }
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * 从 CDN 下载表情包文件并缓存（使用微信 UA + 重定向 + SSL bypass）
   */
  private downloadEmojiFile(cdnUrl: string, cacheKey: string): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        const cachePath = this.configService.get('cachePath')
        if (!cachePath) { resolve(null); return }

        const emojiCacheDir = path.join(cachePath, 'Emojis')
        if (!fs.existsSync(emojiCacheDir)) fs.mkdirSync(emojiCacheDir, { recursive: true })

        let url = cdnUrl
        if (url.startsWith('http://') && (url.includes('qq.com') || url.includes('wechat.com'))) {
          url = url.replace('http://', 'https://')
        }

        this.doDownloadBuffer(url, (buffer) => {
          if (!buffer) { resolve(null); return }
          const ext = this.detectEmojiExt(buffer)
          const filePath = path.join(emojiCacheDir, `${cacheKey}${ext}`)
          fs.writeFileSync(filePath, buffer)
          resolve(filePath)
        })
      } catch { resolve(null) }
    })
  }

  /**
   * 下载加密表情并用 AES 解密
   */
  private async downloadAndDecryptEmoji(encryptUrl: string, aesKey: string, cacheKey: string): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        const cachePath = this.configService.get('cachePath')
        if (!cachePath) { resolve(null); return }

        const emojiCacheDir = path.join(cachePath, 'Emojis')
        if (!fs.existsSync(emojiCacheDir)) fs.mkdirSync(emojiCacheDir, { recursive: true })

        let url = encryptUrl.replace(/&amp;/g, '&')
        if (url.startsWith('http://') && (url.includes('qq.com') || url.includes('wechat.com'))) {
          url = url.replace('http://', 'https://')
        }

        this.doDownloadBuffer(url, (buffer) => {
          if (!buffer) { resolve(null); return }
          try {
            const crypto = require('crypto')
            const keyBuf = Buffer.from(crypto.createHash('md5').update(aesKey).digest('hex').slice(0, 16), 'utf8')
            const decipher = crypto.createDecipheriv('aes-128-ecb', keyBuf, null)
            decipher.setAutoPadding(true)
            const decrypted = Buffer.concat([decipher.update(buffer), decipher.final()])
            const ext = this.detectEmojiExt(decrypted)
            const filePath = path.join(emojiCacheDir, `${cacheKey}${ext}`)
            fs.writeFileSync(filePath, decrypted)
            resolve(filePath)
          } catch { resolve(null) }
        })
      } catch { resolve(null) }
    })
  }

  private doDownloadBuffer(url: string, callback: (buf: Buffer | null) => void, redirectCount = 0): void {
    if (redirectCount > 5) { callback(null); return }
    const protocol = url.startsWith('https') ? https : http
    const req = protocol.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x67001431) NetType/WIFI WindowsWechat/3.9.11.17(0x63090b11)',
        'Accept': '*/*',
      },
      rejectUnauthorized: false,
      timeout: 8000
    }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
        const loc = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href
        this.doDownloadBuffer(loc, callback, redirectCount + 1)
        return
      }
      if (res.statusCode !== 200) { callback(null); return }
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        callback(buf.length > 0 ? buf : null)
      })
      res.on('error', () => callback(null))
    })
    req.on('error', () => callback(null))
    req.setTimeout(8000, () => { req.destroy(); callback(null) })
  }

  private detectEmojiExt(buf: Buffer): string {
    if (buf[0] === 0x89 && buf[1] === 0x50) return '.png'
    if (buf[0] === 0xFF && buf[1] === 0xD8) return '.jpg'
    if (buf[0] === 0x52 && buf[1] === 0x49) return '.webp'
    return '.gif'
  }

  /**
   * 查找 media 数据库文件（从 db_storage 根目录递归枚举）
   */
  private findMediaDbs(): string[] {
    const root = getDbStoragePath()
    if (!root) return []
    const result: string[] = []
    const stack: string[] = [root]
    try {
      while (stack.length > 0) {
        const dir = stack.pop()!
        let entries: string[] = []
        try { entries = fs.readdirSync(dir) } catch { continue }
        for (const entry of entries) {
          const full = path.join(dir, entry)
          let st
          try { st = fs.statSync(full) } catch { continue }
          if (st.isDirectory()) {
            stack.push(full)
          } else if (st.isFile()) {
            const lower = entry.toLowerCase()
            if (lower.startsWith('media') && lower.endsWith('.db')) {
              result.push(full)
            }
          }
        }
      }
    } catch { }
    return result
  }

  /**
   * 解码语音 Blob 数据为 Buffer
   */
  private decodeVoiceBlob(raw: any): Buffer | null {
    if (!raw) return null
    if (Buffer.isBuffer(raw)) return raw
    if (raw instanceof Uint8Array) return Buffer.from(raw)
    if (Array.isArray(raw)) return Buffer.from(raw)
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (/^[a-fA-F0-9]+$/.test(trimmed) && trimmed.length % 2 === 0) {
        try { return Buffer.from(trimmed, 'hex') } catch { }
      }
      try { return Buffer.from(trimmed, 'base64') } catch { }
    }
    if (typeof raw === 'object' && Array.isArray(raw.data)) {
      return Buffer.from(raw.data)
    }
    return null
  }

  /**
   * PCM 数据生成 WAV 文件 Buffer
   */
  private createWavBuffer(pcmData: Buffer, sampleRate: number = 24000, channels: number = 1): Buffer {
    const pcmLength = pcmData.length
    const header = Buffer.alloc(44)
    header.write('RIFF', 0)
    header.writeUInt32LE(36 + pcmLength, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(channels, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(sampleRate * channels * 2, 28)
    header.writeUInt16LE(channels * 2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36)
    header.writeUInt32LE(pcmLength, 40)
    return Buffer.concat([header, pcmData])
  }

  /**
   * 导出通讯录
   */
  async exportContacts(
    outputDir: string,
    options: ContactExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{ success: boolean; successCount?: number; error?: string }> {
    try {
      if (!this.dbDir) {
        const connectResult = await this.connect()
        if (!connectResult.success) {
          return { success: false, error: connectResult.error }
        }
      }

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: '通讯录',
        phase: 'preparing',
        detail: '正在连接数据库...'
      })

      if (!this.contactDbAvailable) {
        return { success: false, error: '联系人数据库未连接' }
      }

      // 确保输出目录存在
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true })
      }

      // 获取表结构
      const columns = await dbAdapter.all<any>('contact', '', "PRAGMA table_info(contact)")
      const columnNames = columns.map((c: any) => c.name)

      // 打印所有列名用于调试
      console.log('Contact table columns:', columnNames)

      const hasBigHeadUrl = columnNames.includes('big_head_url')
      const hasSmallHeadUrl = columnNames.includes('small_head_url')
      const hasLocalType = columnNames.includes('local_type')
      // 微信数据库中手机号可能的字段名
      const hasMobile = columnNames.includes('mobile')
      const hasPhone = columnNames.includes('phone')
      const hasPhoneNumber = columnNames.includes('phone_number')
      const hasTel = columnNames.includes('tel')
      const hasExtraBuffer = columnNames.includes('extra_buffer')
      const hasDescription = columnNames.includes('description')

      const selectCols = ['username', 'remark', 'nick_name', 'alias']
      if (hasBigHeadUrl) selectCols.push('big_head_url')
      if (hasSmallHeadUrl) selectCols.push('small_head_url')
      if (hasLocalType) selectCols.push('local_type')
      if (hasMobile) selectCols.push('mobile')
      if (hasPhone) selectCols.push('phone')
      if (hasPhoneNumber) selectCols.push('phone_number')
      if (hasTel) selectCols.push('tel')
      if (hasExtraBuffer) selectCols.push('extra_buffer')
      if (hasDescription) selectCols.push('description')

      onProgress?.({
        current: 20,
        total: 100,
        currentSession: '通讯录',
        phase: 'exporting',
        detail: '正在读取联系人数据...'
      })

      const rows = await dbAdapter.all<any>(
        'contact',
        '',
        `SELECT ${selectCols.join(', ')} FROM contact`
      )

      // 过滤和转换联系人
      const contacts: any[] = []
      for (const row of rows) {
        const username = row.username || ''

        // 过滤系统账号
        if (!username || username === 'filehelper' || username === 'fmessage' ||
          username === 'floatbottle' || username === 'medianote' ||
          username === 'newsapp' || username.startsWith('fake_')) {
          continue
        }

        // 如果指定了选中列表且不为空，则只导出选中的
        if (options.selectedUsernames && options.selectedUsernames.length > 0) {
          if (!options.selectedUsernames.includes(username)) {
            continue
          }
        }

        // 判断类型
        let type: 'friend' | 'group' | 'official' | 'other' = 'friend'
        if (username.includes('@chatroom')) {
          type = 'group'
        } else if (username.startsWith('gh_')) {
          type = 'official'
        } else if (hasLocalType) {
          const localType = row.local_type || 0
          if (localType === 3) type = 'official'
        }

        // 仅当没有指定选中列表时，才应用类型过滤
        if (!options.selectedUsernames || options.selectedUsernames.length === 0) {
          if (type === 'friend' && !options.contactTypes.friends) continue
          if (type === 'group' && !options.contactTypes.groups) continue
          if (type === 'official' && !options.contactTypes.officials) continue
        }

        const displayName = row.remark || row.nick_name || row.alias || username
        let avatarUrl: string | undefined
        if (options.exportAvatars) {
          if (hasBigHeadUrl && row.big_head_url) {
            avatarUrl = row.big_head_url
          } else if (hasSmallHeadUrl && row.small_head_url) {
            avatarUrl = row.small_head_url
          }
        }

        // 获取手机号 - 尝试多个可能的字段
        let mobile = row.mobile || row.phone || row.phone_number || row.tel || ''

        // 如果有 extra_buffer，尝试从中解析手机号
        if (!mobile && row.extra_buffer) {
          const phoneMatch = this.extractPhoneFromExtraBuf(row.extra_buffer)
          if (phoneMatch) mobile = phoneMatch
        }

        contacts.push({
          username,
          displayName,
          remark: row.remark || '',
          nickname: row.nick_name || '',
          alias: row.alias || '',
          mobile,
          type,
          avatarUrl
        })
      }

      onProgress?.({
        current: 60,
        total: 100,
        currentSession: '通讯录',
        phase: 'writing',
        detail: `正在处理 ${contacts.length} 个联系人...`
      })

      // 按类型和名称排序
      contacts.sort((a, b) => {
        const typeOrder: Record<string, number> = { friend: 0, group: 1, official: 2, other: 3 }
        if (typeOrder[a.type] !== typeOrder[b.type]) {
          return typeOrder[a.type] - typeOrder[b.type]
        }
        return a.displayName.localeCompare(b.displayName, 'zh-CN')
      })

      // 根据格式导出
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      let outputPath: string

      if (options.format === 'json') {
        outputPath = path.join(outputDir, `contacts_${timestamp}.json`)
        const exportData = {
          exportInfo: {
            version: '1.0.0',
            exportedAt: Math.floor(Date.now() / 1000),
            generator: 'CipherTalk',
            platform: 'wechat'
          },
          statistics: {
            total: contacts.length,
            friends: contacts.filter(c => c.type === 'friend').length,
            groups: contacts.filter(c => c.type === 'group').length,
            officials: contacts.filter(c => c.type === 'official').length
          },
          contacts
        }
        fs.writeFileSync(outputPath, JSON.stringify(exportData, null, 2), 'utf-8')
      } else if (options.format === 'csv') {
        outputPath = path.join(outputDir, `contacts_${timestamp}.csv`)
        const headers = ['用户名', '显示名称', '备注', '昵称', '手机号', '类型', '头像URL']
        const csvLines = [headers.join(',')]
        for (const c of contacts) {
          const row = [
            `"${c.username}"`,
            `"${c.displayName.replace(/"/g, '""')}"`,
            `"${(c.remark || '').replace(/"/g, '""')}"`,
            `"${(c.nickname || '').replace(/"/g, '""')}"`,
            `"${c.mobile || ''}"`,
            `"${c.type}"`,
            `"${c.avatarUrl || ''}"`
          ]
          csvLines.push(row.join(','))
        }
        // 添加 BOM 以支持 Excel 正确识别 UTF-8
        fs.writeFileSync(outputPath, '\ufeff' + csvLines.join('\n'), 'utf-8')
      } else if (options.format === 'vcf') {
        outputPath = path.join(outputDir, `contacts_${timestamp}.vcf`)
        const vcfLines: string[] = []
        for (const c of contacts) {
          if (c.type === 'group') continue // vCard 不支持群组
          vcfLines.push('BEGIN:VCARD')
          vcfLines.push('VERSION:3.0')
          // 如果有备注，显示名称用备注，原昵称放到 ORG 或 NOTE
          if (c.remark && c.remark !== c.nickname) {
            vcfLines.push(`FN:${c.remark}`)
            // N 字段：姓;名;中间名;前缀;后缀
            vcfLines.push(`N:${c.remark};;;;`)
            if (c.nickname) vcfLines.push(`NICKNAME:${c.nickname}`)
            vcfLines.push(`NOTE:微信昵称: ${c.nickname || c.username}`)
          } else {
            vcfLines.push(`FN:${c.displayName}`)
            vcfLines.push(`N:${c.displayName};;;;`)
            if (c.nickname && c.nickname !== c.displayName) {
              vcfLines.push(`NICKNAME:${c.nickname}`)
            }
          }
          if (c.mobile) vcfLines.push(`TEL;TYPE=CELL:${c.mobile}`)
          vcfLines.push(`X-WECHAT-ID:${c.username}`)
          if (c.avatarUrl) vcfLines.push(`PHOTO;VALUE=URI:${c.avatarUrl}`)
          vcfLines.push('END:VCARD')
          vcfLines.push('')
        }
        fs.writeFileSync(outputPath, vcfLines.join('\n'), 'utf-8')
      } else {
        return { success: false, error: `不支持的格式: ${options.format}` }
      }

      onProgress?.({
        current: 100,
        total: 100,
        currentSession: '通讯录',
        phase: 'complete',
        detail: '导出完成'
      })

      return { success: true, successCount: contacts.length }
    } catch (e) {
      console.error('ExportService: 导出通讯录失败:', e)
      return { success: false, error: String(e) }
    }
  }
}

export const exportService = new ExportService()

