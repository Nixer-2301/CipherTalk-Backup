import { describe, expect, it } from 'vitest'
import { createProgram } from '../../src/cli.js'
import { notImplemented } from '../../src/errors.js'
import { filterInteractiveCommands, getInteractiveCommands, parseSlashInput, renderWelcomeScreen } from '../../src/interactiveShell.js'
import type { DataService, KeyService } from '../../src/services/types.js'

function createOutput() {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    target: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text)
    }
  }
}

const mockData: DataService = {
  async getStatus(config) {
    return {
      configured: false,
      configPath: config.configPath,
      nativeRoot: 'native',
      databaseFiles: 0
    }
  },
  async listSessions(_config, options) {
    return {
      sessions: [{ sessionId: 'wxid_a', displayName: 'wxid_a', type: 'private', lastMessage: 'hi', lastTime: 1 }],
      hasMore: options.limit < 1
    }
  },
  async getMessages() {
    return { messages: [{ direction: 'in', content: 'hello' }], cursor: null }
  },
  async listContacts() {
    return { contacts: [{ wxid: 'wxid_a', displayName: 'Alice', type: 'friend' }] }
  },
  async getContactInfo() {
    return { wxid: 'wxid_a', displayName: 'Alice', type: 'friend' }
  }
}

const mockKey: KeyService = {
  async setKey(hex) {
    return { saved: true, keyHex: hex.toLowerCase() }
  },
  async testKey() {
    return { validFormat: true }
  },
  async getKey() {
    return { keyHex: 'a'.repeat(64), saved: false }
  }
}

describe('cli command registration', () => {
  it('runs status through injected data service', async () => {
    const output = createOutput()
    const program = createProgram({
      services: { data: mockData, key: mockKey },
      output: output.target,
      setExitCode: () => undefined
    })

    await program.parseAsync(['node', 'miyu', '--format', 'json', 'status'])

    expect(output.stderr).toEqual([])
    const parsed = JSON.parse(output.stdout[0])
    expect(parsed.ok).toBe(true)
    expect(parsed.data.configured).toBe(false)
  })

  it('registers data commands with json envelope output', async () => {
    const output = createOutput()
    const program = createProgram({
      services: { data: mockData, key: mockKey },
      output: output.target,
      setExitCode: () => undefined
    })

    await program.parseAsync(['node', 'miyu', '--format', 'json', 'sessions'])

    const parsed = JSON.parse(output.stdout[0])
    expect(parsed.ok).toBe(true)
    expect(parsed.data.sessions[0].sessionId).toBe('wxid_a')
  })

  it('registers config commands', async () => {
    const output = createOutput()
    const program = createProgram({
      services: { data: mockData, key: mockKey },
      output: output.target,
      setExitCode: () => undefined
    })

    await program.parseAsync(['node', 'miyu', '--format', 'json', 'config', 'show'])

    const parsed = JSON.parse(output.stdout[0])
    expect(parsed.ok).toBe(true)
    expect(parsed.data).toHaveProperty('config')
  })

  it('advanced commands return NOT_IMPLEMENTED instead of failing silently', async () => {
    const output = createOutput()
    let exitCode = 0
    const program = createProgram({
      services: {
          data: mockData,
          key: mockKey,
          advanced: {
            async search() { throw notImplemented('search') },
            async exportChat() { throw notImplemented('export') },
            async moments() { throw notImplemented('moments') },
            async mcpServe() { throw notImplemented('mcp serve') }
          }
      },
      output: output.target,
      setExitCode: (code) => { exitCode = code }
    })

    await program.parseAsync(['node', 'miyu', '--format', 'json', 'search', '生日'])

    const parsed = JSON.parse(output.stderr[0])
    expect(exitCode).toBe(1)
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('NOT_IMPLEMENTED')
  })

  it('exposes slash commands for interactive mode', () => {
    expect(getInteractiveCommands().map((command) => command.name)).toEqual(expect.arrayContaining([
      '/status',
      '/sessions',
      '/messages',
      '/contacts',
      '/key',
      '/search',
      '/exit'
    ]))
  })

  it('parses slash input with quoted arguments', () => {
    expect(parseSlashInput('/messages "张三" --limit 20')).toEqual({
      command: '/messages',
      args: ['张三', '--limit', '20']
    })
  })

  it('filters slash command suggestions by typed prefix', () => {
    expect(filterInteractiveCommands('/s').map((command) => command.name)).toEqual(expect.arrayContaining([
      '/status',
      '/sessions',
      '/search'
    ]))
    expect(filterInteractiveCommands('status')).toEqual([])
  })

  it('renders a standalone welcome screen for interactive mode', () => {
    const screen = renderWelcomeScreen()
    expect(screen).toContain('Welcome to CipherTalk CLI')
    expect(screen).toContain('欢迎使用密语命令行工具')
  })
})
