import type { Envelope } from '../types.js'

export function formatJson(envelope: Envelope): string {
  return JSON.stringify(envelope, null, 2)
}

export function formatJsonl(envelope: Envelope): string {
  if (!envelope.ok) return JSON.stringify(envelope)
  const data = envelope.data
  if (Array.isArray(data)) return data.map((item) => JSON.stringify(item)).join('\n')
  if (data && typeof data === 'object') {
    const values = Object.values(data as Record<string, unknown>)
    const arrayValue = values.find(Array.isArray)
    if (Array.isArray(arrayValue)) return arrayValue.map((item) => JSON.stringify(item)).join('\n')
  }
  return JSON.stringify(envelope)
}
