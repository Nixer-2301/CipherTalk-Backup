import Table from 'cli-table3'
import type { Envelope } from '../types.js'

function rowsFromData(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.map((item) => normalizeRow(item))
  if (data && typeof data === 'object') {
    const objectData = data as Record<string, unknown>
    const arrayValue = Object.values(objectData).find(Array.isArray)
    if (Array.isArray(arrayValue)) return arrayValue.map((item) => normalizeRow(item))
    return Object.entries(objectData).map(([key, value]) => ({ key, value: stringifyCell(value) }))
  }
  return [{ value: stringifyCell(data) }]
}

function normalizeRow(item: unknown): Record<string, unknown> {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    return item as Record<string, unknown>
  }
  return { value: item }
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function formatTable(envelope: Envelope): string {
  if (!envelope.ok) {
    const table = new Table({ head: ['code', 'message'] })
    table.push([envelope.error.code, envelope.error.message])
    return table.toString()
  }

  const rows = rowsFromData(envelope.data)
  if (rows.length === 0) return ''
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).slice(0, 12)
  const table = new Table({ head: columns })
  for (const row of rows) {
    table.push(columns.map((column) => stringifyCell(row[column])))
  }
  return table.toString()
}
