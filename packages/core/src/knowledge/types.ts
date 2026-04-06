// Knowledge Base — user-curated documents, notes, and facts.
// Distinct from experiences (which capture past task traces).

export interface KnowledgeEntry {
  id: string
  title: string
  content: string
  tags: string[]
  source?: string
  createdAt: string
  updatedAt: string
  embedding?: number[]
}

export interface KnowledgeSearchResult {
  entry: KnowledgeEntry
  score: number
}
