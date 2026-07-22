import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createCipherTalkMcpServer } from './server'

const SHUTDOWN_TIMEOUT_MS = 1_000
const CLOSED_PIPE_ERROR_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED'])

let mcpServer: ReturnType<typeof createCipherTalkMcpServer> | null = null
let isShuttingDown = false
let processHandlersInstalled = false

function isClosedPipeError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    CLOSED_PIPE_ERROR_CODES.has(String(error.code))
  )
}

function writeDiagnostic(message: string) {
  if (!process.stderr.destroyed) {
    process.stderr.write(message)
  }
}

async function shutdown(code = 0) {
  if (isShuttingDown) return
  isShuttingDown = true

  const forceExitTimer = setTimeout(() => {
    process.exit(code)
  }, SHUTDOWN_TIMEOUT_MS)
  forceExitTimer.unref()

  try {
    await mcpServer?.close?.()
  } catch (error) {
    if (!isClosedPipeError(error)) {
      writeDiagnostic(`[CipherTalk MCP] close error: ${String(error)}\n`)
    }
  } finally {
    clearTimeout(forceExitTimer)
    process.exit(code)
  }
}

function installProcessHandlers() {
  if (processHandlersInstalled) return
  processHandlersInstalled = true

  const handleOutputError = (error: Error) => {
    // Once an MCP client's output pipe closes, there is no channel left for a
    // graceful response. Exiting directly also prevents recursive EPIPE errors.
    process.exit(isClosedPipeError(error) ? 0 : 1)
  }

  process.stdin.once('end', () => {
    void shutdown(0)
  })

  process.stdin.once('close', () => {
    void shutdown(0)
  })

  process.stdin.once('error', () => {
    void shutdown(1)
  })

  process.stdout.on('error', handleOutputError)
  process.stderr.on('error', handleOutputError)

  process.on('SIGINT', () => {
    void shutdown(0)
  })

  process.on('SIGTERM', () => {
    void shutdown(0)
  })

  process.on('uncaughtException', (error) => {
    if (isClosedPipeError(error)) {
      process.exit(0)
    }
    writeDiagnostic(`[CipherTalk MCP] uncaughtException: ${String(error)}\n`)
    void shutdown(1)
  })

  process.on('unhandledRejection', (error) => {
    writeDiagnostic(`[CipherTalk MCP] unhandledRejection: ${String(error)}\n`)
    void shutdown(1)
  })
}

export async function bootstrapCipherTalkMcpServer() {
  installProcessHandlers()

  try {
    mcpServer = createCipherTalkMcpServer()
    const transport = new StdioServerTransport()
    await mcpServer.connect(transport)
    writeDiagnostic('[CipherTalk MCP] stdio server started\n')
  } catch (error) {
    writeDiagnostic(`[CipherTalk MCP] startup failed: ${String(error)}\n`)
    await shutdown(1)
  }
}
