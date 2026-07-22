/**
 * send_random_image —— 从聊天记录里随机抽一张图片作为当前会话回复附件（彩蛋）。
 * 在 message_index 已索引行里随机取 localType=3 消息，经 chatService.getImageData
 * 解密成纯图片字节后落盘到 ai-images，前端用 local-image:// 展示（同 generate_image）。
 */
import { tool } from 'ai'
import { z } from 'zod'
import * as fs from 'fs'
import * as path from 'path'
import { detectImageExtension } from '../../chat/emoji'
import { resolveSenders, toLocalTime } from './shared'
import { bootstrapIndexRecentSessions, getAiImageOutputDir } from './stickers'

const MAX_ATTEMPTS = 5 // 抽到的消息可能解密失败（缺原图），多试几次

export const sendRandomImage = tool({
  description:
    '从本地聊天记录里随机抽一张历史图片作为当前会话回复附件（盲盒彩蛋）。' +
    '仅当用户明确要求"随机发张图/抽张图/来张老照片"这类玩法时使用，不要主动发。' +
    '可用 sessionId 限定从某个会话里抽；不得指定联系人、群或 toUserId。图片会自动回复到当前会话，回答时提一下来源（谁/何时）即可，不要输出路径。',
  inputSchema: z.object({
    sessionId: z.string().optional().describe('限定某会话/群（username，来自 list_contacts）；不传则全库随机'),
  }),
  execute: async ({ sessionId }) => {
    try {
      const { chatSearchIndexService } = await import('../../search/chatSearchIndexService')
      const { chatService } = await import('../../chatService')

      let bootstrapped = false
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        let pick = chatSearchIndexService.pickRandomImageMessage(sessionId)
        if (!pick && !bootstrapped) {
          // 索引里还没有图片消息：给最近会话补建索引后重试
          bootstrapped = true
          if (sessionId) {
            await chatSearchIndexService.listSessionMemoryMessages(sessionId, undefined, 5000)
          } else {
            await bootstrapIndexRecentSessions()
          }
          pick = chatSearchIndexService.pickRandomImageMessage(sessionId)
        }
        if (!pick) {
          return { error: sessionId ? '该会话索引里没有图片消息' : '消息索引里没有图片消息' }
        }

        const res = await chatService.getImageData(pick.sessionId, String(pick.localId), pick.createTime)
        if (!res.success || !res.data) continue

        const buffer = Buffer.from(res.data, 'base64')
        const ext = detectImageExtension(buffer) || '.jpg'
        const dir = await getAiImageOutputDir()
        if (!dir) return { error: '缓存目录不可用' }
        const safeSession = pick.sessionId.replace(/[^a-zA-Z0-9_@.-]/g, '_')
        const filePath = path.join(dir, `random-${safeSession}-${pick.localId}${ext}`)
        if (!fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, buffer)
        }

        const names = await resolveSenders([pick.sessionId, pick.senderUsername || ''])
        const sessionName = names.get(pick.sessionId) || pick.sessionId
        const senderName = pick.isSend === 1
          ? '我'
          : names.get(pick.senderUsername || '') || pick.senderUsername || undefined
        return {
          success: true,
          filePath,
          from: sessionName,
          sender: senderName,
          time: toLocalTime(pick.createTime),
          note: '图片已准备作为当前会话回复附件，回答里提一下来源即可，不要输出路径或链接',
        }
      }
      return { error: '连续抽到的图片都无法解密（可能缺少原图缓存），可以再试一次' }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
})
