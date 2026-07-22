import { formatEnvelope } from './formatters/index.js'
import { toMiyuError } from './errors.js'
import type { CommandMeta, Envelope, OutputFormat } from './types.js'

export interface OutputTarget {
  stdout: (text: string) => void
  stderr: (text: string) => void
}

export const processOutput: OutputTarget = {
  stdout: (text) => {
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
  },
  stderr: (text) => {
    process.stderr.write(text.endsWith('\n') ? text : `${text}\n`)
  }
}

export function successEnvelope<T>(data: T, meta: CommandMeta = {}): Envelope<T> {
  return { ok: true, data, meta }
}

export function errorEnvelope(error: unknown): Envelope {
  const miyuError = toMiyuError(error)
  return {
    ok: false,
    error: {
      code: miyuError.code,
      message: miyuError.message,
      ...(miyuError.details === undefined ? {} : { details: miyuError.details })
    }
  }
}

export function writeEnvelope(target: OutputTarget, envelope: Envelope, format: OutputFormat): void {
  const text = formatEnvelope(envelope, format)
  if (!text) return
  if (envelope.ok) target.stdout(text)
  else target.stderr(text)
}
