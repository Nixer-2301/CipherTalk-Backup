import { describe, expect, it } from 'vitest'
import { errorEnvelope, successEnvelope } from '../../src/output.js'
import { formatEnvelope } from '../../src/formatters/index.js'
import { notImplemented } from '../../src/errors.js'

describe('formatters', () => {
  it('formats success envelopes as json', () => {
    const output = formatEnvelope(successEnvelope({ value: 1 }, { total: 1 }), 'json')
    expect(JSON.parse(output)).toEqual({ ok: true, data: { value: 1 }, meta: { total: 1 } })
  })

  it('formats error envelopes with stable code and message', () => {
    const output = formatEnvelope(errorEnvelope(notImplemented('search')), 'json')
    const parsed = JSON.parse(output)
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('NOT_IMPLEMENTED')
    expect(parsed.error.message).toContain('search')
  })

  it('formats arrays as jsonl', () => {
    const output = formatEnvelope(successEnvelope({ rows: [{ a: 1 }, { a: 2 }] }), 'jsonl')
    expect(output.split('\n')).toEqual(['{"a":1}', '{"a":2}'])
  })
})
