/**
 * Agent 缓存 fetch 中间层冒烟测试（googleCacheFetch / arkContextFetch）。
 * 运行：node scripts/smoke-cache-middleware.cjs
 * 用 esbuild 现场打包 TS 源码 + stub fetch 断言改写行为，不发真实请求。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-cache-smoke-'))
esbuild.buildSync({
  entryPoints: [
    path.join(__dirname, '../electron/services/agent/googleCacheFetch.ts'),
    path.join(__dirname, '../electron/services/agent/arkContextFetch.ts'),
  ],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outdir: outDir,
  logLevel: 'error',
})
const { withGoogleExplicitCache } = require(path.join(outDir, 'googleCacheFetch.js'))
const { withArkContextCache, isArkBaseURL } = require(path.join(outDir, 'arkContextFetch.js'))

function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
}

async function testGoogle() {
  const calls = []
  const fake = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
    if (String(url).endsWith('/cachedContents')) return jsonResponse(200, { name: 'cachedContents/abc' })
    return jsonResponse(200, { ok: true })
  }
  const f = withGoogleExplicitCache(fake)
  const genUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse'
  const body = {
    systemInstruction: { parts: [{ text: 'sys' }] },
    tools: [{ functionDeclarations: [{ name: 't1' }] }],
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    generationConfig: { temperature: 0.1 },
  }
  await f(genUrl, { method: 'POST', headers: { 'x-goog-api-key': 'k1' }, body: JSON.stringify(body) })
  assert.strictEqual(calls.length, 2, 'first google call: create + generate')
  assert.ok(calls[0].url.endsWith('/v1beta/cachedContents'), 'create url')
  assert.strictEqual(calls[0].body.model, 'models/gemini-2.5-pro')
  assert.strictEqual(calls[0].body.ttl, '3600s')
  assert.ok(calls[0].body.systemInstruction && calls[0].body.tools && calls[0].body.toolConfig, 'prefix in create body')
  const gen = calls[1].body
  assert.strictEqual(gen.cachedContent, 'cachedContents/abc')
  assert.ok(!('systemInstruction' in gen) && !('tools' in gen) && !('toolConfig' in gen), 'prefix stripped')
  assert.ok(gen.contents && gen.generationConfig, 'rest kept')

  // 相同前缀第二次请求：注册表命中，不再 create
  await f(genUrl, { method: 'POST', headers: { 'x-goog-api-key': 'k1' }, body: JSON.stringify(body) })
  assert.strictEqual(calls.length, 3, 'second call reuses cache')
  assert.strictEqual(calls[2].body.cachedContent, 'cachedContents/abc')

  // create 失败（前缀太小等）→ 原样直连，且窗口期内不再重试 create
  const calls2 = []
  const fakeFail = async (url, init) => {
    calls2.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
    if (String(url).endsWith('/cachedContents')) return jsonResponse(400, { error: 'too small' })
    return jsonResponse(200, { ok: true })
  }
  const f2 = withGoogleExplicitCache(fakeFail)
  const smallBody = { systemInstruction: { parts: [{ text: 'x' }] }, contents: [] }
  await f2(genUrl, { method: 'POST', body: JSON.stringify(smallBody) })
  assert.strictEqual(calls2.length, 2, 'failed create + plain request')
  assert.ok(calls2[1].body.systemInstruction, 'passthrough keeps systemInstruction')
  await f2(genUrl, { method: 'POST', body: JSON.stringify(smallBody) })
  assert.strictEqual(calls2.length, 3, 'unsupported cached: no second create')

  // 非 generateContent（countTokens）不拦截
  await f2('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:countTokens', { method: 'POST', body: '{}' })
  assert.strictEqual(calls2[calls2.length - 1].url.includes('countTokens'), true)
  console.log('google wrapper OK')
}

async function testArk() {
  assert.strictEqual(isArkBaseURL('https://ark.cn-beijing.volces.com/api/v3'), true)
  assert.strictEqual(isArkBaseURL('https://api.deepseek.com/v1'), false)
  assert.strictEqual(isArkBaseURL('https://evil.com/volces.com'), false)
  assert.strictEqual(isArkBaseURL(''), false)

  const calls = []
  const fake = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
    if (String(url).endsWith('/context/create')) return jsonResponse(200, { id: 'ctx-1' })
    return jsonResponse(200, { ok: true })
  }
  const f = withArkContextCache(fake)
  const chatUrl = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'
  const body = {
    model: 'doubao-1.5-pro',
    stream: true,
    messages: [
      { role: 'system', content: 'sys-a' },
      { role: 'system', content: 'sys-b' },
      { role: 'user', content: 'hello' },
    ],
  }
  await f(chatUrl, { method: 'POST', headers: { authorization: 'Bearer k' }, body: JSON.stringify(body) })
  assert.strictEqual(calls.length, 2, 'create + context chat')
  assert.ok(calls[0].url.endsWith('/context/create'))
  assert.strictEqual(calls[0].body.mode, 'common_prefix')
  assert.strictEqual(calls[0].body.messages.length, 2)
  assert.strictEqual(calls[0].body.ttl, 3600)
  assert.ok(calls[1].url.endsWith('/context/chat/completions'))
  assert.strictEqual(calls[1].body.context_id, 'ctx-1')
  assert.strictEqual(calls[1].body.messages.length, 1)
  assert.strictEqual(calls[1].body.messages[0].role, 'user')
  assert.strictEqual(calls[1].body.stream, true)

  // 复用
  await f(chatUrl, { method: 'POST', headers: { authorization: 'Bearer k' }, body: JSON.stringify(body) })
  assert.strictEqual(calls.length, 3, 'context reused')

  // 无 system 前缀 → 不拦截
  await f(chatUrl, { method: 'POST', body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }] }) })
  assert.ok(calls[calls.length - 1].url.endsWith('/chat/completions'))
  assert.ok(!calls[calls.length - 1].body.context_id)

  // context chat 4xx → 丢条目 + 原样直连一次
  const calls2 = []
  const fake2 = async (url, init) => {
    calls2.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
    if (String(url).endsWith('/context/create')) return jsonResponse(200, { id: 'ctx-2' })
    if (String(url).includes('/context/chat/completions')) return jsonResponse(404, { error: 'context expired' })
    return jsonResponse(200, { ok: true })
  }
  const f2 = withArkContextCache(fake2)
  const body2 = { model: 'doubao-x', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] }
  const resp = await f2(chatUrl, { method: 'POST', body: JSON.stringify(body2) })
  assert.strictEqual(resp.status, 200, 'fallback response returned')
  assert.strictEqual(calls2.length, 3, 'create + failed context chat + plain fallback')
  assert.ok(calls2[2].url.endsWith('/chat/completions') && !calls2[2].url.includes('/context/'))
  assert.strictEqual(calls2[2].body.messages.length, 2, 'fallback keeps full messages')
  console.log('ark wrapper OK')
}

;(async () => {
  await testGoogle()
  await testArk()
  console.log('ALL SMOKE TESTS PASSED')
})().catch((e) => { console.error(e); process.exit(1) })
