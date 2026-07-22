import { createHash } from 'crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import type { MainProcessContext } from '../../main/context'
import { ConfigService } from '../config'
import type {
  CodeWorkspaceApprovalDecision,
  CodeWorkspaceApprovalKind,
  CodeWorkspaceApprovalPolicy,
  CodeWorkspaceApprovalRequest,
  CodeWorkspaceApprovalRisk,
  CodeWorkspaceBrowserDiagnostic,
  CodeWorkspaceBrowserDiagnosticsResult,
  CodeWorkspaceEvent,
  CodeWorkspaceFileItem,
  CodeWorkspaceListFilesResult,
  CodeWorkspaceRef,
  CodeWorkspaceState,
  CodeWorkspaceToolCall,
} from './codeWorkspaceTypes'
import { agentAuditService } from './agentAuditService'

const CONFIG_KEY = 'agentCodeWorkspaceRoot'
const APPROVAL_POLICY_CONFIG_KEY = 'agentCodeWorkspaceApprovalPolicy'
const MAX_READ_BYTES = 512 * 1024
const MAX_READ_LINES = 1400
const MAX_LIST_ITEMS = 600
const MAX_DIFF_CHARS = 40_000
const MAX_LOG_LINES = 600
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000
const DEV_SERVER_READY_TIMEOUT_MS = 8_000
const BROWSER_DIAGNOSTICS_TIMEOUT_MS = 10_000
const BROWSER_DIAGNOSTICS_IDLE_MS = 1_500

const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'dist-electron',
  'release',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  '.turbo',
  '.vite',
])

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.bmp',
  '.mp4', '.webm', '.mov', '.avi', '.mkv', '.mp3', '.wav', '.ogg', '.flac',
  '.zip', '.7z', '.rar', '.tar', '.gz', '.bz2', '.xz',
  '.exe', '.dll', '.node', '.so', '.dylib', '.lib', '.a', '.obj', '.pdb',
  '.sqlite', '.db', '.sqlite3', '.wasm', '.woff', '.woff2', '.ttf', '.otf',
])

type PendingApproval = {
  request: CodeWorkspaceApprovalRequest
  resolve: (decision: CodeWorkspaceApprovalDecision) => void
  timer: NodeJS.Timeout
}

type ResolvedPath = {
  absPath: string
  displayPath: string
  root: string
}

type CommandSpec = {
  command: string
  args: string[]
  display: string
}

type NormalizedCommand = {
  mode: 'spawn'
  command: string
  args: string[]
} | {
  mode: 'shell'
  commandLine: string
}

function normalizePathKey(value: string): string {
  const normalized = path.resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isPathInside(root: string, target: string): boolean {
  const rootKey = normalizePathKey(root)
  const targetKey = normalizePathKey(target)
  return targetKey === rootKey || targetKey.startsWith(rootKey.endsWith(path.sep) ? rootKey : `${rootKey}${path.sep}`)
}

function displayPathFor(root: string, target: string): string {
  return isPathInside(root, target) ? path.relative(root, target) || '.' : target
}

async function findExistingParentPath(target: string): Promise<string> {
  let current = path.dirname(target)
  while (true) {
    try {
      const stat = await fs.promises.stat(current)
      if (stat.isDirectory()) return fs.promises.realpath(current)
    } catch {
    }
    const next = path.dirname(current)
    if (next === current) throw new Error('目标父目录不存在')
    current = next
  }
}

function truncateText(value: string, max = MAX_DIFF_CHARS): string {
  return value.length > max ? `${value.slice(0, max)}\n...<truncated>` : value
}

function formatCommandText(command: string, args: string[]): string {
  return [command, ...args].join(' ')
}

function commandForPlatform(command: string): string {
  if (process.platform !== 'win32') return command
  if (/[\\/]/.test(command) || /\.[a-z0-9]+$/i.test(command)) return command
  if (['npm', 'npx', 'pnpm', 'yarn'].includes(command.toLowerCase())) return `${command}.cmd`
  return command
}

function commandCandidatesForPlatform(command: string, args: string[]): CommandSpec[] {
  if (process.platform === 'win32' && !/[\\/]/.test(command) && command.toLowerCase() === 'python3') {
    const pyArgs = ['-3', ...args]
    return [
      { command: 'py', args: pyArgs, display: formatCommandText('py', pyArgs) },
      { command: 'python', args, display: formatCommandText('python', args) },
    ]
  }
  return [{ command: commandForPlatform(command), args, display: formatCommandText(command, args) }]
}

function approvalCommandText(candidates: CommandSpec[]): string {
  const [primary, ...fallbacks] = candidates
  if (!primary) return ''
  if (fallbacks.length === 0) return primary.display
  return `${primary.display} (fallback: ${fallbacks.map((item) => item.display).join(' / ')})`
}

function shellCommandForPlatform(commandLine: string): CommandSpec {
  if (process.platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', commandLine],
      display: commandLine,
    }
  }
  return {
    command: process.env.SHELL || '/bin/sh',
    args: ['-lc', commandLine],
    display: commandLine,
  }
}

function looksShellLike(command: string, args: string[]): boolean {
  const text = [command, ...args].join(' ')
  return /[;&|`$<>]/.test(text) || /\b(?:powershell|pwsh|cmd|bash|sh|zsh)\b/i.test(command)
}

function buildDiffPreview(displayPath: string, before: string, after: string): string {
  if (before === after) return `No changes in ${displayPath}`
  const beforeLines = before.split(/\r?\n/)
  const afterLines = after.split(/\r?\n/)
  const maxLines = 220
  const lines = [`--- a/${displayPath}`, `+++ b/${displayPath}`, '@@']

  if (before.length === 0) {
    for (const line of afterLines.slice(0, maxLines)) lines.push(`+${line}`)
  } else if (after.length === 0) {
    for (const line of beforeLines.slice(0, maxLines)) lines.push(`-${line}`)
  } else {
    for (const line of beforeLines.slice(0, Math.min(maxLines, beforeLines.length))) lines.push(`-${line}`)
    if (beforeLines.length > maxLines) lines.push('-...<truncated>')
    for (const line of afterLines.slice(0, Math.min(maxLines, afterLines.length))) lines.push(`+${line}`)
    if (afterLines.length > maxLines) lines.push('+...<truncated>')
  }

  return truncateText(lines.join('\n'))
}

function normalizeApprovalPolicy(value: unknown): CodeWorkspaceApprovalPolicy {
  return value === 'risk-based' || value === 'full-access' ? value : 'on-request'
}

export class CodeWorkspaceService {
  private ctx: MainProcessContext | null = null
  private workspace: CodeWorkspaceRef | null = null
  private workspaceInit: Promise<void> | null = null
  private pendingApprovals = new Map<string, PendingApproval>()
  private devServer: ChildProcessWithoutNullStreams | null = null
  private devServerCommand = ''
  private devServerStartedAt = 0
  private devServerPreviewUrl = ''
  private logs: string[] = []
  private workspaceWatcher: fs.FSWatcher | null = null
  private workspaceWatchTimer: NodeJS.Timeout | null = null
  private workspaceWatchPaths = new Set<string>()

  setContext(ctx: MainProcessContext): void {
    this.ctx = ctx
    void this.ensureWorkspaceInitialized().catch(() => undefined)
  }

  async selectWorkspace(): Promise<{ success: boolean; canceled?: boolean; state?: CodeWorkspaceState; error?: string }> {
    try {
      const { dialog } = await import('electron')
      const defaultPath = await this.ensureDefaultWorkspaceDir()
      const result = await dialog.showOpenDialog({
        title: '选择代码工作区',
        defaultPath,
        properties: ['openDirectory', 'createDirectory'],
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true }
      }
      await this.setWorkspaceRoot(result.filePaths[0])
      return { success: true, state: this.getState() }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  }

  async clearWorkspace(): Promise<CodeWorkspaceState> {
    await this.stopDevServerInternal()
    this.rejectAllApprovals()
    this.workspace = null
    this.writeConfiguredWorkspaceRoot('')
    await this.ensureWorkspaceInitialized()
    this.broadcast({ type: 'state', state: this.getState(), at: Date.now() })
    return this.getState()
  }

  async setApprovalPolicy(policy: CodeWorkspaceApprovalPolicy): Promise<CodeWorkspaceState> {
    const normalized = normalizeApprovalPolicy(policy)
    this.writeConfiguredApprovalPolicy(normalized)
    await this.ensureWorkspaceInitialized()
    if (this.workspace) {
      this.workspace = { ...this.workspace, approvalPolicy: normalized }
    }
    this.broadcast({ type: 'state', state: this.getState(), at: Date.now() })
    return this.getState()
  }

  async ensureWorkspaceInitialized(): Promise<void> {
    if (this.workspace) return
    if (!this.workspaceInit) {
      this.workspaceInit = this.initializeWorkspace().finally(() => {
        this.workspaceInit = null
      })
    }
    await this.workspaceInit
  }

  getState(): CodeWorkspaceState {
    return {
      workspace: this.workspace,
      devServer: {
        running: Boolean(this.devServer && !this.devServer.killed),
        command: this.devServerCommand || undefined,
        pid: this.devServer?.pid,
        startedAt: this.devServerStartedAt || undefined,
        previewUrl: this.devServerPreviewUrl || undefined,
      },
      recentLogs: this.logs.slice(-120),
    }
  }

  approve(requestId: string): boolean {
    return this.resolveApproval(requestId, 'approved')
  }

  reject(requestId: string): boolean {
    return this.resolveApproval(requestId, 'rejected')
  }

  async listFilesForUi(args: Record<string, unknown>): Promise<CodeWorkspaceListFilesResult> {
    await this.ensureWorkspaceInitialized()
    return this.listFiles(args)
  }

  async handleToolCall(call: CodeWorkspaceToolCall): Promise<unknown> {
    await this.ensureWorkspaceInitialized()
    if (call.workspace?.root) {
      await this.ensureWorkspaceFromTool(call.workspace)
    }
    const args = call.args ?? {}
    switch (call.method) {
      case 'status':
        return this.getStatus()
      case 'list_files':
        return this.listFiles(args)
      case 'read_file':
        return this.readFile(args)
      case 'replace_in_file':
        return this.replaceInFile(args)
      case 'write_file':
        return this.writeFile(args)
      case 'delete_file':
        return this.deleteFile(args)
      case 'run_command':
        return this.runCommand(args)
      case 'start_dev_server':
        return this.startDevServer(args)
      case 'stop_dev_server':
        return this.stopDevServer()
      case 'get_dev_server_logs':
        return { success: true, logs: this.logs.slice(-200), state: this.getState() }
      case 'get_browser_diagnostics':
        return this.getBrowserDiagnostics(args)
      default:
        return { success: false, error: `unknown code workspace method: ${call.method}` }
    }
  }

  private readConfiguredWorkspaceRoot(): string {
    const config = new ConfigService()
    try {
      return String(config.get(CONFIG_KEY as any) || '')
    } finally {
      config.close()
    }
  }

  private writeConfiguredWorkspaceRoot(root: string): void {
    const config = new ConfigService()
    try {
      config.set(CONFIG_KEY as any, root as any)
    } finally {
      config.close()
    }
  }

  private readConfiguredApprovalPolicy(): CodeWorkspaceApprovalPolicy {
    const config = new ConfigService()
    try {
      return normalizeApprovalPolicy(config.get(APPROVAL_POLICY_CONFIG_KEY as any))
    } finally {
      config.close()
    }
  }

  private writeConfiguredApprovalPolicy(policy: CodeWorkspaceApprovalPolicy): void {
    const config = new ConfigService()
    try {
      config.set(APPROVAL_POLICY_CONFIG_KEY as any, normalizeApprovalPolicy(policy) as any)
    } finally {
      config.close()
    }
  }

  private async initializeWorkspace(): Promise<void> {
    const configured = this.readConfiguredWorkspaceRoot()
    if (configured) {
      try {
        await this.setWorkspaceRoot(configured)
        return
      } catch (error: any) {
        this.appendLog(`[workspace] configured root unavailable: ${error?.message || String(error)}`)
        this.writeConfiguredWorkspaceRoot('')
      }
    }

    const defaultRoot = await this.ensureDefaultWorkspaceDir()
    await this.setWorkspaceRoot(defaultRoot)
  }

  private getDefaultWorkspaceRoot(): string {
    const config = new ConfigService()
    try {
      return path.join(config.getCacheBasePath(), 'code')
    } finally {
      config.close()
    }
  }

  private async ensureDefaultWorkspaceDir(): Promise<string> {
    const root = this.getDefaultWorkspaceRoot()
    await fs.promises.mkdir(root, { recursive: true })
    return root
  }

  private async setWorkspaceRoot(root: string): Promise<void> {
    const realRoot = await fs.promises.realpath(root)
    const stat = await fs.promises.stat(realRoot)
    if (!stat.isDirectory()) throw new Error('工作区必须是目录')
    this.stopWorkspaceWatcher()
    this.rejectAllApprovals()
    this.workspace = {
      id: createHash('sha1').update(realRoot).digest('hex').slice(0, 12),
      root: realRoot,
      approvalPolicy: this.readConfiguredApprovalPolicy(),
    }
    this.writeConfiguredWorkspaceRoot(realRoot)
    this.appendLog(`[workspace] ${realRoot}`)
    this.startWorkspaceWatcher(realRoot)
    this.broadcast({ type: 'state', state: this.getState(), at: Date.now() })
  }

  private async ensureWorkspaceFromTool(workspace: CodeWorkspaceRef): Promise<void> {
    const incomingRoot = await fs.promises.realpath(workspace.root)
    if (this.workspace?.root && normalizePathKey(this.workspace.root) === normalizePathKey(incomingRoot)) return
    const configuredRoot = this.readConfiguredWorkspaceRoot()
    if (configuredRoot && normalizePathKey(configuredRoot) === normalizePathKey(incomingRoot)) {
      await this.setWorkspaceRoot(incomingRoot)
      return
    }
    throw new Error('代码工作区未在主进程中选择，拒绝访问')
  }

  private requireWorkspace(): CodeWorkspaceRef {
    if (!this.workspace) throw new Error('尚未选择代码工作区')
    return this.workspace
  }

  private async resolvePath(inputPath: unknown, opts: { allowMissing?: boolean } = {}): Promise<ResolvedPath> {
    const workspace = this.requireWorkspace()
    const root = await fs.promises.realpath(workspace.root)
    const raw = String(inputPath || '.').trim() || '.'
    const isAbsoluteInput = path.isAbsolute(raw)
    const candidate = isAbsoluteInput ? path.resolve(raw) : path.resolve(root, raw)
    if (!isAbsoluteInput && !isPathInside(root, candidate)) {
      throw new Error('相对路径越过工作区边界；如需访问工作区外文件，请使用本机绝对路径')
    }

    let real: string
    try {
      real = await fs.promises.realpath(candidate)
    } catch (error: any) {
      if (!opts.allowMissing) throw error
      const realParent = await findExistingParentPath(candidate)
      if (!isAbsoluteInput && !isPathInside(root, realParent)) throw new Error('目标父目录越过工作区边界')
      const external = !isPathInside(root, candidate)
      return {
        absPath: candidate,
        displayPath: displayPathFor(root, candidate),
        root: external ? realParent : root,
      }
    }

    if (!isAbsoluteInput && !isPathInside(root, real)) throw new Error('路径通过符号链接越过工作区边界')
    const stat = await fs.promises.stat(real).catch(() => null)
    const external = !isPathInside(root, real)
    return {
      absPath: real,
      displayPath: displayPathFor(root, real),
      root: external && stat?.isDirectory() ? real : external ? path.dirname(real) : root,
    }
  }

  private isSensitivePath(displayPath: string): boolean {
    const normalized = displayPath.replace(/\\/g, '/').toLowerCase()
    const base = path.basename(normalized)
    return base === '.env'
      || base.startsWith('.env.')
      || /\.(pem|key|p12|pfx|crt|cer)$/i.test(base)
      || /(^|[/_.-])(secret|token|credential|password|passwd|private-key)([/_.-]|$)/i.test(normalized)
  }

  private isBinaryPath(filePath: string): boolean {
    return BINARY_EXTS.has(path.extname(filePath).toLowerCase())
  }

  private async requestApproval(input: {
    kind: CodeWorkspaceApprovalKind
    targetPath?: string
    command?: string
    diffPreview?: string
    risk: CodeWorkspaceApprovalRisk
    summary: string
  }): Promise<boolean> {
    const workspace = this.requireWorkspace()
    if (workspace.approvalPolicy === 'full-access') return true
    if (workspace.approvalPolicy === 'risk-based' && input.risk !== 'high') return true
    const requestId = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const request: CodeWorkspaceApprovalRequest = {
      requestId,
      workspaceRoot: workspace.root,
      createdAt: Date.now(),
      ...input,
    }
    const decision = await new Promise<CodeWorkspaceApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(requestId)
        resolve('rejected')
      }, APPROVAL_TIMEOUT_MS)
      this.pendingApprovals.set(requestId, { request, resolve, timer })
      this.ctx?.broadcastToWindows('agentWorkspace:approvalRequest', request)
    })
    this.broadcast({ type: 'approval-resolved', requestId, decision, at: Date.now() })
    return decision === 'approved'
  }

  private resolveApproval(requestId: string, decision: CodeWorkspaceApprovalDecision): boolean {
    const pending = this.pendingApprovals.get(requestId)
    if (!pending) return false
    clearTimeout(pending.timer)
    this.pendingApprovals.delete(requestId)
    pending.resolve(decision)
    return true
  }

  private rejectAllApprovals(): void {
    if (this.pendingApprovals.size === 0) return
    for (const [requestId, pending] of this.pendingApprovals.entries()) {
      clearTimeout(pending.timer)
      pending.resolve('rejected')
      this.broadcast({ type: 'approval-resolved', requestId, decision: 'rejected', at: Date.now() })
    }
    this.pendingApprovals.clear()
  }

  private broadcast(event: CodeWorkspaceEvent): void {
    this.ctx?.broadcastToWindows('agentWorkspace:event', event)
  }

  private startWorkspaceWatcher(root: string): void {
    this.stopWorkspaceWatcher()
    try {
      this.workspaceWatcher = fs.watch(root, { recursive: true }, (_eventType, filename) => {
        this.queueWorkspaceFileChange(root, filename ? String(filename) : '')
      })
      this.workspaceWatcher.on('error', (error) => {
        this.appendLog(`[workspace watch error] ${error.message}`)
        this.stopWorkspaceWatcher()
      })
    } catch (error: any) {
      try {
        this.workspaceWatcher = fs.watch(root, (_eventType, filename) => {
          this.queueWorkspaceFileChange(root, filename ? String(filename) : '')
        })
      } catch (fallbackError: any) {
        this.appendLog(`[workspace watch disabled] ${fallbackError?.message || error?.message || String(fallbackError || error)}`)
      }
    }
  }

  private stopWorkspaceWatcher(): void {
    if (this.workspaceWatchTimer) {
      clearTimeout(this.workspaceWatchTimer)
      this.workspaceWatchTimer = null
    }
    this.workspaceWatchPaths.clear()
    if (!this.workspaceWatcher) return
    try {
      this.workspaceWatcher.close()
    } catch {
      // ignore
    }
    this.workspaceWatcher = null
  }

  private queueWorkspaceFileChange(root: string, filename: string): void {
    const normalized = filename.replace(/\\/g, '/')
    if (this.shouldIgnoreWatchedPath(normalized)) return
    this.workspaceWatchPaths.add(normalized || '.')
    if (this.workspaceWatchTimer) clearTimeout(this.workspaceWatchTimer)
    this.workspaceWatchTimer = setTimeout(() => {
      this.workspaceWatchTimer = null
      if (!this.workspace || normalizePathKey(this.workspace.root) !== normalizePathKey(root)) return
      const changedPaths = Array.from(this.workspaceWatchPaths).slice(0, 80)
      this.workspaceWatchPaths.clear()
      this.broadcast({ type: 'files-changed', changedPaths, at: Date.now() })
    }, 150)
  }

  private broadcastWorkspaceFileChange(displayPath: string): void {
    if (this.shouldIgnoreWatchedPath(displayPath.replace(/\\/g, '/'))) return
    this.broadcast({ type: 'files-changed', changedPaths: [displayPath || '.'], at: Date.now() })
  }

  private shouldIgnoreWatchedPath(relativePath: string): boolean {
    if (!relativePath) return false
    return relativePath.split('/').some((part) => SKIP_DIRS.has(part))
  }

  private appendLog(line: string): void {
    const text = line.replace(/\r/g, '').trimEnd()
    if (!text) return
    this.logs.push(text)
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES)
    this.broadcast({ type: 'log', log: text, at: Date.now() })
  }

  private getStatus(): unknown {
    const workspace = this.requireWorkspace()
    const candidates = ['package.json', 'vite.config.ts', 'vite.config.js', 'next.config.js', 'src', 'app']
    const entries = candidates.map((name) => {
      const fullPath = path.join(workspace.root, name)
      return { name, exists: fs.existsSync(fullPath) }
    })
    return { success: true, state: this.getState(), projectHints: entries }
  }

  private async listFiles(args: Record<string, unknown>): Promise<CodeWorkspaceListFilesResult> {
    const start = await this.resolvePath(args.path || '.')
    const stat = await fs.promises.stat(start.absPath)
    if (!stat.isDirectory()) return { success: false, error: '路径不是目录' }
    const maxDepth = Math.max(0, Math.min(8, Number(args.maxDepth ?? 3)))
    const limit = Math.max(1, Math.min(MAX_LIST_ITEMS, Number(args.limit ?? 200)))
    const items: CodeWorkspaceFileItem[] = []
    const queue: Array<{ absPath: string; depth: number }> = [{ absPath: start.absPath, depth: 0 }]

    while (queue.length > 0 && items.length < limit) {
      const current = queue.shift()!
      const dirents = await fs.promises.readdir(current.absPath, { withFileTypes: true }).catch(() => [])
      for (const dirent of dirents) {
        if (items.length >= limit) break
        if (dirent.name.startsWith('.') && dirent.name !== '.github') {
          if (SKIP_DIRS.has(dirent.name)) continue
        }
        if (SKIP_DIRS.has(dirent.name)) continue
        const absPath = path.join(current.absPath, dirent.name)
        const rel = path.relative(start.root, absPath)
        if (dirent.isDirectory()) {
          items.push({ path: rel, type: 'dir' })
          if (current.depth < maxDepth) queue.push({ absPath, depth: current.depth + 1 })
        } else if (dirent.isFile()) {
          const childStat = await fs.promises.stat(absPath).catch(() => null)
          items.push({ path: rel, type: 'file', sizeBytes: childStat?.size })
        }
      }
    }
    return { success: true, root: start.displayPath, items, truncated: items.length >= limit }
  }

  private async readFile(args: Record<string, unknown>): Promise<unknown> {
    const target = await this.resolvePath(args.path)
    if (this.isBinaryPath(target.absPath)) return { success: false, error: '二进制文件不会进入模型上下文', path: target.displayPath }
    if (this.isSensitivePath(target.displayPath)) {
      const approved = await this.requestApproval({
        kind: 'sensitive-read',
        targetPath: target.displayPath,
        risk: 'high',
        summary: `读取敏感文件 ${target.displayPath}`,
      })
      if (!approved) return { success: false, denied: true, error: '用户拒绝读取敏感文件', path: target.displayPath }
    }
    const stat = await fs.promises.stat(target.absPath)
    if (!stat.isFile()) return { success: false, error: '路径不是文件', path: target.displayPath }
    if (stat.size > MAX_READ_BYTES) return { success: false, error: `文件超过 ${MAX_READ_BYTES} bytes，拒绝读取`, path: target.displayPath, sizeBytes: stat.size }
    const buffer = await fs.promises.readFile(target.absPath)
    if (buffer.includes(0)) return { success: false, error: '疑似二进制文件，拒绝读取', path: target.displayPath }
    const text = buffer.toString('utf8')
    const lines = text.split(/\r?\n/)
    const maxLines = Math.max(1, Math.min(MAX_READ_LINES, Number(args.maxLines ?? MAX_READ_LINES)))
    return {
      success: true,
      path: target.displayPath,
      content: lines.slice(0, maxLines).join('\n'),
      lineCount: lines.length,
      sizeBytes: stat.size,
      truncated: lines.length > maxLines,
    }
  }

  private async replaceInFile(args: Record<string, unknown>): Promise<unknown> {
    const search = String(args.search ?? '')
    const replace = String(args.replace ?? '')
    if (!search) return { success: false, error: 'search 不能为空' }
    const target = await this.resolvePath(args.path)
    const before = await fs.promises.readFile(target.absPath, 'utf8')
    if (!before.includes(search)) return { success: false, error: '没有找到 search 文本', path: target.displayPath }
    const after = args.replaceAll === true ? before.split(search).join(replace) : before.replace(search, replace)
    const diffPreview = buildDiffPreview(target.displayPath, before, after)
    const approved = await this.requestApproval({
      kind: 'write',
      targetPath: target.displayPath,
      diffPreview,
      risk: this.isSensitivePath(target.displayPath) ? 'high' : 'medium',
      summary: `修改文件 ${target.displayPath}`,
    })
    if (!approved) {
      agentAuditService.record({
        source: 'code-workspace',
        toolName: 'code_replace_in_file',
        argsSummary: { path: target.displayPath },
        risk: this.isSensitivePath(target.displayPath) ? 'high' : 'medium',
        status: 'denied',
        targetPath: target.absPath,
      })
      return { success: false, denied: true, error: '用户拒绝写入', path: target.displayPath }
    }
    const snapshotPath = agentAuditService.createSnapshot(target.absPath)
    await fs.promises.writeFile(target.absPath, after, 'utf8')
    const audit = agentAuditService.record({
      source: 'code-workspace',
      toolName: 'code_replace_in_file',
      argsSummary: { path: target.displayPath, replaceAll: args.replaceAll === true },
      risk: this.isSensitivePath(target.displayPath) ? 'high' : 'medium',
      status: 'success',
      targetPath: target.absPath,
      snapshotPath,
      outputPaths: [target.absPath],
    })
    this.broadcastWorkspaceFileChange(target.displayPath)
    return { success: true, path: target.displayPath, diffPreview, operationId: audit.operationId }
  }

  private async writeFile(args: Record<string, unknown>): Promise<unknown> {
    const target = await this.resolvePath(args.path, { allowMissing: true })
    const content = String(args.content ?? '')
    const before = await fs.promises.readFile(target.absPath, 'utf8').catch(() => '')
    const diffPreview = buildDiffPreview(target.displayPath, before, content)
    const approved = await this.requestApproval({
      kind: 'write',
      targetPath: target.displayPath,
      diffPreview,
      risk: this.isSensitivePath(target.displayPath) ? 'high' : 'medium',
      summary: `${before ? '覆盖' : '创建'}文件 ${target.displayPath}`,
    })
    if (!approved) {
      agentAuditService.record({
        source: 'code-workspace',
        toolName: 'code_write_file',
        argsSummary: { path: target.displayPath },
        risk: this.isSensitivePath(target.displayPath) ? 'high' : 'medium',
        status: 'denied',
        targetPath: target.absPath,
      })
      return { success: false, denied: true, error: '用户拒绝写入', path: target.displayPath }
    }
    const snapshotPath = before ? agentAuditService.createSnapshot(target.absPath) : undefined
    await fs.promises.mkdir(path.dirname(target.absPath), { recursive: true })
    await fs.promises.writeFile(target.absPath, content, 'utf8')
    const audit = agentAuditService.record({
      source: 'code-workspace',
      toolName: 'code_write_file',
      argsSummary: { path: target.displayPath, bytes: Buffer.byteLength(content) },
      risk: this.isSensitivePath(target.displayPath) ? 'high' : 'medium',
      status: 'success',
      targetPath: target.absPath,
      snapshotPath,
      outputPaths: [target.absPath],
    })
    this.broadcastWorkspaceFileChange(target.displayPath)
    return { success: true, path: target.displayPath, bytes: Buffer.byteLength(content), diffPreview, operationId: audit.operationId }
  }

  private async deleteFile(args: Record<string, unknown>): Promise<unknown> {
    const target = await this.resolvePath(args.path)
    const stat = await fs.promises.stat(target.absPath)
    if (!stat.isFile()) return { success: false, error: '只允许删除文件', path: target.displayPath }
    const approved = await this.requestApproval({
      kind: 'delete',
      targetPath: target.displayPath,
      diffPreview: buildDiffPreview(target.displayPath, await fs.promises.readFile(target.absPath, 'utf8').catch(() => ''), ''),
      risk: 'high',
      summary: `删除文件 ${target.displayPath}`,
    })
    if (!approved) {
      agentAuditService.record({
        source: 'code-workspace',
        toolName: 'code_delete_file',
        argsSummary: { path: target.displayPath },
        risk: 'high',
        status: 'denied',
        targetPath: target.absPath,
      })
      return { success: false, denied: true, error: '用户拒绝删除', path: target.displayPath }
    }
    const snapshotPath = agentAuditService.createSnapshot(target.absPath)
    await fs.promises.unlink(target.absPath)
    const audit = agentAuditService.record({
      source: 'code-workspace',
      toolName: 'code_delete_file',
      argsSummary: { path: target.displayPath },
      risk: 'high',
      status: 'success',
      targetPath: target.absPath,
      snapshotPath,
    })
    this.broadcastWorkspaceFileChange(target.displayPath)
    return { success: true, path: target.displayPath, operationId: audit.operationId }
  }

  private async runCommand(args: Record<string, unknown>): Promise<unknown> {
    const workspace = this.requireWorkspace()
    const parsed = this.normalizeCommand(args)
    const cwd = args.cwd ? (await this.resolvePath(args.cwd)).absPath : workspace.root
    const candidates = parsed.mode === 'shell' ? [shellCommandForPlatform(parsed.commandLine)] : commandCandidatesForPlatform(parsed.command, parsed.args)
    const commandText = approvalCommandText(candidates)
    const approved = await this.requestApproval({
      kind: 'command',
      command: commandText,
      risk: parsed.mode === 'shell' || looksShellLike(parsed.command, parsed.args) ? 'high' : 'medium',
      summary: `运行命令 ${commandText}`,
    })
    if (!approved) {
      agentAuditService.record({
        source: 'code-workspace',
        toolName: 'code_run_command',
        argsSummary: { command: commandText, cwd },
        risk: parsed.mode === 'shell' || looksShellLike(parsed.command, parsed.args) ? 'high' : 'medium',
        status: 'denied',
      })
      return { success: false, denied: true, error: '用户拒绝运行命令', command: commandText }
    }
    const result = await this.spawnAndCollectCandidates(candidates, cwd, Number(args.timeoutMs) || COMMAND_TIMEOUT_MS)
    agentAuditService.record({
      source: 'code-workspace',
      toolName: 'code_run_command',
      argsSummary: { command: commandText, cwd },
      risk: parsed.mode === 'shell' || looksShellLike(parsed.command, parsed.args) ? 'high' : 'medium',
      status: (result as { success?: unknown }).success === false ? 'failed' : 'success',
      error: (result as { error?: string }).error,
    })
    return result
  }

  private async startDevServer(args: Record<string, unknown>): Promise<unknown> {
    const workspace = this.requireWorkspace()
    if (this.devServer && !this.devServer.killed) {
      return { success: true, alreadyRunning: true, state: this.getState(), logs: this.logs.slice(-80) }
    }
    const parsed = this.normalizeCommand(args, { defaultCommand: 'npm', defaultArgs: ['run', 'dev'] })
    const cwd = args.cwd ? (await this.resolvePath(args.cwd)).absPath : workspace.root
    const candidates = parsed.mode === 'shell' ? [shellCommandForPlatform(parsed.commandLine)] : commandCandidatesForPlatform(parsed.command, parsed.args)
    const commandText = approvalCommandText(candidates)
    const approved = await this.requestApproval({
      kind: 'dev-server',
      command: commandText,
      risk: parsed.mode === 'shell' ? 'high' : 'medium',
      summary: `启动开发服务器 ${commandText}`,
    })
    if (!approved) return { success: false, denied: true, error: '用户拒绝启动开发服务器', command: commandText }

    this.logs = []
    this.devServerPreviewUrl = ''
    let lastError = '开发服务器启动失败'
    for (const [index, candidate] of candidates.entries()) {
      if (index > 0) this.appendLog(`[dev-server retry] ${candidate.display}`)
      const result = await this.spawnDevServerCandidate(candidate, cwd)
      if (result.success) {
        this.broadcast({ type: 'state', state: this.getState(), at: Date.now() })
        return { success: true, state: this.getState(), logs: this.logs.slice(-120) }
      }
      lastError = result.error
      if (result.code !== 'ENOENT') break
    }

    this.devServer = null
    this.devServerCommand = ''
    this.devServerStartedAt = 0
    this.broadcast({ type: 'state', state: this.getState(), at: Date.now() })
    return { success: false, command: commandText, error: lastError, state: this.getState(), logs: this.logs.slice(-120) }
  }

  private spawnDevServerCandidate(candidate: CommandSpec, cwd: string): Promise<{ success: true } | { success: false; error: string; code?: string }> {
    this.devServerCommand = candidate.display
    this.devServerStartedAt = Date.now()
    this.appendLog(`$ ${candidate.display}`)

    return new Promise((resolve) => {
      const child = spawn(candidate.command, candidate.args, {
        cwd,
        shell: false,
        env: { ...process.env, BROWSER: 'none', HOST: '127.0.0.1' },
        windowsHide: true,
      })
      this.devServer = child
      let settled = false
      const settle = (result: { success: true } | { success: false; error: string; code?: string }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => settle({ success: true }), DEV_SERVER_READY_TIMEOUT_MS)

      child.stdout.on('data', (chunk) => this.handleDevServerOutput(chunk.toString()))
      child.stderr.on('data', (chunk) => this.handleDevServerOutput(chunk.toString()))
      child.on('exit', (code, signal) => {
        this.appendLog(`[dev-server exited] code=${code ?? 'null'} signal=${signal ?? 'null'}`)
        if (this.devServer === child) this.devServer = null
        this.broadcast({ type: 'state', state: this.getState(), at: Date.now() })
        settle({ success: false, error: `开发服务器已退出 code=${code ?? 'null'}${signal ? ` signal=${signal}` : ''}` })
      })
      child.on('error', (error: NodeJS.ErrnoException) => {
        this.appendLog(`[dev-server error] ${error.message}`)
        if (this.devServer === child) this.devServer = null
        this.broadcast({ type: 'state', state: this.getState(), at: Date.now() })
        settle({ success: false, error: error.message, code: error.code })
      })
    })
  }

  private async stopDevServer(): Promise<unknown> {
    await this.stopDevServerInternal()
    return { success: true, state: this.getState(), logs: this.logs.slice(-80) }
  }

  private async getBrowserDiagnostics(args: Record<string, unknown>): Promise<CodeWorkspaceBrowserDiagnosticsResult> {
    const workspace = this.requireWorkspace()
    const requestedUrl = String(args.url || this.devServerPreviewUrl || '').trim()
    if (!requestedUrl) return { success: false, error: '没有可诊断的预览 URL，请先启动 dev server' }
    let parsed: URL
    try {
      parsed = new URL(requestedUrl)
    } catch {
      return { success: false, error: '预览 URL 无效', url: requestedUrl }
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)) {
      return { success: false, error: '只允许诊断本机 localhost / 127.0.0.1 预览', url: requestedUrl }
    }

    const waitMs = Math.max(1_000, Math.min(30_000, Number(args.waitMs || BROWSER_DIAGNOSTICS_IDLE_MS)))
    const diagnostics: CodeWorkspaceBrowserDiagnostic[] = []
    let debuggerAttached = false
    const add = (entry: Omit<CodeWorkspaceBrowserDiagnostic, 'at'>) => {
      diagnostics.push({ ...entry, at: Date.now() })
      if (diagnostics.length > 120) diagnostics.splice(0, diagnostics.length - 120)
    }

    const win = new BrowserWindow({
      width: 1280,
      height: 900,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    })

    try {
      try {
        win.webContents.debugger.attach('1.3')
        debuggerAttached = true
        await win.webContents.debugger.sendCommand('Runtime.enable')
        await win.webContents.debugger.sendCommand('Log.enable')
        await win.webContents.debugger.sendCommand('Network.enable')
        win.webContents.debugger.on('message', (_event, method, params: any) => {
          if (method === 'Runtime.exceptionThrown') {
            const details = params?.exceptionDetails
            add({
              kind: 'page-error',
              level: 'error',
              message: String(details?.exception?.description || details?.text || 'Runtime exception'),
              source: details?.url,
              line: typeof details?.lineNumber === 'number' ? details.lineNumber + 1 : undefined,
              url: win.webContents.getURL(),
            })
          } else if (method === 'Log.entryAdded') {
            const entry = params?.entry
            if (entry?.level === 'error' || entry?.level === 'warning') {
              add({
                kind: 'console',
                level: entry.level === 'error' ? 'error' : 'warning',
                message: String(entry.text || ''),
                source: entry.source,
                line: entry.lineNumber,
                url: entry.url || win.webContents.getURL(),
              })
            }
          } else if (method === 'Network.loadingFailed') {
            add({
              kind: 'load-failed',
              level: 'error',
              message: String(params?.errorText || 'Network request failed'),
              url: String(params?.requestId || win.webContents.getURL()),
            })
          }
        })
      } catch (debuggerError: any) {
        add({ kind: 'console', level: 'warning', message: `DevTools diagnostics unavailable: ${debuggerError?.message || String(debuggerError)}`, url: parsed.toString() })
      }
      win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
        const severity = level >= 3 ? 'error' : level === 2 ? 'warning' : level === 1 ? 'info' : 'debug'
        add({ kind: 'console', level: severity, message, line, source: sourceId, url: win.webContents.getURL() })
      })
      win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        add({
          kind: 'load-failed',
          level: 'error',
          message: `${isMainFrame ? 'main frame' : 'subresource'} load failed ${errorCode}: ${errorDescription}`,
          url: validatedURL,
        })
      })
      win.webContents.on('render-process-gone', (_event, details) => {
        add({
          kind: 'render-process-gone',
          level: 'error',
          message: `${details.reason}${details.exitCode === undefined ? '' : ` exitCode=${details.exitCode}`}`,
          url: win.webContents.getURL(),
        })
      })
      win.webContents.on('did-navigate', (_event, url) => {
        add({ kind: 'navigation', level: 'info', message: 'navigated', url })
      })

      await Promise.race([
        win.webContents.loadURL(parsed.toString()),
        new Promise((_, reject) => setTimeout(() => reject(new Error('页面加载诊断超时')), BROWSER_DIAGNOSTICS_TIMEOUT_MS)),
      ])
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    } catch (error: any) {
      add({ kind: 'load-failed', level: 'error', message: error?.message || String(error), url: parsed.toString() })
    } finally {
      if (debuggerAttached && win.webContents.debugger.isAttached()) {
        try { win.webContents.debugger.detach() } catch { /* ignore */ }
      }
      if (!win.isDestroyed()) win.destroy()
    }

    const relevantDiagnostics = diagnostics.filter((item) => {
      if (!item.source && !item.url) return true
      const value = `${item.source || ''} ${item.url || ''}`
      return !value.includes('favicon.ico') && !value.includes('/@vite/client')
    })
    const hasErrors = relevantDiagnostics.some((item) => item.level === 'error' || item.kind === 'load-failed' || item.kind === 'render-process-gone')
    this.appendLog(`[browser diagnostics] ${workspace.root} ${parsed.toString()} errors=${hasErrors ? 'yes' : 'no'} items=${relevantDiagnostics.length}`)
    return { success: true, url: parsed.toString(), diagnostics: relevantDiagnostics, hasErrors }
  }

  private async stopDevServerInternal(): Promise<void> {
    const child = this.devServer
    if (!child) return
    this.devServer = null
    try {
      child.kill('SIGTERM')
    } catch {
      // ignore
    }
    this.appendLog('[dev-server stopped]')
    this.broadcast({ type: 'state', state: this.getState(), at: Date.now() })
  }

  private handleDevServerOutput(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      this.appendLog(line)
      const url = line.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?[^\s)]*/i)?.[0]
      if (url && !this.devServerPreviewUrl) {
        this.devServerPreviewUrl = url.replace('[::1]', '127.0.0.1')
        this.broadcast({ type: 'preview-url', previewUrl: this.devServerPreviewUrl, at: Date.now() })
        this.broadcast({ type: 'state', state: this.getState(), at: Date.now() })
      }
    }
  }

  private normalizeCommand(args: Record<string, unknown>, fallback?: { defaultCommand: string; defaultArgs: string[] }): NormalizedCommand {
    const commandLine = typeof args.commandLine === 'string' ? args.commandLine.trim() : ''
    if (commandLine) {
      return { mode: 'shell', commandLine }
    }
    let command = String(args.command || '').trim()
    let commandArgs = Array.isArray(args.args) ? args.args.map(String) : []
    if (!command && fallback) {
      command = fallback.defaultCommand
      commandArgs = fallback.defaultArgs
    }
    if (!command) throw new Error('command 不能为空')
    return { mode: 'spawn', command, args: commandArgs }
  }

  private async spawnAndCollectCandidates(candidates: CommandSpec[], cwd: string, timeoutMs: number): Promise<unknown> {
    let lastResult: unknown = { success: false, error: '命令执行失败' }
    for (const [index, candidate] of candidates.entries()) {
      if (index > 0) this.appendLog(`[command retry] ${candidate.display}`)
      const result = await this.spawnAndCollectCandidate(candidate, cwd, timeoutMs)
      lastResult = result
      const meta = result as { success?: boolean; spawnErrorCode?: string }
      if (meta.success || meta.spawnErrorCode !== 'ENOENT') return result
    }
    return lastResult
  }

  private spawnAndCollectCandidate(candidate: CommandSpec, cwd: string, timeoutMs: number): Promise<unknown> {
    this.appendLog(`$ ${candidate.display}`)
    return new Promise((resolve) => {
      const child = spawn(candidate.command, candidate.args, {
        cwd,
        shell: false,
        env: { ...process.env, BROWSER: 'none' },
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      let finished = false
      const timer = setTimeout(() => {
        if (finished) return
        finished = true
        try { child.kill('SIGTERM') } catch { /* ignore */ }
        resolve({ success: false, timedOut: true, command: candidate.display, stdout: truncateText(stdout), stderr: truncateText(stderr), error: '命令执行超时' })
      }, Math.max(1_000, Math.min(COMMAND_TIMEOUT_MS, timeoutMs)))

      child.stdout.on('data', (chunk) => {
        const text = chunk.toString()
        stdout += text
        this.appendLog(text)
      })
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString()
        stderr += text
        this.appendLog(text)
      })
      child.on('error', (error: NodeJS.ErrnoException) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        resolve({
          success: false,
          command: candidate.display,
          error: error.message,
          spawnErrorCode: error.code,
          stdout: truncateText(stdout),
          stderr: truncateText(stderr),
        })
      })
      child.on('exit', (code, signal) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        resolve({
          success: code === 0,
          command: candidate.display,
          exitCode: code,
          signal,
          stdout: truncateText(stdout),
          stderr: truncateText(stderr),
          error: code === 0 ? undefined : `命令退出码 ${code ?? 'null'}${signal ? ` signal=${signal}` : ''}`,
        })
      })
    })
  }
}

export const codeWorkspaceService = new CodeWorkspaceService()
