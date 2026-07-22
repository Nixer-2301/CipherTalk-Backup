import { z } from 'zod'
import { MiyuError, toMiyuError } from '../../errors.js'
import { dataService } from '../dataService.js'
import { searchMessages } from '../searchService.js'
import type { RuntimeConfig } from '../../types.js'

export const MCP_TOOL_NAMES = [
  'health_check',
  'get_status',
  'list_sessions',
  'list_contacts',
  'resolve_session',
  'get_messages',
  'search_messages'
] as const

export type McpToolName = (typeof MCP_TOOL_NAMES)[number]

/**
 * Provider returns the latest resolved runtime config when invoked.
 * It is invoked at tool-call time (not server-build time) so the config
 * snapshot is always fresh and config errors surface as tool errors,
 * not server startup errors.
 */
export type RuntimeConfigProvider = () => RuntimeConfig

export interface RegisterCipherTalkMcpToolsOptions {
  getConfig: RuntimeConfigProvider
  version?: string
}

interface ToolSuccess {
  content: Array<{ type: 'text'; text: string }>
  structuredContent: Record<string, unknown>
}

interface ToolError {
  content: Array<{ type: 'text'; text: string }>
  isError: true
  structuredContent?: Record<string, unknown>
}

function jsonText(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return String(payload)
  }
}

function success(summary: string, payload: Record<string, unknown>): ToolSuccess {
  return {
    content: [{ type: 'text', text: `${summary}\n${jsonText(payload)}` }],
    structuredContent: payload
  }
}

function failure(error: unknown): ToolError {
  const miyu = toMiyuError(error)
  const shape = {
    code: miyu.code,
    message: miyu.message,
    details: miyu.details
  }
  return {
    content: [{ type: 'text', text: `[${shape.code}] ${shape.message}` }],
    isError: true,
    structuredContent: shape
  }
}

function requireConnection(config: RuntimeConfig): RuntimeConfig {
  if (!config.dbPath) {
    throw new MiyuError(
      'CONFIG_MISSING',
      '缺少配置: dbPath。请通过 miyu init 或环境变量 MIYU_DB_PATH 设置微信数据目录。'
    )
  }
  if (!config.keyHex) {
    throw new MiyuError(
      'CONFIG_MISSING',
      '缺少配置: keyHex。请通过 miyu key set 或环境变量 MIYU_KEY_HEX 设置数据库密钥。'
    )
  }
  return config
}

function score(target: string, query: string): number {
  if (!target) return 0
  const lower = target.toLowerCase()
  const q = query.toLowerCase()
  if (lower === q) return 100
  if (lower.startsWith(q)) return 80
  if (lower.includes(q)) return 60
  return 0
}

export function registerCipherTalkMcpTools(server: any, options: RegisterCipherTalkMcpToolsOptions): void {
  const { getConfig, version } = options

  server.registerTool(
    'health_check',
    {
      title: 'Health Check',
      description: 'Return CipherTalk CLI MCP health information.'
    },
    async () => {
      try {
        const config = getConfig()
        const warnings: string[] = []
        if (!config.dbPath) warnings.push('dbPath 未配置，数据类工具会返回 CONFIG_MISSING')
        if (!config.keyHex) warnings.push('keyHex 未配置，数据类工具会返回 CONFIG_MISSING')
        return success('CipherTalk CLI MCP 健康。', {
          ok: true,
          service: 'ciphertalk-cli-mcp',
          version: version || '0.0.0',
          warnings
        })
      } catch (error) {
        return failure(error)
      }
    }
  )

  server.registerTool(
    'get_status',
    {
      title: 'Get Status',
      description: 'Return CipherTalk CLI MCP runtime and configuration status.'
    },
    async () => {
      try {
        const config = getConfig()
        const dbReady = Boolean(config.dbPath && config.keyHex)
        let status: Record<string, unknown> | null = null
        if (dbReady) {
          try {
            status = (await dataService.getStatus(config)) as unknown as Record<string, unknown>
          } catch (statusError) {
            status = { error: statusError instanceof Error ? statusError.message : String(statusError) }
          }
        }
        return success('CipherTalk CLI MCP 状态已加载。', {
          runtime: {
            pid: process.pid,
            platform: process.platform,
            appMode: 'cli' as const
          },
          config: {
            dbReady,
            hasDbPath: Boolean(config.dbPath),
            hasKeyHex: Boolean(config.keyHex),
            wxid: config.wxid || null,
            configPath: config.configPath
          },
          capabilities: {
            tools: [...MCP_TOOL_NAMES]
          },
          status
        })
      } catch (error) {
        return failure(error)
      }
    }
  )

  server.registerTool(
    'list_sessions',
    {
      title: 'List Sessions',
      description: 'List chat sessions from the WCDB session table with pagination and optional type filter.',
      inputSchema: {
        q: z.string().optional().describe('Optional search keyword (matched against sessionId/displayName).'),
        offset: z.number().int().nonnegative().optional().describe('Pagination offset.'),
        limit: z.number().int().positive().optional().describe('Pagination limit. Defaults to 50.'),
        type: z.enum(['private', 'group', 'mp', 'other']).optional().describe('Optional session type filter.')
      }
    },
    async (args: unknown) => {
      try {
        const input = (args || {}) as { q?: string; offset?: number; limit?: number; type?: string }
        const config = requireConnection(getConfig())
        const limit = input.limit ?? 50
        const offset = input.offset ?? 0
        const result = await dataService.listSessions(config, {
          limit,
          offset,
          type: input.type
        })
        const filtered = input.q
          ? result.sessions.filter((s) =>
              (s.sessionId || '').toLowerCase().includes(input.q!.toLowerCase()) ||
              (s.displayName || '').toLowerCase().includes(input.q!.toLowerCase())
            )
          : result.sessions
        return success(`Loaded ${filtered.length} sessions.`, {
          items: filtered,
          offset,
          limit,
          hasMore: result.hasMore
        })
      } catch (error) {
        return failure(error)
      }
    }
  )

  server.registerTool(
    'list_contacts',
    {
      title: 'List Contacts',
      description: 'List contacts (friends, groups, official accounts) from the WCDB contact table.',
      inputSchema: {
        q: z.string().optional().describe('Optional search keyword (matched against wxid/displayName/remark/nickname).'),
        limit: z.number().int().positive().optional().describe('Maximum number of contacts to return. Defaults to 200.'),
        type: z.enum(['friend', 'group', 'mp', 'former_friend', 'other']).optional().describe('Optional contact kind filter.')
      }
    },
    async (args: unknown) => {
      try {
        const input = (args || {}) as { q?: string; limit?: number; type?: string }
        const config = requireConnection(getConfig())
        const limit = input.limit ?? 200
        const result = await dataService.listContacts(config, { limit, type: input.type })
        const filtered = input.q
          ? result.contacts.filter((c) => {
              const q = input.q!.toLowerCase()
              return (
                (c.wxid || '').toLowerCase().includes(q) ||
                (c.displayName || '').toLowerCase().includes(q) ||
                (c.remark || '').toLowerCase().includes(q) ||
                (c.nickname || '').toLowerCase().includes(q)
              )
            })
          : result.contacts
        return success(`Loaded ${filtered.length} contacts.`, {
          items: filtered,
          limit
        })
      } catch (error) {
        return failure(error)
      }
    }
  )

  server.registerTool(
    'resolve_session',
    {
      title: 'Resolve Session',
      description: 'Resolve a fuzzy person/session clue into the most likely chat session candidates.',
      inputSchema: {
        query: z.string().trim().min(1).describe('Fuzzy session clue: partial wxid, display name, remark, or nickname.'),
        limit: z.number().int().positive().optional().describe('Maximum number of candidates. Defaults to 5.')
      }
    },
    async (args: unknown) => {
      try {
        const input = (args || {}) as { query: string; limit?: number }
        if (!input.query || !input.query.trim()) {
          throw new MiyuError('BAD_REQUEST', 'query 不能为空')
        }
        const config = requireConnection(getConfig())
        const limit = input.limit ?? 5

        const sessionResult = await dataService.listSessions(config, { limit: 1000 })
        const contactResult = await dataService.listContacts(config, { limit: 5000 })
        const contactMap = new Map<string, typeof contactResult.contacts[number]>()
        for (const c of contactResult.contacts) contactMap.set(c.wxid, c)

        const query = input.query.trim()
        const candidates = sessionResult.sessions
          .map((s) => {
            const contact = contactMap.get(s.sessionId)
            const aliases = [s.sessionId, s.displayName, contact?.remark, contact?.nickname]
              .filter((v): v is string => Boolean(v))
            const best = aliases.reduce((acc, alias) => Math.max(acc, score(alias, query)), 0)
            return {
              sessionId: s.sessionId,
              displayName: contact?.displayName || s.displayName,
              kind: s.type,
              aliases,
              score: best
            }
          })
          .filter((c) => c.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)

        const recommended = candidates[0]
        const resolved = Boolean(recommended)
        const exact = Boolean(recommended && recommended.score >= 100)

        return success(
          resolved
            ? `Resolved ${candidates.length} candidate(s); top = ${recommended!.displayName}.`
            : `No candidates matched query "${query}".`,
          {
            query,
            resolved,
            exact,
            recommended: recommended || null,
            candidates,
            suggestedNextAction: resolved ? 'get_messages' : 'list_sessions'
          }
        )
      } catch (error) {
        return failure(error)
      }
    }
  )

  server.registerTool(
    'get_messages',
    {
      title: 'Get Messages',
      description: 'List messages from one chat session with pagination and optional direction/type/time filters.',
      inputSchema: {
        sessionId: z.string().trim().min(1).describe('Required session identifier (wxid or @chatroom).'),
        offset: z.number().int().nonnegative().optional().describe('Pagination offset.'),
        limit: z.number().int().positive().optional().describe('Pagination limit. Defaults to 50.'),
        direction: z.enum(['in', 'out']).optional().describe('Optional direction filter.'),
        type: z.string().optional().describe('Optional message type filter (numeric or string).'),
        from: z.string().optional().describe('Optional start time (unix seconds or ISO date).'),
        to: z.string().optional().describe('Optional end time (unix seconds or ISO date).'),
        cursor: z.string().optional().describe('Optional pagination cursor returned from a previous call.')
      }
    },
    async (args: unknown) => {
      try {
        const input = (args || {}) as {
          sessionId: string
          offset?: number
          limit?: number
          direction?: string
          type?: string
          from?: string
          to?: string
          cursor?: string
        }
        if (!input.sessionId || !input.sessionId.trim()) {
          throw new MiyuError('BAD_REQUEST', 'sessionId 不能为空')
        }
        const config = requireConnection(getConfig())
        const limit = input.limit ?? 50
        const result = await dataService.getMessages(config, input.sessionId, {
          limit,
          offset: input.offset,
          direction: input.direction,
          type: input.type,
          from: input.from,
          to: input.to,
          cursor: input.cursor
        })
        return success(`Loaded ${result.messages.length} messages from ${input.sessionId}.`, {
          items: result.messages,
          cursor: result.cursor,
          limit,
          hasMore: Boolean(result.cursor)
        })
      } catch (error) {
        return failure(error)
      }
    }
  )

  server.registerTool(
    'search_messages',
    {
      title: 'Search Messages',
      description: 'Full-text search across message databases. Optionally restrict to one session and a time window.',
      inputSchema: {
        query: z.string().trim().min(1).describe('Required full-text query.'),
        sessionId: z.string().trim().min(1).optional().describe('Optional session identifier to restrict the search.'),
        limit: z.number().int().positive().optional().describe('Maximum number of hits. Defaults to 50.'),
        from: z.string().optional().describe('Optional start time (unix seconds or ISO date).'),
        to: z.string().optional().describe('Optional end time (unix seconds or ISO date).')
      }
    },
    async (args: unknown) => {
      try {
        const input = (args || {}) as {
          query: string
          sessionId?: string
          limit?: number
          from?: string
          to?: string
        }
        if (!input.query || !input.query.trim()) {
          throw new MiyuError('BAD_REQUEST', 'query 不能为空')
        }
        const config = requireConnection(getConfig())
        const result = await searchMessages(config, input.query, {
          session: input.sessionId,
          limit: input.limit,
          from: input.from,
          to: input.to
        })
        return success(`Loaded ${result.messages.length} hits for "${input.query}".`, {
          sessionId: result.sessionId,
          sessionName: result.sessionName,
          items: result.messages,
          total: result.total
        })
      } catch (error) {
        return failure(error)
      }
    }
  )
}
