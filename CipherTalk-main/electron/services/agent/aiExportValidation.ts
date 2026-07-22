import type {
  AiExportDateRange,
  AiExportFollowUpQuestion,
  AiExportFormat,
  AiExportMediaOptions,
  AiExportMissingField,
} from './aiExportTypes'

export const AI_EXPORT_FORMATS = ['chatlab', 'chatlab-jsonl', 'json', 'html', 'excel', 'sql'] as const

const REQUIRED_MEDIA_OPTION_KEYS: Array<keyof AiExportMediaOptions> = [
  'exportAvatars',
  'exportImages',
  'exportVideos',
  'exportEmojis',
  'exportVoices',
]

export function isSupportedAiExportFormat(value: unknown): value is AiExportFormat {
  return typeof value === 'string' && (AI_EXPORT_FORMATS as readonly string[]).includes(value)
}

export function normalizeExportTimestampSeconds(value: number): number {
  if (!Number.isFinite(value)) return value
  return value > 1_000_000_000_000 ? Math.floor(value / 1000) : Math.floor(value)
}

export function normalizeAiExportDateRange(value: Partial<AiExportDateRange> | undefined): AiExportDateRange | null {
  if (!value || typeof value.start !== 'number' || typeof value.end !== 'number') return null
  const start = normalizeExportTimestampSeconds(value.start)
  const end = normalizeExportTimestampSeconds(value.end)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= 0 || start > end) return null
  return { start, end }
}

export function normalizeAiExportMediaOptions(value: Partial<AiExportMediaOptions> | undefined): AiExportMediaOptions | null {
  if (!value) return null
  for (const key of REQUIRED_MEDIA_OPTION_KEYS) {
    if (typeof value[key] !== 'boolean') return null
  }
  return {
    exportAvatars: value.exportAvatars as boolean,
    exportImages: value.exportImages as boolean,
    exportVideos: value.exportVideos as boolean,
    exportEmojis: value.exportEmojis as boolean,
    exportVoices: value.exportVoices as boolean,
  }
}

export function buildAiExportFollowUpQuestions(fields: AiExportMissingField[]): AiExportFollowUpQuestion[] {
  const uniqueFields = Array.from(new Set(fields))
  return uniqueFields.map((field) => {
    switch (field) {
      case 'session':
        return { field, question: '要导出哪个聊天会话？请给出联系人、群名或明确的 sessionId。' }
      case 'dateRange':
        return { field, question: '要导出哪段时间？请给出开始和结束时间。' }
      case 'format':
        return { field, question: '要导出成哪种格式？可选 chatlab、chatlab-jsonl、json、html、excel、sql。' }
      case 'mediaOptions':
        return { field, question: '请明确是否导出头像、图片、视频、表情、语音这五项媒体内容。' }
      case 'outputDir':
        return { field, question: '请提供一个可写的导出目录。' }
      case 'confirmation':
        return { field, question: '参数已齐全。确认开始导出吗？确认后我才会写入文件。' }
    }
  })
}
