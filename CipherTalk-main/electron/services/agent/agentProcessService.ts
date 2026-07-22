/**
 * AgentProcessService —— AI agent 子进程的主进程代理层。
 * 仿 wcdbService：utilityProcess.fork + postMessage 协议 + 崩溃自动重启 + 路径解析。
 * 主进程只做 broker：拉起/重启子进程、转发请求、把流式 chunk 回调给上层（IPC/MessagePort 在 Phase C 接）。
 */
import { utilityProcess } from 'electron'
import type { UtilityProcess } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import type { ModelMessage, UIMessageChunk } from 'ai'
import { getAppPath, isElectronPackaged } from '../runtimePaths'
import { getElectronWorkerEnv } from '../workerEnvironment'
import { codeWorkspaceService } from './codeWorkspaceService'
import type { CodeWorkspaceToolCall } from './codeWorkspaceTypes'
import type { AgentProgressEvent, AgentPromptOptimizeInput, AgentProviderConfig, AgentRunInput } from './types'

const UTILITY_FILE = 'aiAgentUtilityProcess.js'
const RESTART_DELAY_MS = 2000

type Pending = {
  resolve: (value: any) => void
  reject: (reason: any) => void
  type: string
  startedAt: number
}

type AgentProcessLogger = {
  debug?(category: string, message: string, data?: any): void
  info(category: string, message: string, data?: any): void
  warn(category: string, message: string, data?: any): void
  error(category: string, message: string, data?: any): void
}

function errorToLogData(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack }
  }
  return { message: String(error) }
}

function fileDataUrl(data: unknown): URL | null {
  if (data instanceof URL) return data
  if (!data || typeof data !== 'object') return null
  const tagged = data as { type?: unknown; url?: unknown }
  return tagged.type === 'url' && tagged.url instanceof URL ? tagged.url : null
}

/** URL 实例无法可靠穿过 utilityProcess；改用 AI SDK FilePart 支持的 URL 字符串简写。 */
function serializeModelMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== 'user' || !Array.isArray(message.content)) return message
    let changed = false
    const content = message.content.map((part) => {
      if (part.type !== 'file') return part
      const url = fileDataUrl(part.data)
      if (!url) return part
      changed = true
      return { ...part, data: url.href }
    })
    return changed ? { ...message, content } : message
  })
}

function truncateLogText(text: string, maxLength = 2000): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...<truncated>` : text
}

function shouldSuppressUtilityStderrLine(line: string): boolean {
  return /\bAI SDK Warning\b/.test(line) && (
    line.includes('cacheControl breakpoint limit') ||
    /Maximum\s+\d+\s+cache breakpoints exceeded/i.test(line)
  )
}

function filterUtilityStderr(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !shouldSuppressUtilityStderrLine(line))
    .join('\n')
    .trim()
}

export class AgentProcessService {
  private worker: UtilityProcess | null = null
  private pending = new Map<number, Pending>()
  private chunkHandlers = new Map<string, (chunk: UIMessageChunk) => void>()
  private progressHandlers = new Map<string, (progress: AgentProgressEvent) => void>()
  private seq = 0
  private runSeq = 0
  private initPromise: Promise<void> | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private shuttingDown = false
  private logger: AgentProcessLogger | null = null

  setLogger(logger: AgentProcessLogger | null): void {
    this.logger = logger
  }

  /** 连通性自检：返回 'pong'。 */
  async ping(): Promise<string> {
    return this.call<string>('ping', undefined)
  }

  /**
   * 跑一次 agent，流式 chunk 经 onChunk 回调。Promise 在本次运行结束时 resolve。
   */
  async run(
    input: AgentRunInput,
    onChunk: (chunk: UIMessageChunk) => void,
    onProgress?: (progress: AgentProgressEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const runId = `run-${++this.runSeq}`
    this.chunkHandlers.set(runId, onChunk)
    if (onProgress) this.progressHandlers.set(runId, onProgress)
    if (signal) {
      signal.addEventListener('abort', () => { void this.call('abort', { runId }).catch(() => undefined) })
    }
    try {
      await this.call<{ done: boolean }>('run', {
        runId,
        ...input,
        messages: serializeModelMessages(input.messages),
      })
    } finally {
      this.chunkHandlers.delete(runId)
      this.progressHandlers.delete(runId)
    }
  }

  async generateTitle(input: { firstMessage: string; providerConfig: AgentProviderConfig }): Promise<string> {
    const result = await this.call<{ title: string }>('generateTitle', input)
    return result.title
  }

  /** 提示词优化：子进程内单次 generateText，近期对话仅用于消解草稿中的指代。 */
  async optimizePrompt(input: AgentPromptOptimizeInput): Promise<string> {
    const result = await this.call<{ text: string }>('optimizePrompt', input)
    return result.text
  }

  /** 聊天回复建议：子进程内单次 generateText（可带图/带检索工具），返回建议 + 附图诊断信息。 */
  async replySuggest(input: import('./engine').ReplySuggestInput): Promise<import('./engine').ReplySuggestOutcome> {
    return this.call<import('./engine').ReplySuggestOutcome>('replySuggest', input)
  }

  /** 克隆好友：在子进程内跑画像提取（两路 generateObject），返回画像卡 + few-shot。 */
  async extractPersona(input: import('./persona/personaTypes').PersonaExtractInput): Promise<import('./persona/personaTypes').PersonaExtractResult> {
    return this.call('extractPersona', input)
  }

  /** 深层画像 map 阶段：单块历史 → 部分画像。 */
  async extractProfileChunk(input: import('./persona/personaTypes').PersonaProfileChunkInput): Promise<import('./persona/personaTypes').PersonaProfile> {
    return this.call('extractProfileChunk', input)
  }

  /** 深层画像 reduce 阶段：多块部分画像 → 合并画像。 */
  async mergeProfile(input: import('./persona/personaTypes').PersonaProfileMergeInput): Promise<import('./persona/personaTypes').PersonaProfile> {
    return this.call('mergeProfile', input)
  }

  /** 增量进化：旧画像 + 新增聊天 → 修订后的画像。 */
  async revisePersona(input: import('./persona/personaTypes').PersonaReviseInput): Promise<import('./persona/personaTypes').PersonaReviseResult> {
    return this.call('revisePersona', input)
  }

  /** 克隆对话反思：提炼导演笔记 + 对话摘要。 */
  async reflectPersona(input: import('./persona/personaTypes').PersonaReflectInput): Promise<import('./persona/personaTypes').PersonaReflectResult> {
    return this.call('reflectPersona', input)
  }

  /** 克隆好友聊天：预检索 + 单次 generateText，完整生成后经 onChunk 按气泡回调（复用 run 的 chunk 通道）。 */
  async personaChat(
    input: import('./persona/personaTypes').PersonaChatInput,
    onChunk: (chunk: UIMessageChunk) => void,
    onProgress?: (progress: AgentProgressEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const runId = `persona-${++this.runSeq}`
    this.chunkHandlers.set(runId, onChunk)
    if (onProgress) this.progressHandlers.set(runId, onProgress)
    if (signal) {
      signal.addEventListener('abort', () => { void this.call('abort', { runId }).catch(() => undefined) })
    }
    try {
      await this.call<{ done: boolean }>('personaChat', {
        runId,
        ...input,
        messages: serializeModelMessages(input.messages),
      })
    } finally {
      this.chunkHandlers.delete(runId)
      this.progressHandlers.delete(runId)
    }
  }

  shutdown(): void {
    this.shuttingDown = true
    const w = this.worker
    this.worker = null
    this.initPromise = null
    this.rejectAllPending('agent utility process shutdown')
    this.chunkHandlers.clear()
    this.progressHandlers.clear()
    if (w) {
      try { w.kill() } catch { /* ignore */ }
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  // ========= utilityProcess 管理 =========
  private async initWorker(): Promise<void> {
    this.shuttingDown = false
    if (this.worker) return
    if (this.initPromise) return this.initPromise

    this.initPromise = new Promise<void>((resolve, reject) => {
      const utilityPath = this.resolveUtilityPath()
      if (!utilityPath) {
        this.initPromise = null
        this.logger?.error('AIAgentProcess', `未找到 ${UTILITY_FILE}`, {
          candidates: this.getUtilityPathCandidates(),
          packaged: isElectronPackaged(),
          appPath: getAppPath(),
          resourcesPath: process.resourcesPath || null,
        })
        reject(new Error(`未找到 ${UTILITY_FILE}`))
        return
      }

      let worker: UtilityProcess
      try {
        this.logger?.warn('AIAgentProcess', '准备启动 AI Agent utility process', {
          utilityPath,
          packaged: isElectronPackaged(),
        })
        worker = utilityProcess.fork(utilityPath, [], {
          serviceName: 'CipherTalk AI Agent',
          stdio: 'pipe',
          env: { ...getElectronWorkerEnv(), CT_AGENT_WCDB_PROXY: '1' },
        })
      } catch (e: any) {
        this.initPromise = null
        this.logger?.error('AIAgentProcess', '启动 AI Agent utility process 失败', errorToLogData(e))
        reject(new Error(`启动 AI agent utility process 失败: ${e?.message || String(e)}`))
        return
      }

      this.worker = worker
      let readyFired = false
      let stderrTail = ''
      const rejectInitOnce = (err: Error) => {
        if (!readyFired) { readyFired = true; reject(err) }
      }

      worker.on('spawn', () => {
        console.info(`[agentProcessService] utility process spawned pid=${worker.pid ?? 'unknown'}`)
        this.logger?.warn('AIAgentProcess', 'AI Agent utility process 已启动', {
          pid: worker.pid ?? null,
        })
      })

      worker.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim()
        if (text) {
          console.log(`[aiAgentUtility:${worker.pid ?? 'unknown'}] ${text}`)
          this.logger?.debug?.('AIAgentProcess', 'AI Agent utility stdout', {
            pid: worker.pid ?? null,
            text: truncateLogText(text),
          })
        }
      })
      worker.stderr?.on('data', (chunk: Buffer) => {
        const text = filterUtilityStderr(chunk.toString().trim())
        if (text) {
          stderrTail = `${stderrTail}\n${text}`.slice(-4000)
          console.error(`[aiAgentUtility:${worker.pid ?? 'unknown'}] ${text}`)
          this.logger?.warn('AIAgentProcess', 'AI Agent utility stderr', {
            pid: worker.pid ?? null,
            text: truncateLogText(text),
          })
        }
      })

      worker.on('message', (msg: any) => {
        if (msg?.type === 'wcdb:call') {
          void this.handleWcdbCall(worker, msg.payload)
          return
        }
        if (msg?.type === 'mcp:callTool') {
          void this.handleMcpCall(worker, msg.payload)
          return
        }
        if (msg?.type === 'codeWorkspace:call') {
          void this.handleCodeWorkspaceCall(worker, msg.payload)
          return
        }
        if (msg?.type === 'agentCapability:call') {
          void this.handleAgentCapabilityCall(worker, msg.payload)
          return
        }
        if (msg?.type === 'aiExport:call') {
          void this.handleAiExportCall(worker, msg.payload)
          return
        }
        if (msg?.type === 'aiExport:abort') {
          void this.handleAiExportAbort(msg.payload)
          return
        }
        if (msg?.id === 0 && msg.type === 'ready') {
          if (!readyFired) {
            readyFired = true
            this.logger?.warn('AIAgentProcess', 'AI Agent utility process 已就绪', {
              pid: worker.pid ?? null,
            })
            resolve()
          }
          return
        }
        if (msg?.id === -1 && msg.type === 'chunk') {
          const { runId, chunk } = msg.payload || {}
          this.chunkHandlers.get(runId)?.(chunk)
          return
        }
        if (msg?.id === -2 && msg.type === 'progress') {
          const { runId, progress } = msg.payload || {}
          this.progressHandlers.get(runId)?.(progress)
          return
        }
        if (typeof msg?.id === 'number') {
          const pending = this.pending.get(msg.id)
          if (!pending) return
          this.pending.delete(msg.id)
          if (msg.error) {
            this.logger?.error('AIAgentProcess', 'AI Agent utility 调用失败', {
              id: msg.id,
              type: pending.type,
              elapsedMs: Date.now() - pending.startedAt,
              error: msg.error,
            })
            pending.reject(new Error(msg.error))
          } else {
            this.logger?.debug?.('AIAgentProcess', 'AI Agent utility 调用完成', {
              id: msg.id,
              type: pending.type,
              elapsedMs: Date.now() - pending.startedAt,
            })
            pending.resolve(msg.result)
          }
        }
      })

      worker.on('error', (type, location) => {
        console.error('[agentProcessService] utility process fatal:', { pid: worker.pid, type, location })
        this.logger?.error('AIAgentProcess', 'AI Agent utility process fatal', {
          pid: worker.pid ?? null,
          type,
          location,
        })
        if (this.worker === worker) this.worker = null
        this.initPromise = null
        this.rejectAllPending(`agent utility process fatal (${type})`)
        rejectInitOnce(new Error(`AI agent utility process fatal: ${type}`))
      })

      worker.on('exit', (code) => {
        const pid = worker.pid
        if (this.worker === worker) this.worker = null
        this.initPromise = null
        this.rejectAllPending(`agent utility process exited (pid=${pid ?? 'unknown'}, code=${code})`)
        const stderrDetail = stderrTail.trim() ? `，stderr=${stderrTail.trim()}` : ''
        rejectInitOnce(new Error(`AI agent utility process 启动后立即退出，code=${code}${stderrDetail}`))
        if (!this.shuttingDown) {
          console.warn(`[agentProcessService] utility process 退出 pid=${pid ?? 'unknown'} code=${code}，${RESTART_DELAY_MS}ms 后自动重启`)
          this.logger?.warn('AIAgentProcess', 'AI Agent utility process 退出，准备自动重启', {
            pid: pid ?? null,
            code,
            restartDelayMs: RESTART_DELAY_MS,
          })
          this.scheduleRestart()
        }
      })
    })

    try {
      await this.initPromise
    } catch (e) {
      this.initPromise = null
      throw e
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.shuttingDown) return
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.shuttingDown) return
      this.initWorker().catch((e) => {
        console.error('[agentProcessService] 自动重启失败:', e?.message || e)
        this.logger?.error('AIAgentProcess', 'AI Agent utility process 自动重启失败', errorToLogData(e))
      })
    }, RESTART_DELAY_MS)
  }

  private rejectAllPending(reason: string): void {
    if (this.pending.size === 0) return
    const count = this.pending.size
    const err = new Error(reason)
    for (const { reject } of this.pending.values()) {
      try { reject(err) } catch { /* ignore */ }
    }
    this.pending.clear()
    this.logger?.warn('AIAgentProcess', '已拒绝所有等待中的 AI Agent utility 调用', {
      reason,
      count,
    })
  }

  /**
   * 处理子进程发来的 wcdb 代理请求：用主进程已打开的 wcdbService 执行后回传。
   * 子进程的数据层（dbAdapter / chatService / contactNameResolver 等）由此复用原微信库连接。
   */
  private async handleWcdbCall(
    worker: UtilityProcess,
    payload: { reqId: number; method: string; payload: any },
  ): Promise<void> {
    const reqId = payload?.reqId
    try {
      const { wcdbService } = await import('../wcdbService')
      const result = await wcdbService.runProxiedCall(payload.method, payload.payload)
      worker.postMessage({ type: 'wcdb:result', payload: { reqId, result } })
    } catch (e: any) {
      worker.postMessage({ type: 'wcdb:result', payload: { reqId, error: e?.message || String(e) } })
    }
  }

  /**
   * 处理子进程发来的 MCP 代理请求：MCP 连接只存在主进程，Agent 子进程只拿到只读工具描述。
   */
  private async handleMcpCall(
    worker: UtilityProcess,
    payload: { reqId: number; serverName: string; toolName: string; args?: Record<string, unknown> },
  ): Promise<void> {
    const reqId = payload?.reqId
    try {
      const { mcpClientService } = await import('../mcpClientService')
      const response = await mcpClientService.callTool(
        payload.serverName,
        payload.toolName,
        payload.args && typeof payload.args === 'object' ? payload.args : {},
      )
      if (!response.success) throw new Error(response.error || 'MCP tool call failed')
      worker.postMessage({ type: 'mcp:result', payload: { reqId, result: response.result } })
    } catch (e: any) {
      worker.postMessage({ type: 'mcp:result', payload: { reqId, error: e?.message || String(e) } })
    }
  }

  /**
   * 处理子进程发来的代码工作区请求：文件系统和 shell 只允许主进程 CodeWorkspaceService 触碰。
   */
  private async handleCodeWorkspaceCall(
    worker: UtilityProcess,
    payload: { reqId: number } & CodeWorkspaceToolCall,
  ): Promise<void> {
    const reqId = payload?.reqId
    try {
      const result = await codeWorkspaceService.handleToolCall({
        method: payload.method,
        args: payload.args && typeof payload.args === 'object' ? payload.args : {},
        workspace: payload.workspace ?? null,
      })
      worker.postMessage({ type: 'codeWorkspace:result', payload: { reqId, result } })
    } catch (e: any) {
      worker.postMessage({ type: 'codeWorkspace:result', payload: { reqId, error: e?.message || String(e) } })
    }
  }

  /**
   * 处理 Agent 子进程发来的本机能力请求。文件索引、资料库、产物、任务、桌面截图等
   * 都在主进程执行，避免 AI utility process 绕过审计边界。
   */
  private async handleAgentCapabilityCall(
    worker: UtilityProcess,
    payload: { reqId: number; method: string; args?: Record<string, unknown> },
  ): Promise<void> {
    const reqId = payload?.reqId
    try {
      const { agentCapabilityService } = await import('./agentCapabilityService')
      const result = await agentCapabilityService.handleCall(
        String(payload?.method || ''),
        payload?.args && typeof payload.args === 'object' ? payload.args : {},
      )
      worker.postMessage({ type: 'agentCapability:result', payload: { reqId, result } })
    } catch (e: any) {
      worker.postMessage({ type: 'agentCapability:result', payload: { reqId, error: e?.message || String(e) } })
    }
  }

  /**
   * 处理 Agent 子进程发来的 AI 导出请求：主进程只拉起/回收导出 utility process，
   * 实际校验、解析与 exportService 调用都在 aiExportUtilityProcess 里完成。
   */
  private async handleAiExportCall(
    worker: UtilityProcess,
    payload: { reqId: number; method: string; args?: Record<string, unknown> },
  ): Promise<void> {
    const reqId = payload?.reqId
    try {
      if (payload?.method !== 'exportChat') {
        throw new Error(`unknown aiExport method: ${payload?.method}`)
      }
      const { aiExportProcessService } = await import('./aiExportProcessService')
      aiExportProcessService.setLogger(this.logger)
      const requestId = `agent-${reqId}`
      const result = await aiExportProcessService.exportChat(
        requestId,
        payload.args || {},
        (progress) => worker.postMessage({ type: 'aiExport:progress', payload: { reqId, progress } }),
      )
      worker.postMessage({ type: 'aiExport:result', payload: { reqId, result } })
    } catch (e: any) {
      worker.postMessage({ type: 'aiExport:result', payload: { reqId, error: e?.message || String(e) } })
    }
  }

  private async handleAiExportAbort(payload: { reqId: number }): Promise<void> {
    try {
      const reqId = payload?.reqId
      if (typeof reqId !== 'number') return
      const { aiExportProcessService } = await import('./aiExportProcessService')
      aiExportProcessService.abort(`agent-${reqId}`)
    } catch {
      // ignore abort races
    }
  }

  private async call<T = any>(type: string, payload: any): Promise<T> {
    await this.initWorker()
    const w = this.worker
    if (!w) throw new Error('AI agent utility process 未就绪')
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, type, startedAt: Date.now() })
      try {
        w.postMessage({ id, type, payload })
      } catch (e: any) {
        this.pending.delete(id)
        this.logger?.error('AIAgentProcess', 'agent postMessage 失败', {
          id,
          type,
          ...errorToLogData(e),
        })
        reject(new Error(`agent postMessage 失败: ${e?.message || String(e)}`))
      }
    })
  }

  private getUtilityPathCandidates(): string[] {
    const appPath = getAppPath()
    const resourcesRoot = process.resourcesPath || appPath
    return isElectronPackaged()
      ? [
          join(resourcesRoot, 'app.asar.unpacked', 'dist-electron', UTILITY_FILE),
          join(resourcesRoot, 'app.asar', 'dist-electron', UTILITY_FILE),
          join(resourcesRoot, 'dist-electron', UTILITY_FILE),
          join(__dirname, UTILITY_FILE),
          join(__dirname, '..', UTILITY_FILE),
        ]
      : [
          join(__dirname, UTILITY_FILE),
          join(__dirname, '..', UTILITY_FILE),
          join(appPath, 'dist-electron', UTILITY_FILE),
        ]
  }

  private resolveUtilityPath(): string | null {
    return this.getUtilityPathCandidates().find((c) => existsSync(c)) || null
  }
}

export const agentProcessService = new AgentProcessService()
