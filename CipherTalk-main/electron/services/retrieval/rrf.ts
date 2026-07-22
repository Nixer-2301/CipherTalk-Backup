export type RrfRankedItem<T> = {
  item: T
  rank: number
  score?: number
}

export type RrfMergedItem<T> = {
  key: string
  item: T
  rrfScore: number
  ranks: number[]
  scores: number[]
}

export function reciprocalRankFusion<T>(
  rankedLists: Array<Array<RrfRankedItem<T>>>,
  getKey: (item: T) => string,
  k: number = 60
): Array<RrfMergedItem<T>> {
  const safeK = Math.max(1, Math.floor(k || 60))
  const byKey = new Map<string, RrfMergedItem<T>>()

  for (const list of rankedLists) {
    for (let index = 0; index < list.length; index += 1) {
      const entry = list[index]
      const rank = Math.max(1, Math.floor(entry.rank || index + 1))
      const key = getKey(entry.item)
      const existing = byKey.get(key)
      const contribution = 1 / (safeK + rank)

      if (existing) {
        existing.rrfScore += contribution
        existing.ranks.push(rank)
        if (Number.isFinite(entry.score)) existing.scores.push(Number(entry.score))
      } else {
        byKey.set(key, {
          key,
          item: entry.item,
          rrfScore: contribution,
          ranks: [rank],
          scores: Number.isFinite(entry.score) ? [Number(entry.score)] : []
        })
      }
    }
  }

  return Array.from(byKey.values())
    .sort((a, b) => b.rrfScore - a.rrfScore || Math.min(...a.ranks) - Math.min(...b.ranks))
}
