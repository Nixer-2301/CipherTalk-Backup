'use strict'
/**
 * 检索评测打分 —— 纯函数，无依赖，可单测。
 * 召回判定：片段命中"覆盖"某条期望证据 = 证据的 sortSeq 落在片段 [startSortSeq, endSortSeq] 区间内
 *（片段向量是多条消息合并，故按区间而非单点匹配；回退按 localId 区间）。
 */

/** 余弦相似度；长度不一致返回 null（维度不符的旧向量应跳过）。 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return null
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 片段是否覆盖某条期望证据（优先 sortSeq 区间，回退 localId 区间）。 */
function chunkCoversEvidence(chunk, ev) {
  if (ev.sortSeq != null && chunk.startSortSeq != null && chunk.endSortSeq != null) {
    return ev.sortSeq >= chunk.startSortSeq && ev.sortSeq <= chunk.endSortSeq
  }
  if (ev.localId != null && chunk.startLocalId != null && chunk.endLocalId != null) {
    return ev.localId >= chunk.startLocalId && ev.localId <= chunk.endLocalId
  }
  return false
}

/**
 * 单题打分：rankedChunks 按相关度降序，expectedEvidence 为期望命中的证据。
 * 返回 recall@k、首个命中名次、倒数名次（MRR 用）。
 */
function evaluateCase(rankedChunks, expectedEvidence, k) {
  const total = (expectedEvidence || []).length
  if (total === 0) return { total: 0, covered: 0, recall: null, firstHitRank: null, reciprocalRank: 0 }
  const topK = rankedChunks.slice(0, k)
  const coveredSet = new Set()
  let firstHitRank = null
  for (let i = 0; i < topK.length; i += 1) {
    for (let e = 0; e < expectedEvidence.length; e += 1) {
      if (chunkCoversEvidence(topK[i], expectedEvidence[e])) {
        coveredSet.add(e)
        if (firstHitRank === null) firstHitRank = i + 1
      }
    }
  }
  const covered = coveredSet.size
  return {
    total,
    covered,
    recall: covered / total,
    firstHitRank,
    reciprocalRank: firstHitRank ? 1 / firstHitRank : 0,
  }
}

/** 汇总：平均 recall@k、MRR、全覆盖题数（只统计有期望证据的题）。 */
function aggregate(caseResults) {
  const scored = caseResults.filter((r) => r && typeof r.recall === 'number')
  const n = scored.length || 1
  return {
    cases: caseResults.length,
    scored: scored.length,
    skipped: caseResults.filter((r) => r && r.skipped).length,
    errored: caseResults.filter((r) => r && r.error).length,
    meanRecall: scored.reduce((s, r) => s + r.recall, 0) / n,
    mrr: scored.reduce((s, r) => s + r.reciprocalRank, 0) / n,
    fullyCovered: scored.filter((r) => r.recall === 1).length,
  }
}

module.exports = { cosineSimilarity, chunkCoversEvidence, evaluateCase, aggregate }
