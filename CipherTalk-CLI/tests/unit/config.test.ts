import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { patchConfig, resolveRuntimeConfig } from '../../src/config.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'miyu-test-'))
  process.env.MIYU_HOME = home
  delete process.env.MIYU_DB_PATH
  delete process.env.MIYU_KEY_HEX
  delete process.env.MIYU_FORMAT
  delete process.env.MIYU_LIMIT
})

afterEach(() => {
  delete process.env.MIYU_HOME
  rmSync(home, { recursive: true, force: true })
})

describe('config resolution', () => {
  it('uses CLI options before env and file config', () => {
    patchConfig({
      dbPath: 'file-db',
      keyHex: 'a'.repeat(64),
      defaultFormat: 'table',
      defaultLimit: 10
    })
    process.env.MIYU_DB_PATH = 'env-db'
    process.env.MIYU_KEY_HEX = 'b'.repeat(64)
    process.env.MIYU_FORMAT = 'csv'
    process.env.MIYU_LIMIT = '20'

    const config = resolveRuntimeConfig({
      dbPath: 'cli-db',
      key: 'c'.repeat(64),
      format: 'json',
      limit: '30'
    })

    expect(config.dbPath).toBe('cli-db')
    expect(config.keyHex).toBe('c'.repeat(64))
    expect(config.defaultFormat).toBe('json')
    expect(config.defaultLimit).toBe(30)
  })

  it('falls back from env to file config', () => {
    patchConfig({ dbPath: 'file-db', keyHex: 'a'.repeat(64), defaultFormat: 'markdown', defaultLimit: 15 })
    process.env.MIYU_DB_PATH = 'env-db'

    const config = resolveRuntimeConfig()

    expect(config.dbPath).toBe('env-db')
    expect(config.keyHex).toBe('a'.repeat(64))
    expect(config.defaultFormat).toBe('markdown')
    expect(config.defaultLimit).toBe(15)
  })
})
