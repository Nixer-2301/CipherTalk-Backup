/**
 * AI 请求失败的展示文案：带上 status/url/responseBody/cause，而不是只给用户看一句"An error occurred."。
 * 供 aiAgentUtilityProcess（子进程级失败）和 engine.ts（toUIMessageStream 内部错误）共用。
 */

export function truncateText(value: unknown, maxLength = 1200): string {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text.length > maxLength ? `${text.slice(0, maxLength)}...<truncated>` : text
}

export function formatAgentError(error: unknown): string {
  const e = error as {
    message?: unknown
    statusCode?: unknown
    url?: unknown
    responseBody?: unknown
    cause?: { message?: unknown }
  }
  const message = typeof e?.message === 'string' && e.message ? e.message : String(error)
  const details: string[] = [message]

  if (typeof e?.statusCode === 'number') details.push(`status=${e.statusCode}`)
  if (typeof e?.url === 'string' && e.url) details.push(`url=${e.url}`)

  if (typeof e?.responseBody === 'string' && e.responseBody) {
    details.push(`responseBody=${truncateText(e.responseBody)}`)
  }

  if (e?.cause?.message && e.cause.message !== message) {
    details.push(`cause=${truncateText(e.cause.message, 500)}`)
  }

  return details.join(' | ')
}
