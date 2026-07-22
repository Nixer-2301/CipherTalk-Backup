import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { desktopCapturer } from 'electron'
import Database from 'better-sqlite3'
import * as ExcelJS from 'exceljs'
import type { MainProcessContext } from '../../main/context'
import { ConfigService } from '../config'
import { memoryDatabase } from '../memory/memoryDatabase'
import { agentAuditService } from './agentAuditService'

type Row = Record<string, any>

const DB_NAME = 'agent_capabilities.db'
const MAX_INDEX_FILES = 100_000
const DEFAULT_INDEX_FILES = 20_000
const MAX_TEXT_BYTES = 512 * 1024
const SEARCH_SNIPPET_CHARS = 360
const TASK_POLL_MS = 60_000

const SKIP_DIRS = new Set([
  '$recycle.bin',
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.next',
  '.nuxt',
  '.turbo',
  '.vite',
  'appdata',
  'application data',
  'cache',
  'coverage',
  'dist',
  'dist-electron',
  'library',
  'node_modules',
  'program files',
  'program files (x86)',
  'programdata',
  'release',
  'system volume information',
  'windows',
])

const TEXT_EXTS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.csv', '.go', '.h', '.hpp', '.html', '.ini',
  '.java', '.js', '.json', '.jsx', '.log', '.md', '.mdx', '.py', '.rs', '.scss',
  '.sql', '.svelte', '.toml', '.ts', '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml',
])

const DOCX_EXTS = new Set(['.docx'])
const HTML_EXTS = new Set(['.html', '.htm'])

function now(): number {
  return Date.now()
}

function getCacheBasePath(): string {
  const config = new ConfigService()
  try {
    return config.getCacheBasePath()
  } finally {
    config.close()
  }
}

function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function getDbPath(): string {
  return path.join(ensureDir(getCacheBasePath()), DB_NAME)
}

function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\r/g, '').trim()
}

function parseTime(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

function sqlLike(value: string): string {
  return `%${value.replace(/[%_]/g, '\\$&')}%`
}

function hashId(parts: Array<string | undefined>): string {
  return crypto.createHash('sha1').update(parts.filter(Boolean).join('\n')).digest('hex').slice(0, 16)
}

function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase()
  const base = path.basename(normalized)
  return base === '.env'
    || base.startsWith('.env.')
    || /\.(pem|key|p12|pfx|crt|cer)$/i.test(base)
    || /(^|[/_.-])(secret|token|credential|password|passwd|private-key)([/_.-]|$)/i.test(normalized)
}

function fileKind(filePath: string, isDir = false): string {
  if (isDir) return 'directory'
  const ext = path.extname(filePath).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico'].includes(ext)) return 'image'
  if (['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext)) return 'video'
  if (['.mp3', '.wav', '.flac', '.ogg', '.m4a'].includes(ext)) return 'audio'
  if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'].includes(ext)) return 'document'
  if (['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.cs', '.cpp', '.c'].includes(ext)) return 'code'
  if (TEXT_EXTS.has(ext)) return 'text'
  if (['.zip', '.rar', '.7z', '.tar', '.gz'].includes(ext)) return 'archive'
  return ext ? ext.slice(1) : 'file'
}

function defaultCommonRoots(): string[] {
  const roots = new Set<string>()
  const home = os.homedir()
  for (const name of ['Desktop', 'Documents', 'Downloads']) {
    const candidate = path.join(home, name)
    if (fs.existsSync(candidate)) roots.add(candidate)
  }
  const config = new ConfigService()
  try {
    const exportPath = normalizeText(config.get('exportPath' as any))
    if (exportPath && fs.existsSync(exportPath)) roots.add(exportPath)
    const workspaceRoot = normalizeText(config.get('agentCodeWorkspaceRoot' as any))
    if (workspaceRoot && fs.existsSync(workspaceRoot)) roots.add(workspaceRoot)
    const extra = config.get('agentFileIndexRoots' as any)
    if (Array.isArray(extra)) {
      for (const item of extra) {
        const root = normalizeText(item)
        if (root && fs.existsSync(root)) roots.add(root)
      }
    }
  } finally {
    config.close()
  }
  return [...roots]
}

function defaultMetadataRoots(): string[] {
  if (process.platform !== 'win32') return ['/']
  const roots: string[] = []
  for (let code = 67; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`
    if (fs.existsSync(drive)) roots.push(drive)
  }
  return roots.length > 0 ? roots : defaultCommonRoots()
}

function rootAllowsContent(root: string): boolean {
  const normalized = path.resolve(root).toLowerCase()
  return defaultCommonRoots().some((candidate) => {
    const current = path.resolve(candidate).toLowerCase()
    return normalized === current || normalized.startsWith(`${current}${path.sep}`)
  })
}

function shouldSkipDir(dirName: string): boolean {
  return SKIP_DIRS.has(dirName.toLowerCase())
}

function isProbablyText(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096))
  let suspicious = 0
  for (const byte of sample) {
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1
  }
  return suspicious / Math.max(1, sample.length) < 0.08
}

function stripHtml(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

async function extractDocxText(filePath: string): Promise<string> {
  const mod = await import('jszip')
  const JSZip = mod.default
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath))
  const doc = zip.file('word/document.xml')
  if (!doc) return ''
  const xml = await doc.async('string')
  return stripHtml(xml.replace(/<w:tab\/>/g, ' ').replace(/<\/w:p>/g, '\n'))
}

async function extractFileText(filePath: string, maxBytes = MAX_TEXT_BYTES): Promise<string> {
  const ext = path.extname(filePath).toLowerCase()
  const stat = fs.statSync(filePath)
  if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return ''
  if (DOCX_EXTS.has(ext)) return extractDocxText(filePath)
  if (!TEXT_EXTS.has(ext) && !HTML_EXTS.has(ext)) return ''
  const buffer = fs.readFileSync(filePath)
  if (!isProbablyText(buffer)) return ''
  const text = buffer.toString('utf8')
  return HTML_EXTS.has(ext) ? stripHtml(text) : text
}

function buildSnippet(text: string, query: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!query.trim()) return compact.slice(0, SEARCH_SNIPPET_CHARS)
  const lower = compact.toLowerCase()
  const idx = lower.indexOf(query.toLowerCase())
  if (idx < 0) return compact.slice(0, SEARCH_SNIPPET_CHARS)
  const start = Math.max(0, idx - Math.floor(SEARCH_SNIPPET_CHARS / 2))
  return `${start > 0 ? '...' : ''}${compact.slice(start, start + SEARCH_SNIPPET_CHARS)}${start + SEARCH_SNIPPET_CHARS < compact.length ? '...' : ''}`
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function safeFileName(value: string, fallback: string): string {
  const cleaned = normalizeText(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80)
  return cleaned || fallback
}

export class AgentCapabilityService {
  private db: Database.Database | null = null
  private ctx: MainProcessContext | null = null
  private taskTimer: NodeJS.Timeout | null = null

  setContext(ctx: MainProcessContext): void {
    this.ctx = ctx
    this.startTaskScheduler()
  }

  notifyWechatIncomingMessage(input: { from: string; text: string; at?: number }): void {
    const text = normalizeText(input.text)
    if (!text) return
    const rows = this.getDb().prepare(`
      SELECT * FROM agent_tasks
      WHERE status = 'active' AND trigger_type = 'keyword'
      ORDER BY created_at DESC
      LIMIT 200
    `).all() as Row[]
    for (const row of rows) {
      let trigger: Record<string, unknown> = {}
      try {
        trigger = JSON.parse(row.trigger_json || '{}')
      } catch {
        trigger = {}
      }
      const keyword = normalizeText(trigger.keyword)
      if (!keyword || !text.includes(keyword)) continue
      this.markTaskRun(row, `微信关键词"${keyword}"已触发，仅在软件内提醒；不会自动回复微信。`)
      this.ctx?.broadcastToWindows('agentTask:keyword', {
        task: this.formatTask(row),
        from: input.from,
        keyword,
        textPreview: text.slice(0, 160),
        at: input.at || now(),
      })
    }
  }

  async handleCall(method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    switch (method) {
      case 'index_local_files':
        return this.indexLocalFiles(args)
      case 'find_files':
        return this.findFiles(args)
      case 'search_local_files':
        return this.searchLocalFiles(args)
      case 'add_knowledge_source':
        return this.addKnowledgeSource(args)
      case 'search_knowledge':
        return this.searchKnowledge(args)
      case 'remove_knowledge_source':
        return this.removeKnowledgeSource(args)
      case 'create_artifact':
        return this.createArtifact(args)
      case 'create_task':
        return this.createTask(args)
      case 'list_tasks':
        return this.listTasks(args)
      case 'update_task':
        return this.updateTask(args)
      case 'cancel_task':
        return this.cancelTask(args)
      case 'run_task_now':
        return this.runTaskNow(args)
      case 'list_audit_logs':
        return { success: true, logs: agentAuditService.list(Number(args.limit ?? 50)) }
      case 'rollback_operation':
        return agentAuditService.rollback(normalizeText(args.operationId), args.confirmed === true)
      case 'desktop_screenshot':
        return this.desktopScreenshot(args)
      case 'desktop_ocr':
        return this.desktopOcr(args)
      case 'audit_memories':
        return this.auditMemories(args)
      case 'apply_memory_fix':
        return this.applyMemoryFix(args)
      case 'transcribe_voice_message':
        return this.transcribeVoiceMessage(args)
      case 'canvas_create':
      case 'canvas_read':
      case 'canvas_edit':
      case 'canvas_replace':
      case 'canvas_rename':
        return this.handleCanvasCall(method, args)
      default:
        return { success: false, error: `unknown agent capability method: ${method}` }
    }
  }

  /**
   * Agent Canvas 工具（见 Docs/Agent-Canvas画布对接开发文档.md §8）。
   * conversationId 由主进程校验过的 canvasContext 注入（不来自模型输入）；
   * 这里再次校验 Canvas 归属，防止工具拿其它会话的 canvasId 读写。
   * 日志只记 canvasId/revision/长度，不落正文。
   */
  private async handleCanvasCall(method: string, args: Record<string, unknown>): Promise<unknown> {
    const { agentCanvasStore } = await import('./agentCanvasStore')
    const { AgentCanvasConflictError, CANVAS_MAX_CONTENT_CHARS, CANVAS_MAX_EDITS } = await import('./canvasTypes')
    const conversationId = Number(args.conversationId)
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      return { success: false, error: '当前会话没有 Canvas 上下文，无法使用画布工具。', errorCode: 'NO_CANVAS_CONTEXT' }
    }

    const requireOwnCanvas = (canvasId: unknown) => {
      const canvas = agentCanvasStore.get(String(canvasId || ''))
      if (!canvas) throw new Error(`Canvas 不存在: ${String(canvasId || '')}`)
      if (canvas.conversationId !== conversationId) {
        const err = new Error('该 Canvas 不属于当前会话') as Error & { errorCode?: string }
        err.errorCode = 'CANVAS_NOT_IN_CONVERSATION'
        throw err
      }
      return canvas
    }
    const refOf = (canvas: import('./canvasTypes').AgentCanvasRecord) => ({
      canvasId: canvas.id,
      conversationId: canvas.conversationId,
      kind: canvas.kind,
      title: canvas.title,
      revision: canvas.revision,
    })

    try {
      switch (method) {
        case 'canvas_create': {
          const canvas = agentCanvasStore.create({
            conversationId,
            kind: args.kind === 'code' ? 'code' : 'document',
            title: normalizeText(args.title).slice(0, 120) || '未命名画布',
            language: normalizeText(args.language).slice(0, 40) || undefined,
            content: String(args.content ?? ''),
            createdBy: 'agent',
          })
          return { success: true, ...refOf(canvas) }
        }
        case 'canvas_read': {
          const canvas = requireOwnCanvas(args.canvasId)
          return {
            success: true,
            ...refOf(canvas),
            language: canvas.language,
            content: canvas.content,
            contentLength: canvas.content.length,
          }
        }
        case 'canvas_edit': {
          const canvas = requireOwnCanvas(args.canvasId)
          const edits = Array.isArray(args.edits) ? args.edits : []
          if (edits.length === 0) return { success: false, error: 'edits 不能为空' }
          if (edits.length > CANVAS_MAX_EDITS) {
            return { success: false, error: `单次最多允许 ${CANVAS_MAX_EDITS} 个 edits` }
          }
          // 全部替换先在内存副本验证：零命中/非唯一命中直接失败，任一失败整次不落库
          let next = canvas.content
          for (let i = 0; i < edits.length; i += 1) {
            const edit = edits[i] as { search?: unknown; replace?: unknown; replaceAll?: unknown }
            const search = String(edit?.search ?? '')
            const replace = String(edit?.replace ?? '')
            if (!search) return { success: false, error: `第 ${i + 1} 个 edit 的 search 为空` }
            const first = next.indexOf(search)
            if (first < 0) {
              return { success: false, error: `第 ${i + 1} 个 edit 零命中：请先 canvas_read 获取最新正文，不要猜测位置。`, errorCode: 'EDIT_NO_MATCH' }
            }
            if (edit?.replaceAll === true) {
              next = next.split(search).join(replace)
            } else {
              if (next.indexOf(search, first + 1) >= 0) {
                return { success: false, error: `第 ${i + 1} 个 edit 命中多处：请提供更长的唯一上下文，或明确 replaceAll=true。`, errorCode: 'EDIT_AMBIGUOUS' }
              }
              next = next.slice(0, first) + replace + next.slice(first + search.length)
            }
          }
          if (next.length > CANVAS_MAX_CONTENT_CHARS) {
            return { success: false, error: `编辑后正文超过上限（${CANVAS_MAX_CONTENT_CHARS} 字符）` }
          }
          const updated = agentCanvasStore.update({
            canvasId: canvas.id,
            baseRevision: Number(args.baseRevision),
            content: next,
            source: 'agent',
          })
          return { success: true, ...refOf(updated), appliedEdits: edits.length, contentLength: updated.content.length }
        }
        case 'canvas_replace': {
          const canvas = requireOwnCanvas(args.canvasId)
          const updated = agentCanvasStore.update({
            canvasId: canvas.id,
            baseRevision: Number(args.baseRevision),
            content: String(args.content ?? ''),
            source: 'agent',
          })
          return { success: true, ...refOf(updated), contentLength: updated.content.length }
        }
        case 'canvas_rename': {
          const canvas = requireOwnCanvas(args.canvasId)
          const updated = agentCanvasStore.rename({
            canvasId: canvas.id,
            baseRevision: Number(args.baseRevision),
            title: normalizeText(args.title).slice(0, 120),
            source: 'agent',
          })
          return { success: true, ...refOf(updated) }
        }
        default:
          return { success: false, error: `unknown canvas method: ${method}` }
      }
    } catch (error) {
      if (error instanceof AgentCanvasConflictError) {
        return {
          success: false,
          error: `REVISION_CONFLICT：画布已被更新到 v${error.conflict.actualRevision}。请先 canvas_read 读取最新内容再重试，不得覆盖用户的新编辑。`,
          errorCode: 'REVISION_CONFLICT',
          actualRevision: error.conflict.actualRevision,
          expectedRevision: error.conflict.expectedRevision,
        }
      }
      const err = error as Error & { errorCode?: string }
      return { success: false, error: err?.message || String(error), ...(err?.errorCode ? { errorCode: err.errorCode } : {}) }
    }
  }

  private getDb(): Database.Database {
    if (this.db) return this.db
    const db = new Database(getDbPath())
    db.pragma('journal_mode = WAL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_index (
        path TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        ext TEXT NOT NULL,
        kind TEXT NOT NULL,
        root TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL,
        content_indexed INTEGER NOT NULL DEFAULT 0,
        content_text TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_file_name ON file_index(name);
      CREATE INDEX IF NOT EXISTS idx_file_kind ON file_index(kind);
      CREATE INDEX IF NOT EXISTS idx_file_mtime ON file_index(mtime_ms);

      CREATE TABLE IF NOT EXISTS knowledge_sources (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source TEXT NOT NULL,
        content_text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        instruction TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        trigger_json TEXT NOT NULL,
        status TEXT NOT NULL,
        approval_mode TEXT NOT NULL,
        last_run_at INTEGER,
        next_run_at INTEGER,
        result_summary TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    this.db = db
    return db
  }

  private async indexLocalFiles(args: Record<string, unknown>): Promise<unknown> {
    const rootsInput = Array.isArray(args.roots) ? args.roots.map(normalizeText).filter(Boolean) : []
    const metadataOnly = args.content !== true
    const roots = rootsInput.length > 0 ? rootsInput : (metadataOnly ? defaultMetadataRoots() : defaultCommonRoots())
    const maxFiles = Math.max(1, Math.min(MAX_INDEX_FILES, Number(args.maxFiles ?? DEFAULT_INDEX_FILES) || DEFAULT_INDEX_FILES))
    const db = this.getDb()
    const upsert = db.prepare(`
      INSERT INTO file_index(path, name, ext, kind, root, size_bytes, mtime_ms, indexed_at, content_indexed, content_text)
      VALUES (@path, @name, @ext, @kind, @root, @size_bytes, @mtime_ms, @indexed_at, @content_indexed, @content_text)
      ON CONFLICT(path) DO UPDATE SET
        name=excluded.name,
        ext=excluded.ext,
        kind=excluded.kind,
        root=excluded.root,
        size_bytes=excluded.size_bytes,
        mtime_ms=excluded.mtime_ms,
        indexed_at=excluded.indexed_at,
        content_indexed=excluded.content_indexed,
        content_text=excluded.content_text
    `)
    let scanned = 0
    let indexed = 0
    let contentIndexed = 0
    const errors: string[] = []

    for (const root of roots) {
      if (indexed >= maxFiles) break
      let realRoot = ''
      try {
        realRoot = fs.realpathSync(root)
        if (!fs.statSync(realRoot).isDirectory()) continue
      } catch (error) {
        errors.push(`${root}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const allowContent = !metadataOnly && rootAllowsContent(realRoot)
      const queue = [realRoot]
      while (queue.length > 0 && indexed < maxFiles) {
        const dir = queue.shift()!
        let dirents: fs.Dirent[]
        try {
          dirents = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const dirent of dirents) {
          if (indexed >= maxFiles) break
          if (dirent.isDirectory() && shouldSkipDir(dirent.name)) continue
          const fullPath = path.join(dir, dirent.name)
          scanned += 1
          try {
            const stat = fs.statSync(fullPath)
            if (dirent.isDirectory()) {
              queue.push(fullPath)
              continue
            }
            if (!stat.isFile()) continue
            const ext = path.extname(fullPath).toLowerCase()
            let contentText = ''
            let indexedContent = 0
            if (allowContent && !isSensitivePath(fullPath)) {
              contentText = (await extractFileText(fullPath)).slice(0, 120_000)
              indexedContent = contentText ? 1 : 0
              if (indexedContent) contentIndexed += 1
            }
            upsert.run({
              path: fullPath,
              name: path.basename(fullPath),
              ext,
              kind: fileKind(fullPath),
              root: realRoot,
              size_bytes: stat.size,
              mtime_ms: Math.floor(stat.mtimeMs),
              indexed_at: now(),
              content_indexed: indexedContent,
              content_text: contentText,
            })
            indexed += 1
          } catch {
            // Per-file failures are expected on protected system paths.
          }
        }
      }
    }

    return {
      success: true,
      roots,
      scanned,
      indexed,
      contentIndexed,
      truncated: indexed >= maxFiles,
      errors: errors.slice(0, 10),
    }
  }

  private findFiles(args: Record<string, unknown>): unknown {
    const query = normalizeText(args.query)
    const limit = Math.max(1, Math.min(100, Number(args.limit ?? 30) || 30))
    const modifiedAfter = parseTime(args.modifiedAfter)
    const modifiedBefore = parseTime(args.modifiedBefore)
    const types = Array.isArray(args.types) ? args.types.map(normalizeText).filter(Boolean) : []
    const clauses: string[] = []
    const params: any[] = []
    if (query) {
      clauses.push('(name LIKE ? ESCAPE \'\\\' OR path LIKE ? ESCAPE \'\\\')')
      params.push(sqlLike(query), sqlLike(query))
    }
    if (types.length > 0) {
      clauses.push(`kind IN (${types.map(() => '?').join(',')})`)
      params.push(...types)
    }
    if (modifiedAfter) {
      clauses.push('mtime_ms >= ?')
      params.push(modifiedAfter)
    }
    if (modifiedBefore) {
      clauses.push('mtime_ms <= ?')
      params.push(modifiedBefore)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.getDb().prepare(`
      SELECT path, name, ext, kind, root, size_bytes AS sizeBytes, mtime_ms AS modifiedAt, content_indexed AS contentIndexed
      FROM file_index
      ${where}
      ORDER BY
        CASE WHEN lower(name) = lower(?) THEN 0 WHEN name LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END,
        mtime_ms DESC
      LIMIT ?
    `).all(...params, query, query ? `${query}%` : '%', limit) as Row[]
    return {
      success: true,
      count: rows.length,
      files: rows.map((row) => ({
        path: row.path,
        name: row.name,
        kind: row.kind,
        ext: row.ext,
        sizeBytes: row.sizeBytes,
        modifiedAt: row.modifiedAt,
        contentIndexed: Boolean(row.contentIndexed),
      })),
      note: rows.length === 0 ? '本机文件索引没有命中；可先调用 index_local_files 建立或刷新索引。' : undefined,
    }
  }

  private async searchLocalFiles(args: Record<string, unknown>): Promise<unknown> {
    const query = normalizeText(args.query)
    if (!query) return { success: false, error: 'query 不能为空' }
    const roots = Array.isArray(args.roots) ? args.roots.map(normalizeText).filter(Boolean) : []
    if (roots.length > 0 && args.refresh !== false) {
      await this.indexLocalFiles({ roots, content: true, maxFiles: Number(args.maxFiles ?? 5000) || 5000 })
    }
    const limit = Math.max(1, Math.min(50, Number(args.limit ?? 20) || 20))
    const rows = this.getDb().prepare(`
      SELECT path, name, kind, size_bytes AS sizeBytes, mtime_ms AS modifiedAt, content_text AS contentText
      FROM file_index
      WHERE content_indexed = 1 AND content_text LIKE ? ESCAPE '\\'
      ORDER BY mtime_ms DESC
      LIMIT ?
    `).all(sqlLike(query), limit) as Row[]
    return {
      success: true,
      count: rows.length,
      hits: rows.map((row) => ({
        path: row.path,
        name: row.name,
        kind: row.kind,
        sizeBytes: row.sizeBytes,
        modifiedAt: row.modifiedAt,
        snippet: isSensitivePath(row.path) ? '[敏感文件：内容片段已隐藏]' : buildSnippet(String(row.contentText || ''), query),
      })),
      note: rows.length === 0 ? '内容索引没有命中；内容搜索只覆盖常用目录和显式 roots，可传 roots 并 refresh=true 后重试。' : undefined,
    }
  }

  private async addKnowledgeSource(args: Record<string, unknown>): Promise<unknown> {
    const filePath = normalizeText(args.path)
    const url = normalizeText(args.url)
    const titleInput = normalizeText(args.title)
    if (!filePath && !url) return { success: false, error: '需要 path 或 url' }
    let source = ''
    let sourceType = ''
    let content = ''
    let title = titleInput
    if (filePath) {
      const real = fs.realpathSync(filePath)
      const stat = fs.statSync(real)
      if (!stat.isFile()) return { success: false, error: 'path 不是文件' }
      source = real
      sourceType = path.extname(real).toLowerCase().replace('.', '') || 'file'
      title = title || path.basename(real)
      content = await extractFileText(real, 5 * 1024 * 1024)
      if (!content && path.extname(real).toLowerCase() === '.pdf') {
        content = `PDF 文件：${path.basename(real)}\n路径：${real}\n第一版仅索引 PDF 文件元数据；如需全文，请先转换为 Markdown 或文本。`
      }
    } else {
      const response = await fetch(url)
      if (!response.ok) return { success: false, error: `网页读取失败：HTTP ${response.status}` }
      const html = await response.text()
      source = url
      sourceType = 'web'
      title = title || (/<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1]?.trim() || url)
      content = stripHtml(html).slice(0, 300_000)
    }
    const id = hashId([source, title])
    const at = now()
    this.getDb().prepare(`
      INSERT INTO knowledge_sources(id, title, source_type, source, content_text, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,
        source_type=excluded.source_type,
        source=excluded.source,
        content_text=excluded.content_text,
        updated_at=excluded.updated_at
    `).run(id, title, sourceType, source, content, at, at)
    return { success: true, id, title, sourceType, source, chars: content.length }
  }

  private searchKnowledge(args: Record<string, unknown>): unknown {
    const query = normalizeText(args.query)
    if (!query) return { success: false, error: 'query 不能为空' }
    const limit = Math.max(1, Math.min(50, Number(args.limit ?? 10) || 10))
    const rows = this.getDb().prepare(`
      SELECT id, title, source_type AS sourceType, source, content_text AS contentText, updated_at AS updatedAt
      FROM knowledge_sources
      WHERE title LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\' OR content_text LIKE ? ESCAPE '\\'
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(sqlLike(query), sqlLike(query), sqlLike(query), limit) as Row[]
    return {
      success: true,
      count: rows.length,
      hits: rows.map((row) => ({
        id: row.id,
        title: row.title,
        sourceType: row.sourceType,
        source: row.source,
        updatedAt: row.updatedAt,
        snippet: buildSnippet(String(row.contentText || ''), query),
      })),
    }
  }

  private removeKnowledgeSource(args: Record<string, unknown>): unknown {
    const id = normalizeText(args.id)
    if (!id) return { success: false, error: 'id 不能为空' }
    const info = this.getDb().prepare('DELETE FROM knowledge_sources WHERE id = ?').run(id)
    return { success: true, removed: info.changes }
  }

  private getArtifactDir(outputDir?: unknown): string {
    const explicit = normalizeText(outputDir)
    if (explicit) return ensureDir(explicit)
    const config = new ConfigService()
    try {
      const exportPath = normalizeText(config.get('exportPath' as any))
      if (exportPath) return ensureDir(exportPath)
      return ensureDir(path.join(config.getCacheBasePath(), 'agent-artifacts'))
    } finally {
      config.close()
    }
  }

  private async createArtifact(args: Record<string, unknown>): Promise<unknown> {
    const format = normalizeText(args.format || 'html').toLowerCase()
    if (!['html', 'excel', 'word', 'ppt'].includes(format)) return { success: false, error: 'format 只支持 html/excel/word/ppt' }
    const title = normalizeText(args.title || 'AI 产物') || 'AI 产物'
    const content = normalizeText(args.content)
    const outputDir = this.getArtifactDir(args.outputDir)
    const ext = format === 'excel' ? '.xlsx' : format === 'word' ? '.docx' : format === 'ppt' ? '.pptx' : '.html'
    const fileName = `${safeFileName(normalizeText(args.fileName) || title, 'artifact')}${ext}`
    const outputPath = path.join(outputDir, fileName)
    if (args.confirmed !== true) {
      return {
        success: false,
        requiresConfirmation: true,
        format,
        title,
        outputPath,
        message: 'create_artifact 会写入本机文件；确认后请再次调用 confirmed=true。',
      }
    }
    const snapshot = fs.existsSync(outputPath) ? agentAuditService.createSnapshot(outputPath) : undefined
    if (format === 'html') await this.writeHtmlArtifact(outputPath, title, content)
    else if (format === 'excel') await this.writeExcelArtifact(outputPath, title, content, args.rows)
    else if (format === 'word') await this.writeDocxArtifact(outputPath, title, content)
    else await this.writePptxArtifact(outputPath, title, content)
    const audit = agentAuditService.record({
      source: 'agent',
      toolName: 'create_artifact',
      argsSummary: { format, title, outputPath },
      risk: 'medium',
      status: 'success',
      targetPath: outputPath,
      snapshotPath: snapshot,
      outputPaths: [outputPath],
    })
    return { success: true, format, title, outputPath, outputPaths: [outputPath], operationId: audit.operationId }
  }

  private async writeHtmlArtifact(outputPath: string, title: string, content: string): Promise<void> {
    const body = content
      .split(/\n{2,}/)
      .map((paragraph) => `<p>${xmlEscape(paragraph).replace(/\n/g, '<br>')}</p>`)
      .join('\n')
    fs.writeFileSync(outputPath, [
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
      `<title>${xmlEscape(title)}</title>`,
      '<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:920px;margin:40px auto;padding:0 24px;line-height:1.7;color:#202124}h1{font-size:28px}</style>',
      '</head><body>',
      `<h1>${xmlEscape(title)}</h1>`,
      body || '<p></p>',
      '</body></html>',
    ].join('\n'), 'utf8')
  }

  private async writeExcelArtifact(outputPath: string, title: string, content: string, rowsInput: unknown): Promise<void> {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Sheet1')
    sheet.addRow([title])
    sheet.addRow([])
    const rows = Array.isArray(rowsInput) ? rowsInput : []
    if (rows.length > 0 && rows.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
      const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row as Record<string, unknown>))))
      sheet.addRow(keys)
      for (const row of rows) sheet.addRow(keys.map((key) => (row as Record<string, unknown>)[key] ?? ''))
    } else {
      for (const line of content.split(/\r?\n/)) sheet.addRow([line])
    }
    sheet.getColumn(1).width = 48
    await workbook.xlsx.writeFile(outputPath)
  }

  private async writeDocxArtifact(outputPath: string, title: string, content: string): Promise<void> {
    const mod = await import('jszip')
    const zip = new mod.default()
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    zip.folder('_rels')!.file('.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    const paragraphs = [title, '', ...content.split(/\r?\n/)]
      .map((line) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`)
      .join('')
    zip.folder('word')!.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`)
    const data = await zip.generateAsync({ type: 'nodebuffer' })
    fs.writeFileSync(outputPath, data)
  }

  private async writePptxArtifact(outputPath: string, title: string, content: string): Promise<void> {
    const mod = await import('jszip')
    const zip = new mod.default()
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>')
    zip.folder('_rels')!.file('.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>')
    zip.folder('ppt')!.file('presentation.xml', '<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/></p:presentation>')
    zip.folder('ppt')!.folder('_rels')!.file('presentation.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>')
    const lines = content.split(/\r?\n/).filter(Boolean).slice(0, 10).map((line) => `<a:p><a:r><a:t>${xmlEscape(line)}</a:t></a:r></a:p>`).join('')
    zip.folder('ppt')!.folder('slides')!.file('slide1.xml', `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${xmlEscape(title)}</a:t></a:r></a:p>${lines}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`)
    const data = await zip.generateAsync({ type: 'nodebuffer' })
    fs.writeFileSync(outputPath, data)
  }

  private createTask(args: Record<string, unknown>): unknown {
    const title = normalizeText(args.title)
    const instruction = normalizeText(args.instruction)
    const trigger = args.trigger && typeof args.trigger === 'object' ? args.trigger as Record<string, unknown> : {}
    const triggerType = normalizeText(trigger.type || args.triggerType || 'once')
    if (!title || !instruction) return { success: false, error: 'title 和 instruction 不能为空' }
    if (String(instruction).includes('发微信') || String(instruction).toLowerCase().includes('send_wechat')) {
      return { success: false, error: '主动任务不允许发送微信消息，只能提醒、生成草稿或写文件。' }
    }
    const id = `task-${now()}-${crypto.randomBytes(4).toString('hex')}`
    const nextRunAt = this.computeNextRunAt(triggerType, trigger)
    const at = now()
    this.getDb().prepare(`
      INSERT INTO agent_tasks(id, title, instruction, trigger_type, trigger_json, status, approval_mode, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', 'confirm-before-risk', ?, ?, ?)
    `).run(id, title, instruction, triggerType, JSON.stringify(trigger), nextRunAt, at, at)
    agentAuditService.record({
      source: 'task',
      toolName: 'create_task',
      argsSummary: { title, trigger },
      risk: 'medium',
      status: 'success',
    })
    return { success: true, id, title, triggerType, nextRunAt }
  }

  private computeNextRunAt(triggerType: string, trigger: Record<string, unknown>): number | null {
    if (triggerType === 'keyword') return null
    const atValue = parseTime(trigger.at)
    if (atValue) return atValue
    const time = normalizeText(trigger.time || '09:00')
    const match = /^(\d{1,2}):(\d{2})$/.exec(time)
    const date = new Date()
    if (match) {
      date.setHours(Number(match[1]), Number(match[2]), 0, 0)
      if (date.getTime() <= now()) date.setDate(date.getDate() + 1)
      return date.getTime()
    }
    return null
  }

  private listTasks(args: Record<string, unknown>): unknown {
    const status = normalizeText(args.status)
    const rows = this.getDb().prepare(`
      SELECT * FROM agent_tasks
      ${status ? 'WHERE status = ?' : ''}
      ORDER BY COALESCE(next_run_at, created_at) ASC
      LIMIT 100
    `).all(...(status ? [status] : [])) as Row[]
    return { success: true, tasks: rows.map((row) => this.formatTask(row)) }
  }

  private formatTask(row: Row): Record<string, unknown> {
    return {
      id: row.id,
      title: row.title,
      instruction: row.instruction,
      triggerType: row.trigger_type,
      trigger: JSON.parse(row.trigger_json || '{}'),
      status: row.status,
      approvalMode: row.approval_mode,
      lastRunAt: row.last_run_at,
      nextRunAt: row.next_run_at,
      resultSummary: row.result_summary,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private updateTask(args: Record<string, unknown>): unknown {
    const id = normalizeText(args.id)
    if (!id) return { success: false, error: 'id 不能为空' }
    const row = this.getDb().prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id) as Row | undefined
    if (!row) return { success: false, error: '任务不存在' }
    const next = {
      title: normalizeText(args.title) || row.title,
      instruction: normalizeText(args.instruction) || row.instruction,
      status: normalizeText(args.status) || row.status,
    }
    if (next.instruction.includes('发微信') || next.instruction.toLowerCase().includes('send_wechat')) {
      return { success: false, error: '主动任务不允许发送微信消息。' }
    }
    this.getDb().prepare('UPDATE agent_tasks SET title = ?, instruction = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(next.title, next.instruction, next.status, now(), id)
    return { success: true, task: this.formatTask(this.getDb().prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id) as Row) }
  }

  private cancelTask(args: Record<string, unknown>): unknown {
    const id = normalizeText(args.id)
    if (!id) return { success: false, error: 'id 不能为空' }
    const info = this.getDb().prepare("UPDATE agent_tasks SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now(), id)
    return { success: true, cancelled: info.changes > 0, id }
  }

  private runTaskNow(args: Record<string, unknown>): unknown {
    const id = normalizeText(args.id)
    const row = this.getDb().prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id) as Row | undefined
    if (!row) return { success: false, error: '任务不存在' }
    this.markTaskRun(row, '手动触发，等待 Agent 根据 instruction 执行；高风险动作必须再次确认。')
    return {
      success: true,
      task: this.formatTask(row),
      readyForAgent: true,
      instruction: row.instruction,
      guardrail: '不得发送微信消息；如需写文件、导出或命令，必须走确认。',
    }
  }

  private startTaskScheduler(): void {
    if (this.taskTimer) return
    this.taskTimer = setInterval(() => this.pollDueTasks(), TASK_POLL_MS)
    this.taskTimer.unref?.()
  }

  private pollDueTasks(): void {
    const rows = this.getDb().prepare(`
      SELECT * FROM agent_tasks
      WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at ASC
      LIMIT 20
    `).all(now()) as Row[]
    for (const row of rows) {
      this.markTaskRun(row, '任务到期，已在软件内提醒；不会自动发送微信消息。')
      this.ctx?.broadcastToWindows('agentTask:due', this.formatTask(row))
    }
  }

  private markTaskRun(row: Row, summary: string): void {
    const trigger = JSON.parse(row.trigger_json || '{}') as Record<string, unknown>
    const nextRunAt = row.trigger_type === 'daily' || row.trigger_type === 'weekly'
      ? this.computeNextRunAt(row.trigger_type, trigger)
      : null
    this.getDb().prepare(`
      UPDATE agent_tasks
      SET last_run_at = ?, next_run_at = ?, result_summary = ?, updated_at = ?
      WHERE id = ?
    `).run(now(), nextRunAt, summary, now(), row.id)
    agentAuditService.record({
      source: 'task',
      toolName: 'agent_task_due',
      argsSummary: { taskId: row.id, title: row.title },
      risk: 'low',
      status: 'success',
    })
  }

  private async desktopScreenshot(args: Record<string, unknown>): Promise<unknown> {
    const width = Math.max(320, Math.min(3840, Number(args.width ?? 1920) || 1920))
    const height = Math.max(240, Math.min(2160, Number(args.height ?? 1080) || 1080))
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width, height } })
    const source = sources.find((item) => item.id === args.sourceId) || sources.find((item) => item.id.startsWith('screen:')) || sources[0]
    if (!source) return { success: false, error: '没有可截图的屏幕或窗口' }
    const dir = ensureDir(path.join(getCacheBasePath(), 'desktop-screenshots'))
    const filePath = path.join(dir, `desktop-${Date.now()}.png`)
    fs.writeFileSync(filePath, source.thumbnail.toPNG())
    return {
      success: true,
      sourceId: source.id,
      sourceName: source.name,
      filePath,
      sensitive: true,
      delivery: 'local-preview-only',
      note: '桌面截图已保存到本机。软件内对话不要说已发送到微信；微信机器人入口下，如果当前用户明确要求截图，可直接把它作为当前会话回复附件发送。',
    }
  }

  private async desktopOcr(args: Record<string, unknown>): Promise<unknown> {
    const screenshot = await this.desktopScreenshot(args) as Record<string, unknown>
    return {
      ...screenshot,
      success: false,
      error: '桌面 OCR 第一版已能截图，但本地 OCR/视觉模型尚未配置；可把 screenshot filePath 交给支持视觉的模型或后续 OCR 服务。',
    }
  }

  private auditMemories(args: Record<string, unknown>): unknown {
    const limit = Math.max(1, Math.min(500, Number(args.limit ?? 200) || 200))
    const items = memoryDatabase.listMemoryItems({ limit })
    const byText = new Map<string, typeof items>()
    for (const item of items) {
      const key = item.content.replace(/\s+/g, '').toLowerCase()
      byText.set(key, [...(byText.get(key) || []), item])
    }
    const duplicates = [...byText.values()]
      .filter((group) => group.length > 1)
      .map((group) => ({ ids: group.map((item) => item.id), content: group[0].content }))
    const lowConfidence = items
      .filter((item) => item.confidence < 0.5 || item.tags.includes('pending'))
      .map((item) => ({ id: item.id, content: item.content, confidence: item.confidence, tags: item.tags }))
    const staleBefore = now() - (Number(args.staleDays ?? 180) || 180) * 24 * 60 * 60 * 1000
    const stale = items
      .filter((item) => item.updatedAt < staleBefore)
      .map((item) => ({ id: item.id, content: item.content, updatedAt: item.updatedAt }))
    return { success: true, scanned: items.length, duplicates, lowConfidence, stale }
  }

  private applyMemoryFix(args: Record<string, unknown>): unknown {
    const action = normalizeText(args.action)
    const ids = Array.isArray(args.ids) ? args.ids.map((id) => Number(id)).filter(Number.isFinite) : []
    if (args.confirmed !== true) {
      return {
        success: false,
        requiresConfirmation: true,
        action,
        ids,
        message: '修改记忆属于高风险操作；确认后请再次调用 confirmed=true。',
      }
    }
    if (action === 'delete') {
      let removed = 0
      for (const id of ids) {
        if (memoryDatabase.deleteMemoryItem(id)) removed += 1
      }
      agentAuditService.record({
        source: 'agent',
        toolName: 'apply_memory_fix',
        argsSummary: { action, ids },
        risk: 'high',
        status: 'success',
      })
      return { success: true, removed }
    }
    if (action === 'consolidate') {
      const result = memoryDatabase.consolidate(50)
      return { success: true, result }
    }
    return { success: false, error: 'action 只支持 delete/consolidate' }
  }

  private async transcribeVoiceMessage(args: Record<string, unknown>): Promise<unknown> {
    const sessionId = normalizeText(args.sessionId)
    const localId = Number(args.localId)
    const createTime = Number(args.createTime)
    const force = args.force === true
    if (!sessionId || !Number.isInteger(localId) || localId <= 0 || !Number.isInteger(createTime) || createTime <= 0) {
      return { success: false, error: 'sessionId、localId、createTime 必填且必须有效', errorCode: 'BAD_REQUEST' }
    }

    const [{ chatService }, { sttRuntimeService }] = await Promise.all([
      import('../chatService'),
      import('../sttRuntimeService'),
    ])

    if (!force && sttRuntimeService.hasCachedTranscript(sessionId, createTime, localId)) {
      const transcript = sttRuntimeService.getCachedTranscript(sessionId, createTime, localId) ?? ''
      if (!transcript) {
        return {
          success: false,
          error: '语音转写结果为空（已缓存；如需重新识别，请明确要求强制转写）',
          errorCode: 'EMPTY_TRANSCRIPT_CACHED',
        }
      }
      return {
        success: true,
        transcript,
        cached: true,
        sttMode: sttRuntimeService.getCurrentSttMode(),
        sessionId,
        localId,
        createTime,
      }
    }

    const voice = await chatService.getVoiceData(sessionId, String(localId), createTime)
    if (!voice.success || !voice.data) {
      const error = voice.error || '未找到语音数据'
      return {
        success: false,
        error,
        errorCode: error.includes('未找到媒体数据库') ? 'DB_NOT_READY' : 'VOICE_DATA_UNAVAILABLE',
      }
    }

    const result = await sttRuntimeService.transcribeWavBuffer(Buffer.from(voice.data, 'base64'), {
      cache: { sessionId, createTime, localId, force },
    })
    if (!result.success || !result.transcript) {
      return {
        success: false,
        error: result.error || '语音转写失败',
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      }
    }

    return {
      success: true,
      transcript: result.transcript,
      cached: Boolean(result.cached),
      sttMode: result.sttMode,
      sessionId,
      localId,
      createTime,
    }
  }
}

export const agentCapabilityService = new AgentCapabilityService()
