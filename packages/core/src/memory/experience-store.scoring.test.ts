import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ExperienceStore,
  computeHealthScoreForTest,
  refreshConsolidationFields,
} from './experience-store.js'
import { RecallLog, type RecallLogEntry } from './recall-log.js'
import type { Experience, ExperienceHealth } from '../types.js'

function makeExperience(
  id: string,
  health: Partial<ExperienceHealth>,
  opts: {
    admissionScore?: number
    daysOld?: number
    conceptualRichness?: number
  } = {},
): Experience {
  const now = Date.now()
  const daysOld = opts.daysOld ?? 0
  const timestamp = new Date(now - daysOld * 24 * 60 * 60 * 1000).toISOString()
  return {
    id,
    task: `task ${id}`,
    steps: [],
    result: 'success',
    reflection: { whatWorked: ['ok'], whatFailed: [], lesson: 'l' },
    tags: ['test'],
    timestamp,
    health: {
      referencedCount: 0,
      contradictionCount: 0,
      lastReferenced: timestamp,
      ...health,
      ...(opts.conceptualRichness !== undefined
        ? { conceptualRichness: opts.conceptualRichness }
        : {}),
    },
    admissionScore: opts.admissionScore ?? 0.7,
  }
}

describe('computeHealthScoreForTest — six-signal formula + quality gate', () => {
  it('ranks the stable multi-signal pattern above pure frequency above low-use', () => {
    // A: hot hit — 100× from one query in one day. High frequency only.
    const a = makeExperience('A', {
      referencedCount: 100,
      totalRelevance: 65, // avg similarity 0.65
      distinctQueries: 1,
      distinctDays: 1,
      lastReferenced: new Date().toISOString(),
    })

    // B: varied usage — 20 hits across 15 queries over 10 days.
    // This is the "good" consolidated pattern.
    const b = makeExperience('B', {
      referencedCount: 20,
      totalRelevance: 16, // avg similarity 0.8
      distinctQueries: 15,
      distinctDays: 10,
      lastReferenced: new Date().toISOString(),
    })

    // C: fresh, low-count, moderately rich. Should lose to both.
    const c = makeExperience(
      'C',
      {
        referencedCount: 3,
        totalRelevance: 2.1, // avg similarity 0.7
        distinctQueries: 3,
        distinctDays: 3,
        lastReferenced: new Date().toISOString(),
      },
      { daysOld: 0, conceptualRichness: 1 },
    )

    // Fixed maxRef = 100 across all three so frequency is stable.
    const maxRef = 100
    const hA = computeHealthScoreForTest(a, maxRef)
    const hB = computeHealthScoreForTest(b, maxRef)
    const hC = computeHealthScoreForTest(c, maxRef)

    for (const [id, h] of [['A', hA], ['B', hB], ['C', hC]] as const) {
      expect(h, `health(${id}) = ${h}`).toBeGreaterThanOrEqual(0)
      expect(h, `health(${id}) = ${h}`).toBeLessThanOrEqual(1)
    }

    expect(hB).toBeGreaterThan(hA)
    expect(hA).toBeGreaterThan(hC)
  })

  it('returns a value in [0, 1] for an old-shape experience with undefined new fields', () => {
    const old = makeExperience('old', {
      referencedCount: 5,
      lastReferenced: new Date().toISOString(),
    })
    delete old.health.totalRelevance
    delete old.health.distinctQueries
    delete old.health.distinctDays
    delete old.health.conceptualRichness

    const h = computeHealthScoreForTest(old, 10)
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThanOrEqual(1)
    expect(Number.isFinite(h)).toBe(true)
  })

  it('logScaleFrequency does not saturate — 1000 hits beats 10 hits', () => {
    const hot = makeExperience('hot', {
      referencedCount: 1000,
      lastReferenced: new Date().toISOString(),
    })
    const warm = makeExperience('warm', {
      referencedCount: 10,
      lastReferenced: new Date().toISOString(),
    })

    const hHot = computeHealthScoreForTest(hot, 1000)
    const hWarm = computeHealthScoreForTest(warm, 1000)

    expect(hHot).toBeGreaterThan(hWarm)
  })

  it('quality gate: admissionScore gap produces strictly different scores', () => {
    const common: Partial<ExperienceHealth> = {
      referencedCount: 10,
      totalRelevance: 7,
      distinctQueries: 5,
      distinctDays: 5,
      lastReferenced: new Date().toISOString(),
    }
    const high = makeExperience('hi', common, { admissionScore: 1.0 })
    const low = makeExperience('lo', common, { admissionScore: 0.4 })

    const hHigh = computeHealthScoreForTest(high, 10)
    const hLow = computeHealthScoreForTest(low, 10)

    expect(hHigh).toBeGreaterThan(hLow)
    // And the gap should be material (gate multiplies everything).
    expect(hHigh - hLow).toBeGreaterThan(0.1)
  })

  it('quality gate: contradictionCount penalizes health', () => {
    const common: Partial<ExperienceHealth> = {
      referencedCount: 10,
      totalRelevance: 7,
      distinctQueries: 5,
      distinctDays: 5,
      lastReferenced: new Date().toISOString(),
    }
    const clean = makeExperience('clean', common)
    const disputed = makeExperience('disputed', {
      ...common,
      contradictionCount: 3,
    })

    const hClean = computeHealthScoreForTest(clean, 10)
    const hDisputed = computeHealthScoreForTest(disputed, 10)

    expect(hClean).toBeGreaterThan(hDisputed)
    // With contradictionCount=3 the gate halves the score.
    expect(hDisputed).toBeLessThanOrEqual(hClean * 0.51)
  })
})

describe('refreshConsolidationFields — window-authoritative, not a ratchet', () => {
  it('decays totalRelevance to 0 when all entries fall outside the window', () => {
    const exp = makeExperience('e', {
      referencedCount: 5,
      // A previously-ratcheted value. The old implementation would
      // keep this forever; the new one must let it decay.
      totalRelevance: 99,
      distinctQueries: 5,
      distinctDays: 5,
    })
    // No entries passed in — simulates "all recall-log entries for
    // this experience have aged out of the 14-day window".
    refreshConsolidationFields(exp, [])

    expect(exp.health.totalRelevance).toBe(0)
    expect(exp.health.distinctQueries).toBe(0)
    expect(exp.health.distinctDays).toBe(0)
  })

  it('overwrites (not max) totalRelevance from a smaller window sum', () => {
    const exp = makeExperience('e', {
      referencedCount: 10,
      totalRelevance: 50, // stale, inflated
    })
    const entries: RecallLogEntry[] = [
      { experienceId: 'e', query: 'q1', similarity: 0.6, timestamp: new Date().toISOString() },
      { experienceId: 'e', query: 'q2', similarity: 0.7, timestamp: new Date().toISOString() },
    ]
    refreshConsolidationFields(exp, entries)

    // Must be the window sum (1.3), NOT max(50, 1.3) = 50.
    expect(exp.health.totalRelevance).toBeCloseTo(1.3, 5)
    expect(exp.health.distinctQueries).toBe(2)
    expect(exp.health.distinctDays).toBe(1)
  })

  it('excludes null-similarity entries from totalRelevance but still counts them for diversity/days', () => {
    const exp = makeExperience('e', { referencedCount: 3 })
    const day1 = new Date().toISOString()
    const day2 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const entries: RecallLogEntry[] = [
      { experienceId: 'e', query: 'q-keyword', similarity: null, timestamp: day1 },
      { experienceId: 'e', query: 'q-vector', similarity: 0.8, timestamp: day1 },
      { experienceId: 'e', query: 'q-tag-only', similarity: null, timestamp: day2 },
    ]
    refreshConsolidationFields(exp, entries)

    expect(exp.health.totalRelevance).toBeCloseTo(0.8, 5)
    expect(exp.health.distinctQueries).toBe(3)
    expect(exp.health.distinctDays).toBe(2)
  })
})

describe('ExperienceStore.maintain — integration with recall log', () => {
  let tmpDir: string
  let store: ExperienceStore
  let recallLog: RecallLog

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'exp-maintain-test-'))
    store = new ExperienceStore(tmpDir)
    await store.init()
    recallLog = new RecallLog(tmpDir)
    await recallLog.init()
  })

  it('calls recallLog.readRecent exactly once per sweep', async () => {
    // Seed 5 experiences.
    for (let i = 0; i < 5; i++) {
      const exp = makeExperience(`e${i}`, { referencedCount: 2 })
      await store.save(exp)
    }
    // And a handful of recall-log entries.
    for (let i = 0; i < 5; i++) {
      await recallLog.append({
        experienceId: `e${i}`,
        query: `q${i}`,
        similarity: 0.5,
        timestamp: new Date().toISOString(),
      })
    }

    const spy = vi.spyOn(recallLog, 'readRecent')
    await store.maintain(recallLog)
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('refreshes consolidation fields from the recall log during maintain', async () => {
    const exp = makeExperience('e1', { referencedCount: 3 })
    await store.save(exp)

    const now = new Date().toISOString()
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    await recallLog.append({ experienceId: 'e1', query: 'alpha', similarity: 0.9, timestamp: now })
    await recallLog.append({ experienceId: 'e1', query: 'beta', similarity: 0.8, timestamp: now })
    await recallLog.append({
      experienceId: 'e1',
      query: 'gamma',
      similarity: 0.7,
      timestamp: yesterday,
    })

    await store.maintain(recallLog)

    const updated = store.get('e1')!
    expect(updated.health.distinctQueries).toBe(3)
    expect(updated.health.distinctDays).toBe(2)
    expect(updated.health.totalRelevance).toBeCloseTo(2.4, 5)
  })

  it('does not demote Active→Stale→Archive in one sweep (snapshot preserved)', async () => {
    const oldDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString()
    const stale = makeExperience(
      'old',
      { referencedCount: 0, lastReferenced: oldDate },
      { admissionScore: 0.5 },
    )
    stale.timestamp = oldDate
    await store.save(stale)

    const result = await store.maintain(recallLog)
    expect(result.movedToStale).toBe(1)
    expect(result.movedToArchive).toBe(0)
    expect(store.getAll('stale')).toHaveLength(1)
  })

  it('quality gate on contradictionCount survives through maintain', async () => {
    const now = new Date().toISOString()
    const healthy = makeExperience(
      'healthy',
      { referencedCount: 20, lastReferenced: now },
      { admissionScore: 0.9 },
    )
    const refuted = makeExperience(
      'refuted',
      { referencedCount: 20, contradictionCount: 3, lastReferenced: now },
      { admissionScore: 0.9 },
    )
    await store.save(healthy)
    await store.save(refuted)

    await store.maintain(recallLog)

    const h = store.get('healthy')!
    const r = store.get('refuted')!
    const hHealthy = computeHealthScoreForTest(h, 20)
    const hRefuted = computeHealthScoreForTest(r, 20)
    expect(hHealthy).toBeGreaterThan(hRefuted)
  })
})
