import { mkdir, appendFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Single retrieval hit record. Written JSONL, one line per hit.
 *
 * Shape is deliberately minimal — everything the six-signal scoring
 * upgrade (S0) needs, nothing it doesn't. Query + similarity come
 * straight from the retriever's own call stack so downstream sweeps can
 * recompute distinctQueries / distinctDays / totalRelevance from
 * primary evidence rather than a secondary counter.
 */
export interface RecallLogEntry {
  experienceId: string
  query: string
  /** Cosine similarity at time of hit, 0..1 (clamped). */
  similarity: number
  /** ISO-8601 timestamp. The date portion decides the file bucket. */
  timestamp: string
  /** Optional — unknown in code paths that don't carry a session. */
  sessionId?: string
}

/**
 * Thin JSONL appender for retrieval events.
 *
 * On-disk layout matches `metrics/collector.ts`:
 *   <dataPath>/memory/recall-log/YYYY-MM-DD.jsonl
 *
 * Writes are fire-and-forget `appendFile` — ordering within a day is
 * best-effort (good enough for distinct-day / distinct-query rollups).
 * Reads swallow missing-file errors (empty list) and skip malformed
 * JSON lines so a single corrupt write can't crash a pool sweep.
 */
export class RecallLog {
  private logDir: string

  constructor(dataPath: string) {
    this.logDir = join(dataPath, 'memory', 'recall-log')
  }

  async init(): Promise<void> {
    await mkdir(this.logDir, { recursive: true })
  }

  async append(entry: RecallLogEntry): Promise<void> {
    const date = entry.timestamp.slice(0, 10) // YYYY-MM-DD
    const filePath = join(this.logDir, `${date}.jsonl`)
    await appendFile(filePath, JSON.stringify(entry) + '\n', 'utf-8')
  }

  /**
   * Return every entry whose date-bucket falls inside the inclusive
   * window `[today - days + 1, today]`, in time-ascending order.
   *
   * `days=1` ⇒ only today. `days=14` ⇒ the trailing fortnight (the
   * value the health-scoring sweep uses).
   */
  async readRecent(days: number): Promise<RecallLogEntry[]> {
    if (days <= 0) return []

    const now = new Date()
    const windowStart = new Date(now)
    windowStart.setUTCDate(windowStart.getUTCDate() - (days - 1))

    const startDate = toDateKey(windowStart)
    const endDate = toDateKey(now)

    let files: string[]
    try {
      files = await readdir(this.logDir)
    } catch {
      return []
    }

    const entries: RecallLogEntry[] = []
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const date = file.slice(0, -'.jsonl'.length)
      if (date < startDate || date > endDate) continue

      let content: string
      try {
        content = await readFile(join(this.logDir, file), 'utf-8')
      } catch {
        continue
      }

      for (const line of content.split('\n')) {
        if (!line) continue
        try {
          entries.push(JSON.parse(line) as RecallLogEntry)
        } catch {
          // Skip malformed line — a half-written tail must not crash
          // the sweep that reads this file.
        }
      }
    }

    entries.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0))
    return entries
  }
}

function toDateKey(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
