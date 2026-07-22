import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createRequire } from 'node:module'
import { registerCipherTalkMcpTools, type RuntimeConfigProvider } from './tools.js'

function readCliVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require('../../../package.json') as { version?: string }
    return pkg.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export interface CreateMcpServerOptions {
  getConfig: RuntimeConfigProvider
  version?: string
}

/**
 * Builds an McpServer instance with all CipherTalk CLI tools registered.
 * Pure: does not connect to any transport and does not perform I/O.
 */
export function createCipherTalkCliMcpServer(options: CreateMcpServerOptions): McpServer {
  const version = options.version || readCliVersion()
  const server = new McpServer({
    name: 'ciphertalk-cli-mcp',
    version
  })

  registerCipherTalkMcpTools(server, {
    getConfig: options.getConfig,
    version
  })

  return server
}
