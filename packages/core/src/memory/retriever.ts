import type { Experience, RetrievalQuery, RetrievalResult } from '../types.js'
import type { ExperienceStore } from './experience-store.js'
import type { VectorIndex } from './vector-index.js'
import type { Embedder } from './embedder.js'
import type { RecallLog } from './recall-log.js'

const RRF_K = 60 // Reciprocal Rank Fusion constant

// ============================================================
// Retriever Configuration
// ============================================================

export interface RetrieverConfig {
  weights?: {
    keyword: number  // default 0.3
    vector: number   // default 0.5
    tag: number      // default 0.2
  }
  /** Enable vector search — defaults to true when embedder is available */
  vectorEnabled?: boolean
}

const DEFAULT_WEIGHTS = { keyword: 0.3, vector: 0.5, tag: 0.2 }

/**
 * Hybrid retriever using keyword search + vector search + tag matching + weighted RRF fusion.
 * Gracefully degrades: if no embedder/vector index, falls back to keyword + tag only.
 */
export class MemoryRetriever {
  private weights: { keyword: number; vector: number; tag: number }
  private vectorEnabled: boolean

  constructor(
    private store: ExperienceStore,
    private vectorIndex?: VectorIndex,
    private embedder?: Embedder,
    private config?: RetrieverConfig,
    private recallLog?: RecallLog,
  ) {
    const hasVector = Boolean(vectorIndex && embedder)
    this.vectorEnabled = config?.vectorEnabled ?? hasVector

    if (this.vectorEnabled && hasVector) {
      // Use configured weights or defaults
      this.weights = config?.weights ?? { ...DEFAULT_WEIGHTS }
    } else {
      // No vector available: redistribute vector weight proportionally to keyword + tag
      const base = config?.weights ?? { ...DEFAULT_WEIGHTS }
      const kwTagSum = base.keyword + base.tag
      if (kwTagSum > 0) {
        this.weights = {
          keyword: base.keyword / kwTagSum,
          vector: 0,
          tag: base.tag / kwTagSum,
        }
      } else {
        this.weights = { keyword: 0.6, vector: 0, tag: 0.4 }
      }
    }
  }

  async search(query: RetrievalQuery): Promise<RetrievalResult[]> {
    const topK = query.topK ?? 5
    const minScore = query.minScore ?? 0.005
    const pool = query.pool ?? 'active'

    const experiences = this.store.getAll(pool)
    if (experiences.length === 0) return []

    // Build ranked lists with weights
    const rankedLists: Array<{ list: Array<[string, number]>; weight: number }> = []

    // 1. Keyword ranking
    const keywordRanked = this.keywordSearch(query.text, experiences)
    if (keywordRanked.length > 0) {
      rankedLists.push({ list: keywordRanked, weight: this.weights.keyword })
    }

    // 2. Vector ranking (if available)
    let vectorRanked: Array<[string, number]> = []
    // Per-id cosine similarity — captured here (not in rankedLists which
    // carry rank positions for RRF) so S0 scoring can feed a real similarity
    // into recall-log and totalRelevance rather than the fused RRF score.
    const similarityById = new Map<string, number>()
    if (this.vectorEnabled && this.embedder && this.vectorIndex) {
      const { ranked, similarities } = await this.vectorSearch(query.text)
      vectorRanked = ranked
      for (const [id, sim] of similarities) similarityById.set(id, sim)
      if (vectorRanked.length > 0) {
        rankedLists.push({ list: vectorRanked, weight: this.weights.vector })
      }
    }

    // 3. Tag ranking
    const tagRanked = query.tags?.length
      ? this.tagSearch(query.tags, experiences)
      : []
    if (tagRanked.length > 0) {
      rankedLists.push({ list: tagRanked, weight: this.weights.tag })
    }

    // Weighted RRF fusion
    const fused = this.rrfFuse(rankedLists)

    // Filter by min score and take top K
    const results: RetrievalResult[] = []
    for (const [id, score] of fused) {
      if (score < minScore) continue
      const exp = experiences.find((e) => e.id === id)
      if (!exp) continue

      const matchSource: ('keyword' | 'semantic' | 'tag')[] = []
      if (keywordRanked.some((r) => r[0] === id)) matchSource.push('keyword')
      if (vectorRanked.some((r) => r[0] === id)) matchSource.push('semantic')
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

    // Mark referenced experiences. S0: also accumulate totalRelevance and
    // (if wired) append a recall-log line per hit. The similarity used
    // is the cosine similarity from the vector search; keyword/tag-only
    // hits log `null` (unknown) rather than 0, so the maintenance sweep
    // doesn't fold a synthetic zero into the avgRelevance average.
    const ts = new Date().toISOString()
    for (const r of results) {
      const rawSim = similarityById.get(r.id)
      const similarity = rawSim === undefined ? null : clamp01(rawSim)
      // `markReferenced` still accepts a numeric bump for its running
      // counter — keyword/tag-only hits contribute 0 to that in-memory
      // counter. The next maintain() sweep will authoritatively rewrite
      // totalRelevance from the recall-log window (skipping nulls), so
      // the counter is only a best-effort intra-sweep accumulator.
      await this.store.markReferenced(r.id, similarity ?? 0)
      if (this.recallLog) {
        try {
          await this.recallLog.append({
            experienceId: r.id,
            query: query.text,
            similarity,
            timestamp: ts,
          })
        } catch {
          // Recall-log failures must never break retrieval.
        }
      }
    }

    return results
  }

  // ============================================================
  // Search Strategies
  // ============================================================

  /**
   * Vector search: embed the query and search the vector index.
   * Returns both:
   *  - `ranked`: `[id, rank_position]` pairs for RRF fusion (unchanged shape).
   *  - `similarities`: `[id, cosineSimilarity]` pairs so callers can feed a
   *     real similarity score into recall-log / health scoring instead of
   *     the fused rank-based number.
   */
  private async vectorSearch(text: string): Promise<{
    ranked: Array<[string, number]>
    similarities: Array<[string, number]>
  }> {
    if (!this.embedder || !this.vectorIndex || this.vectorIndex.size() === 0) {
      return { ranked: [], similarities: [] }
    }

    const queryEmbedding = await this.embedder.embed(text)
    // Retrieve more candidates than we need; RRF fusion handles final ranking
    const results = this.vectorIndex.search(queryEmbedding, 50)

    return {
      ranked: results.map((r, i) => [r.id, i + 1]),
      similarities: results.map((r) => [r.id, r.score]),
    }
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

  // ============================================================
  // Fusion
  // ============================================================

  /**
   * Weighted Reciprocal Rank Fusion: fuse multiple ranked lists with weights.
   * score = sum(weight_i / (k + rank_i)) for each list
   */
  private rrfFuse(
    rankedLists: Array<{ list: Array<[string, number]>; weight: number }>,
  ): Array<[string, number]> {
    const scores = new Map<string, number>()

    for (const { list, weight } of rankedLists) {
      if (list.length === 0 || weight === 0) continue
      for (const [id, rank] of list) {
        const current = scores.get(id) ?? 0
        scores.set(id, current + weight / (RRF_K + rank))
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

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}
