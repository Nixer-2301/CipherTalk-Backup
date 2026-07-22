import crypto from 'crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { MainProcessContext } from '../../main/context'
import { ConfigService } from '../config'
import { agentAuditService } from '../agent/agentAuditService'
import {
  DEFAULT_LOCAL_CODING_AGENT_CONFIG,
  buildLocalCodingAgentCommand,
  commandNameForKind,
  extractStructuredText,
  parseClaudeJsonEvent,
  parseCodexJsonEvent,
  parseOpencodeJsonEvent,
} from './adapters'
import {
  copyWorkspaceFiltered,
  extractChangedPathsFromPatch,
  validatePatchPaths,
} from './shadowWorkspace'
import type {
  LocalCodingAgentConfig,
  LocalCodingAgentDefinition,
  LocalCodingAgentDetectResult,
  LocalCodingAgentEvent,
  LocalCodingAgentJob,
  LocalCodingAgentPatchResult,
  LocalCodingAgentRunInput,
  LocalCodingAgentRunResult,
} from './types'

type SpawnResult = {
  command?: string
  exitCode: number | null
  stdout: string
  stderr: string
  error?: string
  timedOut?: boolean
}

type PendingJob = {
  job: LocalCodingAgentJob
  child: ChildProcessWithoutNullStreams | null
  canceled: boolean
}

function now(): number {
  return Date.now()
}

function newJobId(): string {
  return `lcagent-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
}

function truncateText(value: string, max = 16_000): string {
  return value.length > max ? `${value.slice(0, max)}\n...<truncated>` : value
}

function normalizeConfig(value: unknown): LocalCodingAgentConfig {
  const fallback = DEFAULT_LOCAL_CODING_AGENT_CONFIG as LocalCodingAgentConfig
  if (!value || typeof value !== 'object') return structuredClone(fallback)
  const input = value as Partial<LocalCodingAgentConfig>
  const agents: Record<string, LocalCodingAgentDefinition> = { ...fallback.agents }
  if (input.agents && typeof input.agents === 'object') {
    for (const [id, agent] of Object.entries(input.agents)) {
      if (!agent || typeof agent !== 'object') continue
      const base = agents[id] || {
        kind: 'custom',
        name: id,
        executablePath: '',
        timeoutMs: 1_800_000,
      } as LocalCodingAgentDefinition
      agents[id] = {
        ...base,
        ...agent,
        name: String(agent.name || base.name || id),
        executablePath: String(agent.executablePath || ''),
        timeoutMs: Math.max(10_000, Math.min(7_200_000, Number(agent.timeoutMs || base.timeoutMs || 1_800_000))),
        env: agent.env && typeof agent.env === 'object' ? Object.fromEntries(
          Object.entries(agent.env).filter(([key, val]) => typeof key === 'string' && typeof val === 'string')
        ) : undefined,
        argsTemplate: Array.isArray(agent.argsTemplate) ? agent.argsTemplate.map(String) : base.argsTemplate,
      }
    }
  }
  const activeAgent = typeof input.activeAgent === 'string' && input.activeAgent ? input.activeAgent : fallback.activeAgent
  return {
    enabled: Boolean(input.enabled),
    activeAgent: agents[activeAgent] ? activeAgent : fallback.activeAgent,
    agents,
  }
}

function commandCandidates(command: string): string[] {
  if (process.platform === 'win32' && !path.extname(command)) {
    return [`${command}.exe`, `${command}.cmd`, `${command}.ps1`, command]
  }
  if (/[\\/]/.test(command) || path.extname(command)) return [command]
  return [command]
}

function readPathEnv(): string {
  return process.env.PATH || process.env.Path || ''
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const normalized = value.trim()
    if (!normalized || seen.has(normalized.toLowerCase())) continue
    seen.add(normalized.toLowerCase())
    result.push(normalized)
  }
  return result
}

function commandPathDirs(command: string): string[] {
  if (!/[\\/]/.test(command)) return []
  const dir = path.dirname(command)
  const parent = path.dirname(dir)
  return uniqueStrings([dir, parent])
}

function buildChildEnv(extra?: Record<string, string>, pathDirs: string[] = []): NodeJS.ProcessEnv {
  const keys = [
    'PATH',
    'Path',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
    'SystemRoot',
    'ComSpec',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ]
  const env: NodeJS.ProcessEnv = {}
  for (const key of keys) {
    const value = process.env[key]
    if (typeof value === 'string') env[key] = value
  }
  const currentPath = env.PATH || env.Path || readPathEnv()
  env.PATH = uniqueStrings([...pathDirs, ...currentPath.split(path.delimiter)]).join(path.delimiter)
  if (process.platform === 'win32') env.Path = env.PATH
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = value
    }
  }
  return env
}

function quoteCmdArg(value: string): string {
  if (!value) return '""'
  if (!/[ \t&()^|<>"]/g.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

function spawnSpec(command: string, args: string[]): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (process.platform !== 'win32') return { command, args }
  const ext = path.extname(command).toLowerCase()
  if (ext === '.cmd' || ext === '.bat') {
    const line = [quoteCmdArg(command), ...args.map(quoteCmdArg)].join(' ')
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', line],
      windowsVerbatimArguments: true,
    }
  }
  if (ext === '.ps1') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', command, ...args],
    }
  }
  return { command, args }
}

function parseJsonLines(buffer: { value: string }, text: string, onJson: (value: unknown) => void): void {
  buffer.value += text
  const lines = buffer.value.split(/\r?\n/)
  buffer.value = lines.pop() || ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) continue
    try {
      onJson(JSON.parse(trimmed))
    } catch {
      // Keep raw stdout/stderr as the fallback UI surface.
    }
  }
}

export class LocalCodingAgentService {
  private ctx: MainProcessContext | null = null
  private jobs = new Map<string, LocalCodingAgentJob>()
  private pending = new Map<string, PendingJob>()

  setContext(ctx: MainProcessContext): void {
    this.ctx = ctx
  }

  getConfig(): LocalCodingAgentConfig {
    return this.withConfig((config) => normalizeConfig(config.get('localCodingAgentConfig' as any)))
  }

  setConfig(input: unknown): LocalCodingAgentConfig {
    const configValue = normalizeConfig(input)
    this.withConfig((config) => {
      config.set('localCodingAgentConfig' as any, configValue as any)
    })
    return configValue
  }

  async detect(): Promise<LocalCodingAgentDetectResult[]> {
    const config = this.getConfig()
    const entries = Object.entries(config.agents)
      .filter(([, agent]) => agent.kind !== 'custom')
    const results: LocalCodingAgentDetectResult[] = []
    for (const [id, agent] of entries) {
      results.push(await this.detectOne(id, agent))
    }
    return results
  }

  async run(input: LocalCodingAgentRunInput): Promise<LocalCodingAgentRunResult> {
    const config = this.getConfig()
    if (!config.enabled) return { success: false, error: '本地编码智能体未启用' }
    const agent = config.agents[input.agentId]
    if (!agent) return { success: false, error: '未找到本地编码智能体配置' }
    const prompt = String(input.prompt || '').trim()
    if (!prompt) return { success: false, error: '任务内容不能为空' }
    if (!input.workspace?.root) return { success: false, error: '请先选择代码工作区' }
    const mode = input.mode === 'inspect' || input.mode === 'direct' ? input.mode : 'propose'
    const jobId = newJobId()
    const startedAt = now()
    const jobBaseDir = path.join(this.getJobsBaseDir(), jobId)
    const runRoot = mode === 'propose' ? path.join(jobBaseDir, 'workspace') : input.workspace.root
    const job: LocalCodingAgentJob = {
      id: jobId,
      agentId: input.agentId,
      mode,
      prompt,
      workspaceRoot: input.workspace.root,
      runRoot,
      shadowRoot: mode === 'propose' ? runRoot : undefined,
      changedPaths: [],
      status: 'running',
      startedAt,
    }
    this.jobs.set(jobId, job)
    this.pending.set(jobId, { job, child: null, canceled: false })
    void this.runInternal(job, agent, input.model).catch((error) => {
      this.failJob(job, error instanceof Error ? error.message : String(error))
    })
    return { success: true, jobId }
  }

  cancel(jobId: string): { success: boolean; error?: string } {
    const pending = this.pending.get(jobId)
    if (!pending) return { success: false, error: '任务不存在或已结束' }
    pending.canceled = true
    pending.job.status = 'canceled'
    pending.job.finishedAt = now()
    try {
      pending.child?.kill('SIGTERM')
    } catch {
      // ignore
    }
    this.emit({ type: 'error', jobId, error: '任务已取消', at: now() })
    this.pending.delete(jobId)
    return { success: true }
  }

  async applyPatch(jobId: string): Promise<LocalCodingAgentPatchResult> {
    const job = this.jobs.get(jobId)
    if (!job) return { success: false, error: '任务不存在' }
    if (!job.patchPath || !job.patch || job.changedPaths.length === 0) return { success: false, error: '该任务没有可应用补丁' }
    try {
      validatePatchPaths(job.workspaceRoot, job.changedPaths)
      const check = await this.spawnCollect(commandCandidates('git'), ['apply', '--check', job.patchPath], job.workspaceRoot, 60_000)
      if (check.exitCode !== 0) {
        return { success: false, error: check.stderr || check.stdout || check.error || '补丁检查失败' }
      }
      const apply = await this.spawnCollect(commandCandidates('git'), ['apply', job.patchPath], job.workspaceRoot, 60_000)
      if (apply.exitCode !== 0) {
        return { success: false, error: apply.stderr || apply.stdout || apply.error || '补丁应用失败' }
      }
      agentAuditService.record({
        source: 'code-workspace',
        toolName: 'local_coding_agent_apply_patch',
        argsSummary: { jobId, agentId: job.agentId, mode: job.mode, changedPaths: job.changedPaths },
        risk: 'high',
        status: 'success',
        targetPath: job.workspaceRoot,
        outputPaths: job.changedPaths.map((item) => path.join(job.workspaceRoot, item)),
      })
      this.ctx?.broadcastToWindows('agentWorkspace:event', {
        type: 'files-changed',
        changedPaths: job.changedPaths,
        at: now(),
      })
      return { success: true, changedPaths: job.changedPaths }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      agentAuditService.record({
        source: 'code-workspace',
        toolName: 'local_coding_agent_apply_patch',
        argsSummary: { jobId, agentId: job.agentId },
        risk: 'high',
        status: 'failed',
        targetPath: job.workspaceRoot,
        error: message,
      })
      return { success: false, error: message }
    }
  }

  async discardPatch(jobId: string): Promise<LocalCodingAgentPatchResult> {
    const job = this.jobs.get(jobId)
    if (!job) return { success: false, error: '任务不存在' }
    if (job.shadowRoot) {
      await fs.promises.rm(path.dirname(job.shadowRoot), { recursive: true, force: true }).catch(() => undefined)
    }
    job.patch = ''
    job.patchPath = undefined
    job.changedPaths = []
    return { success: true, changedPaths: [] }
  }

  private async runInternal(job: LocalCodingAgentJob, agent: LocalCodingAgentDefinition, model?: string): Promise<void> {
    const pending = this.pending.get(job.id)
    if (!pending) return
    await fs.promises.mkdir(path.dirname(job.runRoot), { recursive: true })
    if (job.mode === 'propose') {
      await copyWorkspaceFiltered(job.workspaceRoot, job.runRoot)
      await this.createGitBaseline(job.runRoot)
    }

    const command = buildLocalCodingAgentCommand({
      agent,
      prompt: job.prompt,
      cwd: job.runRoot,
      mode: job.mode,
      model,
    })
    this.emit({ type: 'started', jobId: job.id, agentId: job.agentId, mode: job.mode, cwd: job.runRoot, at: now() })
    agentAuditService.record({
      source: 'code-workspace',
      toolName: 'local_coding_agent_run',
      argsSummary: { jobId: job.id, agentId: job.agentId, mode: job.mode, command: command.display },
      risk: job.mode === 'direct' ? 'high' : 'medium',
      status: 'pending',
      targetPath: job.workspaceRoot,
    })

    const result = await this.spawnAgent(job, command.command, command.args, agent.env, agent.timeoutMs, agent.kind)
    if (pending.canceled) return
    job.exitCode = result.exitCode
    job.finishedAt = now()

    if (job.mode === 'propose') await this.collectPatch(job)

    if (result.exitCode === 0) {
      job.status = 'finished'
      this.emit({ type: 'finished', jobId: job.id, exitCode: result.exitCode, durationMs: job.finishedAt - job.startedAt, at: now() })
    } else {
      job.status = 'failed'
      job.error = result.error || result.stderr || `本地编码智能体退出码 ${result.exitCode ?? 'null'}`
      this.emit({ type: 'error', jobId: job.id, error: job.error, at: now() })
      this.emit({ type: 'finished', jobId: job.id, exitCode: result.exitCode, durationMs: job.finishedAt - job.startedAt, at: now() })
    }
    this.pending.delete(job.id)
  }

  private async createGitBaseline(root: string): Promise<void> {
    const git = commandCandidates('git')
    const init = await this.spawnCollect(git, ['init'], root, 60_000)
    if (init.exitCode !== 0) throw new Error(init.stderr || init.error || 'shadow workspace 初始化 git 失败')
    await this.spawnCollect(git, ['add', '-A'], root, 60_000)
    const commit = await this.spawnCollect(
      git,
      ['-c', 'user.name=CipherTalk', '-c', 'user.email=ciphertalk.local@example.invalid', 'commit', '--allow-empty', '-m', 'baseline'],
      root,
      60_000,
    )
    if (commit.exitCode !== 0) {
      const status = await this.spawnCollect(git, ['status', '--porcelain'], root, 60_000)
      if ((status.stdout || '').trim()) throw new Error(commit.stderr || commit.stdout || 'shadow workspace baseline commit 失败')
    }
  }

  private async collectPatch(job: LocalCodingAgentJob): Promise<void> {
    const diff = await this.spawnCollect(commandCandidates('git'), ['diff', '--binary', 'HEAD'], job.runRoot, 60_000)
    const patch = diff.stdout || ''
    const changedPaths = extractChangedPathsFromPatch(patch)
    validatePatchPaths(job.workspaceRoot, changedPaths)
    job.patch = patch
    job.changedPaths = changedPaths
    if (patch.trim()) {
      const patchPath = path.join(path.dirname(job.runRoot), 'changes.patch')
      await fs.promises.writeFile(patchPath, patch, 'utf8')
      job.patchPath = patchPath
    }
    this.emit({ type: 'diff', jobId: job.id, patch, changedPaths, at: now() })
  }

  private spawnAgent(
    job: LocalCodingAgentJob,
    command: string,
    args: string[],
    extraEnv: Record<string, string> | undefined,
    timeoutMs: number,
    kind: LocalCodingAgentDefinition['kind'],
  ): Promise<SpawnResult> {
    return new Promise((resolve) => {
      const candidates = commandCandidates(command)
      let candidateIndex = 0

      const startCandidate = (): void => {
        const current = candidates[candidateIndex]
        const spec = spawnSpec(current, args)
        const child = spawn(spec.command, spec.args, {
          cwd: job.runRoot,
          shell: false,
          env: buildChildEnv(extraEnv, commandPathDirs(current)),
          windowsHide: true,
          windowsVerbatimArguments: spec.windowsVerbatimArguments,
        })
        const pending = this.pending.get(job.id)
        if (pending) pending.child = child
        child.stdin.end()
        let stdout = ''
        let stderr = ''
        let settled = false
        const jsonBuffer = { value: '' }
        // claude 的 tool_use / tool_result 分处两条事件，按 job 维护 id→工具 的映射做关联。
        const claudeToolUses = new Map<string, { toolName: string; input: unknown }>()
        const finish = (result: SpawnResult): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(result)
        }
        const timer = setTimeout(() => {
          try { child.kill('SIGTERM') } catch { /* ignore */ }
          finish({ command: current, exitCode: null, stdout: truncateText(stdout), stderr: truncateText(stderr), timedOut: true, error: '本地编码智能体运行超时' })
        }, Math.max(10_000, Math.min(7_200_000, Number(timeoutMs) || 1_800_000)))

        child.stdout.on('data', (chunk) => {
          const text = chunk.toString()
          stdout += text
          this.emit({ type: 'stdout', jobId: job.id, text, at: now() })
          parseJsonLines(jsonBuffer, text, (value) => {
            // 思考/工具/命令走 activity（折叠链），只有最终回复走 message。各 CLI 的 JSON 格式不同，分别解析。
            const parsedList = kind === 'codex'
              ? [parseCodexJsonEvent(value)]
              : kind === 'claude-cli'
                ? parseClaudeJsonEvent(value, claudeToolUses)
                : kind === 'opencode'
                  ? [parseOpencodeJsonEvent(value)]
                  : null
            if (parsedList) {
              for (const parsed of parsedList) {
                if (parsed?.message) this.emit({ type: 'message', jobId: job.id, ...parsed.message, at: now() })
                else if (parsed?.activity) this.emit({ type: 'activity', jobId: job.id, ...parsed.activity, at: now() })
              }
              return
            }
            // custom / 未知：通用兜底，尽力从任意 JSON 里抠出一段文字。
            const extracted = extractStructuredText(value)
            if (extracted) this.emit({ type: 'message', jobId: job.id, ...extracted, at: now() })
          })
        })
        child.stderr.on('data', (chunk) => {
          const text = chunk.toString()
          stderr += text
          this.emit({ type: 'stderr', jobId: job.id, text, at: now() })
        })
        child.on('error', (error: NodeJS.ErrnoException) => {
          clearTimeout(timer)
          if (error.code === 'ENOENT' && candidateIndex < candidates.length - 1) {
            candidateIndex += 1
            startCandidate()
            return
          }
          finish({ command: current, exitCode: null, stdout: truncateText(stdout), stderr: truncateText(stderr), error: error.message })
        })
        child.on('exit', (code) => {
          finish({ command: current, exitCode: code, stdout: truncateText(stdout), stderr: truncateText(stderr) })
        })
      }

      startCandidate()
    })
  }

  private spawnCollect(commands: string[], args: string[], cwd: string, timeoutMs: number): Promise<SpawnResult> {
    return new Promise((resolve) => {
      let index = 0
      const run = (): void => {
        const command = commands[index]
        const spec = spawnSpec(command, args)
        const child = spawn(spec.command, spec.args, {
          cwd,
          shell: false,
          env: buildChildEnv(undefined, commandPathDirs(command)),
          windowsHide: true,
          windowsVerbatimArguments: spec.windowsVerbatimArguments,
        })
        let stdout = ''
        let stderr = ''
        let settled = false
        const finish = (result: SpawnResult): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(result)
        }
        const timer = setTimeout(() => {
          try { child.kill('SIGTERM') } catch { /* ignore */ }
          finish({ command, exitCode: null, stdout, stderr, timedOut: true, error: '命令执行超时' })
        }, timeoutMs)
        child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
        child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
        child.on('error', (error: NodeJS.ErrnoException) => {
          clearTimeout(timer)
          if (error.code === 'ENOENT' && index < commands.length - 1) {
            index += 1
            run()
            return
          }
          finish({ command, exitCode: null, stdout, stderr, error: error.message })
        })
        child.on('exit', (code) => finish({ command, exitCode: code, stdout, stderr }))
      }
      run()
    })
  }

  private async detectOne(id: string, agent: LocalCodingAgentDefinition): Promise<LocalCodingAgentDetectResult> {
    const command = agent.executablePath.trim() || commandNameForKind(agent.kind)
    if (!command) return { id, kind: agent.kind, name: agent.name, executablePath: '', found: false, error: '未配置命令' }
    const locator = process.platform === 'win32' ? 'where.exe' : 'which'
    const located = await this.spawnCollect([locator], [command], process.cwd(), 10_000)
    const locatedPaths = (located.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const candidates = uniqueStrings([
      ...locatedPaths.flatMap(commandCandidates),
      ...commandCandidates(command),
    ])
    const version = await this.spawnCollect(candidates, ['--version'], process.cwd(), 10_000)
    const found = version.exitCode === 0
    return {
      id,
      kind: agent.kind,
      name: agent.name,
      executablePath: found ? (version.command || candidates[0] || command) : command,
      found,
      version: found ? truncateText((version.stdout || version.stderr || '').trim(), 300) : undefined,
      error: found ? undefined : (located.stderr || located.error || version.error || '未找到命令'),
    }
  }

  private failJob(job: LocalCodingAgentJob, error: string): void {
    job.status = 'failed'
    job.error = error
    job.finishedAt = now()
    this.pending.delete(job.id)
    this.emit({ type: 'error', jobId: job.id, error, at: now() })
    agentAuditService.record({
      source: 'code-workspace',
      toolName: 'local_coding_agent_run',
      argsSummary: { jobId: job.id, agentId: job.agentId, mode: job.mode },
      risk: job.mode === 'direct' ? 'high' : 'medium',
      status: 'failed',
      targetPath: job.workspaceRoot,
      error,
    })
  }

  private emit(event: LocalCodingAgentEvent): void {
    this.ctx?.broadcastToWindows('localCodingAgent:event', event)
  }

  private getJobsBaseDir(): string {
    return this.withConfig((config) => {
      const dir = path.join(config.getCacheBasePath(), 'local-coding-agent', 'jobs')
      fs.mkdirSync(dir, { recursive: true })
      return dir
    })
  }

  private withConfig<T>(fn: (config: ConfigService) => T): T {
    const existing = this.ctx?.getConfigService()
    if (existing) return fn(existing)
    const config = new ConfigService()
    try {
      return fn(config)
    } finally {
      config.close()
    }
  }
}

export const localCodingAgentService = new LocalCodingAgentService()
