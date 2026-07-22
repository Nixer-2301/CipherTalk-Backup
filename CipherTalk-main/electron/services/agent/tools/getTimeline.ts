/**
 * get_timeline —— 按时间顺序读取某会话在指定时间窗内的消息原文。
 * 适合"某天/某段时间聊了啥""把这段对话讲清楚"。读原微信库（经 chatService → wcdb 代理）。
 */
import { tool } from 'ai'
import { z } from 'zod'
import { compactMessage, evidenceFromMessage, resolveSenders, msToSeconds } from './shared'

export const getTimeline = tool({
  description:
    '按时间顺序读取某个会话在指定时间窗内的连续消息原文，适合"某天/某段时间聊了什么""把这段对话讲清楚"。' +
    '必须指定 sessionId（先用 list_contacts 拿 username）。不给时间范围则取最近的一段。' +
    '只读单个会话的连续时间线；跨会话找内容用 search_messages / semantic_search。',
  inputSchema: z.object({
    sessionId: z.string().describe('会话 username（来自 list_contacts）'),
    startTimeMs: z.number().optional().describe('起始时间，毫秒时间戳'),
    endTimeMs: z.number().optional().describe('结束时间，毫秒时间戳；留空表示到现在'),
    limit: z.number().int().min(1).max(200).default(50).describe('返回条数上限'),
  }),
  execute: async ({ sessionId, startTimeMs, endTimeMs, limit }) => {
    try {
      const { chatService } = await import('../../chatService')
      const res = await chatService.getMessagesByTimeRangeForSummary(sessionId, {
        startTime: msToSeconds(startTimeMs),
        endTime: msToSeconds(endTimeMs) ?? Math.floor(Date.now() / 1000),
        limit,
      })
      if (!res.success) return { error: res.error || '读取时间线失败' }

      const ordered = (res.messages || [])
        .slice()
        .sort((a, b) => a.sortSeq - b.sortSeq || a.createTime - b.createTime || a.localId - b.localId)
      const senderMap = await resolveSenders(ordered.map((m) => m.senderUsername || ''))
      const messages = ordered.map((m) => compactMessage(m, senderMap.get(m.senderUsername || '')))
      return {
        sessionId,
        hasMore: !!res.hasMore,
        messages,
        evidence: messages.map((message) => evidenceFromMessage(sessionId, message)),
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
})
