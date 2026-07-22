import * as http from 'http'
import type { Socket } from 'net'
import { McpToolError } from './result'
import { executeMcpTool } from './dispatcher'
import { MCP_TOOL_NAMES, type McpStreamEvent, type McpStreamPartialPayloadMap, type McpStreamProgressPayload, type McpToolName } from './types'

type ProxySettings = {
  host: '127.0.0.1'
  port: number
  token: string
}

type ProxyLogger = {
  info(category: string, message: string, data?: any): void
  warn(category: string, message: string, data?: any): void
  error(category: string, message: string, data?: any): void
}

class McpProxyService {
  private server: http.Server | null = null
  private readonly connections = new Set<Socket>()
  private logger: ProxyLogger | null = null
  private startedAt = 0
  private lastError = ''
  private settings: ProxySettings = {
    host: '127.0.0.1',
    port: 5032,
    token: ''
  }

  setLogger(logger: ProxyLogger | null): void {
    this.logger = logger
  }

  applySettings(next: Partial<ProxySettings>): void {
    this.settings = {
      ...this.settings,
      ...next,
      host: '127.0.0.1'
    }
  }

  isRunning(): boolean {
    return Boolean(this.server)
  }

  getStatus() {
    return {
      running: this.isRunning(),
      host: this.settings.host,
      port: this.settings.port,
      startedAt: this.startedAt,
      tokenConfigured: Boolean(this.settings.token),
      lastError: this.lastError
    }
  }

  async start(): Promise<{ success: boolean; error?: string }> {
    if (this.server) {
      return { success: true }
    }

    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        void this.handleRequest(req, res)
      })

      server.on('connection', (socket) => {
        this.connections.add(socket)
        socket.on('close', () => this.connections.delete(socket))
      })

      server.on('error', (err: NodeJS.ErrnoException) => {
        this.lastError = err.message
        this.logger?.error('McpProxy', '内部 MCP 代理启动失败', { error: err.message, code: err.code })
        if (err.code === 'EADDRINUSE') {
          resolve({ success: false, error: `端口 ${this.settings.port} 已被占用` })
          return
        }
        resolve({ success: false, error: err.message })
      })

      server.listen(this.settings.port, this.settings.host, () => {
        this.server = server
        this.startedAt = Date.now()
        this.lastError = ''
        this.logger?.info('McpProxy', '内部 MCP 代理已启动', {
          host: this.settings.host,
          port: this.settings.port
        })
        resolve({ success: true })
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return

    const currentServer = this.server
    this.server = null

    const sockets = Array.from(this.connections)
    this.connections.clear()
    sockets.forEach((socket) => {
      try {
        socket.destroy()
      } catch {
        // ignore
      }
    })

    await new Promise<void>((resolve) => {
      currentServer.close(() => resolve())
    })

    this.logger?.info('McpProxy', '内部 MCP 代理已停止')
  }

  private async readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }

    if (chunks.length === 0) {
      return {}
    }

    const raw = Buffer.concat(chunks).toString('utf8').trim()
    if (!raw) return {}

    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  }

  private createRequestId(): string {
    return `mcp_proxy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  }

  private sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    res.end(JSON.stringify(payload))
  }

  private sendSse(res: http.ServerResponse, event: McpStreamEvent): void {
    res.write(`event: ${event.event}\n`)
    res.write(`data: ${JSON.stringify(event.data)}\n\n`)
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    if (!this.settings.token) return true

    const authHeader = String(req.headers.authorization || '')
    if (!authHeader.startsWith('Bearer ')) return false
    return authHeader.slice('Bearer '.length).trim() === this.settings.token
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const requestId = this.createRequestId()
    const pathname = new URL(req.url || '/', `http://${this.settings.host}:${this.settings.port}`).pathname
    const method = req.method || 'GET'

    if (method === 'GET' && pathname === '/health') {
      this.sendJson(res, 200, {
        success: true,
        data: {
          ok: true,
          startedAt: this.startedAt,
          uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0
        },
        meta: { requestId, ts: Date.now() }
      })
      return
    }

    if (!this.isAuthorized(req)) {
      this.logger?.warn('McpProxy', '内部 MCP 代理鉴权失败', { pathname, method })
      this.sendJson(res, 401, {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Unauthorized MCP proxy request',
          hint: 'Provide Authorization: Bearer <token>'
        },
        meta: { requestId, ts: Date.now() }
      })
      return
    }

    if (method === 'GET' && pathname === '/status') {
      this.sendJson(res, 200, {
        success: true,
        data: this.getStatus(),
        meta: { requestId, ts: Date.now() }
      })
      return
    }

    if ((method !== 'POST' && method !== 'GET') || !pathname.startsWith('/tool/')) {
      this.sendJson(res, 404, {
        success: false,
        error: {
          code: 'BAD_REQUEST',
          message: 'Unknown MCP proxy endpoint'
        },
        meta: { requestId, ts: Date.now() }
      })
      return
    }

    const isStreamRequest = pathname.endsWith('/stream')
    const toolPath = isStreamRequest ? pathname.slice(0, -'/stream'.length) : pathname
    const toolName = toolPath.slice('/tool/'.length) as McpToolName
    if (!MCP_TOOL_NAMES.includes(toolName)) {
      this.sendJson(res, 404, {
        success: false,
        error: {
          code: 'BAD_REQUEST',
          message: `Unsupported MCP tool: ${toolName}`
        },
        meta: { requestId, ts: Date.now() }
      })
      return
    }

    try {
      const body = method === 'POST' ? await this.readJson(req) : {}
      const args = body.args && typeof body.args === 'object' ? body.args as Record<string, unknown> : {}
      if (isStreamRequest) {
        await this.handleStreamRequest(toolName, args, requestId, res)
        return
      }
      const startedAt = Date.now()
      const result = await executeMcpTool(toolName, args)
      this.logger?.info('McpProxy', '内部 MCP 代理查询成功', {
        toolName,
        durationMs: Date.now() - startedAt
      })
      this.sendJson(res, 200, {
        success: true,
        data: result.payload,
        summary: result.summary,
        meta: { requestId, ts: Date.now() }
      })
    } catch (error) {
      const payload = error instanceof McpToolError
        ? error.toShape()
        : {
            code: 'INTERNAL_ERROR',
            message: String(error)
          }

      this.logger?.error('McpProxy', '内部 MCP 代理查询失败', {
        toolName,
        error: payload
      })

      this.sendJson(res, payload.code === 'BAD_REQUEST' ? 400 : 503, {
        success: false,
        error: payload,
        meta: { requestId, ts: Date.now() }
      })
    }
  }

  private async handleStreamRequest(
    toolName: McpToolName,
    args: Record<string, unknown>,
    requestId: string,
    res: http.ServerResponse
  ): Promise<void> {
    const startedAt = Date.now()
    let chunkIndex = 0

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    })

    this.sendSse(res, {
      event: 'meta',
      data: {
        toolName,
        requestId,
        startedAt
      }
    })

    try {
      const result = await executeMcpTool(toolName, args, {
        progress: async (payload: McpStreamProgressPayload) => {
          this.sendSse(res, {
            event: 'progress',
            data: payload
          })
        },
        partial: async <K extends keyof McpStreamPartialPayloadMap>(partialToolName: K, payload: McpStreamPartialPayloadMap[K]) => {
          chunkIndex += 1
          this.sendSse(res, {
            event: 'partial',
            data: {
              toolName: partialToolName,
              chunkIndex,
              payload
            }
          })
        }
      })

      this.sendSse(res, {
        event: 'progress',
        data: {
          stage: 'completed',
          message: `Completed ${toolName}.`
        }
      })
      this.sendSse(res, {
        event: 'complete',
        data: {
          toolName,
          summary: result.summary,
          payload: result.payload,
          completedAt: Date.now()
        }
      })
      res.end()
    } catch (error) {
      const payload = error instanceof McpToolError
        ? error.toShape()
        : {
            code: 'INTERNAL_ERROR' as const,
            message: String(error)
          }

      this.sendSse(res, {
        event: 'progress',
        data: {
          stage: 'failed',
          message: `Failed ${toolName}.`
        }
      })
      this.sendSse(res, {
        event: 'error',
        data: {
          ...payload,
          toolName,
          failedAt: Date.now()
        }
      })
      res.end()
    }
  }
}

export const mcpProxyService = new McpProxyService()
