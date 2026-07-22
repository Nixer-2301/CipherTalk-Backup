import { ipcMain } from 'electron'
import { chatService } from '../../services/chatService'
import { pickRandomPrivateIncomingMoment } from '../../services/randomMomentService'
import type { MainProcessContext } from '../context'

/**
 * 聊天 IPC 与增量消息事件。
 * chat:new-messages 由 service 事件广播到所有未销毁窗口。
 */
export function registerChatHandlers(ctx: MainProcessContext): void {

  // 监听增量消息推送
  chatService.on('new-messages', (data) => {
    ctx.broadcastToWindows('chat:new-messages', data)
  })

  ipcMain.handle('chat:getMessage', async (_, sessionId: string, localId: number) => {
    return chatService.getMessageByLocalId(sessionId, localId)
  })

  /** 「回忆一刻」：直接扫消息库 + 完整解析校验，不依赖 message_index */
  ipcMain.handle('chat:pickRandomMomentFromIndex', async () => {
    try {
      return await pickRandomPrivateIncomingMoment()
    } catch (e) {
      const err = String(e)
      ctx.getLogService()?.warn('Chat', 'pickRandomMomentFromIndex 失败', { error: err })
      return { success: false, error: err, hint: `随机回忆失败：${err}` }
    }
  })
  ipcMain.handle('chat:connect', async () => {
    ctx.getLogService()?.info('Chat', '尝试连接聊天服务')
    const result = await chatService.connect()
    if (result.success) {
      ctx.getLogService()?.info('Chat', '聊天服务连接成功')
    } else {
      // 聊天连接失败可能是数据库未准备好，使用WARN级别
      ctx.getLogService()?.warn('Chat', '聊天服务连接失败', { error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getSessions', async (_, offset?: number, limit?: number) => {
    const result = await chatService.getSessions(offset, limit)
    if (!result.success) {
      // 获取会话失败可能是数据库未连接，使用WARN级别
      ctx.getLogService()?.warn('Chat', '获取会话列表失败', { error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:searchSessions', async (_, keyword: string) => {
    const result = await chatService.searchSessions(keyword)
    if (!result.success) {
      ctx.getLogService()?.warn('Chat', '搜索会话失败', { error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getMentionTargets', async (_, offset?: number, limit?: number, keyword?: string) => {
    const startedAt = Date.now()
    const logData = {
      offset,
      limit,
      keywordLength: String(keyword || '').trim().length,
      hasKeyword: !!String(keyword || '').trim(),
    }
    ctx.getLogService()?.warn('Chat', '[AgentMention] 获取 Agent @ 列表请求', logData)
    const result = await chatService.getMentionTargets(offset, limit, keyword)
    ctx.getLogService()?.warn('Chat', '[AgentMention] 获取 Agent @ 列表返回', {
      ...logData,
      success: result.success,
      sessions: Array.isArray(result.sessions) ? result.sessions.length : null,
      hasMore: result.hasMore,
      error: result.error,
      elapsedMs: Date.now() - startedAt,
    })
    if (!result.success) {
      ctx.getLogService()?.warn('Chat', '获取 Agent @ 列表失败', { error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getContacts', async () => {
    const result = await chatService.getContacts()
    if (!result.success) {
      ctx.getLogService()?.warn('Chat', '获取通讯录失败', { error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getMessages', async (_, sessionId: string, offset?: number, limit?: number) => {
    const result = await chatService.getMessages(sessionId, offset, limit)
    if (!result.success) {
      // 获取消息失败可能是数据库未连接，使用WARN级别
      ctx.getLogService()?.warn('Chat', '获取消息失败', { sessionId, error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getMessagesBefore', async (
    _,
    sessionId: string,
    cursorSortSeq: number,
    limit?: number,
    cursorCreateTime?: number,
    cursorLocalId?: number
  ) => {
    const result = await chatService.getMessagesBefore(sessionId, cursorSortSeq, limit, cursorCreateTime, cursorLocalId)
    if (!result.success) {
      ctx.getLogService()?.warn('Chat', '按游标获取更早消息失败', {
        sessionId,
        cursorSortSeq,
        cursorCreateTime,
        cursorLocalId,
        error: result.error
      })
    }
    return result
  })

  ipcMain.handle('chat:getMessagesAfter', async (
    _,
    sessionId: string,
    cursorSortSeq: number,
    limit?: number,
    cursorCreateTime?: number,
    cursorLocalId?: number
  ) => {
    const result = await chatService.getMessagesAfter(sessionId, cursorSortSeq, limit, cursorCreateTime, cursorLocalId)
    if (!result.success) {
      ctx.getLogService()?.warn('Chat', '按游标获取更新消息失败', {
        sessionId,
        cursorSortSeq,
        cursorCreateTime,
        cursorLocalId,
        error: result.error
      })
    }
    return result
  })

  ipcMain.handle('chat:getNewMessages', async (_, sessionId: string, minTime: number, limit?: number) => {
    const result = await chatService.getNewMessages(sessionId, minTime, limit)
    if (!result.success) {
      ctx.getLogService()?.warn('Chat', '获取新增消息失败', { sessionId, minTime, error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getAllVoiceMessages', async (_, sessionId: string) => {
    const result = await chatService.getAllVoiceMessages(sessionId)

    // 确保 messages 是数组
    if (result.success && result.messages) {
      // 简化消息对象，只保留必要字段
      const simplifiedMessages = result.messages.map(msg => ({
        localId: msg.localId,
        serverId: msg.serverId,
        localType: msg.localType,
        createTime: msg.createTime,
        sortSeq: msg.sortSeq,
        isSend: msg.isSend,
        senderUsername: msg.senderUsername,
        parsedContent: msg.parsedContent || '',
        rawContent: msg.rawContent || '',
        voiceDuration: msg.voiceDuration
      }))

      return {
        success: true,
        messages: simplifiedMessages
      }
    }

    if (!result.success) {
      ctx.getLogService()?.warn('Chat', '获取所有语音消息失败', { sessionId, error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getAllImageMessages', async (_, sessionId: string) => {
    return chatService.getAllImageMessages(sessionId)
  })

  ipcMain.handle('chat:getImageData', async (_, sessionId: string, msgId: string, createTime?: number) => {
    return chatService.getImageData(sessionId, msgId, createTime)
  })

  ipcMain.handle('chat:getContact', async (_, username: string) => {
    return chatService.getContact(username)
  })

  ipcMain.handle('chat:getContactAvatar', async (_, username: string) => {
    return chatService.getContactAvatar(username)
  })

  ipcMain.handle('chat:resolveTransferDisplayNames', async (_, chatroomId: string, payerUsername: string, receiverUsername: string) => {
    return chatService.resolveTransferDisplayNames(chatroomId, payerUsername, receiverUsername)
  })

  ipcMain.handle('chat:getMyAvatarUrl', async () => {
    const result = chatService.getMyAvatarUrl()
    // 首页会调用这个接口，失败是正常的，不记录错误日志
    return result
  })

  ipcMain.handle('chat:getMyUserInfo', async () => {
    const result = chatService.getMyUserInfo()
    // 首页会调用这个接口，失败是正常的，不记录错误日志
    return result
  })

  ipcMain.handle('chat:downloadEmoji', async (_, cdnUrl: string, md5?: string, productId?: string, createTime?: number, encryptUrl?: string, aesKey?: string) => {
    const result = await chatService.downloadEmoji(cdnUrl, md5, productId, createTime, encryptUrl, aesKey)
    if (!result.success) {
      ctx.getLogService()?.warn('Chat', '下载表情失败', { cdnUrl, error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:resolveEmojiPath', async (_, md5?: string, cdnUrl?: string, productId?: string, createTime?: number, encryptUrl?: string, aesKey?: string) => {
    const result = await chatService.downloadEmoji(cdnUrl || '', md5, productId, createTime, encryptUrl, aesKey)
    if (!result.success) {
      ctx.getLogService()?.warn('Chat', '解析表情缓存路径失败', { md5, cdnUrl, error: result.error })
      return result
    }
    return {
      success: true,
      cachePath: result.cachePath,
      localPath: result.localPath
    }
  })

  ipcMain.handle('chat:close', async () => {
    ctx.getLogService()?.info('Chat', '关闭聊天服务')
    chatService.close()
    return true
  })

  ipcMain.handle('chat:refreshCache', async () => {
    ctx.getLogService()?.info('Chat', '刷新消息缓存')
    chatService.refreshMessageDbCache()
    return true
  })

  ipcMain.handle('chat:setCurrentSession', async (_, sessionId: string | null) => {
    chatService.setCurrentSession(sessionId)
    return true
  })

  ipcMain.handle('chat:getSessionDetail', async (_, sessionId: string) => {
    const result = await chatService.getSessionDetail(sessionId)
    if (!result.success) {
      // 获取会话详情失败可能是数据库未连接，使用WARN级别
      ctx.getLogService()?.warn('Chat', '获取会话详情失败', { sessionId, error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getVoiceData', async (_, sessionId: string, msgId: string, createTime?: number, serverId?: number) => {
    const result = await chatService.getVoiceData(sessionId, msgId, createTime, serverId)
    if (!result.success) {
      ctx.getLogService()?.warn('Chat', '获取语音数据失败', { sessionId, msgId, createTime, serverId, error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getMessagesByDate', async (_, sessionId: string, targetTimestamp: number, limit?: number) => {
    const result = await chatService.getMessagesByDate(sessionId, targetTimestamp, limit)
    if (!result.success) {
      ctx.getLogService()?.warn('Chat', '按日期获取消息失败', { sessionId, targetTimestamp, error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getDatesWithMessages', async (_, sessionId: string, year: number, month: number) => {
    const result = await chatService.getDatesWithMessages(sessionId, year, month)
    if (!result.success) {
      ctx.getLogService()?.warn('Chat', '获取有消息日期失败', { sessionId, year, month, error: result.error })
    }
    return result
  })

  // 朋友圈相关

}
