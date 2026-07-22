export class MiyuError extends Error {
  readonly code: string
  readonly details?: unknown
  readonly exitCode: number

  constructor(code: string, message: string, details?: unknown, exitCode = 1) {
    super(message)
    this.name = 'MiyuError'
    this.code = code
    this.details = details
    this.exitCode = exitCode
  }
}

export function notImplemented(feature: string): MiyuError {
  return new MiyuError('NOT_IMPLEMENTED', `${feature} 尚未移植到 CLI 版。`)
}

export function configMissing(field: string, hint?: string): MiyuError {
  return new MiyuError('CONFIG_MISSING', `缺少配置: ${field}${hint ? `。${hint}` : ''}`)
}

export function invalidArgument(message: string, details?: unknown): MiyuError {
  return new MiyuError('INVALID_ARGUMENT', message, details)
}

export function dbError(message: string, details?: unknown): MiyuError {
  return new MiyuError('DB_ERROR', message, details)
}

export function toMiyuError(error: unknown): MiyuError {
  if (error instanceof MiyuError) return error
  if (error instanceof Error) return new MiyuError('INTERNAL_ERROR', error.message, { name: error.name })
  return new MiyuError('INTERNAL_ERROR', String(error))
}
