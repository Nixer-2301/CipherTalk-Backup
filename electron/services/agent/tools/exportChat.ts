import { tool } from 'ai'
import { z } from 'zod'
import { proxyAiExportCall } from '../aiExportProxyClient'
import type { AiExportChatArgs, AiExportChatResult, AiExportProgress } from '../aiExportTypes'
import { reportAgentProgress } from '../progress'

function titleForProgress(progress: AiExportProgress): string {
  switch (progress.phase) {
    case 'validating':
      return '校验导出请求'
    case 'resolving':
      return '解析导出会话'
    case 'preparing':
      return '准备导出'
    case 'exporting':
    case 'writing':
      return '导出聊天记录'
    case 'complete':
      return '聊天记录导出完成'
    case 'failed':
      return '聊天记录导出失败'
    case 'aborted':
      return '聊天记录导出已取消'
  }
}

function detailForProgress(progress: AiExportProgress): string | undefined {
  const parts = [
    progress.currentSession,
    progress.detail || progress.message,
    typeof progress.current === 'number' && typeof progress.total === 'number'
      ? `${progress.current}/${progress.total}`
      : '',
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

export const exportChat = tool({
  description:
    '自动化导出一个聊天会话。先用 validateOnly=true 校验参数；参数齐全但 confirmed 不是 true 时只返回 requiresConfirmation=true，不写文件。' +
    '用户明确最终确认后，才用 confirmed=true 执行导出。支持格式 chatlab、chatlab-jsonl、json、html、excel、sql；不支持 txt。' +
    'mediaOptions 必须显式给出 exportAvatars、exportImages、exportVideos、exportEmojis、exportVoices 五个布尔值。',
  inputSchema: z.object({
    sessionId: z.string().optional().describe('会话 username。若没有明确 username，可改用 query 做模糊解析。'),
    query: z.string().optional().describe('联系人名、群名或关键词，用于模糊解析唯一会话。'),
    format: z.enum(['chatlab', 'chatlab-jsonl', 'json', 'html', 'excel', 'sql']).optional().describe('导出格式；不开放 txt。'),
    dateRange: z.object({
      start: z.number().optional().describe('开始时间，秒或毫秒时间戳。'),
      end: z.number().optional().describe('结束时间，秒或毫秒时间戳。'),
    }).optional(),
    mediaOptions: z.object({
      exportAvatars: z.boolean().optional(),
      exportImages: z.boolean().optional(),
      exportVideos: z.boolean().optional(),
      exportEmojis: z.boolean().optional(),
      exportVoices: z.boolean().optional(),
    }).optional().describe('必须显式包含头像、图片、视频、表情、语音五项布尔值。'),
    outputDir: z.string().optional().describe('导出目录；不传则使用设置里的 exportPath。'),
    validateOnly: z.boolean().optional().describe('只校验/解析，不导出。'),
    confirmed: z.boolean().optional().describe('用户已最终确认时才传 true。'),
  }),
  execute: async (input, { abortSignal, toolCallId }) => {
    try {
      const result = await proxyAiExportCall<AiExportChatResult>(
        'exportChat',
        input as AiExportChatArgs as Record<string, unknown>,
        {
          signal: abortSignal,
          onProgress: (progress) => {
            reportAgentProgress({
              stage: progress.phase === 'complete' ? 'tool_finished' : progress.phase === 'failed' || progress.phase === 'aborted' ? 'error' : 'tool_started',
              title: titleForProgress(progress),
              detail: detailForProgress(progress),
              category: 'tool',
              toolName: 'export_chat',
              toolCallId: typeof toolCallId === 'string' ? toolCallId : undefined,
              sessionsScanned: progress.total,
            })
          },
        },
      )
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        canExport: false,
        requiresConfirmation: false,
        missingFields: [],
        followUpQuestions: [],
        success: false,
        error: message.includes('EXPORT_ABORTED') ? 'EXPORT_ABORTED' : message,
        message: message.includes('EXPORT_ABORTED') ? '导出已取消。' : message,
      } satisfies AiExportChatResult
    }
  },
})

