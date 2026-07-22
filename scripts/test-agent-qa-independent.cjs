const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const rootDir = path.resolve(__dirname, '..')

require.extensions['.ts'] = function loadTypeScript(module, filename) {
  const source = fs.readFileSync(filename, 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      skipLibCheck: true
    },
    fileName: filename
  })
  module._compile(output.outputText, filename)
}

function fromRoot(...segments) {
  return path.join(rootDir, ...segments)
}

function walkFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(fullPath, files)
    else files.push(fullPath)
  }
  return files
}

function assertNoForbiddenPattern(pattern, label) {
  const root = fromRoot('electron', 'services', 'ai-agent')
  const matches = []
  for (const file of walkFiles(root)) {
    const relative = path.relative(rootDir, file)
    const content = fs.readFileSync(file, 'utf8')
    if (pattern.test(content)) matches.push(relative)
  }
  assert.deepEqual(matches, [], `${label} still found in: ${matches.join(', ')}`)
}

function makeMessage(overrides = {}) {
  const cursor = overrides.cursor || { localId: 1, createTime: 100, sortSeq: 100 }
  return {
    messageId: cursor.localId,
    timestamp: cursor.createTime,
    timestampMs: cursor.createTime * 1000,
    direction: overrides.direction || 'in',
    kind: overrides.kind || 'text',
    text: overrides.text || '',
    sender: {
      username: overrides.senderUsername ?? 'alice',
      displayName: overrides.displayName ?? 'Alice',
      isSelf: overrides.isSelf ?? false
    },
    cursor,
    raw: {
      localId: cursor.localId,
      serverId: 0,
      localType: 1,
      createTime: cursor.createTime,
      sortSeq: cursor.sortSeq,
      isSend: overrides.direction === 'out' ? 1 : 0,
      senderUsername: overrides.senderUsername ?? 'alice',
      parsedContent: overrides.text || '',
      rawContent: overrides.rawText !== undefined ? overrides.rawText : overrides.text || ''
    }
  }
}

async function main() {
  assertNoForbiddenPattern(/executeMcpTool|from .*mcp|Mcp/, 'MCP dependency')
  assertNoForbiddenPattern(/chatService|httpApi|retrievalEngine|memoryDatabase|chatSearchIndexService/, 'business service dependency')

  const nodeNames = require(fromRoot('electron', 'services', 'ai-agent', 'qa', 'nodeNames.ts'))
  assert.equal(nodeNames.AGENT_TOOL_NODE_NAMES.search_messages, '语义搜索')
  assert.equal(nodeNames.getAgentNodeName({ stage: 'answer' }), '生成回答')

  const progress = require(fromRoot('electron', 'services', 'ai-agent', 'qa', 'progress.ts'))
  const progressEvent = progress.buildProgressEvent({
    id: 'p1',
    stage: 'tool',
    status: 'running',
    title: '搜索相关消息',
    toolName: 'search_messages'
  })
  assert.equal(progressEvent.nodeName, '语义搜索')
  assert.equal(progressEvent.displayName, '语义搜索')

  const nativeTools = require(fromRoot('electron', 'services', 'ai-agent', 'qa', 'nativeTools.ts'))
  const tools = nativeTools.getNativeSessionQATools()
  const toolNames = tools.map((tool) => tool.function.name)
  assert.deepEqual(toolNames, [
    'read_summary_facts',
    'search_messages',
    'read_context',
    'read_latest',
    'read_by_time_range',
    'resolve_participant',
    'aggregate_messages',
    'answer'
  ])
  const searchTool = tools.find((tool) => tool.function.name === 'search_messages')
  assert.deepEqual(searchTool.function.parameters.required, ['query'])
  const contextTool = tools.find((tool) => tool.function.name === 'read_context')
  assert.deepEqual(contextTool.function.parameters.required, ['hitId'])
  assert.equal(contextTool.function.parameters.properties.beforeLimit.default, 6)
  const parsedToolCall = nativeTools.parseNativeToolCallArguments('search_messages', '{"query":"Falcon","reason":"查项目"}')
  assert.equal(parsedToolCall.action.action, 'search_messages')
  assert.equal(parsedToolCall.action.query, 'Falcon')
  const invalidToolCall = nativeTools.parseNativeToolCallArguments('search_messages', '{bad json')
  assert.equal(invalidToolCall.action, null)
  assert.match(invalidToolCall.error, /JSON/)

  const router = require(fromRoot('electron', 'services', 'ai-agent', 'qa', 'intent', 'router.ts'))
  const selfIntroRoute = router.routeFromHeuristics('请介绍一下你自己')
  assert.equal(selfIntroRoute.intent, 'direct_answer')
  assert.equal(selfIntroRoute.needsSearch, false)
  assert.deepEqual(selfIntroRoute.preferredPlan, ['answer'])

  const aiRouter = require(fromRoot('electron', 'services', 'ai-agent', 'qa', 'intent', 'aiRouter.ts'))
  const modelQuestionRoute = router.routeFromHeuristics('你是什么模型')
  const modelQuestionDecision = aiRouter.parseAIIntentRouterDecision('```json\n{"needsLocalEvidence":false,"intent":"assistant_meta","confidence":"high","reason":"用户询问助手当前模型"}\n```')
  assert.ok(modelQuestionDecision)
  assert.equal(modelQuestionDecision.needsLocalEvidence, false)
  const modelQuestionRefined = aiRouter.applyAIIntentDecisionToRoute(modelQuestionRoute, modelQuestionDecision)
  assert.equal(modelQuestionRefined.intent, 'direct_answer')
  assert.equal(modelQuestionRefined.needsSearch, false)
  assert.deepEqual(modelQuestionRefined.preferredPlan, ['answer'])

  const textParser = require(fromRoot('electron', 'services', 'ai-agent', 'qa', 'data', 'textParser.ts'))
  assert.equal(textParser.parseMessageContent('hello', 1), 'hello')
  assert.equal(textParser.parseMessageContent('<msg><appmsg><type>6</type><title>报价.xlsx</title></appmsg></msg>', 49), '[文件] 报价.xlsx')
  assert.equal(textParser.detectAgentMessageKind({ localType: 3, rawContent: '', parsedContent: '[图片]' }), 'image')
  assert.equal(textParser.detectAgentMessageKind({ localType: 49, rawContent: '<type>2000</type>', parsedContent: '[转账]' }), 'app_transfer')

  const repositoryModule = require(fromRoot('electron', 'services', 'ai-agent', 'qa', 'data', 'repository.ts'))
  const repository = repositoryModule.agentDataRepository
  const deduped = repository.dedupeMessagesByCursor([
    makeMessage({ cursor: { localId: 3, createTime: 300, sortSeq: 300 }, text: 'third' }),
    makeMessage({ cursor: { localId: 1, createTime: 100, sortSeq: 100 }, text: 'first' }),
    makeMessage({ cursor: { localId: 3, createTime: 300, sortSeq: 300 }, text: 'duplicate' })
  ])
  assert.deepEqual(deduped.map((item) => item.cursor.localId), [1, 3])

  const participant = require(fromRoot('electron', 'services', 'ai-agent', 'qa', 'tools', 'participant.ts'))
  const resolved = await participant.resolveParticipantName({
    sessionId: 's1',
    name: 'Alice',
    contextWindows: [{ source: 'latest', messages: [makeMessage({ displayName: 'Alice', senderUsername: 'alice' })] }],
    knownHits: []
  })
  assert.equal(resolved.senderUsername, 'alice')
  assert.equal(resolved.source, 'observed')

  console.log('Agent QA independent tests passed.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
