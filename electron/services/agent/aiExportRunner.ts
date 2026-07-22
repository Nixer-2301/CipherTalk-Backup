import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import { ConfigService } from '../config'
import { chatService } from '../chatService'
import type { ChatSession, ContactInfo } from '../chat/types'
import { exportService, type ExportOptions, type ExportProgress } from '../exportService'
import type {
  AiExportChatArgs,
  AiExportChatResult,
  AiExportFollowUpQuestion,
  AiExportFormat,
  AiExportMediaOptions,
  AiExportMissingField,
  AiExportProgress,
  AiExportSessionCandidate,
} from './aiExportTypes'
import {
  buildAiExportFollowUpQuestions,
  isSupportedAiExportFormat,
  normalizeAiExportDateRange,
  normalizeAiExportMediaOptions,
} from './aiExportValidation'

const MAX_SESSION_RESOLVE_ITEMS = 5000

const aiExportArgsSchema = z.object({
  sessionId: z.string().trim().min(1).optional(),
  query: z.string().trim().min(1).optional(),
  format: z.string().trim().optional(),
  dateRange: z.object({
    start: z.number().optional(),
    end: z.number().optional(),
  }).optional(),
  mediaOptions: z.object({
    exportAvatars: z.boolean().optional(),
    exportImages: z.boolean().optional(),
    exportVideos: z.boolean().optional(),
    exportEmojis: z.boolean().optional(),
    exportVoices: z.boolean().optional(),
  }).optional(),
  outputDir: z.string().trim().min(1).optional(),
  validateOnly: z.boolean().optional(),
  confirmed: z.boolean().optional(),
}).passthrough()

interface SessionCatalogItem {
  sessionId: string
  displayName: string
  kind: AiExportSessionCandidate['kind']
  aliases: string[]
}

interface OutputDirCheck {
  ok: boolean
  dir?: string
  source: 'explicit' | 'config' | 'none'
  reason?: string
}

function compactStrings(values: Array<string | undefined | null>): string[] {
  return Array.from(new Set(values
    .map((item) => String(item || '').trim())
    .filter(Boolean)))
}

function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function includesSequentially(text: string, query: string): boolean {
  let cursor = 0
  for (const ch of query) {
    cursor = text.indexOf(ch, cursor)
    if (cursor === -1) return false
    cursor += 1
  }
  return true
}

function scoreAlias(alias: string, query: string): number {
  const value = normalizeText(alias)
  const q = normalizeText(query)
  if (!value || !q) return 0
  if (value === q) return 1000
  if (value.startsWith(q)) return 820
  if (value.includes(q)) return 640
  if (q.includes(value) && value.length >= 2) return 420
  if (includesSequentially(value, q)) return 260
  return 0
}

function confidenceFromScore(score: number): AiExportSessionCandidate['confidence'] {
  if (score >= 900) return 'high'
  if (score >= 600) return 'medium'
  return 'low'
}

function inferKind(username: string, contact?: ContactInfo): AiExportSessionCandidate['kind'] {
  if (contact?.type === 'group' || username.endsWith('@chatroom')) return 'group'
  if (contact?.type === 'official' || username.startsWith('gh_')) return 'official'
  if (contact?.type === 'friend' || username.startsWith('wxid_')) return 'friend'
  return 'other'
}

function toCatalogCandidate(item: SessionCatalogItem, score: number, evidence: string[]): AiExportSessionCandidate {
  return {
    sessionId: item.sessionId,
    displayName: item.displayName || item.sessionId,
    kind: item.kind,
    score,
    confidence: confidenceFromScore(score),
    aliases: item.aliases,
    evidence,
  }
}

function hasStrongUniqueWinner(candidates: AiExportSessionCandidate[]): boolean {
  if (candidates.length !== 1) {
    const [first, second] = candidates
    return Boolean(first && second && first.score >= 640 && first.score - second.score >= 140)
  }
  return candidates[0].score >= 640
}

async function loadSessionCatalog(): Promise<SessionCatalogItem[]> {
  const [sessionsResult, contactsResult] = await Promise.all([
    chatService.getSessions(0, MAX_SESSION_RESOLVE_ITEMS),
    chatService.getContacts(),
  ])

  if (!sessionsResult.success) {
    throw new Error(sessionsResult.error || '读取会话列表失败')
  }
  if (!contactsResult.success) {
    throw new Error(contactsResult.error || '读取联系人列表失败')
  }

  const sessions = sessionsResult.sessions || []
  const contacts = contactsResult.contacts || []
  const contactByUsername = new Map<string, ContactInfo>()
  for (const contact of contacts) {
    if (contact.username) contactByUsername.set(contact.username, contact)
  }

  const bySession = new Map<string, SessionCatalogItem>()
  const upsert = (username: string, session?: ChatSession, contact?: ContactInfo): void => {
    const displayName = contact?.remark || session?.displayName || contact?.displayName || contact?.nickname || username
    const aliases = compactStrings([
      username,
      displayName,
      session?.displayName,
      contact?.displayName,
      contact?.remark,
      contact?.nickname,
    ])
    const existing = bySession.get(username)
    if (existing) {
      existing.displayName = existing.displayName || displayName
      existing.aliases = compactStrings([...existing.aliases, ...aliases])
      return
    }
    bySession.set(username, {
      sessionId: username,
      displayName,
      kind: inferKind(username, contact),
      aliases,
    })
  }

  for (const session of sessions) {
    upsert(session.username, session, contactByUsername.get(session.username))
  }
  for (const contact of contacts) {
    upsert(contact.username, undefined, contact)
  }

  return Array.from(bySession.values())
}

async function resolveExportSession(args: AiExportChatArgs): Promise<{
  resolvedSession?: AiExportSessionCandidate
  candidates?: AiExportSessionCandidate[]
}> {
  const query = String(args.sessionId || args.query || '').trim()
  if (!query) return {}

  const catalog = await loadSessionCatalog()
  const exact = catalog.find((item) => item.sessionId === query || item.aliases.some((alias) => normalizeText(alias) === normalizeText(query)))
  if (exact) {
    return {
      resolvedSession: toCatalogCandidate(exact, 1000, ['exact match']),
      candidates: [toCatalogCandidate(exact, 1000, ['exact match'])],
    }
  }

  const candidates = catalog
    .map((item) => {
      let bestScore = 0
      const evidence: string[] = []
      for (const alias of item.aliases) {
        const score = scoreAlias(alias, query)
        if (score > bestScore) {
          bestScore = score
          evidence.splice(0, evidence.length, alias)
        } else if (score === bestScore && score > 0) {
          evidence.push(alias)
        }
      }
      return bestScore > 0 ? toCatalogCandidate(item, bestScore, compactStrings(evidence).slice(0, 3)) : null
    })
    .filter((item): item is AiExportSessionCandidate => Boolean(item))
    .sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName))
    .slice(0, 8)

  if (hasStrongUniqueWinner(candidates)) {
    return { resolvedSession: candidates[0], candidates }
  }

  return { candidates }
}

function findExistingParent(dir: string): string | null {
  let current = path.resolve(dir)
  while (current && current !== path.dirname(current)) {
    if (fs.existsSync(current)) return current
    current = path.dirname(current)
  }
  return fs.existsSync(current) ? current : null
}

function isWritableTargetDirectory(dir: string): { ok: boolean; reason?: string } {
  const resolved = path.resolve(dir)
  try {
    if (fs.existsSync(resolved)) {
      const stat = fs.statSync(resolved)
      if (!stat.isDirectory()) return { ok: false, reason: '目标路径不是目录' }
      fs.accessSync(resolved, fs.constants.W_OK)
      return { ok: true }
    }

    const parent = findExistingParent(resolved)
    if (!parent) return { ok: false, reason: '找不到可用的父目录' }
    fs.accessSync(parent, fs.constants.W_OK)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

function resolveOutputDir(explicitOutputDir?: string): OutputDirCheck {
  const explicit = String(explicitOutputDir || '').trim()
  if (explicit) {
    const check = isWritableTargetDirectory(explicit)
    return { ok: check.ok, dir: path.resolve(explicit), source: 'explicit', reason: check.reason }
  }

  const config = new ConfigService()
  try {
    const configured = String(config.get('exportPath') || '').trim()
    if (!configured) return { ok: false, source: 'none', reason: '未配置默认导出目录' }
    const check = isWritableTargetDirectory(configured)
    return { ok: check.ok, dir: path.resolve(configured), source: 'config', reason: check.reason }
  } finally {
    config.close()
  }
}

function uniqueFields(fields: AiExportMissingField[]): AiExportMissingField[] {
  return Array.from(new Set(fields))
}

function formatMissingResult(input: {
  missingFields: AiExportMissingField[]
  resolvedSession?: AiExportSessionCandidate
  candidates?: AiExportSessionCandidate[]
  outputDir?: string
  format?: AiExportFormat
  dateRange?: { start: number; end: number }
  mediaOptions?: AiExportMediaOptions
  message?: string
  error?: string
}): AiExportChatResult {
  const missingFields = uniqueFields(input.missingFields)
  return {
    canExport: false,
    requiresConfirmation: false,
    missingFields,
    followUpQuestions: buildAiExportFollowUpQuestions(missingFields),
    resolvedSession: input.resolvedSession,
    candidates: input.candidates,
    outputDir: input.outputDir,
    format: input.format,
    dateRange: input.dateRange,
    mediaOptions: input.mediaOptions,
    success: false,
    error: input.error,
    message: input.message || '导出参数还不完整。',
  }
}

function mapExportProgress(progress: ExportProgress): AiExportProgress {
  return {
    phase: progress.phase,
    message: progress.detail || progress.phase,
    current: progress.current,
    total: progress.total,
    currentSession: progress.currentSession,
    detail: progress.detail,
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('EXPORT_ABORTED')
    error.name = 'AbortError'
    throw error
  }
}

function buildExportOptions(format: AiExportFormat, dateRange: { start: number; end: number }, mediaOptions: AiExportMediaOptions): ExportOptions {
  return {
    format,
    dateRange,
    exportMedia: mediaOptions.exportImages || mediaOptions.exportVideos || mediaOptions.exportEmojis || mediaOptions.exportVoices,
    exportAvatars: mediaOptions.exportAvatars,
    exportImages: mediaOptions.exportImages,
    exportVideos: mediaOptions.exportVideos,
    exportEmojis: mediaOptions.exportEmojis,
    exportVoices: mediaOptions.exportVoices,
  }
}

export async function exportChatFromAi(
  rawArgs: unknown,
  onProgress?: (progress: AiExportProgress) => void,
  signal?: AbortSignal,
): Promise<AiExportChatResult> {
  onProgress?.({ phase: 'validating', message: '正在校验导出参数' })
  throwIfAborted(signal)

  const parsed = aiExportArgsSchema.safeParse(rawArgs || {})
  if (!parsed.success) {
    return formatMissingResult({
      missingFields: ['session', 'dateRange', 'format', 'mediaOptions'],
      error: parsed.error.issues.map((issue) => issue.message).join('; '),
      message: '导出参数格式不正确。',
    })
  }

  const args = parsed.data as AiExportChatArgs
  const missingFields: AiExportMissingField[] = []
  const format = isSupportedAiExportFormat(args.format) ? args.format : undefined
  const dateRange = normalizeAiExportDateRange(args.dateRange)
  const mediaOptions = normalizeAiExportMediaOptions(args.mediaOptions)
  const outputDirCheck = resolveOutputDir(args.outputDir)

  if (!format) missingFields.push('format')
  if (!dateRange) missingFields.push('dateRange')
  if (!mediaOptions) missingFields.push('mediaOptions')
  if (!outputDirCheck.ok || !outputDirCheck.dir) missingFields.push('outputDir')

  onProgress?.({ phase: 'resolving', message: '正在解析导出会话' })
  let sessionResult: Awaited<ReturnType<typeof resolveExportSession>> = {}
  try {
    sessionResult = await resolveExportSession(args)
  } catch (error) {
    return formatMissingResult({
      missingFields: ['session'],
      outputDir: outputDirCheck.dir,
      format,
      dateRange: dateRange || undefined,
      mediaOptions: mediaOptions || undefined,
      error: error instanceof Error ? error.message : String(error),
      message: '读取会话信息失败，无法确认导出对象。',
    })
  }

  const candidates = sessionResult.candidates
  const resolvedSession = sessionResult.resolvedSession
  if (!resolvedSession) missingFields.push('session')

  if (missingFields.length > 0) {
    const extra = outputDirCheck.ok ? '' : ` ${outputDirCheck.reason || '导出目录不可写'}。`
    return formatMissingResult({
      missingFields,
      candidates,
      resolvedSession,
      outputDir: outputDirCheck.dir,
      format,
      dateRange: dateRange || undefined,
      mediaOptions: mediaOptions || undefined,
      message: `导出参数还不完整。${extra}`.trim(),
    })
  }

  if (!resolvedSession || !format || !dateRange || !mediaOptions || !outputDirCheck.dir) {
    return formatMissingResult({
      missingFields: ['session', 'dateRange', 'format', 'mediaOptions', 'outputDir'],
      candidates,
      resolvedSession,
      outputDir: outputDirCheck.dir,
      format,
      dateRange: dateRange || undefined,
      mediaOptions: mediaOptions || undefined,
      message: '导出参数还不完整。',
    })
  }

  const confirmationQuestion: AiExportFollowUpQuestion = {
    field: 'confirmation',
    question: '参数已齐全。确认开始导出吗？确认后我才会写入文件。',
  }

  if (args.validateOnly || args.confirmed !== true) {
    return {
      canExport: true,
      requiresConfirmation: true,
      missingFields: [],
      followUpQuestions: [confirmationQuestion],
      resolvedSession,
      candidates,
      outputDir: outputDirCheck.dir,
      format,
      dateRange,
      mediaOptions,
      success: false,
      message: '导出参数已齐全，等待最终确认。',
    }
  }

  throwIfAborted(signal)
  onProgress?.({ phase: 'preparing', message: '正在准备导出' })

  const result = await exportService.exportSessions(
    [resolvedSession.sessionId],
    outputDirCheck.dir!,
    buildExportOptions(format, dateRange, mediaOptions),
    (progress) => onProgress?.(mapExportProgress(progress)),
  )

  return {
    canExport: true,
    requiresConfirmation: false,
    missingFields: [],
    followUpQuestions: [],
    resolvedSession,
    candidates,
    outputDir: outputDirCheck.dir,
    outputPaths: result.outputPaths || [],
    format,
    dateRange,
    mediaOptions,
    success: result.success,
    successCount: result.successCount,
    failCount: result.failCount,
    error: result.error,
    message: result.success ? '导出完成。' : (result.error || '导出失败。'),
  }
}
