import type { IconComponent } from '@/types/icon'

export type ExportTab = 'chat' | 'database'

// 会话类型筛选
export type SessionTypeFilter = 'all' | 'group' | 'private'

export interface ChatSession {
  username: string
  displayName?: string
  avatarUrl?: string
  summary: string
  lastTimestamp: number
}

export interface ExportOptions {
  format: 'chatlab' | 'chatlab-jsonl' | 'json' | 'html' | 'txt' | 'excel' | 'sql'
  startDate: string
  endDate: string
  exportAvatars: boolean
  exportImages: boolean
  exportVideos: boolean
  exportEmojis: boolean
  exportVoices: boolean
}

export interface ExportResult {
  success: boolean
  successCount?: number
  failCount?: number
  outputPaths?: string[]
  error?: string
}

// 数据库导出：db_storage 下的单个加密库
export interface DatabaseFile {
  path: string
  name: string
  relativePath: string
  folder: string
  size: number
}

export interface ExportProgress {
  current: number
  total: number
  currentName: string
  phase: string
  detail: string
}

// 格式选择卡片的配置项
export interface FormatOption {
  value: string
  label: string
  icon: IconComponent
  desc: string
}
