import { EventEmitter } from 'events'
import { ChatServiceState } from './chat/state'
import { wcdbService } from './wcdbService'
import type { StatsPartialError } from './statsConstants'
import type {
  ChatSession,
  ContactInfo,
  Message,
  ChatLabSourceMessage,
  ChatRecordItem,
  Contact,
} from './chat/types'
import {
  getContacts,
  getContact,
  getContactAvatar,
  resolveTransferDisplayNames,
  getMyAvatarUrl,
  getMyUserInfo,
  getUinFromMiscDb,
} from './chat/contactQueries'
import { isOfficialAccountUsername, isOfficialFolderUsername } from './chat/accountUtils'
import { isSystemContactUsername } from './chat/constants'
import { getSessionDetail } from './chat/sessionDetail'
import { getSessions, searchSessions } from './chat/sessionList'
import {
  getEmoticonDecryptionParams,
  decryptEmoticonCache,
  downloadEmoji,
} from './chat/emoji'
import {
  getMessageByLocalId,
  getMessageByLocalIdFromTable,
  getImageData,
  getVoiceData,
} from './chat/media'
import {
  findSessionTables,
  refreshMessageDbCache as refreshMessageDbCacheImpl,
} from './chat/tableResolver'
import {
  getMessages,
  getNewMessages,
  getMessagesByTimeRangeForSummary,
  getMessagesBefore,
  getMessagesAfter,
  getMessagesForChatLab,
  getAllVoiceMessages,
  getAllImageMessages,
  getMessagesByDate,
  getDatesWithMessages,
} from './chat/messageQueries'

export type {
  ChatSession,
  ContactInfo,
  Message,
  ChatLabSourceMessage,
  ChatRecordItem,
  Contact,
}

class ChatService extends EventEmitter {
  private state = new ChatServiceState()

  constructor() {
    super()
  }

  /**
   * 设置当前聚焦的会话 ID
   * 用于增量同步时只推送当前会话的消息
   */
  setCurrentSession(sessionId: string | null): void {
    this.state.currentSessionId = sessionId
  }

  getCurrentSessionId(): string | null {
    return this.state.currentSessionId
  }

  /**
   * 启动屏预加载：DB 连接成功后在后台预热会话列表、联系人和前几个会话的消息。
   * startup.ts 通过 Promise.race 加 5s 超时调用此方法，保证不会无限阻塞启动屏。
   */
  async preloadData(): Promise<void> {
    const t0 = Date.now()
    try {
      const sessionsResult = await this.getSessions(0, 300)
      this.state.preloadCache.sessions = {
        success: sessionsResult.success,
        sessions: sessionsResult.sessions,
        hasMore: sessionsResult.hasMore
      }

      const contactsResult = await this.getContacts()
      this.state.preloadCache.contacts = contactsResult

      if (sessionsResult.success && sessionsResult.sessions?.length) {
        const topSessions = sessionsResult.sessions.slice(0, 5)
        await Promise.all(topSessions.map(async (session) => {
          const result = await this.getMessages(session.username, 0, 50)
          if (result.success) {
            this.state.preloadCache.messages.set(session.username, {
              success: result.success,
              messages: result.messages,
              hasMore: result.hasMore
            })
          }
        }))
      }

      this.state.preloadCache.builtAt = Date.now()
      console.log(`[ChatService] 预加载完成，耗时 ${Date.now() - t0}ms，会话 ${this.state.preloadCache.sessions?.sessions?.length ?? 0} 条，消息缓存 ${this.state.preloadCache.messages.size} 个会话`)
    } catch (e) {
      console.warn('[ChatService] 预加载失败:', e)
    }
  }

  /**
   * 连接数据库。业务层仍调用 chatService.connect，但实际句柄由 wcdbService Worker 管理。
   */
  async connect(): Promise<{ success: boolean; error?: string }> {
    try {
      const wxid = String(this.state.configService.get('myWxid') || '').trim()
      const dbPath = String(this.state.configService.get('dbPath') || '').trim()
      const decryptKey = String(this.state.configService.get('decryptKey') || '').trim()

      if (!wxid || !dbPath || !decryptKey) {
        return { success: false, error: '数据库配置不完整' }
      }

      const opened = await wcdbService.open(dbPath, decryptKey, wxid)
      return opened ? { success: true } : { success: false, error: 'WCDB 打开失败' }
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) }
    }
  }

  /**
   * 关闭数据库连接（no-op；真正的 close 由 wcdbService 接管）
   */
  close(): void {
    // 清理本地缓存（真正的句柄由 wcdbService 的 Worker 管理）
    this.state.sessionTableCache.clear()
    this.state.sessionTableCacheTime = 0
    this.state.knownMessageDbFiles.clear()
    this.state.myRowIdCache.clear()
    this.state.hasName2IdCache.clear()
    this.state.contactColumnsCache = null
    this.state.weComCorpNameCache.clear()
    this.state.hasOpenImWordingTable = null
    this.state.avatarBase64Cache.clear()
    this.state.preloadCache.sessions = null
    this.state.preloadCache.contacts = null
    this.state.preloadCache.messages.clear()
    this.state.preloadCache.builtAt = 0
  }

  /**
   * 关闭指定的数据库文件（no-op；wcdbService 统一管理）
   */
  closeDatabase(_fileName: string): void {
    // 不再持有本地 better-sqlite3 句柄。清掉相关缓存即可。
    this.state.sessionTableCache.clear()
    this.state.sessionTableCacheTime = 0
    this.state.knownMessageDbFiles.clear()
    this.state.avatarBase64Cache.clear()
    this.state.contactColumnsCache = null
    this.state.weComCorpNameCache.clear()
    this.state.hasOpenImWordingTable = null
  }

  /**
   * 由 startup.ts 调用：把 monitorBridge 的变更事件桥接成 chatService 自身的 EventEmitter
   * 暂时只做事件转发；不在这里做 query 或 push。
   */
  attachMonitor(bridge: { on: (evt: string, cb: (p: any) => void) => void }): void {
    bridge.on('change', (payload) => {
      if (payload?.table === 'Session' || payload?.table === 'Message' || payload?.table === 'Contact') {
        this.emit('dbChange', payload)
      }
    })
  }

  /**
   * 获取会话列表
   */
  async getSessions(offset?: number, limit?: number): Promise<{ success: boolean; sessions?: ChatSession[]; hasMore?: boolean; error?: string }> {
    return getSessions(this.state, offset, limit)
  }

  /**
   * 后端全量搜索会话（聊天页侧边栏搜索）
   */
  async searchSessions(keyword: string): Promise<{ success: boolean; sessions?: ChatSession[]; error?: string }> {
    return searchSessions(this.state, keyword)
  }

  /**
   * 获取通讯录列表
   */
  async getContacts(): Promise<{ success: boolean; contacts?: ContactInfo[]; error?: string }> {
    return getContacts(this.state)
  }

  /**
   * 获取 AI Agent @ 选择列表：只返回私聊和群聊，过滤公众号/系统号。
   * 独立于通用 getSessions，避免影响聊天页、导出页等其他会话列表。
   */
  async getMentionTargets(offset?: number, limit?: number, keyword?: string): Promise<{ success: boolean; sessions?: ChatSession[]; hasMore?: boolean; error?: string }> {
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0))
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 300)))
    const safeKeyword = String(keyword || '').trim().toLowerCase()
    console.warn('[AgentMention][service] request', {
      offset: safeOffset,
      limit: safeLimit,
      hasKeyword: !!safeKeyword,
      keywordLength: safeKeyword.length,
    })
    const contactToSession = (contact: ContactInfo): ChatSession => ({
      username: contact.username,
      type: contact.type === 'group' ? 2 : 1,
      unreadCount: 0,
      summary: '',
      sortTimestamp: contact.lastContactTime || 0,
      lastTimestamp: contact.lastContactTime || 0,
      lastMsgType: 0,
      displayName: contact.displayName,
      avatarUrl: contact.avatarUrl,
      isWeCom: contact.isWeCom,
      weComCorp: contact.weComCorp,
    })
    const filterMentionContact = (contact: ContactInfo): boolean => (
      (contact.type === 'friend' || contact.type === 'group') && !isSystemContactUsername(contact.username)
    )

    if (safeKeyword) {
      const contactsResult = await this.getContacts()
      console.warn('[AgentMention][service] keyword contacts result', {
        success: contactsResult.success,
        contacts: Array.isArray(contactsResult.contacts) ? contactsResult.contacts.length : null,
        error: contactsResult.error,
      })
      if (!contactsResult.success || !Array.isArray(contactsResult.contacts)) {
        return { success: false, error: contactsResult.error || '获取通讯录失败' }
      }

      const mentionContacts = contactsResult.contacts.filter(filterMentionContact)
      const matchedContacts = contactsResult.contacts
        .filter(filterMentionContact)
        .filter((contact) => [
          contact.displayName,
          contact.username,
          contact.remark,
          contact.nickname,
          contact.weComCorp,
        ].some((value) => String(value || '').toLowerCase().includes(safeKeyword)))

      const page = matchedContacts.slice(safeOffset, safeOffset + safeLimit)
      console.warn('[AgentMention][service] keyword page', {
        mentionContacts: mentionContacts.length,
        matchedContacts: matchedContacts.length,
        page: page.length,
        hasMore: matchedContacts.length > safeOffset + safeLimit,
      })
      return {
        success: true,
        sessions: page.map(contactToSession),
        hasMore: matchedContacts.length > safeOffset + safeLimit,
      }
    }

    const result = await this.getSessions(safeOffset, safeLimit)
    console.warn('[AgentMention][service] sessions result', {
      success: result.success,
      rawSessions: Array.isArray(result.sessions) ? result.sessions.length : null,
      hasMore: result.hasMore,
      error: result.error,
    })

    if (result.success && Array.isArray(result.sessions)) {
      const sessions = result.sessions.filter((session) => {
        const username = String(session.username || '')
        if (!username) return false
        if (session.isOfficialAccount || session.isOfficialFolder || session.isFoldGroup) return false
        if (isOfficialAccountUsername(username) || isOfficialFolderUsername(username)) return false
        if (isSystemContactUsername(username)) return false
        return true
      })
      console.warn('[AgentMention][service] sessions filtered', {
        rawSessions: result.sessions.length,
        filteredSessions: sessions.length,
        hasMore: result.hasMore,
      })

      if (sessions.length > 0) {
        return { success: true, sessions, hasMore: !!result.hasMore }
      }
      if (result.hasMore) {
        return { success: true, sessions: [], hasMore: true }
      }
    }

    if (safeOffset > 0) {
      console.warn('[AgentMention][service] skip contacts fallback for paged request', {
        offset: safeOffset,
        sessionSuccess: result.success,
        sessionError: result.error,
      })
      return result.success ? { success: true, sessions: [], hasMore: false } : result
    }

    const contactsResult = await this.getContacts()
    console.warn('[AgentMention][service] fallback contacts result', {
      success: contactsResult.success,
      contacts: Array.isArray(contactsResult.contacts) ? contactsResult.contacts.length : null,
      error: contactsResult.error,
    })
    if (!contactsResult.success || !Array.isArray(contactsResult.contacts)) {
      return result.success ? { success: true, sessions: [], hasMore: false } : result
    }

    const mentionContacts = contactsResult.contacts.filter(filterMentionContact)
    const contacts = mentionContacts
      .slice(safeOffset, safeOffset + safeLimit)
      .map(contactToSession)
    console.warn('[AgentMention][service] fallback contacts page', {
      mentionContacts: mentionContacts.length,
      page: contacts.length,
      hasMore: contacts.length === safeLimit && (contactsResult.contacts.length > safeOffset + safeLimit),
    })

    return {
      success: true,
      sessions: contacts,
      hasMore: contacts.length === safeLimit && (contactsResult.contacts.length > safeOffset + safeLimit),
    }
  }

  /**
   * 刷新消息数据库缓存（解密后调用）
   */
  refreshMessageDbCache(): void {
    refreshMessageDbCacheImpl(this.state)
    // 尝试推送增量消息（fire-and-forget，避免把同步方法改成 async）
    void this.checkNewMessagesForCurrentSession()
  }

  /**
   * 获取消息列表（支持跨多个数据库合并，已优化）
   */
  async getMessages(
    sessionId: string,
    offset: number = 0,
    limit: number = 50
  ): Promise<{ success: boolean; messages?: Message[]; hasMore?: boolean; error?: string }> {
    return getMessages(this.state, sessionId, offset, limit)
  }

  /**
   * 获取指定时间之后的新消息。
   * 优先走 WeFlow native cursor；cursor 不可用时回退到现有最新页查询。
   */
  async getNewMessages(
    sessionId: string,
    minTime: number,
    limit: number = 1000
  ): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
    return getNewMessages(this.state, sessionId, minTime, limit)
  }

  /**
   * 摘要专用：按精确时间范围读取消息，并优先保留范围内最新消息。
   */
  async getMessagesByTimeRangeForSummary(
    sessionId: string,
    options: {
      startTime?: number
      endTime: number
      limit: number
    }
  ): Promise<{ success: boolean; messages?: Message[]; hasMore?: boolean; error?: string }> {
    return getMessagesByTimeRangeForSummary(this.state, sessionId, options)
  }

  /**
   * 基于 sortSeq 游标，获取更早的消息（严格小于 cursorSortSeq）
   */
  async getMessagesBefore(
    sessionId: string,
    cursorSortSeq: number,
    limit: number = 50,
    cursorCreateTime?: number,
    cursorLocalId?: number
  ): Promise<{ success: boolean; messages?: Message[]; hasMore?: boolean; error?: string }> {
    return getMessagesBefore(this.state, sessionId, cursorSortSeq, limit, cursorCreateTime, cursorLocalId)
  }

  /**
   * 基于 sortSeq 游标，获取更新的消息（严格大于 cursorSortSeq）
   */
  async getMessagesAfter(
    sessionId: string,
    cursorSortSeq: number,
    limit: number = 50,
    cursorCreateTime?: number,
    cursorLocalId?: number
  ): Promise<{ success: boolean; messages?: Message[]; hasMore?: boolean; error?: string }> {
    return getMessagesAfter(this.state, sessionId, cursorSortSeq, limit, cursorCreateTime, cursorLocalId)
  }

  /**
   * ChatLab Pull 轻量消息查询。
   * 只返回协议组装所需的最小字段，避免媒体路径解析和富结构展开。
   */
  async getMessagesForChatLab(
    sessionId: string,
    options?: {
      startTime?: number
      endTime?: number
      watermark?: number
      offset?: number
      limit?: number
    }
  ): Promise<{ success: boolean; messages?: ChatLabSourceMessage[]; hasMore?: boolean; error?: string }> {
    return getMessagesForChatLab(this.state, sessionId, options)
  }

  /**
   * 获取会话的所有语音消息（用于批量转写）
   * 复用 getMessages 的查询逻辑，只查询语音消息类型
   */
  async getAllVoiceMessages(
    sessionId: string
  ): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
    return getAllVoiceMessages(this.state, sessionId)
  }

  /**
   * 获取会话的所有图片消息（用于批量解密）
   */
  async getAllImageMessages(
    sessionId: string
  ): Promise<{ success: boolean; images?: { imageMd5?: string; imageDatName?: string; createTime?: number }[]; error?: string }> {
    return getAllImageMessages(this.state, sessionId)
  }

  /**
   * 根据日期获取消息（用于日期跳转）
   * @param sessionId 会话ID
   * @param targetTimestamp 目标日期的 Unix 时间戳（秒）
   * @param limit 返回消息数量
   * @returns 返回目标日期当天或之后最近的消息列表
   */
  async getMessagesByDate(
    sessionId: string,
    targetTimestamp: number,
    limit: number = 50
  ): Promise<{ success: boolean; messages?: Message[]; targetIndex?: number; error?: string }> {
    return getMessagesByDate(this.state, sessionId, targetTimestamp, limit)
  }

  /**
   * 获取指定月份中有消息的日期列表
   * @param sessionId 会话ID
   * @param year 年份
   * @param month 月份 (1-12)
   * @returns 有消息的日期字符串列表 (YYYY-MM-DD)
   */
  async getDatesWithMessages(
    sessionId: string,
    year: number,
    month: number
  ): Promise<{ success: boolean; dates?: string[]; error?: string }> {
    return getDatesWithMessages(this.state, sessionId, year, month)
  }

  async getContact(username: string): Promise<Contact | null> {
    return getContact(username)
  }

  /**
   * 获取联系人头像和显示名称（用于群聊消息）
   */
  async getContactAvatar(username: string): Promise<{ avatarUrl?: string; displayName?: string; weComCorp?: string } | null> {
    return getContactAvatar(this.state, username)
  }

  /**
   * 解析转账消息中的付款方和收款方显示名称
   * 优先使用群昵称（从 chatroom_info 表），群昵称为空时回退到微信昵称/备注
   */
  async resolveTransferDisplayNames(
    chatroomId: string,
    payerUsername: string,
    receiverUsername: string
  ): Promise<{ payerName: string; receiverName: string }> {
    return resolveTransferDisplayNames(this.state, chatroomId, payerUsername, receiverUsername)
  }

  /**
   * 获取当前用户的头像 URL
   */
  async getMyAvatarUrl(): Promise<{ success: boolean; avatarUrl?: string; error?: string }> {
    return getMyAvatarUrl(this.state)
  }

  /**
   * 获取当前用户的完整信息（昵称、微信号、头像）
   */
  async getMyUserInfo(): Promise<{
    success: boolean
    userInfo?: {
      wxid: string
      nickName: string
      alias: string
      avatarUrl: string
    }
    error?: string
  }> {
    return getMyUserInfo(this.state)
  }

  /**
   * 从 misc.db 获取 UIN（微信账号ID）
   * UIN 用于表情包缓存解密的密钥派生
   */
  async getUinFromMiscDb(): Promise<string | null> {
    return getUinFromMiscDb()
  }

  /**
   * 获取表情包缓存解密所需的 UIN 和 keyString
   * - UIN: 从 misc.db 获取，或从配置读取
   * - keyString: 使用 myWxid（已在配置中）
   */
  async getEmoticonDecryptionParams(): Promise<{ uin: string | null; keyString: string | null }> {
    return getEmoticonDecryptionParams(this.state)
  }

  /**
   * 解密表情包缓存文件
   * 使用 AES-128-CBC (IV=Key) + XOR 掩码
   * 密钥派生: MD5(str(UIN) + keyString + "EMOTICON") → 小写十六进制 → 前16字符
   */
  async decryptEmoticonCache(filePath: string): Promise<Buffer | null> {
    return decryptEmoticonCache(this.state, filePath)
  }

  /**
   * 下载或获取表情包本地缓存
   * 如果 cdnUrl 为空但 md5 存在，则尝试通过本地存储或多种拼接规则下载
   */
  async downloadEmoji(cdnUrl: string, md5?: string, productId?: string, createTime?: number, encryptUrl?: string, aesKey?: string): Promise<{ success: boolean; localPath?: string; cachePath?: string; error?: string }> {
    return downloadEmoji(this.state, cdnUrl, md5, productId, createTime, encryptUrl, aesKey)
  }

  /**
   * 获取会话详情信息
   */
  async getSessionDetail(sessionId: string): Promise<{
    success: boolean
    detail?: {
      wxid: string
      displayName: string
      remark?: string
      nickName?: string
      alias?: string
      avatarUrl?: string
      messageCount: number
      firstMessageTime?: number
      latestMessageTime?: number
      messageTables: { dbName: string; tableName: string; count: number }[]
      errors?: StatsPartialError[]
      partialFailureCount?: number
    }
    error?: string
  }> {
    return getSessionDetail(this.state, sessionId)
  }

  /**
   * 获取单条消息
   */
  public async getMessageByLocalId(sessionId: string, localId: number): Promise<{ success: boolean; message?: Message; error?: string }> {
    return getMessageByLocalId(this.state, sessionId, localId)
  }

  /**
   * 从指定消息库/表读取消息。
   * randomMomentService 会先在具体表中抽样；这里必须用同一张表还原，避免 local_id 跨库/跨表重复导致消息和会话错配。
   */
  public async getMessageByLocalIdFromTable(
    sessionId: string,
    localId: number,
    tableName: string,
    dbPath: string
  ): Promise<{ success: boolean; message?: Message; error?: string }> {
    return getMessageByLocalIdFromTable(this.state, sessionId, localId, tableName, dbPath)
  }

  /**
   * 获取图片数据（base64）。
   * 与 WeFlow 一致，作为聊天页图片渲染的 localId 兜底通道。
   */
  async getImageData(sessionId: string, msgId: string, createTime?: number): Promise<{ success: boolean; data?: string; error?: string }> {
    return getImageData(this.state, sessionId, msgId, createTime)
  }

  /**
   * 获取语音数据（解码为 WAV base64）
   * 同一秒内可能有多条语音消息，需用 serverId 精确匹配，缺失时按 rowid 顺序映射兜底
   */
  async getVoiceData(
    sessionId: string,
    msgId: string,
    createTime?: number,
    serverId?: number
  ): Promise<{ success: boolean; data?: string; error?: string }> {
    return getVoiceData(this.state, sessionId, msgId, createTime, serverId)
  }

  /**
   * 启动自动增量同步（保留签名作为 no-op；实时同步已迁移到 monitorBridge）
   */
  startAutoSync(_intervalMs = 5000) {
    // no-op，等待 monitorBridge 推送
  }

  /**
   * 停止自动同步（保留签名作为 no-op）
   */
  stopAutoSync() {
    // no-op
  }

  /**
   * 检查数据库是否有更新（保留签名作为 no-op；真正的变更来自 monitorBridge）
   */
  async checkUpdates(_force: boolean = false) {
    // no-op
  }

  /**
   * 检查当前会话的新消息并推送（保留签名作为 no-op；真正的增量推送走 monitorBridge）
   */
  private async checkNewMessagesForCurrentSession(): Promise<void> {
    // no-op；等待 wcdb monitor 推送变更后再由 attachMonitor 处理
  }

  /**
   * 解析会话对应的消息表路径（可能跨多个 .db），供 randomMomentService 等模块使用。
   */
  public async getSessionMessageTables(sessionId: string): Promise<{ tableName: string; dbPath: string }[]> {
    return findSessionTables(this.state, sessionId)
  }
}

export const chatService = new ChatService()
