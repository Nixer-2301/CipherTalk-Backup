import type { JSONSchema7 } from 'ai'
import type { McpToolInfo } from '../mcpClientService'
import type { AgentMcpToolDescriptor } from './types'

const ALLOW_WORDS = [
  'list', 'get', 'read', 'search', 'query', 'fetch', 'find', 'lookup',
  'status', 'describe', 'inspect', 'resolve', 'scan', 'show',
]

const DENY_WORDS = [
  'write', 'create', 'update', 'delete', 'remove', 'send', 'post', 'put', 'patch',
  'upload', 'download', 'execute', 'exec', 'run', 'shell', 'terminal', 'cmd',
  'move', 'copy', 'rename', 'replace', 'insert', 'drop', 'alter', 'commit',
  'publish', 'deploy', 'install', 'uninstall', 'kill', 'stop', 'start',
]

function textOf(...values: Array<unknown>): string {
  return values.map((value) => String(value || '').toLowerCase()).join(' ')
}

function tokensOf(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function hasPolicyWord(text: string, words: string[]): boolean {
  const compact = text.replace(/[^a-z0-9]+/gi, '').toLowerCase()
  const tokens = tokensOf(text)
  return words.some((word) => (
    compact.startsWith(word) ||
    tokens.some((token) => token === word || token.startsWith(word))
  ))
}

export function isReadOnlyMcpTool(tool: Pick<McpToolInfo, 'name' | 'description'>): boolean {
  const text = textOf(tool.name, tool.description)
  if (hasPolicyWord(text, DENY_WORDS)) return false
  return hasPolicyWord(text, ALLOW_WORDS)
}

function safeSegment(value: string): string {
  const segment = value
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  return segment || 'tool'
}

export function makeMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${safeSegment(serverName)}__${safeSegment(toolName)}`
}

function normalizeInputSchema(schema: unknown): JSONSchema7 {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    return schema as JSONSchema7
  }
  return { type: 'object', properties: {}, additionalProperties: false }
}

export function buildReadOnlyMcpToolDescriptors(
  servers: Array<{ serverName: string; tools: McpToolInfo[] }>,
): AgentMcpToolDescriptor[] {
  const out: AgentMcpToolDescriptor[] = []
  const seen = new Set<string>()
  for (const server of servers) {
    for (const tool of server.tools) {
      if (!isReadOnlyMcpTool(tool)) continue
      let name = makeMcpToolName(server.serverName, tool.name)
      if (seen.has(name)) {
        name = `${name}_${out.length + 1}`
      }
      seen.add(name)
      out.push({
        name,
        serverName: server.serverName,
        toolName: tool.name,
        description: [
          `外部 MCP 只读工具，来自服务器 "${server.serverName}"。`,
          tool.description || '',
          '只在内置工具无法完成、且该外部数据源明显相关时调用。',
        ].filter(Boolean).join(' '),
        inputSchema: normalizeInputSchema(tool.inputSchema),
      })
    }
  }
  return out
}
