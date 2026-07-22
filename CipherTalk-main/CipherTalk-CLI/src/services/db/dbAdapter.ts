import { wcdbService } from './wcdbService.js'

type QueryResult = { success: boolean; rows?: any[]; error?: string }

const PARAMS_UNSUPPORTED = 'native 未支持参数化查询'

function bufferToHex(buffer: Buffer): string {
  return Array.from(buffer)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function sqlLiteral(value: any): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object' && value && typeof value.type === 'string' && 'value' in value) {
    return sqlLiteral(value.value)
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (Buffer.isBuffer(value)) return `X'${bufferToHex(value)}'`
  if (value instanceof Uint8Array) return `X'${bufferToHex(Buffer.from(value))}'`
  return `'${String(value).replace(/'/g, "''")}'`
}

function inlineParams(sql: string, params: any[]): string {
  let index = 0
  let out = ''
  let quote: '"' | "'" | '`' | null = null

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (quote) {
      out += ch
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          out += sql[++i]
        } else {
          quote = null
        }
      }
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ch
      continue
    }
    if (ch === '?' && index < params.length) {
      out += sqlLiteral(params[index++])
      continue
    }
    out += ch
  }

  if (index !== params.length) {
    throw new Error(`参数数量不匹配: expected ${index}, got ${params.length}`)
  }
  return out
}

async function runQuery(
  kind: string,
  path: string,
  sql: string,
  params?: any[]
): Promise<QueryResult> {
  if (params && params.length > 0) {
    const svc = wcdbService as any
    if (typeof svc.execQueryWithParams === 'function') {
      const result: QueryResult = await svc.execQueryWithParams(kind, path, sql, params)
      if (result.success || !result.error?.includes(PARAMS_UNSUPPORTED)) {
        return result
      }
    }
    return wcdbService.execQuery(kind, path, inlineParams(sql, params))
  }
  return wcdbService.execQuery(kind, path, sql)
}

function ensureOk(result: QueryResult, sql: string): void {
  if (!result.success) {
    throw new Error(result.error || '数据库查询失败: ' + sql.slice(0, 80))
  }
}

export const dbAdapter = {
  async all<T = any>(kind: string, path: string, sql: string, params?: any[]): Promise<T[]> {
    const result = await runQuery(kind, path, sql, params)
    ensureOk(result, sql)
    return (result.rows ?? []) as T[]
  },

  async get<T = any>(kind: string, path: string, sql: string, params?: any[]): Promise<T | null> {
    const result = await runQuery(kind, path, sql, params)
    ensureOk(result, sql)
    const rows = result.rows ?? []
    return (rows[0] ?? null) as T | null
  },

  async exec(kind: string, path: string, sql: string, params?: any[]): Promise<number> {
    const result = await runQuery(kind, path, sql, params)
    ensureOk(result, sql)
    return 0
  }
}
