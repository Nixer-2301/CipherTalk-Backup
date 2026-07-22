/**
 * OpenAI-compatible chat stream sanitizer.
 *
 * Some compatible gateways emit sparse or one-based tool call indexes. The AI
 * SDK stores calls at those indexes and later assumes the array is dense, which
 * makes stream finalization read `hasFinished` from an undefined array slot.
 * Remap indexes by first appearance within each choice while preserving every
 * other SSE field.
 */

type JsonRecord = Record<string, unknown>

export type ToolCallIndexNormalizerState = {
  choiceIndexes: Map<number, Map<number, number>>
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function createToolCallIndexNormalizerState(): ToolCallIndexNormalizerState {
  return { choiceIndexes: new Map() }
}

export function normalizeOpenAICompatibleSseLine(
  line: string,
  state: ToolCallIndexNormalizerState,
): string {
  const match = line.match(/^([ \t]*data:[ \t]*)(.*?)(\r?)$/)
  if (!match || match[2] === '[DONE]') return line

  let payload: unknown
  try {
    payload = JSON.parse(match[2])
  } catch {
    return line
  }
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return line

  let changed = false
  for (let choicePosition = 0; choicePosition < payload.choices.length; choicePosition += 1) {
    const choice = payload.choices[choicePosition]
    if (!isRecord(choice) || !isRecord(choice.delta) || !Array.isArray(choice.delta.tool_calls)) continue

    const choiceIndex = typeof choice.index === 'number' && Number.isInteger(choice.index)
      ? choice.index
      : choicePosition
    let indexMap = state.choiceIndexes.get(choiceIndex)
    if (!indexMap) {
      indexMap = new Map()
      state.choiceIndexes.set(choiceIndex, indexMap)
    }

    for (const toolCall of choice.delta.tool_calls) {
      if (!isRecord(toolCall) || typeof toolCall.index !== 'number' || !Number.isInteger(toolCall.index) || toolCall.index < 0) {
        continue
      }
      const rawIndex = toolCall.index
      let normalizedIndex = indexMap.get(rawIndex)
      if (normalizedIndex === undefined) {
        normalizedIndex = indexMap.size
        indexMap.set(rawIndex, normalizedIndex)
      }
      if (normalizedIndex !== rawIndex) {
        toolCall.index = normalizedIndex
        changed = true
      }
    }
  }

  return changed ? `${match[1]}${JSON.stringify(payload)}${match[3]}` : line
}

function normalizeSseBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const state = createToolCallIndexNormalizerState()
  let buffer = ''

  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        controller.enqueue(encoder.encode(`${normalizeOpenAICompatibleSseLine(line, state)}\n`))
        newlineIndex = buffer.indexOf('\n')
      }
    },
    flush(controller) {
      buffer += decoder.decode()
      if (buffer) controller.enqueue(encoder.encode(normalizeOpenAICompatibleSseLine(buffer, state)))
    },
  }))
}

type FetchInput = Parameters<typeof globalThis.fetch>[0]

function requestUrl(input: FetchInput): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url || ''
}

export function withOpenAICompatibleStreamSanitizer(
  baseFetch: typeof globalThis.fetch | undefined,
): typeof globalThis.fetch {
  const f = baseFetch ?? (globalThis.fetch as typeof globalThis.fetch)
  return (async (input: FetchInput, init?: RequestInit) => {
    const response = await f(input, init)
    const url = requestUrl(input)
    const contentType = response.headers.get('content-type') || ''
    if (!response.ok || !response.body || !/\/chat\/completions(?:\?|$)/.test(url) || !contentType.includes('text/event-stream')) {
      return response
    }

    const headers = new Headers(response.headers)
    headers.delete('content-length')
    headers.delete('content-encoding')
    return new Response(normalizeSseBody(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }) as typeof globalThis.fetch
}
