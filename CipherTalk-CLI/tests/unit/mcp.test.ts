import { describe, expect, it, vi } from 'vitest'
import { MCP_TOOL_NAMES, registerCipherTalkMcpTools } from '../../src/services/mcp/tools.js'
import type { RuntimeConfig } from '../../src/types.js'

vi.mock('../../src/services/dataService.js', () => ({
  dataService: {
    getStatus: vi.fn(async () => ({
      configured: true,
      configPath: '/tmp/cfg.json',
      dbPath: '/tmp/db',
      wxid: 'wxid_test',
      nativeRoot: '/tmp/native',
      databaseFiles: 3,
      connection: { attempted: true, ok: true, sessionCount: 12 }
    })),
    listSessions: vi.fn(async () => ({ sessions: [], hasMore: false })),
    listContacts: vi.fn(async () => ({ contacts: [] })),
    getMessages: vi.fn(async () => ({ messages: [], cursor: null })),
    getContactInfo: vi.fn(async () => null)
  }
}))

vi.mock('../../src/services/searchService.js', () => ({
  searchMessages: vi.fn(async () => ({
    sessionId: '',
    sessionName: '全部会话',
    messages: [],
    total: 0
  }))
}))

interface RegisteredTool {
  name: string
  config: Record<string, unknown>
  handler: (args: unknown) => Promise<unknown>
}

function createStubServer(): { server: { registerTool: (n: string, c: Record<string, unknown>, h: RegisteredTool['handler']) => void }, tools: Map<string, RegisteredTool> } {
  const tools = new Map<string, RegisteredTool>()
  const server = {
    registerTool(name: string, config: Record<string, unknown>, handler: RegisteredTool['handler']) {
      tools.set(name, { name, config, handler })
    }
  }
  return { server, tools }
}

function buildConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    dbPath: '/tmp/db',
    keyHex: 'a'.repeat(64),
    wxid: 'wxid_test',
    defaultFormat: 'json',
    defaultLimit: 50,
    cacheDir: '/tmp/cache',
    configPath: '/tmp/cfg.json',
    ...overrides
  }
}

describe('mcp tools registration', () => {
  it('registers exactly the documented tool surface', () => {
    const { server, tools } = createStubServer()
    registerCipherTalkMcpTools(server, { getConfig: () => buildConfig(), version: '0.0.0-test' })

    const registered = [...tools.keys()].sort()
    const expected = [...MCP_TOOL_NAMES].sort()
    expect(registered).toEqual(expected)
  })

  it('every registered tool exposes title and description metadata', () => {
    const { server, tools } = createStubServer()
    registerCipherTalkMcpTools(server, { getConfig: () => buildConfig(), version: '0.0.0-test' })

    for (const tool of tools.values()) {
      expect(typeof tool.config.title).toBe('string')
      expect(typeof tool.config.description).toBe('string')
      expect((tool.config.title as string).length).toBeGreaterThan(0)
      expect((tool.config.description as string).length).toBeGreaterThan(0)
    }
  })
})

describe('mcp tools execution', () => {
  it('health_check happy path returns structured ok payload', async () => {
    const { server, tools } = createStubServer()
    registerCipherTalkMcpTools(server, { getConfig: () => buildConfig(), version: '9.9.9-test' })

    const tool = tools.get('health_check')
    expect(tool).toBeDefined()

    const result = (await tool!.handler({})) as {
      isError?: boolean
      structuredContent: { ok: boolean; service: string; version: string; warnings: string[] }
    }

    expect(result.isError).toBeUndefined()
    expect(result.structuredContent.ok).toBe(true)
    expect(result.structuredContent.service).toBe('ciphertalk-cli-mcp')
    expect(result.structuredContent.version).toBe('9.9.9-test')
    expect(result.structuredContent.warnings).toEqual([])
  })

  it('health_check surfaces warnings when config is incomplete', async () => {
    const { server, tools } = createStubServer()
    registerCipherTalkMcpTools(server, {
      getConfig: () => buildConfig({ dbPath: undefined, keyHex: undefined }),
      version: '0.0.0-test'
    })

    const result = (await tools.get('health_check')!.handler({})) as {
      isError?: boolean
      structuredContent: { ok: boolean; warnings: string[] }
    }

    expect(result.isError).toBeUndefined()
    expect(result.structuredContent.ok).toBe(true)
    expect(result.structuredContent.warnings.length).toBeGreaterThanOrEqual(2)
  })

  it('list_sessions returns CONFIG_MISSING error when dbPath is missing', async () => {
    const { server, tools } = createStubServer()
    registerCipherTalkMcpTools(server, {
      getConfig: () => buildConfig({ dbPath: undefined }),
      version: '0.0.0-test'
    })

    const result = (await tools.get('list_sessions')!.handler({})) as {
      isError?: boolean
      structuredContent?: { code: string; message: string }
      content: Array<{ type: string; text: string }>
    }

    expect(result.isError).toBe(true)
    expect(result.structuredContent?.code).toBe('CONFIG_MISSING')
    expect(result.structuredContent?.message).toMatch(/dbPath/)
    expect(result.content[0].text).toMatch(/CONFIG_MISSING/)
  })

  it('search_messages rejects an empty query as BAD_REQUEST', async () => {
    const { server, tools } = createStubServer()
    registerCipherTalkMcpTools(server, { getConfig: () => buildConfig(), version: '0.0.0-test' })

    const result = (await tools.get('search_messages')!.handler({ query: '   ' })) as {
      isError?: boolean
      structuredContent?: { code: string }
    }

    expect(result.isError).toBe(true)
    expect(result.structuredContent?.code).toBe('BAD_REQUEST')
  })
})
