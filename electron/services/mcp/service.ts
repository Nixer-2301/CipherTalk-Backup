import { spawn } from 'child_process'
import { dirname } from 'path'
import { getAppPath, getExePath, isElectronPackaged } from '../runtimePaths'
import { McpToolError } from './result'
import { getMcpProxyConfig } from './runtime'
import type {
  McpContactsPayload,
  McpExportChatPayload,
  McpHealthPayload,
  McpMomentsTimelinePayload,
  McpMessagesPayload,
  McpVoiceTranscriptionPayload,
  McpAudioFileTranscriptionPayload,
  McpMemorySearchPayload,
  McpResolveSessionPayload,
  McpStreamEvent,
  McpSearchMessagesPayload,
  McpSessionContextPayload,
  McpSessionsPayload,
  McpStatusPayload,
  McpToolName
} from './types'

type ProxyEnvelopeSuccess<T> = {
  success: true
  data: T
  summary?: string
  meta?: {
    requestId: string
    ts: number
  }
}

type ProxyEnvelopeError = {
  success: false
  error?: {
    code?: string
    message?: string
    hint?: string
  }
}

type StreamToolOptions = {
  signal?: AbortSignal
  onEvent?: (event: McpStreamEvent) => void
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function findSseDelimiterIndex(buffer: string): { index: number; length: number } | null {
  const crlfIndex = buffer.indexOf('\r\n\r\n')
  if (crlfIndex >= 0) {
    return { index: crlfIndex, length: 4 }
  }

  const lfIndex = buffer.indexOf('\n\n')
  if (lfIndex >= 0) {
    return { index: lfIndex, length: 2 }
  }

  return null
}

function getSpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.CIPHERTALK_MCP_ENTRY
  delete env.CIPHERTALK_MCP_LAUNCHER
  return env
}

async function isProxyHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, {
      method: 'GET'
    })
    if (!response.ok) return false
    const payload = await response.json() as ProxyEnvelopeSuccess<{ ok: boolean }>
    return Boolean(payload.success && payload.data?.ok)
  } catch {
    return false
  }
}

function launchMainApplication(): void {
  if (isElectronPackaged()) {
    const exePath = getExePath()
    spawn(exePath, [], {
      cwd: dirname(exePath),
      env: getSpawnEnv(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }).unref()
    return
  }

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  spawn(npmCmd, ['run', 'electron:dev'], {
    cwd: getAppPath(),
    env: getSpawnEnv(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  }).unref()
}

export class McpReadService {
  private launchAttempted = false

  private async ensureProxyReady(requireAuth = true) {
    let proxyConfig = getMcpProxyConfig()
    if (await isProxyHealthy(proxyConfig.url)) {
      if (!requireAuth) return proxyConfig
      if (proxyConfig.token) return proxyConfig
    }

    if (!this.launchAttempted) {
      this.launchAttempted = true
      process.stderr.write('[CipherTalk MCP] proxy unavailable, launching desktop app\n')
      launchMainApplication()
    }

    const startedAt = Date.now()
    while (Date.now() - startedAt < proxyConfig.timeoutMs) {
      await sleep(500)
      proxyConfig = getMcpProxyConfig()
      if (await isProxyHealthy(proxyConfig.url)) {
        if (!requireAuth || proxyConfig.token) {
          return proxyConfig
        }
      }
    }

    throw new McpToolError(
      'APP_NOT_RUNNING',
      'CipherTalk 主应用未就绪，无法代理查询。',
      '已尝试自动拉起主应用，但内部 MCP 代理未在限定时间内就绪。'
    )
  }

  private async callProxy<T>(toolName: McpToolName, args: Record<string, unknown> = {}): Promise<T> {
    const proxyConfig = await this.ensureProxyReady(toolName !== 'health_check')

    const response = await fetch(`${proxyConfig.url}/tool/${toolName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(proxyConfig.token ? { Authorization: `Bearer ${proxyConfig.token}` } : {})
      },
      body: JSON.stringify({ args })
    })

    let payload: ProxyEnvelopeSuccess<T> | ProxyEnvelopeError
    try {
      payload = await response.json() as ProxyEnvelopeSuccess<T> | ProxyEnvelopeError
    } catch (error) {
      throw new McpToolError('INTERNAL_ERROR', '内部 MCP 代理返回了无效响应。', String(error))
    }

    if (!response.ok || !('success' in payload) || !payload.success) {
      const code = payload && 'error' in payload ? String(payload.error?.code || 'INTERNAL_ERROR') : 'INTERNAL_ERROR'
      const message = payload && 'error' in payload ? String(payload.error?.message || '内部 MCP 代理请求失败。') : '内部 MCP 代理请求失败。'
      const hint = payload && 'error' in payload ? payload.error?.hint : undefined
      throw new McpToolError(
        code === 'APP_NOT_RUNNING' || code === 'DB_NOT_READY' || code === 'SESSION_NOT_FOUND' || code === 'BAD_REQUEST' || code === 'STT_NOT_READY'
          ? code
          : 'INTERNAL_ERROR',
        message,
        hint
      )
    }

    return payload.data
  }

  async streamTool(
    toolName: McpToolName,
    args: Record<string, unknown> = {},
    options: StreamToolOptions = {}
  ): Promise<unknown> {
    const proxyConfig = await this.ensureProxyReady(toolName !== 'health_check')
    const response = await fetch(`${proxyConfig.url}/tool/${toolName}/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(proxyConfig.token ? { Authorization: `Bearer ${proxyConfig.token}` } : {})
      },
      body: JSON.stringify({ args }),
      signal: options.signal
    })

    if (!response.ok || !response.body) {
      return this.callProxy(toolName, args)
    }

    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    let buffer = ''
    let finalPayload: unknown

    const flushEvent = async (rawBlock: string) => {
      const lines = rawBlock.split(/\r?\n/)
      let eventName = 'message'
      const dataLines: string[] = []

      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventName = line.slice('event:'.length).trim()
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice('data:'.length).trim())
        }
      }

      if (dataLines.length === 0) return
      const parsed = JSON.parse(dataLines.join('\n')) as McpStreamEvent['data']
      const event = { event: eventName, data: parsed } as McpStreamEvent
      options.onEvent?.(event)

      if (event.event === 'error') {
        throw new McpToolError(event.data.code, event.data.message, event.data.hint)
      }

      if (event.event === 'complete') {
        finalPayload = event.data.payload
      }
    }

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let delimiter = findSseDelimiterIndex(buffer)
      while (delimiter) {
        const block = buffer.slice(0, delimiter.index).trim()
        buffer = buffer.slice(delimiter.index + delimiter.length)
        if (block) {
          await flushEvent(block)
        }
        delimiter = findSseDelimiterIndex(buffer)
      }
    }

    if (buffer.trim()) {
      await flushEvent(buffer.trim())
    }

    return finalPayload
  }

  async healthCheck(): Promise<McpHealthPayload> {
    const proxyConfig = await this.ensureProxyReady(false)
    const response = await fetch(`${proxyConfig.url}/status`, {
      method: 'GET',
      headers: proxyConfig.token ? { Authorization: `Bearer ${proxyConfig.token}` } : {}
    })
    if (!response.ok) {
      throw new McpToolError('APP_NOT_RUNNING', 'CipherTalk 主应用内部 MCP 代理不可用。')
    }
    return this.callProxy<McpHealthPayload>('health_check')
  }

  async getStatus(): Promise<McpStatusPayload> {
    return this.callProxy<McpStatusPayload>('get_status')
  }

  async getMomentsTimeline(rawArgs: Record<string, unknown>): Promise<McpMomentsTimelinePayload> {
    return this.callProxy<McpMomentsTimelinePayload>('get_moments_timeline', rawArgs)
  }

  async resolveSession(rawArgs: Record<string, unknown>): Promise<McpResolveSessionPayload> {
    return this.callProxy<McpResolveSessionPayload>('resolve_session', rawArgs)
  }

  async exportChat(rawArgs: Record<string, unknown>): Promise<McpExportChatPayload> {
    return this.callProxy<McpExportChatPayload>('export_chat', rawArgs)
  }

  async listSessions(rawArgs: Record<string, unknown>): Promise<McpSessionsPayload> {
    return this.callProxy<McpSessionsPayload>('list_sessions', rawArgs)
  }

  async listContacts(rawArgs: Record<string, unknown>): Promise<McpContactsPayload> {
    return this.callProxy<McpContactsPayload>('list_contacts', rawArgs)
  }

  async getMessages(rawArgs: Record<string, unknown>, defaultIncludeMediaPaths: boolean): Promise<McpMessagesPayload> {
    return this.callProxy<McpMessagesPayload>('get_messages', {
      ...rawArgs,
      includeMediaPaths: rawArgs.includeMediaPaths ?? defaultIncludeMediaPaths
    })
  }

  async searchMessages(rawArgs: Record<string, unknown>, defaultIncludeMediaPaths: boolean): Promise<McpSearchMessagesPayload> {
    return this.callProxy<McpSearchMessagesPayload>('search_messages', {
      ...rawArgs,
      includeMediaPaths: rawArgs.includeMediaPaths ?? defaultIncludeMediaPaths
    })
  }

  async searchMemory(rawArgs: Record<string, unknown>, defaultIncludeMediaPaths: boolean): Promise<McpMemorySearchPayload> {
    return this.callProxy<McpMemorySearchPayload>('search_memory', {
      ...rawArgs,
      includeMediaPaths: rawArgs.includeMediaPaths ?? defaultIncludeMediaPaths
    })
  }

  async transcribeVoiceMessage(rawArgs: Record<string, unknown>): Promise<McpVoiceTranscriptionPayload> {
    return this.callProxy<McpVoiceTranscriptionPayload>('transcribe_voice_message', rawArgs)
  }

  async transcribeAudioFile(rawArgs: Record<string, unknown>): Promise<McpAudioFileTranscriptionPayload> {
    return this.callProxy<McpAudioFileTranscriptionPayload>('transcribe_audio_file', rawArgs)
  }

  async getSessionContext(rawArgs: Record<string, unknown>, defaultIncludeMediaPaths: boolean): Promise<McpSessionContextPayload> {
    return this.callProxy<McpSessionContextPayload>('get_session_context', {
      ...rawArgs,
      includeMediaPaths: rawArgs.includeMediaPaths ?? defaultIncludeMediaPaths
    })
  }

  async streamSearchMessages(
    rawArgs: Record<string, unknown>,
    defaultIncludeMediaPaths: boolean,
    options: StreamToolOptions = {}
  ): Promise<McpSearchMessagesPayload> {
    return this.streamTool('search_messages', {
      ...rawArgs,
      includeMediaPaths: rawArgs.includeMediaPaths ?? defaultIncludeMediaPaths
    }, options) as Promise<McpSearchMessagesPayload>
  }

  async streamSearchMemory(
    rawArgs: Record<string, unknown>,
    defaultIncludeMediaPaths: boolean,
    options: StreamToolOptions = {}
  ): Promise<McpMemorySearchPayload> {
    return this.streamTool('search_memory', {
      ...rawArgs,
      includeMediaPaths: rawArgs.includeMediaPaths ?? defaultIncludeMediaPaths
    }, options) as Promise<McpMemorySearchPayload>
  }
}
