export type AiExportFormat = 'chatlab' | 'chatlab-jsonl' | 'json' | 'html' | 'excel' | 'sql'

export interface AiExportDateRange {
  start: number
  end: number
}

export interface AiExportMediaOptions {
  exportAvatars: boolean
  exportImages: boolean
  exportVideos: boolean
  exportEmojis: boolean
  exportVoices: boolean
}

export type AiExportMissingField =
  | 'session'
  | 'dateRange'
  | 'format'
  | 'mediaOptions'
  | 'outputDir'
  | 'confirmation'

export interface AiExportFollowUpQuestion {
  field: AiExportMissingField
  question: string
}

export interface AiExportSessionCandidate {
  sessionId: string
  displayName: string
  kind: 'group' | 'friend' | 'official' | 'other'
  score: number
  confidence: 'high' | 'medium' | 'low'
  aliases: string[]
  evidence: string[]
}

export interface AiExportChatArgs {
  sessionId?: string
  query?: string
  format?: AiExportFormat
  dateRange?: Partial<AiExportDateRange>
  mediaOptions?: Partial<AiExportMediaOptions>
  outputDir?: string
  validateOnly?: boolean
  confirmed?: boolean
}

export interface AiExportProgress {
  phase: 'validating' | 'resolving' | 'preparing' | 'exporting' | 'writing' | 'complete' | 'failed' | 'aborted'
  message: string
  current?: number
  total?: number
  currentSession?: string
  detail?: string
}

export interface AiExportChatResult {
  canExport: boolean
  requiresConfirmation: boolean
  missingFields: AiExportMissingField[]
  followUpQuestions: AiExportFollowUpQuestion[]
  resolvedSession?: AiExportSessionCandidate
  candidates?: AiExportSessionCandidate[]
  outputDir?: string
  outputPaths?: string[]
  format?: AiExportFormat
  dateRange?: AiExportDateRange
  mediaOptions?: AiExportMediaOptions
  success?: boolean
  successCount?: number
  failCount?: number
  error?: string
  message: string
}

export interface AiExportCallPayload {
  requestId: string
  args: AiExportChatArgs
}

