'use strict'
/**
 * 检索评测 runner（L1）—— 量化语义向量检索的召回质量，不跑 agent、不调 LLM 对话。
 *
 * 自包含、读已建好的派生库：
 *   - 经 ConfigService 读 cachePath + embeddingConfig（getUserDataPath 在非 Electron 下回退 %APPDATA%/ciphertalk）。
 *   - 直接 better-sqlite3 只读打开 chat_vectors.db 的 message_chunks（不经 wcdb/子进程）。
 *   - 查询向量用 fetch 直连嵌入 API（OpenAI 兼容 /embeddings）。
 *   - cosine 排序 → score.cjs 算 recall@k / MRR。
 *
 * 前置：① 设置里配好嵌入模型；② 已在 app 里对相关会话做过语义检索（建好向量）。
 * 用法（直接用 node 跑即可，会自动切到 Electron 的 node 以匹配 better-sqlite3 的 ABI）：
 *   node scripts/run-retrieval-evaluator.cjs --cases evaluation/retrieval/baseline.local.jsonl --k 10
 *   或：npm run eval:retrieval -- --cases evaluation/retrieval/baseline.local.jsonl
 */

// better-sqlite3 是按 Electron 的 Node ABI 编的，普通 node 加载会报 NODE_MODULE_VERSION 不符。
// 若不在 Electron 的 node 下运行，自动用 electron（ELECTRON_RUN_AS_NODE）重启自己。
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const electronPath = require('electron')
  const res = spawnSync(electronPath, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  process.exit(res.status == null ? 1 : res.status)
}

const fs = require('node:fs')
const path = require('node:path')
const Database = require('better-sqlite3')
const ts = require('typescript')

const rootDir = path.resolve(__dirname, '..')

// 允许 require .ts（仅用于 ConfigService —— 它只依赖 better-sqlite3，无 ESM 的 'ai'）
require.extensions['.ts'] = function loadTypeScript(module, filename) {
  const source = fs.readFileSync(filename, 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      skipLibCheck: true,
    },
    fileName: filename,
  })
  module._compile(output.outputText, filename)
}

const { cosineSimilarity, evaluateCase, aggregate } = require('../evaluation/retrieval/score.cjs')

function parseArgs(argv) {
  const args = { cases: 'evaluation/retrieval/baseline.local.jsonl', k: 10 }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--cases') args.cases = argv[++i]
    else if (a === '--k') args.k = Number(argv[++i]) || 10
  }
  return args
}

function loadCases(file) {
  const abs = path.isAbsolute(file) ? file : path.join(rootDir, file)
  if (!fs.existsSync(abs)) throw new Error(`用例文件不存在：${abs}（参考 evaluation/retrieval/baseline.example.jsonl 的字段）`)
  return fs.readFileSync(abs, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      try { return JSON.parse(l) } catch (e) { throw new Error(`第 ${i + 1} 行 JSON 解析失败：${e.message}`) }
    })
}

function readConfig() {
  const { ConfigService } = require('../electron/services/config.ts')
  const cs = new ConfigService()
  try {
    return { cachePath: String(cs.get('cachePath') || '').trim(), embedding: cs.get('embeddingConfig') }
  } finally {
    cs.close()
  }
}

async function embedQuery(text, emb) {
  const endpoint = `${String(emb.baseURL || '').replace(/\/$/, '')}/embeddings`
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${emb.apiKey}` },
    body: JSON.stringify({ model: emb.model, input: text }),
  })
  if (!res.ok) throw new Error(`嵌入接口 ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
  const json = await res.json()
  const vec = json?.data?.[0]?.embedding
  if (!Array.isArray(vec)) throw new Error('嵌入接口返回缺少 data[0].embedding')
  return vec
}

function loadSessionChunks(db, sessionId) {
  const rows = db.prepare(
    'SELECT start_sort_seq, end_sort_seq, start_local_id, end_local_id, dim, embedding FROM message_chunks WHERE session_id = ?'
  ).all(sessionId)
  return rows.map((r) => {
    const buf = r.embedding
    const vec = Array.from(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)))
    return {
      startSortSeq: r.start_sort_seq,
      endSortSeq: r.end_sort_seq,
      startLocalId: r.start_local_id,
      endLocalId: r.end_local_id,
      dim: r.dim,
      vec,
    }
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cases = loadCases(args.cases)
  const { cachePath, embedding } = readConfig()

  if (!cachePath) throw new Error('未配置 cachePath（请先在 app 里完成账号/缓存设置）')
  if (!embedding || !embedding.apiKey || !embedding.model) {
    throw new Error('未配置嵌入模型（设置 → 嵌入），无法做向量检索评测')
  }
  const vdbPath = path.join(cachePath, 'chat_vectors.db')
  if (!fs.existsSync(vdbPath)) {
    throw new Error(`找不到向量库 ${vdbPath}；请先在 app 里对相关会话做过语义检索以建立索引`)
  }

  const db = new Database(vdbPath, { readonly: true })
  const results = []
  console.log(`[eval] ${cases.length} 题 · k=${args.k} · 模型=${embedding.model}\n`)

  for (const c of cases) {
    try {
      const chunks = loadSessionChunks(db, c.sessionId)
      if (chunks.length === 0) {
        results.push({ id: c.id, skipped: '该会话无向量索引（先在 app 里建）' })
        console.log(`  ⏭  ${c.id}  跳过：会话 ${c.sessionId} 无向量`)
        continue
      }
      const qvec = await embedQuery(c.semanticQuery || c.question, embedding)
      const ranked = chunks
        .map((ch) => ({ ...ch, score: cosineSimilarity(qvec, ch.vec) }))
        .filter((ch) => ch.score != null)
        .sort((a, b) => b.score - a.score)
      const r = evaluateCase(ranked, c.expectedEvidence || [], args.k)
      results.push({ id: c.id, ...r })
      const tag = r.recall == null ? '—' : r.recall === 1 ? '✓' : r.recall > 0 ? '◐' : '✗'
      console.log(`  ${tag}  ${c.id}  recall@${args.k}=${r.recall == null ? 'n/a' : r.recall.toFixed(2)}  命中名次=${r.firstHitRank ?? '-'}`)
    } catch (e) {
      results.push({ id: c.id, error: e.message })
      console.log(`  ✗  ${c.id}  错误：${e.message}`)
    }
  }
  db.close()

  const agg = aggregate(results)
  console.log('\n=== 汇总 ===')
  console.log(`题数 ${agg.cases} · 已评 ${agg.scored} · 跳过 ${agg.skipped} · 出错 ${agg.errored}`)
  console.log(`平均 recall@${args.k} = ${agg.meanRecall.toFixed(3)} · MRR = ${agg.mrr.toFixed(3)} · 全覆盖 ${agg.fullyCovered}/${agg.scored}`)
}

main().catch((e) => {
  console.error('[eval] 失败：', e.message || e)
  process.exit(1)
})
