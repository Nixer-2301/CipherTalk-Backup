import { stringify } from 'csv-stringify/sync'
import type { Envelope } from '../types.js'

function getRows(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.map((row) => normalizeRow(row))
  if (data && typeof data === 'object') {
    const objectData = data as Record<string, unknown>
    const arrayValue = Object.values(objectData).find(Array.isArray)
    if (Array.isArray(arrayValue)) return arrayValue.map((row) => normalizeRow(row))
    return Object.entries(objectData).map(([key, value]) => ({ key, value }))
  }
  return [{ value: data }]
}

function normalizeRow(row: unknown): Record<string, unknown> {
  if (row && typeof row === 'object' && !Array.isArray(row)) return row as Record<string, unknown>
  return { value: row }
}

export function formatCsv(envelope: Envelope): string {
  const rows = envelope.ok ? getRows(envelope.data) : [{ code: envelope.error.code, message: envelope.error.message }]
  if (rows.length === 0) return ''
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))))
  return stringify(rows, { header: true, columns })
}
