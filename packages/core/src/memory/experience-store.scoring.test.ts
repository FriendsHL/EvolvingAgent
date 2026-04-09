import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ExperienceStore } from './experience-store.js'
import type { Experience, ExperienceHealth } from '../types.js'

function makeExperience(
  id: string,
  health: Partial<ExperienceHealth>,
  opts: { admissionScore?: number; daysOld?: number; conceptualRichness?: number } = {},
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

describe('ExperienceStore.scoreHealth — six-signal formula', () => {
  let tmpDir: string
  let store: ExperienceStore

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'exp-scoring-test-'))
    store = new ExperienceStore(tmpDir)
    await store.init()
  })

  it('ranks the stable multi-signal pattern above a pure-frequency hit', async () => {
    // A: hot hit — 100× but all from one query on one day. High freq only.
    const a = makeExperience(
      'A',
      {
        referencedCount: 100,
        totalRelevance: 65, // avg similarity ~0.65
        distinctQueries: 1,
        distinctDays: 1,
        lastReferenced: new Date().toISOString(),
      },
      { daysOld: 0 },
    )

    // B: varied usage — 20 hits across 15 distinct queries over 10 days.
    // This is the "good" consolidated pattern.
    const b = makeExperience(
      'B',
      {
        referencedCount: 20,
        totalRelevance: 16, // avg similarity 0.8 — a little higher than A
        distinctQueries: 15,
        distinctDays: 10,
        lastReferenced: new Date().toISOString(),
      },
      { daysOld: 0 },
    )

    // C: stale but fancy — only 3 hits, weeks ago, but high conceptual
    // richness. Spec calls this the "stable 2×/day × 10d" *alternative*
    // that should nevertheless lose to B's more consolidated pattern
    // and to A's raw throughput — richness alone can't carry a memory.
    const staleTs = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString()
    const c = makeExperience(
      'C',
      {
        referencedCount: 3,
        totalRelevance: 2.1, // avg similarity 0.7
        distinctQueries: 3,
        distinctDays: 3,
        lastReferenced: staleTs,
      },
      { daysOld: 21, conceptualRichness: 1 },
    )

    // Fixed maxRef = 100 (A's count) so the frequency term is stable
    // across all three experiences.
    const maxRef = 100
    const hA = store.scoreHealth(a, maxRef)
    const hB = store.scoreHealth(b, maxRef)
    const hC = store.scoreHealth(c, maxRef)

    // Sanity: all in [0, 1].
    for (const [id, h] of [['A', hA], ['B', hB], ['C', hC]] as const) {
      expect(h, `health(${id}) = ${h}`).toBeGreaterThanOrEqual(0)
      expect(h, `health(${id}) = ${h}`).toBeLessThanOrEqual(1)
    }

    // The whole point of the upgrade: B (varied, consolidated) outranks
    // A (raw frequency) outranks C (a handful of fancy hits).
    expect(hB).toBeGreaterThan(hA)
    expect(hA).toBeGreaterThan(hC)
  })

  it('returns a value in [0, 1] for an old-shape experience with undefined new fields', () => {
    const old = makeExperience('old', {
      referencedCount: 5,
      // No totalRelevance / distinctQueries / distinctDays / conceptualRichness.
      lastReferenced: new Date().toISOString(),
    })
    // Remove optional fields to prove undefined is handled.
    delete old.health.totalRelevance
    delete old.health.distinctQueries
    delete old.health.distinctDays
    delete old.health.conceptualRichness

    const h = store.scoreHealth(old, 10)
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

    const hHot = store.scoreHealth(hot, 1000)
    const hWarm = store.scoreHealth(warm, 1000)

    // Under the old formula both saturated at frequency=1 and scored
    // identically on that axis. Under log-scale with maxRef=1000, warm
    // lands at log(11)/log(1001) ≈ 0.347 while hot lands at 1.0.
    expect(hHot).toBeGreaterThan(hWarm)
  })
})
