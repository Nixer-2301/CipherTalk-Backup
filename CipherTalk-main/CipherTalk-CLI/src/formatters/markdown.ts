import type { Envelope } from '../types.js'

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
}

function rowsFromData(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.map((item) => normalizeRow(item))
  if (data && typeof data === 'object') {
    const objectData = data as Record<string, unknown>
    const arrayValue = Object.values(objectData).find(Array.isArray)
    if (Array.isArray(arrayValue)) return arrayValue.map((item) => normalizeRow(item))
    return Object.entries(objectData).map(([key, value]) => ({ key, value }))
  }
  return [{ value: data }]
}

function normalizeRow(item: unknown): Record<string, unknown> {
  if (item && typeof item === 'object' && !Array.isArray(item)) return item as Record<string, unknown>
  return { value: item }
}

export function formatMarkdown(envelope: Envelope): string {
  const rows = envelope.ok ? rowsFromData(envelope.data) : [{ code: envelope.error.code, message: envelope.error.message }]
  if (rows.length === 0) return ''

  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))))
  const header = `| ${columns.join(' | ')} |`
  const separator = `| ${columns.map(() => '---').join(' | ')} |`
  const body = rows.map((row) => `| ${columns.map((column) => escapeCell(row[column])).join(' | ')} |`)
  return [header, separator, ...body].join('\n')
}
