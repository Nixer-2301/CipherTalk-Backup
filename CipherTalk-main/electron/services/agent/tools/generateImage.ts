/**
 * generate_image —— AI 作图工具（见 services/ai/imageGenService）。
 * 仅在用户配置并启用「AI 作图」时才挂进工具集（见 tools/index.ts buildTools / engine.ts）。
 * 生成的图片落盘到 cachePath/ai-images，前端按 filePath 用 local-image:// 协议直接展示。
 */
import { tool } from 'ai'
import { z } from 'zod'
import fs from 'fs'
import { generateImageToFile } from '../../ai/imageGenService'

export const generateImage = tool({
  description:
    '根据文字描述生成一张图片（AI 作图）。用户要求画图/作图/生成图片/配图时使用。' +
    'prompt 用具体、生动的描述（主体、风格、构图、色调），中英文皆可。' +
    '必须按画面构图自行选择 size：风景/宽场景用横图，人像/全身/手机壁纸用竖图，图标/头像/无明确方向用方图。' +
    '生成的图片会自动展示给用户；用户明确说“只要图/不要文字”时无需补充文字，否则简要说明画了什么。不要输出图片路径或链接。',
  inputSchema: z.object({
    prompt: z.string().min(1).describe('图片描述（提示词），尽量具体：主体、风格、构图、色调等'),
    size: z
      .string()
      .optional()
      .describe(
        '图片尺寸，格式 宽x高。按构图选择横/竖/方图，如横图 1792x1024、竖图 1024x1792、方图 1024x1024。' +
          '用户未指定比例时必须自行挑选，不要省略。若服务商报错不支持该尺寸，换用报错信息里支持的尺寸重试，没给就省略 size 重试。',
      ),
  }),
  execute: async ({ prompt, size }, { abortSignal }) => {
    const res = await generateImageToFile(prompt, { size, signal: abortSignal })
    if (!res.success) {
      return { error: res.error || '图片生成失败' }
    }
    if (!res.filePath || !fs.existsSync(res.filePath)) {
      return { error: '图片生成接口返回成功，但没有生成可读取的本地图片文件' }
    }
    const stat = fs.statSync(res.filePath)
    if (stat.size <= 0) {
      return { error: '图片生成接口返回成功，但生成的本地图片文件为空' }
    }
    return {
      success: true,
      filePath: res.filePath,
      mimeType: res.mimeType,
      note: '图片已生成并自动展示给用户，无需在回答中粘贴路径或链接',
    }
  },
})
