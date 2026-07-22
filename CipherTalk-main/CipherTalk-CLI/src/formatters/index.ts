import { formatCsv } from './csv.js'
import { formatJson, formatJsonl } from './json.js'
import { formatMarkdown } from './markdown.js'
import { formatTable } from './table.js'
import type { Envelope, OutputFormat } from '../types.js'

export function formatEnvelope(envelope: Envelope, format: OutputFormat): string {
  switch (format) {
    case 'json':
      return formatJson(envelope)
    case 'jsonl':
      return formatJsonl(envelope)
    case 'table':
      return formatTable(envelope)
    case 'csv':
      return formatCsv(envelope)
    case 'markdown':
      return formatMarkdown(envelope)
    default:
      return formatJson(envelope)
  }
}
