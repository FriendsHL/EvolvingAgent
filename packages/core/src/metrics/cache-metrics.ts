import { mkdir, appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * One row per LLM call. The JSONL file at
 * `data/metrics/cache-calls-YYYY-MM-DD.jsonl` contains one of these per line.
 *
 * Schema is intentionally flat + stable so the cache-health alert cron hook
 * (Phase 3 Batch 4 task C) can stream it without re-reading the source.
 */
export interface CacheCallRecord {
  /** Unix epoch milliseconds. */
  ts: number
  sessionId: string
  /** Main-agent task id (one per user message). */
  taskId?: string
  /** Sub-agent task id when the call was issued from a SubAgent wrapper. */
  subAgentTaskId?: string
  model: string
  /** 'anthropic' | 'openai' | 'openai-compatible' | 'bailian' | 'deepseek' */
  provider: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  latencyMs: number
}

export interface CacheAggregate {
  totalCalls: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheCreationTokens: number
  totalCacheReadTokens: number
  /** Weighted: totalCacheRead / (totalCacheRead + totalInput). */
  hitRatio: number
  avgLatencyMs: number
  windowStart: number
  windowEnd: number
}

const EMPTY_AGGREGATE: CacheAggregate = {
  totalCalls: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheCreationTokens: 0,
  totalCacheReadTokens: 0,
  hitRatio: 0,
  avgLatencyMs: 0,
  windowStart: 0,
  windowEnd: 0,
}

const DEFAULT_RING_SIZE = 1000
const FLUSH_EVERY_N_CALLS = 10
const FLUSH_INTERVAL_MS = 5_000

/**
 * CacheMetricsRecorder — records per-LLM-call cache stats to JSONL and keeps
 * lightweight in-memory aggregates for task/session/day windows.
 *
 * Writes are buffered: whichever comes first of 10 queued records or 5s
 * wall-clock triggers a flush. `shutdown()` flushes any trailing buffer.
 *
 * Storage layout under `<dataPath>/metrics/`:
 *   cache-calls-YYYY-MM-DD.jsonl   — one CacheCallRecord per line
 *   cache-daily-summary.json       — { "YYYY-MM-DD": CacheAggregate }
 */
export class CacheMetricsRecorder {
  private metricsDir: string
  private dailySummaryPath: string

  /** Ring buffer of the most recent calls for the getRecentCalls API. */
  private ring: CacheCallRecord[] = []
  private ringSize: number
  private ringHead = 0
  private ringCount = 0

  /** Pending writes not yet flushed to the JSONL file. */
  private pendingWrites: CacheCallRecord[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private flushing: Promise<void> | null = null
  private initialized = false

  /** Daily aggregates, keyed by YYYY-MM-DD. Persisted to cache-daily-summary.json. */
  private dailySummary = new Map<string, CacheAggregate>()

  constructor(dataPath: string, options: { ringSize?: number } = {}) {
    this.metricsDir = join(dataPath, 'metrics')
    this.dailySummaryPath = join(this.metricsDir, 'cache-daily-summary.json')
    this.ringSize = options.ringSize ?? DEFAULT_RING_SIZE
    this.ring = new Array<CacheCallRecord>(this.ringSize)
  }

  async init(): Promise<void> {
    if (this.initialized) return
    await mkdir(this.metricsDir, { recursive: true })
    await this.loadDailySummary()
    this.initialized = true
  }

  /**
   * Record one LLM call. Synchronous — the buffered JSONL write happens on
   * the next flush. Safe to call from inside a hook without awaiting.
   */
  record(call: CacheCallRecord): void {
    // Ring buffer.
    this.ring[this.ringHead] = call
    this.ringHead = (this.ringHead + 1) % this.ringSize
    if (this.ringCount < this.ringSize) this.ringCount += 1

    // Update in-memory daily summary.
    const day = isoDate(call.ts)
    const prev = this.dailySummary.get(day) ?? { ...EMPTY_AGGREGATE, windowStart: call.ts, windowEnd: call.ts }
    this.dailySummary.set(day, mergeInto(prev, call))

    // Pending JSONL buffer.
    this.pendingWrites.push(call)
    if (this.pendingWrites.length >= FLUSH_EVERY_N_CALLS) {
      void this.flush()
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        void this.flush()
      }, FLUSH_INTERVAL_MS)
      // Don't hold the event loop open for a flush timer.
      if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref()
    }
  }

  /** Aggregate every record in the ring buffer matching sessionId. */
  aggregateBySession(sessionId: string): CacheAggregate {
    return this.aggregateRing((r) => r.sessionId === sessionId)
  }

  aggregateByTask(taskId: string): CacheAggregate {
    return this.aggregateRing((r) => r.taskId === taskId || r.subAgentTaskId === taskId)
  }

  aggregateByDay(date: string): CacheAggregate {
    const fromDaily = this.dailySummary.get(date)
    if (fromDaily) return { ...fromDaily }
    return { ...EMPTY_AGGREGATE }
  }

  aggregateRecent(windowMs: number): CacheAggregate {
    const cutoff = Date.now() - windowMs
    return this.aggregateRing((r) => r.ts >= cutoff)
  }

  /** Most recent N calls from the ring buffer (newest first). */
  getRecentCalls(limit: number): CacheCallRecord[] {
    const out: CacheCallRecord[] = []
    const max = Math.min(limit, this.ringCount)
    for (let i = 0; i < max; i++) {
      // ringHead points at next write slot; most recent is (ringHead - 1 - i).
      const idx = (this.ringHead - 1 - i + this.ringSize) % this.ringSize
      const rec = this.ring[idx]
      if (rec) out.push(rec)
    }
    return out
  }

  /** Force-write any buffered records to disk. Safe to call concurrently. */
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.pendingWrites.length === 0 && !this.initialized) return

    this.flushing = this.doFlush().finally(() => {
      this.flushing = null
    })
    return this.flushing
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    await this.flush()
  }

  // ============================================================
  // Internals
  // ============================================================

  private async doFlush(): Promise<void> {
    if (!this.initialized) {
      await mkdir(this.metricsDir, { recursive: true })
      this.initialized = true
    }

    const toWrite = this.pendingWrites
    this.pendingWrites = []

    if (toWrite.length > 0) {
      // Group by day so each record lands in the right JSONL file even if the
      // flush straddles a UTC-day boundary.
      const byDay = new Map<string, string[]>()
      for (const rec of toWrite) {
        const day = isoDate(rec.ts)
        const lines = byDay.get(day) ?? []
        lines.push(JSON.stringify(rec))
        byDay.set(day, lines)
      }
      for (const [day, lines] of byDay) {
        const filePath = join(this.metricsDir, `cache-calls-${day}.jsonl`)
        await appendFile(filePath, lines.join('\n') + '\n', 'utf-8')
      }
    }

    // Always persist the daily summary on every flush (cheap, one small file).
    await this.persistDailySummary()
  }

  private aggregateRing(predicate: (r: CacheCallRecord) => boolean): CacheAggregate {
    const agg: CacheAggregate = { ...EMPTY_AGGREGATE }
    let latencySum = 0
    let matches = 0
    for (let i = 0; i < this.ringCount; i++) {
      const rec = this.ring[i]
      if (!rec) continue
      if (!predicate(rec)) continue
      matches += 1
      agg.totalCalls += 1
      agg.totalInputTokens += rec.inputTokens
      agg.totalOutputTokens += rec.outputTokens
      agg.totalCacheCreationTokens += rec.cacheCreationTokens
      agg.totalCacheReadTokens += rec.cacheReadTokens
      latencySum += rec.latencyMs
      if (agg.windowStart === 0 || rec.ts < agg.windowStart) agg.windowStart = rec.ts
      if (rec.ts > agg.windowEnd) agg.windowEnd = rec.ts
    }
    if (matches > 0) {
      agg.avgLatencyMs = latencySum / matches
      const denom = agg.totalCacheReadTokens + agg.totalInputTokens
      agg.hitRatio = denom > 0 ? agg.totalCacheReadTokens / denom : 0
    }
    return agg
  }

  private async loadDailySummary(): Promise<void> {
    try {
      const raw = await readFile(this.dailySummaryPath, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, CacheAggregate>
      this.dailySummary = new Map(Object.entries(parsed))
    } catch {
      // Missing/corrupt — start fresh.
      this.dailySummary = new Map()
    }
  }

  private async persistDailySummary(): Promise<void> {
    const obj: Record<string, CacheAggregate> = {}
    for (const [k, v] of this.dailySummary) obj[k] = v
    await writeFile(this.dailySummaryPath, JSON.stringify(obj, null, 2), 'utf-8')
  }
}

// ============================================================
// Helpers
// ============================================================

function isoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

/** Fold a single call into an aggregate, updating weighted fields in place. */
function mergeInto(prev: CacheAggregate, call: CacheCallRecord): CacheAggregate {
  const nextCalls = prev.totalCalls + 1
  const nextInput = prev.totalInputTokens + call.inputTokens
  const nextOutput = prev.totalOutputTokens + call.outputTokens
  const nextCacheCreate = prev.totalCacheCreationTokens + call.cacheCreationTokens
  const nextCacheRead = prev.totalCacheReadTokens + call.cacheReadTokens
  const nextAvgLatency =
    (prev.avgLatencyMs * prev.totalCalls + call.latencyMs) / nextCalls
  const denom = nextCacheRead + nextInput
  return {
    totalCalls: nextCalls,
    totalInputTokens: nextInput,
    totalOutputTokens: nextOutput,
    totalCacheCreationTokens: nextCacheCreate,
    totalCacheReadTokens: nextCacheRead,
    hitRatio: denom > 0 ? nextCacheRead / denom : 0,
    avgLatencyMs: nextAvgLatency,
    windowStart: prev.windowStart === 0 ? call.ts : Math.min(prev.windowStart, call.ts),
    windowEnd: Math.max(prev.windowEnd, call.ts),
  }
}
