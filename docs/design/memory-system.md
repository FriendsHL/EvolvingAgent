# Memory System Design

> Part of [Evolving Agent Architecture](../ARCHITECTURE.md)

## Three-Tier Knowledge System

```
  ┌─────────────┐  Extract  ┌─────────────┐  Generalize ┌──────────┐
  │  Experience  │ ────────> │   Skill     │ ──────────> │ Knowledge │
  │  (Memory)    │           │  (Pattern)   │             │ (Facts)   │
  │             │           │             │             │           │
  │ Specific    │           │ Reusable    │             │ Universal │
  │ Timestamped │           │ Scored      │             │ Persistent│
  │ JSON files  │           │ JSON files  │             │ MD files  │
  └─────────────┘           └─────────────┘             └──────────┘

  Query Priority (when facing a problem):
  1. Skill Store → Is there a ready-to-use SOP?
  2. Experience Store → Have we seen similar problems?
  3. Knowledge Store → Any relevant general knowledge?
  4. LLM pretrained knowledge → Fallback
```

## Experience (Memory)

Specific, time-bound execution records.

```typescript
interface Experience {
  id: string
  task: string
  steps: ExecutionStep[]
  result: 'success' | 'partial' | 'failure'
  reflection: Reflection
  tags: string[]
  timestamp: string
  embedding?: number[]  // Phase 2

  // Health tracking
  health: {
    referencedCount: number      // Times retrieved
    contradictionCount: number   // Times led to failure when reused
    lastReferenced?: string
  }
}
```

## Memory Anti-Corruption Mechanisms

### 1. Strict Admission (Write-Time Filtering)

Not all executions deserve memory. Reflector scores each candidate across 5 dimensions (0-1):

```
  Admission Score Formula:
  score = 0.25 * novelty
        + 0.25 * lesson_value
        + 0.20 * reusability
        + 0.15 * user_signal
        + 0.15 * complexity

  ┌──────────────┬──────────────────────────────────────────────┐
  │ Dimension     │ Scoring Criteria                             │
  ├──────────────┼──────────────────────────────────────────────┤
  │ novelty       │ 1.0: never seen before                      │
  │               │ 0.5: similar exists but different approach   │
  │               │ 0.0: near-duplicate of existing experience  │
  ├──────────────┼──────────────────────────────────────────────┤
  │ lesson_value  │ 1.0: failure with clear root cause          │
  │               │ 0.7: success with non-obvious strategy      │
  │               │ 0.3: success with standard approach         │
  │               │ 0.0: simple query, no learning              │
  ├──────────────┼──────────────────────────────────────────────┤
  │ reusability   │ 1.0: likely to recur (common task type)     │
  │               │ 0.5: might recur in similar context         │
  │               │ 0.0: one-off, environment-specific          │
  ├──────────────┼──────────────────────────────────────────────┤
  │ user_signal   │ 1.0: user explicitly said "remember this"  │
  │               │ 0.5: user corrected agent (implicit signal) │
  │               │ 0.0: no user feedback                       │
  ├──────────────┼──────────────────────────────────────────────┤
  │ complexity    │ 1.0: multi-step, multi-tool execution       │
  │               │ 0.5: moderate (2-3 steps)                   │
  │               │ 0.0: single tool call                       │
  └──────────────┴──────────────────────────────────────────────┘

  Thresholds:
  • score < 0.4  → discard (not worth storing)
  • score 0.4-0.6 → store as low-confidence
  • score > 0.6  → store as high-confidence
```

Auto-skip (bypass scoring): simple queries, cancelled tasks, exact duplicate (similarity > 0.9).

### 2. Deduplication

Before storing, check similarity against existing Active Pool:

```
  similarity > 0.9  → skip (near-duplicate, only update reference count)
  similarity 0.7-0.9 → merge (combine insights into existing experience)
  similarity < 0.7  → new entry
```

### 3. Three-Pool Management

```
  ┌───────────────────────────────────────────────────────────────┐
  │  Active Pool       │  Stale Pool      │  Archive              │
  │  (hot, searchable) │  (cooling off)   │  (no search, on disk) │
  │  ←── 200 cap ─────>│←── 100 cap ─────>│  (unlimited)          │
  └───────────────────────────────────────────────────────────────┘

  Health Score (per experience):
  health = 0.3 * recency + 0.3 * frequency + 0.4 * quality

  Where:
  • recency   = e^(-λ * days_since_last_reference)   λ=0.05 (14-day half-life)
  • frequency = min(1.0, referencedCount / 10)
  • quality   = admission_score * (1 - 0.5 * min(1, contradictionCount / 3))

  Pool Transitions (periodic cleanup — weekly or every 100 tasks):
  • Active → Stale:   health < 0.2 OR 30 days unreferenced
  • Stale → Archive:  health < 0.1 OR 60 days unreferenced
  • Stale → Active:   re-referenced (health recalculated on access)

  Overflow Strategy:
  • Active Pool full (>200): evict lowest health to Stale
  • Stale Pool full (>100):  evict lowest health to Archive
  • Archive: filesystem only, no memory footprint
```

### 4. Contradiction Detection

```
  Experience referenced → execution fails
    │
    ▼
  contradictionCount++
    │
    ├── count >= 2 → quality decays 50%
    └── count >= 3 → auto-archive as "disproven"
```

### 5. Memory Compaction

When 5+ experiences share similar tags/patterns, trigger LLM-based compaction:

```
  5 similar Kafka debugging experiences
    │
    ▼
  LLM summary → 1 consolidated experience
  + Skill candidate extraction
    │
    ▼
  Original 5 → archived (linked to consolidated)
  Consolidated → Active Pool
```

## Memory Retrieval — Hybrid Search

```
  Query: "上次处理 npm install 报错的经验"
    │
    ├──① 关键词检索 (BM25 / inverted index)
    │   匹配: "npm install", "报错"
    │   → 精确匹配，召回率低但准确
    │
    ├──② 向量语义检索 (Embedding + cosine similarity)
    │   匹配: "依赖安装失败的排查流程"（语义相近但无关键词重叠）
    │   → 泛化能力强，但可能漂移
    │
    ├──③ Skill 标签匹配 (structured filtering)
    │   匹配: tags = ["npm", "dependency", "error-handling"]
    │   → 快速缩小范围
    │
    └──④ RRF Fusion Ranking (Reciprocal Rank Fusion)
        score = Σ 1/(k + rank_i)    k=60
        → 合并三路结果，重排序，取 Top-N
```

**Why RRF over MMR?**
RRF solves "how to merge multiple ranked lists" (fusion). MMR solves "how to diversify a single result set" (de-duplication). They are complementary — Phase 1 uses RRF only (200 entries, low redundancy risk), Phase 2+ adds MMR re-ranking on top when memory grows large enough.

### Retrieval Interface

```typescript
interface RetrievalQuery {
  text: string                          // User query text
  tags?: string[]                       // Optional tag filter
  pool?: 'active' | 'stale' | 'all'    // Search scope
  topK?: number                         // Default 5
  minScore?: number                     // Min relevance threshold, default 0.3
}

interface RetrievalResult {
  id: string
  type: 'experience' | 'skill' | 'knowledge'
  content: string
  score: number                         // RRF fusion score
  matchSource: ('keyword' | 'semantic' | 'tag')[]
}

interface MemoryRetriever {
  search(query: RetrievalQuery): Promise<RetrievalResult[]>
}
```

### Embedding Strategy

```
  Phase 1: Python CLI pipe mode
  ┌──────────────┐    stdin (JSON)     ┌─────────────────────┐
  │  TS Agent     │ ──────────────────> │  python -m           │
  │  (core)       │                     │  evolving_ai.embed   │
  │               │ <────────────────── │                      │
  └──────────────┘    stdout (JSON)     └─────────────────────┘

  Model: sentence-transformers/all-MiniLM-L6-v2 (384-dim, local, free)
  Upgrade path: text-embedding-3-small (OpenAI) or nomic-embed-text (768-dim)
```

## Memory Storage — Phased Strategy

```
  Phase 1: JSON files + in-memory index
  ═══════════════════════════════════════
  data/memory/
  ├── experiences/          # One JSON file per experience
  │   ├── exp-001.json     # { content, tags, embedding, health }
  │   └── exp-002.json
  ├── skills/
  ├── knowledge/
  └── index.json           # Loaded at startup: inverted index + embedding matrix

  • Keyword search: in-memory inverted index (Map<token, Set<docId>>)
  • Vector search: brute-force cosine similarity (200 × 384-dim < 1ms)
  • Pros: zero dependency, debuggable (plain files), sufficient for <1000 entries

  Phase 2: SQLite + sqlite-vss (single file DB)
  ═══════════════════════════════════════════════
  data/evolving.db

  CREATE TABLE experiences (
    id TEXT PRIMARY KEY,
    content TEXT,
    tags TEXT,              -- JSON array
    embedding BLOB,         -- float32 array
    health_score REAL,
    created_at TEXT,
    updated_at TEXT
  );
  CREATE VIRTUAL TABLE experiences_fts USING fts5(content, tags);
  CREATE VIRTUAL TABLE experiences_vss USING vss0(embedding(384));

  • Keyword search: FTS5 (BM25 ranking)
  • Vector search: sqlite-vss (ANN search)
  • Fusion: TS layer does RRF
  • Migration: JSON → SQLite via migrate script

  Phase 3+: PostgreSQL + pgvector (only if needed)
  ═════════════════════════════════════════════════
  Trigger: data > 50K entries OR multi-agent concurrent writes
  • Keyword: tsvector
  • Vector: pgvector
  • Full hybrid: SQL-level fusion possible
```

**Why NOT Elasticsearch?** Single-user local Agent — ES requires JVM, cluster ops, heavy resources. Overkill for <50K memory entries.

**Why NOT ChromaDB/LanceDB?** ChromaDB = Python-only (extra process). LanceDB = weak full-text search (no BM25). SQLite FTS5 + sqlite-vss is more complete for hybrid retrieval.

### Storage Summary

| Phase | Storage | Keyword Search | Vector Search | Embedding Model | Data Capacity |
|-------|---------|---------------|---------------|-----------------|---------------|
| 1 | JSON files | In-memory inverted index | Brute-force cosine | MiniLM-L6-v2 (384d) | < 1,000 |
| 2 | SQLite | FTS5 (BM25) | sqlite-vss (ANN) | Same or upgrade | < 50,000 |
| 3+ | PostgreSQL | tsvector | pgvector | OpenAI/Nomic | Unlimited |

## Memory CLI Commands

```bash
$ evolve memory list                    # Show active pool
$ evolve memory search "npm error"      # Hybrid search
$ evolve memory inspect <id>            # View details + health
$ evolve memory archive <id>            # Manual archive
$ evolve memory compact                 # Trigger compaction
$ evolve memory stats                   # Pool sizes, health distribution
```

## Skill Health

```
  score = success_count / total_usage_count

  score > 0.8   → Healthy, prioritized
  score 0.5-0.8 → Usable, ask user confirmation
  score < 0.5   → Disabled, trigger re-evaluation
  3 consecutive failures → Frozen, await repair or archive
```

## Knowledge (Generalized Facts)

Universal, time-independent information distilled from multiple experiences:
- Stored as `data/knowledge/*.md`
- Example: `kafka-troubleshooting.md` aggregated from multiple Kafka debugging experiences
- Phase 2+: generated automatically when Agent detects clusters of related skills

## Future Enhancements (Decided to Defer)

| Phase | Enhancement | Trigger Condition |
|-------|------------|-------------------|
| Phase 2 | MMR diversity re-ranking | Memory > 500, Top-K results show high redundancy |
| Phase 2 | Query Expansion (LLM rewrites query) | Single-pass recall rate insufficient |
| Phase 3 | Time-weighted retrieval (recent experiences boosted) | Need to distinguish old vs new experience priority |
| Phase 3 | Contextual retrieval (inject current task context) | Multi-turn tasks suffer from retrieval drift |
