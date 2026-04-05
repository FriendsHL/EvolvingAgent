import type { Experience, RetrievalQuery, RetrievalResult } from '../types.js'
import type { ExperienceStore } from './experience-store.js'

const RRF_K = 60 // Reciprocal Rank Fusion constant

/**
 * Hybrid retriever using keyword search + tag matching + RRF fusion.
 * Phase 1: no semantic/embedding search — keyword + tag only.
 */
export class MemoryRetriever {
  constructor(private store: ExperienceStore) {}

  async search(query: RetrievalQuery): Promise<RetrievalResult[]> {
    const topK = query.topK ?? 5
    const minScore = query.minScore ?? 0.3
    const pool = query.pool ?? 'active'

    const experiences = this.store.getAll(pool)
    if (experiences.length === 0) return []

    // Keyword ranking
    const keywordRanked = this.keywordSearch(query.text, experiences)

    // Tag ranking
    const tagRanked = query.tags?.length
      ? this.tagSearch(query.tags, experiences)
      : []

    // RRF fusion
    const fused = this.rrfFuse([keywordRanked, tagRanked])

    // Filter by min score and take top K
    const results: RetrievalResult[] = []
    for (const [id, score] of fused) {
      if (score < minScore) continue
      const exp = experiences.find((e) => e.id === id)
      if (!exp) continue

      const matchSource: ('keyword' | 'tag')[] = []
      if (keywordRanked.some((r) => r[0] === id)) matchSource.push('keyword')
      if (tagRanked.some((r) => r[0] === id)) matchSource.push('tag')

      results.push({
        id,
        type: 'experience',
        content: exp,
        score,
        matchSource,
      })

      if (results.length >= topK) break
    }

    // Mark referenced experiences
    for (const r of results) {
      await this.store.markReferenced(r.id)
    }

    return results
  }

  /**
   * Keyword search: tokenize query and match against task + tags + reflection.
   * Returns sorted list of [id, rank_position].
   */
  private keywordSearch(text: string, experiences: Experience[]): Array<[string, number]> {
    const queryTokens = this.tokenize(text)
    if (queryTokens.length === 0) return []

    const scored: Array<[string, number]> = []

    for (const exp of experiences) {
      const docTokens = new Set([
        ...this.tokenize(exp.task),
        ...exp.tags.flatMap((t) => this.tokenize(t)),
        ...this.tokenize(exp.reflection.lesson),
      ])

      let matchCount = 0
      for (const token of queryTokens) {
        if (docTokens.has(token)) matchCount++
      }

      if (matchCount > 0) {
        const relevance = matchCount / queryTokens.length
        scored.push([exp.id, relevance])
      }
    }

    // Sort by relevance descending
    scored.sort((a, b) => b[1] - a[1])
    return scored.map(([id], i) => [id, i + 1]) // Return [id, rank_position]
  }

  /**
   * Tag search: exact match on tags.
   */
  private tagSearch(tags: string[], experiences: Experience[]): Array<[string, number]> {
    const queryTags = new Set(tags.map((t) => t.toLowerCase()))
    const scored: Array<[string, number]> = []

    for (const exp of experiences) {
      const expTags = new Set(exp.tags.map((t) => t.toLowerCase()))
      let matchCount = 0
      for (const tag of queryTags) {
        if (expTags.has(tag)) matchCount++
      }
      if (matchCount > 0) {
        scored.push([exp.id, matchCount / queryTags.size])
      }
    }

    scored.sort((a, b) => b[1] - a[1])
    return scored.map(([id], i) => [id, i + 1])
  }

  /**
   * Reciprocal Rank Fusion: fuse multiple ranked lists.
   * score = sum(1 / (k + rank_i)) for each list
   */
  private rrfFuse(rankedLists: Array<Array<[string, number]>>): Array<[string, number]> {
    const scores = new Map<string, number>()

    for (const list of rankedLists) {
      if (list.length === 0) continue
      for (const [id, rank] of list) {
        const current = scores.get(id) ?? 0
        scores.set(id, current + 1 / (RRF_K + rank))
      }
    }

    return [...scores.entries()].sort((a, b) => b[1] - a[1])
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2) // Skip very short tokens
  }
}
