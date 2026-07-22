import type { McpErrorCode, McpErrorShape } from './types'

export class McpToolError extends Error {
  code: McpErrorCode
  hint?: string

  constructor(code: McpErrorCode, message: string, hint?: string) {
    super(message)
    this.name = 'McpToolError'
    this.code = code
    this.hint = hint
  }

  toShape(): McpErrorShape {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint
    }
  }
}

function toStructuredContent(data: unknown): Record<string, unknown> {
  if (data && typeof data === 'object') {
    return data as Record<string, unknown>
  }

  return { value: data }
}

export function createToolSuccess(summary: string, data: unknown) {
  return {
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: toStructuredContent(data),
    isError: false
  }
}

export function createToolError(error: unknown) {
  const payload = error instanceof McpToolError
    ? error.toShape()
    : {
        code: 'INTERNAL_ERROR' as const,
        message: String(error),
        hint: undefined
      }
  const text = `[${payload.code}] ${payload.message}${payload.hint ? `\nHint: ${payload.hint}` : ''}`

  return {
    content: [{ type: 'text' as const, text }],
    isError: true
  }
}
