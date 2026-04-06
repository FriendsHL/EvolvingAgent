import { readFile, writeFile, readdir, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { Experience } from '../types.js'

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

  /** Mark an experience as referenced (updates health) */
  async markReferenced(id: string): Promise<void> {
    const exp = this.active.get(id) ?? this.stale.get(id)
    if (!exp) return

    exp.health.referencedCount++
    exp.health.lastReferenced = new Date().toISOString()

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

  /** Run periodic health check and pool transitions */
  async maintain(): Promise<{ movedToStale: number; movedToArchive: number }> {
    const now = Date.now()
    let movedToStale = 0
    let movedToArchive = 0

    // Active → Stale: unreferenced for STALE_DAYS
    for (const [id, exp] of this.active) {
      const healthScore = this.computeHealthScore(exp)
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

    // Stale → Archive: unreferenced for ARCHIVE_DAYS
    for (const [id, exp] of this.stale) {
      const healthScore = this.computeHealthScore(exp)
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

  private computeHealthScore(exp: Experience): number {
    const now = Date.now()
    const lastRef = exp.health.lastReferenced
      ? new Date(exp.health.lastReferenced).getTime()
      : new Date(exp.timestamp).getTime()
    const daysSince = (now - lastRef) / (1000 * 60 * 60 * 24)

    const lambda = 0.05
    const recency = Math.exp(-lambda * daysSince) // 14-day half-life
    const frequency = Math.min(1.0, exp.health.referencedCount / 10)
    const quality = exp.admissionScore * (1 - 0.5 * Math.min(1, exp.health.contradictionCount / 3))

    return 0.3 * recency + 0.3 * frequency + 0.4 * quality
  }

  private async evictLowestHealth(
    from: Map<string, Experience>,
    fromDir: string,
    to: Map<string, Experience> | null,
    toDir: string,
  ): Promise<void> {
    let lowestId = ''
    let lowestScore = Infinity

    for (const [id, exp] of from) {
      const score = this.computeHealthScore(exp)
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
