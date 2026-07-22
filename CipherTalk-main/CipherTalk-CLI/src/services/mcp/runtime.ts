import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resolveRuntimeConfig } from '../../config.js'
import { createCipherTalkCliMcpServer } from './server.js'

let activeServer: ReturnType<typeof createCipherTalkCliMcpServer> | null = null
let isShuttingDown = false

async function shutdown(code = 0): Promise<void> {
  if (isShuttingDown) return
  isShuttingDown = true
  try {
    await activeServer?.close?.()
  } catch (error) {
    process.stderr.write(`[CipherTalk CLI MCP] close error: ${String(error)}\n`)
  } finally {
    process.exit(code)
  }
}

function installProcessHandlers(): void {
  process.on('SIGINT', () => {
    void shutdown(0)
  })
  process.on('SIGTERM', () => {
    void shutdown(0)
  })
  process.on('uncaughtException', (error) => {
    process.stderr.write(`[CipherTalk CLI MCP] uncaughtException: ${String(error)}\n`)
    void shutdown(1)
  })
  process.on('unhandledRejection', (error) => {
    process.stderr.write(`[CipherTalk CLI MCP] unhandledRejection: ${String(error)}\n`)
    void shutdown(1)
  })
}

/**
 * Entry point for `miyu mcp serve`.
 *
 * Boots a long-running stdio MCP server. The returned promise never resolves
 * — it only ever rejects if the transport fails to start, or the process is
 * terminated via SIGINT/SIGTERM (in which case `process.exit` is called).
 *
 * Tool handlers re-resolve the runtime config on every call so configuration
 * changes (e.g. `miyu init` run in another shell) take effect without
 * restarting the server, and missing-config errors surface as structured
 * tool errors rather than crashing the server.
 */
export async function runMcpServe(): Promise<never> {
  installProcessHandlers()

  try {
    activeServer = createCipherTalkCliMcpServer({
      getConfig: () => resolveRuntimeConfig()
    })
    const transport = new StdioServerTransport()
    await activeServer.connect(transport)
    process.stderr.write('[CipherTalk CLI MCP] stdio server started\n')
  } catch (error) {
    process.stderr.write(`[CipherTalk CLI MCP] startup failed: ${String(error)}\n`)
    await shutdown(1)
  }

  // Block forever — the process will be terminated via signal handlers.
  return new Promise<never>(() => {})
}
