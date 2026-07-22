import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getAppVersion } from '../runtimePaths'
import { registerCipherTalkMcpTools } from './tools'

export function createCipherTalkMcpServer() {
  const server = new McpServer({
    name: 'ciphertalk-mcp',
    version: getAppVersion()
  })

  registerCipherTalkMcpTools(server)
  return server
}
