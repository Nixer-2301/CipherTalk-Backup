import assert from 'node:assert/strict'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { buildPromptCacheKey, applyAnthropicCacheControl, buildProviderOptions } from '../electron/services/agent/cache.ts'
import { buildAgentPromptParts } from '../electron/services/agent/prompts.ts'
import { isQuerySqlUnlocked, readToolRuntimeContext } from '../electron/services/agent/toolPolicy.ts'
import type { AgentRunInput } from '../electron/services/agent/types.ts'

const globalScope = { kind: 'global' as const }
const sessionScope = { kind: 'session' as const, sessionId: 'wxid_example', displayName: '示例联系人' }

const baseTools: ToolSet = {
  search_messages: tool({ inputSchema: z.object({ query: z.string() }), description: 'stable search tool' }),
  query_sql: tool({ inputSchema: z.object({ sql: z.string() }), description: 'stable sql tool' }),
}
const globalParts = buildAgentPromptParts(globalScope)
const dynamicParts = buildAgentPromptParts(sessionScope, [{
  name: 'demo',
  version: '1.0.0',
  description: '测试 Skill',
  content: '动态 skill 内容',
}])

assert.equal(
  buildPromptCacheKey(globalParts, baseTools),
  buildPromptCacheKey(dynamicParts, baseTools),
  'cache key must ignore dynamic scope and skills',
)

const officialOpenAIInput: AgentRunInput = {
  messages: [],
  scope: globalScope,
  providerConfig: {
    providerKind: 'openai-responses',
    name: 'openai',
    apiKey: 'test',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-5.1',
  },
}

assert.equal(
  (buildProviderOptions(officialOpenAIInput, 'cache-key')?.openai as any)?.promptCacheKey,
  'cache-key',
  'official OpenAI Responses calls should include promptCacheKey',
)

assert.equal(
  (buildProviderOptions({
    ...officialOpenAIInput,
    providerConfig: { ...officialOpenAIInput.providerConfig, name: 'custom' },
  }, 'cache-key')?.openai as any)?.promptCacheKey,
  undefined,
  'custom Responses endpoints must not receive OpenAI promptCacheKey',
)

assert.equal(
  buildProviderOptions({
    ...officialOpenAIInput,
    providerConfig: { ...officialOpenAIInput.providerConfig, providerKind: 'openai-compatible', name: 'deepseek', baseURL: 'https://api.deepseek.com' },
  }, 'cache-key'),
  undefined,
  'OpenAI-compatible providers without other OpenAI options should not receive private cache params',
)

const toolSet: ToolSet = {
  search_messages: tool({ inputSchema: z.object({}), description: 'stable tool' }),
  mcp__demo__tool: tool({ inputSchema: z.object({}), description: 'dynamic mcp tool' }),
}
const cached = applyAnthropicCacheControl([{ role: 'system', content: 'stable' }], toolSet)
assert.equal((cached.messages[0].providerOptions?.anthropic as any)?.cacheControl?.type, 'ephemeral')
assert.equal((cached.tools.search_messages.providerOptions?.anthropic as any)?.cacheControl?.ttl, '5m')
assert.equal(cached.tools.mcp__demo__tool.providerOptions, undefined)

assert.equal(isQuerySqlUnlocked([]), false)
assert.equal(isQuerySqlUnlocked([{ toolCalls: [{ toolName: 'search_messages' }] }] as any), true)
assert.equal(readToolRuntimeContext({ querySqlUnlocked: false }).querySqlUnlocked, false)
assert.equal(readToolRuntimeContext({ querySqlUnlocked: true }).querySqlUnlocked, true)

console.log('agent cache helper tests passed')
