// ============================================================
// VectorIndex — in-memory vector similarity search
// ============================================================

export interface ScoredResult {
  id: string
  score: number
}

/**
 * Cosine similarity between two vectors.
 * Handles different-length vectors by treating missing dimensions as zero.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0

  const len = Math.max(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < len; i++) {
    const ai = i < a.length ? a[i] : 0
    const bi = i < b.length ? b[i] : 0
    dot += ai * bi
    normA += ai * ai
    normB += bi * bi
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  if (denom === 0) return 0
  return dot / denom
}

/**
 * Simple in-memory vector index using brute-force cosine similarity.
 * Sufficient for hundreds of experiences; swap for HNSW/IVF if scaling beyond ~10k.
 */
export class VectorIndex {
  private vectors = new Map<string, number[]>()

  add(id: string, embedding: number[]): void {
    this.vectors.set(id, embedding)
  }

  remove(id: string): void {
    this.vectors.delete(id)
  }

  /**
   * Search for the closest vectors to `queryEmbedding`.
   * Returns results sorted by cosine similarity descending.
   */
  search(queryEmbedding: number[], topK: number, minScore = 0): ScoredResult[] {
    const results: ScoredResult[] = []

    for (const [id, vec] of this.vectors) {
      const score = cosineSimilarity(queryEmbedding, vec)
      if (score >= minScore) {
        results.push({ id, score })
      }
    }

    // Sort descending by score
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, topK)
  }

  size(): number {
    return this.vectors.size
  }

  has(id: string): boolean {
    return this.vectors.has(id)
  }
}
