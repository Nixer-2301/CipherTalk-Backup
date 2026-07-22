/**
 * transcribe_voice_message —— 按聊天消息定位语音，并使用当前 STT 配置转写。
 * 默认优先读取转写缓存；只有用户明确要求重新识别时才应传 force=true。
 */
import { tool } from 'ai'
import { z } from 'zod'
import { proxyAgentCapabilityCall } from '../agentCapabilityProxyClient'
import { describeToolError } from './shared'

export const transcribeVoiceMessage = tool({
  description:
    '转写 get_context / get_timeline 返回的语音消息。' +
    '仅在语音内容会影响当前结论时调用，sessionId、localId、createTime 必须原样使用工具返回值。' +
    '默认复用缓存；只有用户明确要求重新识别时才传 force=true。',
  inputSchema: z.object({
    sessionId: z.string().trim().min(1).describe('语音消息所在会话的 username'),
    localId: z.number().int().positive().describe('语音消息的 localId'),
    createTime: z.number().int().positive().describe('消息返回的原始 createTime，必须原样传入，不要换算单位'),
    force: z.boolean().default(false).describe('是否忽略缓存重新识别；仅在用户明确要求时使用'),
  }),
  execute: async ({ sessionId, localId, createTime, force = false }) => {
    try {
      return await proxyAgentCapabilityCall('transcribe_voice_message', {
        sessionId,
        localId,
        createTime,
        force,
      })
    } catch (error) {
      return {
        error: describeToolError(error, 'transcribe_voice_message 执行失败'),
        errorCode: 'INTERNAL_ERROR',
      }
    }
  },
})
