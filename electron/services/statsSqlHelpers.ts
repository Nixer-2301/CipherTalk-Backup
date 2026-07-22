import { basename } from 'path'
import { EXCLUDED_LOCAL_TYPES, StatsPartialError } from './statsConstants'

export interface TimeRangeSec {
  startTimeSec?: number
  endTimeSec?: number
}

export function quoteIdent(identifier: string): string {
  return `"${String(identifier).replace(/"/g, '""')}"`
}

export function normalizeTimestampSeconds(value?: number | null): number | undefined {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return undefined
  return value >= 1_000_000_000_000 ? Math.floor(value / 1000) : Math.floor(value)
}

export function normalizeTimeRange(startTime?: number, endTime?: number): TimeRangeSec {
  const startTimeSec = normalizeTimestampSeconds(startTime)
  const endTimeSec = normalizeTimestampSeconds(endTime)
  if (startTimeSec && endTimeSec && startTimeSec > endTimeSec) {
    return { startTimeSec: endTimeSec, endTimeSec: startTimeSec }
  }
  return { startTimeSec, endTimeSec }
}

export function buildHalfOpenTimeClause(
  range: TimeRangeSec,
  columnName = 'create_time',
  params: unknown[] = [],
): string[] {
  const clauses: string[] = []
  if (range.startTimeSec !== undefined) {
    clauses.push(`${columnName} >= ?`)
    params.push(range.startTimeSec)
  }
  if (range.endTimeSec !== undefined) {
    clauses.push(`${columnName} < ?`)
    params.push(range.endTimeSec)
  }
  return clauses
}

export function buildMessageStatsWhere(
  options: {
    alias?: string
    range?: TimeRangeSec
    includeContentFilter?: boolean
    includeExcludedTypes?: boolean
    contentColumn?: string
    requirePositiveTime?: boolean
  } = {},
): { sql: string; params: unknown[] } {
  const alias = options.alias ? `${options.alias}.` : ''
  const params: unknown[] = []
  const clauses: string[] = []

  if (options.requirePositiveTime !== false) {
    clauses.push(`${alias}create_time > 0`)
  }

  if (options.includeExcludedTypes !== false) {
    const placeholders = EXCLUDED_LOCAL_TYPES.map(() => '?').join(',')
    clauses.push(`COALESCE(${alias}local_type, 0) NOT IN (${placeholders})`)
    params.push(...EXCLUDED_LOCAL_TYPES)
  }

  if (options.includeContentFilter !== false && options.contentColumn) {
    clauses.push(`COALESCE(${alias}${quoteIdent(options.contentColumn)}, '') <> ''`)
  }

  if (options.range) {
    clauses.push(...buildHalfOpenTimeClause(options.range, `${alias}create_time`, params))
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  }
}

export function toLocalDateKey(timestampSec: number): string {
  const d = new Date(timestampSec * 1000)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function toLocalMonthKey(timestampSec: number): string {
  const d = new Date(timestampSec * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function toLocalDateParts(timestampSec: number): { day: string; month: number; hour: number; weekday: number; monthKey: string } {
  const d = new Date(timestampSec * 1000)
  return {
    day: toLocalDateKey(timestampSec),
    month: d.getMonth() + 1,
    hour: d.getHours(),
    weekday: d.getDay(),
    monthKey: toLocalMonthKey(timestampSec),
  }
}

export function utcDateFromLocalKey(dateKey: string): Date {
  const [y, m, d] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(y || 1970, (m || 1) - 1, d || 1))
}

export function recordStatsError(
  errors: StatsPartialError[],
  err: unknown,
  context: { dbPath?: string; tableName?: string; prefix?: string },
): void {
  const message = err instanceof Error ? err.message : String(err)
  const item: StatsPartialError = {
    dbPath: context.dbPath,
    dbName: context.dbPath ? basename(context.dbPath) : undefined,
    tableName: context.tableName,
    message,
  }
  errors.push(item)
  console.warn(context.prefix || '[Stats]', item)
}
