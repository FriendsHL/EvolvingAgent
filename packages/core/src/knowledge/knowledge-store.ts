import { readFile, writeFile, readdir, mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import type { KnowledgeEntry, KnowledgeSearchResult } from './types.js'
import { VectorIndex } from '../memory/vector-index.js'
import type { Embedder } from '../memory/embedder.js'

/**
 * KnowledgeStore — JSON file-based persistence for user-curated knowledge.
 *
 * Each entry is stored as `data/knowledge/<id>.json`. Supports hybrid keyword
 * + vector search by reusing the memory VectorIndex and Embedder.
 */
export class KnowledgeStore {
  private basePath = ''
  private dir = ''
  private entries = new Map<string, KnowledgeEntry>()
  private vectorIndex = new VectorIndex()
  private embedder?: Embedder
  private initialized = false

  constructor(embedder?: Embedder) {
    this.embedder = embedder
  }

  async init(dataPath: string): Promise<void> {
    this.basePath = dataPath
    this.dir = join(dataPath, 'knowledge')
    await mkdir(this.dir, { recursive: true })

    // Load existing entries from disk
    try {
      const files = await readdir(this.dir)
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        try {
          const raw = await readFile(join(this.dir, file), 'utf-8')
          const entry = JSON.parse(raw) as KnowledgeEntry
          this.entries.set(entry.id, entry)
          if (entry.embedding && entry.embedding.length > 0) {
            this.vectorIndex.add(entry.id, entry.embedding)
          }
        } catch {
          // Skip corrupted files
        }
      }
    } catch {
      // Directory may not exist yet
    }

    this.initialized = true
  }

  /** Set or replace the embedder — used after init if embedder isn't ready earlier. */
  setEmbedder(embedder: Embedder): void {
    this.embedder = embedder
  }

  async add(input: {
    title: string
    content: string
    tags?: string[]
    source?: string
    id?: string
  }): Promise<KnowledgeEntry> {
    const now = new Date().toISOString()
    const entry: KnowledgeEntry = {
      id: input.id ?? nanoid(),
      title: input.title,
      content: input.content,
      tags: input.tags ?? [],
      source: input.source,
      createdAt: now,
      updatedAt: now,
    }

    // Compute embedding (optional, best-effort)
    if (this.embedder) {
      try {
        entry.embedding = await this.embedder.embed(`${entry.title}\n${entry.content}`)
      } catch {
        // Embedding failed — store without
      }
    }

    this.entries.set(entry.id, entry)
    if (entry.embedding) this.vectorIndex.add(entry.id, entry.embedding)

    await this.persist(entry)
    return entry
  }

  async update(
    id: string,
    patch: Partial<Pick<KnowledgeEntry, 'title' | 'content' | 'tags' | 'source'>>,
  ): Promise<KnowledgeEntry | undefined> {
    const existing = this.entries.get(id)
    if (!existing) return undefined

    const updated: KnowledgeEntry = {
      ...existing,
      ...patch,
      tags: patch.tags ?? existing.tags,
      updatedAt: new Date().toISOString(),
    }

    // Re-embed if content or title changed
    if (this.embedder && (patch.content !== undefined || patch.title !== undefined)) {
      try {
        updated.embedding = await this.embedder.embed(`${updated.title}\n${updated.content}`)
      } catch {
        // keep previous embedding
      }
    }

    this.entries.set(id, updated)
    if (updated.embedding) this.vectorIndex.add(id, updated.embedding)

    await this.persist(updated)
    return updated
  }

  async remove(id: string): Promise<boolean> {
    if (!this.entries.has(id)) return false
    this.entries.delete(id)
    this.vectorIndex.remove(id)
    try {
      await unlink(join(this.dir, `${id}.json`))
    } catch {
      // File might already be gone
    }
    return true
  }

  get(id: string): KnowledgeEntry | undefined {
    return this.entries.get(id)
  }

  list(): KnowledgeEntry[] {
    return [...this.entries.values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    )
  }

  /**
   * Hybrid search: keyword (title/content/tags) + vector cosine similarity.
   * Scores are blended: 0.5 * keywordScore + 0.5 * vectorScore.
   */
  async search(query: string, topK = 5): Promise<KnowledgeSearchResult[]> {
    if (!query.trim() || this.entries.size === 0) return []

    // Keyword scoring: term overlap on normalized tokens
    const queryTokens = tokenize(query)
    const keywordScores = new Map<string, number>()
    for (const entry of this.entries.values()) {
      const hay = tokenize(`${entry.title} ${entry.content} ${entry.tags.join(' ')}`)
      const haySet = new Set(hay)
      let hits = 0
      for (const q of queryTokens) if (haySet.has(q)) hits++
      const score = queryTokens.length === 0 ? 0 : hits / queryTokens.length
      if (score > 0) keywordScores.set(entry.id, score)
    }

    // Vector scoring
    const vectorScores = new Map<string, number>()
    if (this.embedder && this.vectorIndex.size() > 0) {
      try {
        const qEmbed = await this.embedder.embed(query)
        const hits = this.vectorIndex.search(qEmbed, Math.max(topK * 2, 10), 0)
        for (const h of hits) vectorScores.set(h.id, h.score)
      } catch {
        // Vector search failed — fall back to keyword only
      }
    }

    // Blend
    const allIds = new Set<string>([...keywordScores.keys(), ...vectorScores.keys()])
    const results: KnowledgeSearchResult[] = []
    for (const id of allIds) {
      const entry = this.entries.get(id)
      if (!entry) continue
      const kw = keywordScores.get(id) ?? 0
      const vec = vectorScores.get(id) ?? 0
      // If we have no vectors at all, fall back to keyword only
      const score = vectorScores.size === 0 ? kw : 0.5 * kw + 0.5 * vec
      results.push({ entry, score })
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, topK)
  }

  size(): number {
    return this.entries.size
  }

  isInitialized(): boolean {
    return this.initialized
  }

  private async persist(entry: KnowledgeEntry): Promise<void> {
    await writeFile(
      join(this.dir, `${entry.id}.json`),
      JSON.stringify(entry, null, 2),
      'utf-8',
    )
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2)
}
