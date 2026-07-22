export const OUTPUT_FORMATS = ['json', 'jsonl', 'table', 'csv', 'markdown'] as const

export type OutputFormat = (typeof OUTPUT_FORMATS)[number]

export interface JsonEnvelope<T = unknown> {
  ok: true
  data: T
  meta?: Record<string, unknown>
}

export interface ErrorEnvelope {
  ok: false
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export type Envelope<T = unknown> = JsonEnvelope<T> | ErrorEnvelope

export interface GlobalCliOptions {
  dbPath?: string
  key?: string
  format?: OutputFormat
  limit?: string | number
  quiet?: boolean
  wxid?: string
  ui?: boolean
}

export interface RuntimeConfig {
  dbPath?: string
  keyHex?: string
  wxid?: string
  defaultFormat: OutputFormat
  defaultLimit: number
  cacheDir: string
  configPath: string
}

export interface CommandMeta {
  total?: number
  limit?: number
  cursor?: string | number | null
  took_ms?: number
  [key: string]: unknown
}

export interface CommandResult<T = unknown> {
  data: T
  meta?: CommandMeta
}
