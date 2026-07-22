/**
 * get_context —— 按锚点展开某条消息前后的上下文原文，用于核对与标注出处。
 * 锚点来自 search_messages / semantic_search 命中里的 anchor 字段。
 * 读原微信库（经 chatService，子进程内由 wcdb 代理转发到主进程）。
 */
import { tool } from 'ai'
import { z } from 'zod'
import { compactMessage, describeToolError, evidenceFromMessage, resolveSenders, type CompactMessage } from './shared'
import type { Message } from '../../chat/types'

function sameAnchorMessage(
  message: Pick<Message, 'localId' | 'sortSeq' | 'createTime'>,
  anchor: { localId: number; sortSeq: number; createTime: number },
): boolean {
  return Number(message.localId) === Number(anchor.localId) &&
    Number(message.sortSeq) === Number(anchor.sortSeq) &&
    Number(message.createTime) === Number(anchor.createTime)
}

export const getContext = tool({
  description:
    '展开某条消息前后的上下文原文，用来核对事实、引用出处。' +
    '入参直接用 search_messages / semantic_search 命中结果里的 anchor 字段（sessionId/sortSeq/createTime/localId 原样填）。' +
    '返回锚点前后各若干条消息（时间 + 发送者 + 原文），方便按"时间 + 发送者"标注出处。',
  inputSchema: z.object({
    sessionId: z.string().describe('会话 username（anchor.sessionId）'),
    sortSeq: z.number().describe('锚点 sortSeq（anchor.sortSeq）'),
    createTime: z.number().describe('锚点 createTime（anchor.createTime，原样传入）'),
    localId: z.number().describe('锚点 localId（anchor.localId）'),
    radius: z.number().int().min(1).max(30).default(6).describe('锚点前后各取多少条'),
  }),
  execute: async ({ sessionId, sortSeq, createTime, localId, radius }) => {
    try {
      const { chatService } = await import('../../chatService')
      const anchor = { sessionId, sortSeq, createTime, localId }
      const [beforeRes, anchorRes, afterRes] = await Promise.all([
        chatService.getMessagesBefore(sessionId, sortSeq, radius, createTime, localId),
        chatService.getMessageByLocalId(sessionId, localId),
        chatService.getMessagesAfter(sessionId, sortSeq, radius, createTime, localId),
      ])
      const anchorMessage = anchorRes.success && anchorRes.message && sameAnchorMessage(anchorRes.message, anchor)
        ? anchorRes.message
        : null
      const anchorMismatch = Boolean(anchorRes.success && anchorRes.message && !anchorMessage)

      const collected = [
        ...(beforeRes.success ? beforeRes.messages || [] : []),
        ...(anchorMessage ? [anchorMessage] : []),
        ...(afterRes.success ? afterRes.messages || [] : []),
      ]

      // 去重 + 按时间升序。localId 可跨库/跨表重复，锚点 localId 必须同时匹配 sortSeq/createTime。
      const seen = new Set<string>()
      const ordered = collected
        .filter((m) => {
          if (Number(m.localId) === Number(localId) && !sameAnchorMessage(m, anchor)) return false
          const key = `${m.localId}:${m.sortSeq}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        .sort((a, b) => a.sortSeq - b.sortSeq || a.createTime - b.createTime || a.localId - b.localId)

      if (ordered.length === 0) {
        return { sessionId, messages: [] as CompactMessage[], note: '未取到上下文（会话可能未加载，或锚点无效）' }
      }

      const senderMap = await resolveSenders(ordered.map((m) => m.senderUsername || ''))
      const messages = ordered.map((m) => compactMessage(m, senderMap.get(m.senderUsername || '')))
      return {
        sessionId,
        anchorLocalId: localId,
        ...(anchorMismatch
          ? { note: '锚点 localId 命中了不同 sortSeq/createTime 的旧消息，已丢弃该 localId 冲突结果。' }
          : {}),
        messages,
        evidence: messages.map((message) => evidenceFromMessage(sessionId, message)),
      }
    } catch (error) {
      return { error: describeToolError(error, 'get_context 执行失败') }
    }
  },
})
