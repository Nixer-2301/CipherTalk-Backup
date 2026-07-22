import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { getCacheDir, getConfigHome, inferWxid } from './runtimePaths.js'
import { invalidArgument } from './errors.js'
import { OUTPUT_FORMATS, type GlobalCliOptions, type OutputFormat, type RuntimeConfig } from './types.js'

const configSchema = z.object({
  dbPath: z.string().optional(),
  keyHex: z.string().optional(),
  wxid: z.string().optional(),
  defaultFormat: z.enum(OUTPUT_FORMATS).optional(),
  defaultLimit: z.number().int().positive().optional(),
  cacheDir: z.string().optional()
})

export type ConfigFile = z.infer<typeof configSchema>

export function getConfigPath(): string {
  return join(getConfigHome(), 'config.json')
}

export function readConfig(): ConfigFile {
  const configPath = getConfigPath()
  if (!existsSync(configPath)) return {}

  const raw = readFileSync(configPath, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  return configSchema.parse(parsed)
}

export function writeConfig(nextConfig: ConfigFile): ConfigFile {
  const configPath = getConfigPath()
  mkdirSync(getConfigHome(), { recursive: true })
  const normalized = configSchema.parse(nextConfig)
  writeFileSync(configPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  return normalized
}

export function patchConfig(patch: ConfigFile): ConfigFile {
  return writeConfig({ ...readConfig(), ...patch })
}

export function clearConfig(keys?: Array<keyof ConfigFile>): ConfigFile {
  if (!keys || keys.length === 0) return writeConfig({})
  const current = readConfig()
  for (const key of keys) {
    delete current[key]
  }
  return writeConfig(current)
}

export function parseLimit(raw: string | number | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw invalidArgument(`limit 必须是正整数: ${String(raw)}`)
  }
  return value
}

export function parseFormat(raw: string | undefined, fallback: OutputFormat): OutputFormat {
  if (!raw) return fallback
  if ((OUTPUT_FORMATS as readonly string[]).includes(raw)) return raw as OutputFormat
  throw invalidArgument(`format 不支持: ${raw}`)
}

export function resolveRuntimeConfig(options: GlobalCliOptions = {}): RuntimeConfig {
  const fileConfig = readConfig()
  const envFormat = process.env.MIYU_FORMAT
  const defaultFormat = parseFormat(
    options.format || envFormat || fileConfig.defaultFormat,
    'json'
  )
  const defaultLimit = parseLimit(options.limit || process.env.MIYU_LIMIT, fileConfig.defaultLimit || 50)
  const dbPath = options.dbPath || process.env.MIYU_DB_PATH || fileConfig.dbPath
  const keyHex = options.key || process.env.MIYU_KEY_HEX || fileConfig.keyHex
  const wxid = options.wxid || process.env.MIYU_WXID || fileConfig.wxid || inferWxid(dbPath)

  return {
    dbPath,
    keyHex,
    wxid,
    defaultFormat,
    defaultLimit,
    cacheDir: fileConfig.cacheDir || getCacheDir(),
    configPath: getConfigPath()
  }
}
