import { readFile, writeFile, readdir, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { Experience } from '../types.js'
import type { RecallLog } from './recall-log.js'

const ACTIVE_CAP = 200
const STALE_CAP = 100
const STALE_DAYS = 30
const ARCHIVE_DAYS = 60

/**
 * Experience Store — JSON file-based persistence.
 *
 * Three pools:
 *   Active  (data/memory/experiences/)  — cap 200
 *   Stale   (data/memory/stale/)        — cap 100
 *   Archive (data/memory/archive/)      — unlimited
 */
export class ExperienceStore {
  private basePath: string
  private activePath: string
  private stalePath: string
  private archivePath: string

  // In-memory cache
  private active = new Map<string, Experience>()
  private stale = new Map<string, Experience>()

  constructor(basePath: string) {
    this.basePath = basePath
    this.activePath = join(basePath, 'experiences')
    this.stalePath = join(basePath, 'stale')
    this.archivePath = join(basePath, 'archive')
  }

  async init(): Promise<void> {
    await mkdir(this.activePath, { recursive: true })
    await mkdir(this.stalePath, { recursive: true })
    await mkdir(this.archivePath, { recursive: true })

    // Load active + stale into memory
    this.active = await this.loadPool(this.activePath)
    this.stale = await this.loadPool(this.stalePath)
  }

  private async loadPool(dir: string): Promise<Map<string, Experience>> {
    const pool = new Map<string, Experience>()
    try {
      const files = await readdir(dir)
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        try {
          const data = await readFile(join(dir, file), 'utf-8')
          const exp = JSON.parse(data) as Experience
          pool.set(exp.id, exp)
        } catch {
          // Skip corrupted files
        }
      }
    } catch {
      // Directory may not exist yet
    }
    return pool
  }

  async save(experience: Experience): Promise<void> {
    this.active.set(experience.id, experience)
    await writeFile(
      join(this.activePath, `${experience.id}.json`),
      JSON.stringify(experience, null, 2),
      'utf-8',
    )

    // Enforce cap
    if (this.active.size > ACTIVE_CAP) {
      await this.evictLowestHealth(this.active, this.activePath, this.stale, this.stalePath)
    }
    if (this.stale.size > STALE_CAP) {
      await this.evictLowestHealth(this.stale, this.stalePath, null, this.archivePath)
    }
  }

  get(id: string): Experience | undefined {
    return this.active.get(id) ?? this.stale.get(id)
  }

  /**
   * Locate which pool currently holds an experience id.
   * Checks in-memory active/stale first, then falls back to the on-disk archive.
   */
  async findPool(id: string): Promise<'active' | 'stale' | 'archive' | null> {
    if (this.active.has(id)) return 'active'
    if (this.stale.has(id)) return 'stale'
    try {
      const files = await readdir(this.archivePath)
      if (files.includes(`${id}.json`)) return 'archive'
    } catch {
      /* archive dir missing */
    }
    return null
  }

  /**
   * Update an experience in place in whichever pool currently holds it.
   * Unlike save(), this does NOT move the experience back to the active pool,
   * and does NOT trigger cap-based eviction. Used for lightweight mutations
   * like recording user feedback.
   */
  async updateInPlace(experience: Experience): Promise<boolean> {
    const pool = await this.findPool(experience.id)
    if (!pool) return false

    let dir: string
    if (pool === 'active') {
      this.active.set(experience.id, experience)
      dir = this.activePath
    } else if (pool === 'stale') {
      this.stale.set(experience.id, experience)
      dir = this.stalePath
    } else {
      dir = this.archivePath
    }

    await writeFile(
      join(dir, `${experience.id}.json`),
      JSON.stringify(experience, null, 2),
      'utf-8',
    )
    return true
  }

  /** Fetch an experience by id, looking in active, stale, and archive pools. */
  async getAnyPool(id: string): Promise<Experience | undefined> {
    const hot = this.get(id)
    if (hot) return hot
    try {
      const data = await readFile(join(this.archivePath, `${id}.json`), 'utf-8')
      return JSON.parse(data) as Experience
    } catch {
      return undefined
    }
  }

  getAll(pool: 'active' | 'stale' | 'all' = 'active'): Experience[] {
    if (pool === 'active') return [...this.active.values()]
    if (pool === 'stale') return [...this.stale.values()]
    return [...this.active.values(), ...this.stale.values()]
  }

  getAllTasks(): string[] {
    return this.getAll('all').map((e) => e.task)
  }

  /**
   * Mark an experience as referenced (updates health).
   *
   * @param similarity optional cosine similarity [0..1] at the time of the
   *   hit. When provided (S0+), it's added to `health.totalRelevance` so
   *   the six-signal scoring can compute `avgRelevance = totalRelevance /
   *   referencedCount`. Keyword/tag-only hits pass 0 (or omit it), which
   *   correctly pulls the average down.
   */
  async markReferenced(id: string, similarity = 0): Promise<void> {
    const exp = this.active.get(id) ?? this.stale.get(id)
    if (!exp) return

    exp.health.referencedCount++
    exp.health.lastReferenced = new Date().toISOString()
    exp.health.totalRelevance = (exp.health.totalRelevance ?? 0) + similarity

    // If in stale pool, promote back to active
    if (this.stale.has(id)) {
      this.stale.delete(id)
      this.active.set(id, exp)
      // Move file
      try {
        await rename(join(this.stalePath, `${id}.json`), join(this.activePath, `${id}.json`))
      } catch {
        // File might not exist
      }
    }

    await writeFile(
      join(this.activePath, `${exp.id}.json`),
      JSON.stringify(exp, null, 2),
      'utf-8',
    )
  }

  /**
   * Run periodic health check and pool transitions.
   *
   * S0: before computing the six-signal health score, we refresh each
   * experience's `distinctQueries` / `distinctDays` / `totalRelevance`
   * from the trailing 14 days of the recall log (if one is wired in).
   * This keeps the consolidation and diversity signals in sync with
   * primary evidence and lets `totalRelevance` survive process restarts
   * even if a session crashed between `markReferenced` and flush.
   */
  async maintain(recallLog?: RecallLog): Promise<{ movedToStale: number; movedToArchive: number }> {
    const now = Date.now()
    let movedToStale = 0
    let movedToArchive = 0

    // Refresh consolidation fields from the recall log window before scoring.
    if (recallLog) {
      for (const exp of this.active.values()) {
        await this.refreshConsolidationFields(exp, recallLog)
      }
      for (const exp of this.stale.values()) {
        await this.refreshConsolidationFields(exp, recallLog)
      }
    }

    // Snapshot the stale pool as of sweep start. Without this, an
    // experience freshly demoted Active→Stale in the first loop below
    // would immediately be re-examined in the Stale→Archive loop and —
    // under the six-signal formula, where an unreferenced low-metadata
    // memory scores well below 0.1 — get hurled straight into archive
    // in the same sweep. Callers rely on one step of motion per sweep.
    const preexistingStaleIds = new Set(this.stale.keys())

    const maxRefActive = maxReferencedCount(this.active)

    // Active → Stale: unreferenced for STALE_DAYS
    for (const [id, exp] of this.active) {
      const healthScore = this.computeHealthScore(exp, maxRefActive)
      const daysSinceRef = exp.health.lastReferenced
        ? (now - new Date(exp.health.lastReferenced).getTime()) / (1000 * 60 * 60 * 24)
        : (now - new Date(exp.timestamp).getTime()) / (1000 * 60 * 60 * 24)

      if (healthScore < 0.2 || daysSinceRef > STALE_DAYS) {
        this.active.delete(id)
        this.stale.set(id, exp)
        try {
          await rename(join(this.activePath, `${id}.json`), join(this.stalePath, `${id}.json`))
        } catch {
          // Write to stale directly
          await writeFile(join(this.stalePath, `${id}.json`), JSON.stringify(exp, null, 2), 'utf-8')
        }
        movedToStale++
      }
    }

    const maxRefStale = maxReferencedCount(this.stale)

    // Stale → Archive: unreferenced for ARCHIVE_DAYS. Only examine
    // experiences that were already stale at sweep start — see the
    // snapshot comment above.
    for (const [id, exp] of this.stale) {
      if (!preexistingStaleIds.has(id)) continue
      const healthScore = this.computeHealthScore(exp, maxRefStale)
      const daysSinceRef = exp.health.lastReferenced
        ? (now - new Date(exp.health.lastReferenced).getTime()) / (1000 * 60 * 60 * 24)
        : (now - new Date(exp.timestamp).getTime()) / (1000 * 60 * 60 * 24)

      if (healthScore < 0.1 || daysSinceRef > ARCHIVE_DAYS) {
        this.stale.delete(id)
        try {
          await rename(join(this.stalePath, `${id}.json`), join(this.archivePath, `${id}.json`))
        } catch {
          await writeFile(join(this.archivePath, `${id}.json`), JSON.stringify(exp, null, 2), 'utf-8')
        }
        movedToArchive++
      }
    }

    return { movedToStale, movedToArchive }
  }

  /**
   * Rebuild `distinctQueries` / `distinctDays` / `totalRelevance` from the
   * trailing 14 days of the recall log for a single experience. Cheap per
   * experience (filters the already-loaded window) and keeps the sweep
   * self-healing if entries were dropped due to a mid-write crash.
   */
  private async refreshConsolidationFields(exp: Experience, recallLog: RecallLog): Promise<void> {
    const window = await recallLog.readRecent(14)
    const mine = window.filter((e) => e.experienceId === exp.id)
    if (mine.length === 0) return

    const queries = new Set<string>()
    const days = new Set<string>()
    let totalRelevance = 0
    for (const e of mine) {
      queries.add(e.query)
      days.add(e.timestamp.slice(0, 10))
      totalRelevance += e.similarity
    }

    exp.health.distinctQueries = queries.size
    exp.health.distinctDays = days.size
    // Prefer the recall-log sum when it's larger — the in-memory counter
    // may have been reset across restarts. A smaller window sum should
    // not erase a legitimately higher counter, so we take the max.
    exp.health.totalRelevance = Math.max(exp.health.totalRelevance ?? 0, totalRelevance)
  }

  // === Introspection API (for web dashboard) ===

  async getArchive(): Promise<Experience[]> {
    const pool = await this.loadPool(this.archivePath)
    return [...pool.values()]
  }

  async getPoolStats(): Promise<{ active: number; stale: number; archive: number }> {
    const archiveFiles = await readdir(this.archivePath).catch(() => [])
    return {
      active: this.active.size,
      stale: this.stale.size,
      archive: archiveFiles.filter((f) => f.endsWith('.json')).length,
    }
  }

  /**
   * S0: six-signal health score in `[0, 1]`.
   *
   * The former 3-signal formula (`0.3*recency + 0.3*frequency + 0.4*quality`)
   * saturated after ~10 hits, so every battle-tested memory looked
   * identical to a one-off one. The new formula blends:
   *
   *   frequency           0.24   log-scale vs pool max (no saturation)
   *   relevance           0.30   avg cosine similarity of hits
   *   diversity           0.15   distinct queries, capped at 10
   *   recency             0.15   existing 14-day half-life (kept)
   *   consolidation       0.10   distinct days the memory was hit on
   *   conceptualRichness  0.06   admission-time density signal
   *
   * All new `ExperienceHealth` fields are optional; `undefined` degrades
   * to `0`, so old persisted experiences score gracefully without a
   * migration. `maxRef` is the largest `referencedCount` in the pool
   * being scored — passed in by the caller so a single sweep computes it
   * once instead of O(n) per scoring call. Defaults to `0`, in which
   * case log-scale frequency degenerates to 1 for any hit count (fine
   * for the single-element edge case).
   */
  /**
   * Public accessor for the six-signal health score. Wraps the private
   * implementation so tests and web dashboards can reason about scoring
   * without reaching into the class. When `maxRef` is omitted, defaults
   * to the max `referencedCount` across the active pool (the usual
   * reference point for "how hot is this relative to everyone else").
   */
  scoreHealth(exp: Experience, maxRef?: number): number {
    const effectiveMax = maxRef ?? maxReferencedCount(this.active)
    return this.computeHealthScore(exp, effectiveMax)
  }

  private computeHealthScore(exp: Experience, maxRef = 0): number {
    const now = Date.now()
    const lastRef = exp.health.lastReferenced
      ? new Date(exp.health.lastReferenced).getTime()
      : new Date(exp.timestamp).getTime()
    const daysSince = (now - lastRef) / (1000 * 60 * 60 * 24)

    const refCount = exp.health.referencedCount
    const frequency = logScaleFrequency(refCount, maxRef)

    const totalRelevance = exp.health.totalRelevance ?? 0
    const relevanceRaw = refCount > 0 ? totalRelevance / refCount : 0
    const relevance = clamp01(relevanceRaw)

    const distinctQueries = exp.health.distinctQueries ?? 0
    const diversity = Math.min(1, distinctQueries / 10)

    const recency = Math.exp(-0.05 * daysSince) // 14-day half-life

    const distinctDays = exp.health.distinctDays ?? 0
    const consolidation = Math.min(1, distinctDays / 10)

    const conceptualRichness = clamp01(exp.health.conceptualRichness ?? 0)

    const score =
      0.24 * frequency +
      0.30 * relevance +
      0.15 * diversity +
      0.15 * recency +
      0.10 * consolidation +
      0.06 * conceptualRichness

    return clamp01(score)
  }

  private async evictLowestHealth(
    from: Map<string, Experience>,
    fromDir: string,
    to: Map<string, Experience> | null,
    toDir: string,
  ): Promise<void> {
    let lowestId = ''
    let lowestScore = Infinity

    const maxRef = maxReferencedCount(from)

    for (const [id, exp] of from) {
      const score = this.computeHealthScore(exp, maxRef)
      if (score < lowestScore) {
        lowestScore = score
        lowestId = id
      }
    }

    if (!lowestId) return

    const exp = from.get(lowestId)!
    from.delete(lowestId)
    if (to) to.set(lowestId, exp)

    try {
      await rename(join(fromDir, `${lowestId}.json`), join(toDir, `${lowestId}.json`))
    } catch {
      await writeFile(join(toDir, `${lowestId}.json`), JSON.stringify(exp, null, 2), 'utf-8')
    }
  }
}

/**
 * Log-scale frequency: `log1p(count) / log1p(max(count, maxRef, 1))`.
 * Returns a value in `[0, 1]`. When `count === maxRef` (the pool's most-
 * referenced experience) the term is 1; a one-off hit with `maxRef=100`
 * lands near `log(2)/log(101) ≈ 0.15`. Degenerates to 1 if `maxRef=0`.
 */
function logScaleFrequency(count: number, maxRef: number): number {
  const n = Math.max(0, count)
  const denom = Math.log1p(Math.max(n, maxRef, 1))
  if (denom === 0) return 0
  return Math.log1p(n) / denom
}

function maxReferencedCount(pool: Map<string, Experience>): number {
  let max = 0
  for (const exp of pool.values()) {
    if (exp.health.referencedCount > max) max = exp.health.referencedCount
  }
  return max
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}
