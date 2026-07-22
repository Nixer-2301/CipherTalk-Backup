import { describe, expect, it } from 'vitest'
import {
  exportChat,
  inferFormatFromPath,
  renderCsv,
  renderJson,
  renderMarkdown
} from '../../src/services/export/exportService.js'
import { MiyuError } from '../../src/errors.js'
import type { DataService, MessageRow, SessionRow } from '../../src/services/types.js'
import type { RuntimeConfig } from '../../src/types.js'

const RUNTIME_CONFIG: RuntimeConfig = {
  dbPath: '/fake/db',
  keyHex: 'a'.repeat(64),
  wxid: 'wxid_test',
  defaultFormat: 'json',
  defaultLimit: 50,
  cacheDir: '/tmp/cache',
  configPath: '/tmp/config.json'
}

function makeMessages(): MessageRow[] {
  return [
    {
      localId: 1,
      createTime: 1700000000,
      direction: 'in',
      senderUsername: 'wxid_a',
      type: 1,
      content: 'hello, "world"\nnext line, comma'
    },
    {
      localId: 2,
      createTime: 1700000100,
      direction: 'out',
      senderUsername: 'self',
      type: 1,
      content: 'simple reply'
    }
  ]
}

interface CapturedWrite {
  path: string
  contents: string
}

function makeMockService(messages: MessageRow[], sessions: SessionRow[] = []): Pick<DataService, 'getMessages' | 'listSessions'> {
  return {
    async getMessages() {
      return { messages, cursor: null }
    },
    async listSessions() {
      return { sessions, hasMore: false }
    }
  }
}

describe('inferFormatFromPath', () => {
  it('detects csv from extension', () => {
    expect(inferFormatFromPath('./chat.csv')).toBe('csv')
  })

  it('detects json from extension', () => {
    expect(inferFormatFromPath('/tmp/out.json')).toBe('json')
  })

  it('detects markdown from .md', () => {
    expect(inferFormatFromPath('chat.md')).toBe('md')
  })

  it('detects markdown from .markdown', () => {
    expect(inferFormatFromPath('chat.markdown')).toBe('md')
  })

  it('falls back to json when no extension', () => {
    expect(inferFormatFromPath('./outdir')).toBe('json')
  })

  it('falls back to json when output is undefined', () => {
    expect(inferFormatFromPath(undefined)).toBe('json')
  })

  it('throws INVALID_ARGUMENT for unknown extension', () => {
    expect(() => inferFormatFromPath('chat.xlsx')).toThrowError(MiyuError)
    try {
      inferFormatFromPath('chat.xlsx')
    } catch (e) {
      expect((e as MiyuError).code).toBe('INVALID_ARGUMENT')
    }
  })
})

describe('renderCsv', () => {
  it('emits a header row and escapes quotes/commas/newlines', () => {
    const csv = renderCsv(makeMessages())
    const lines = csv.split(/\r?\n/).filter(Boolean)
    expect(lines[0]).toContain('localId')
    expect(lines[0]).toContain('content')
    // The first message content includes quotes, commas and a newline.
    // csv-stringify wraps such fields in double quotes and doubles internal quotes.
    expect(csv).toContain('"hello, ""world""\nnext line, comma"')
  })
})

describe('renderJson', () => {
  it('produces a valid JSON array without raw payloads', () => {
    const json = renderJson([
      {
        localId: 1,
        createTime: 1700000000,
        direction: 'in',
        senderUsername: 'wxid_a',
        type: 1,
        content: 'hi',
        raw: { huge: 'payload' }
      }
    ])
    const parsed = JSON.parse(json)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed[0]).toEqual({
      localId: 1,
      createTime: 1700000000,
      direction: 'in',
      senderUsername: 'wxid_a',
      type: 1,
      content: 'hi'
    })
    expect(parsed[0].raw).toBeUndefined()
  })
})

describe('renderMarkdown', () => {
  it('renders a transcript with sender, direction arrow and content', () => {
    const md = renderMarkdown(makeMessages(), 'wxid_a')
    expect(md).toContain('# 聊天记录：wxid_a')
    expect(md).toContain('消息条数：2')
    expect(md).toContain('**wxid_a** <-')
    expect(md).toContain('**self** ->')
    expect(md).toContain('simple reply')
  })
})

describe('exportChat orchestrator', () => {
  it('throws INVALID_ARGUMENT when neither session nor --all is given', async () => {
    await expect(
      exportChat(RUNTIME_CONFIG, { output: './chat.json' }, {
        service: makeMockService([]),
        writer: async () => undefined
      })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('throws INVALID_ARGUMENT when --output is missing', async () => {
    await expect(
      exportChat(RUNTIME_CONFIG, { session: 'wxid_a' }, {
        service: makeMockService([]),
        writer: async () => undefined
      })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('throws NOT_IMPLEMENTED when --with-media is requested', async () => {
    await expect(
      exportChat(RUNTIME_CONFIG, { session: 'wxid_a', output: './x.json', withMedia: true }, {
        service: makeMockService([]),
        writer: async () => undefined
      })
    ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' })
  })

  it('writes a single session export and returns path + count', async () => {
    const writes: CapturedWrite[] = []
    const result = await exportChat(
      RUNTIME_CONFIG,
      { session: 'wxid_a', output: '/tmp/chat.json' },
      {
        service: makeMockService(makeMessages()),
        writer: async (path, contents) => { writes.push({ path, contents }) }
      }
    )
    expect(result).toEqual({ path: '/tmp/chat.json', count: 2 })
    expect(writes).toHaveLength(1)
    expect(writes[0].path).toBe('/tmp/chat.json')
    const parsed = JSON.parse(writes[0].contents)
    expect(parsed).toHaveLength(2)
  })

  it('exports each session into a separate file when --all is passed', async () => {
    const writes: CapturedWrite[] = []
    const messages = makeMessages()
    const sessions: SessionRow[] = [
      { sessionId: 'wxid_a', displayName: 'Alice', type: 'private', lastMessage: '', lastTime: 0 },
      { sessionId: 'wxid_b', displayName: 'Bob', type: 'private', lastMessage: '', lastTime: 0 }
    ]
    const result = await exportChat(
      RUNTIME_CONFIG,
      { all: true, output: '/tmp/exports' },
      {
        service: makeMockService(messages, sessions),
        writer: async (path, contents) => { writes.push({ path, contents }) }
      }
    )
    expect(result.path).toBe('/tmp/exports')
    expect(result.count).toBe(messages.length * sessions.length)
    expect(writes.map((w) => w.path).sort()).toEqual([
      // path.join uses platform separator; just check the basenames are present
      expect.stringContaining('wxid_a.json'),
      expect.stringContaining('wxid_b.json')
    ].sort())
  })

  it('filters messages outside the --from/--to range', async () => {
    const writes: CapturedWrite[] = []
    // Use ISO times so the parser converts them to seconds.
    const from = new Date(1700000050 * 1000).toISOString()
    await exportChat(
      RUNTIME_CONFIG,
      { session: 'wxid_a', output: '/tmp/range.json', from },
      {
        service: makeMockService(makeMessages()),
        writer: async (path, contents) => { writes.push({ path, contents }) }
      }
    )
    const parsed = JSON.parse(writes[0].contents)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].localId).toBe(2)
  })
})
