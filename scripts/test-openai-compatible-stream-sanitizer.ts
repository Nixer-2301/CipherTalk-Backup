import assert from 'node:assert/strict'
import {
  createToolCallIndexNormalizerState,
  normalizeOpenAICompatibleSseLine,
  withOpenAICompatibleStreamSanitizer,
} from '../electron/services/ai/openaiCompatibleStreamSanitizer.ts'

function readToolCallIndexes(line: string): number[] {
  const payload = JSON.parse(line.replace(/^data:\s*/, ''))
  return payload.choices[0].delta.tool_calls.map((toolCall: { index: number }) => toolCall.index)
}

const state = createToolCallIndexNormalizerState()
const first = normalizeOpenAICompatibleSseLine(
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call-a","function":{"name":"recall","arguments":""}}]}}]}',
  state,
)
const continuation = normalizeOpenAICompatibleSseLine(
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{}"}}]}}]}',
  state,
)
const second = normalizeOpenAICompatibleSseLine(
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":3,"id":"call-b","function":{"name":"list_memories","arguments":"{}"}}]}}]}',
  state,
)

assert.deepEqual(readToolCallIndexes(first), [0], 'one-based first tool call should be remapped to zero')
assert.deepEqual(readToolCallIndexes(continuation), [0], 'continuation chunks must keep the same normalized index')
assert.deepEqual(readToolCallIndexes(second), [1], 'sparse later tool calls should be remapped densely')
assert.equal(normalizeOpenAICompatibleSseLine('data: [DONE]', state), 'data: [DONE]')
assert.equal(normalizeOpenAICompatibleSseLine('event: ping', state), 'event: ping')

async function main(): Promise<void> {
  const streamText = [
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-a","function":{"name":"recall","arguments":"{}"}},{"index":2,"id":"call-b","function":{"name":"list_memories","arguments":"{}"}}]}}]}\n',
    '\n',
    'data: [DONE]\n\n',
  ].join('')
  const encoded = new TextEncoder().encode(streamText)
  const fragmentedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded.slice(0, 17))
      controller.enqueue(encoded.slice(17, 89))
      controller.enqueue(encoded.slice(89))
      controller.close()
    },
  })
  const fakeFetch = async () => new Response(fragmentedBody, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'content-length': String(encoded.length) },
  })
  const response = await withOpenAICompatibleStreamSanitizer(fakeFetch as typeof globalThis.fetch)(
    'https://example.com/v1/chat/completions',
  )
  const lines = (await response.text()).split('\n').filter((line) => line.startsWith('data: {'))

  assert.deepEqual(readToolCallIndexes(lines[0]), [0, 1], 'fragmented SSE should produce dense tool call indexes')
  assert.equal(response.headers.has('content-length'), false, 'rewritten streamed responses must drop content-length')

  console.log('openai-compatible stream sanitizer tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
