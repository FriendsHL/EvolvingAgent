import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { ExperienceStore } from '../memory/experience-store.js'
import type { Embedder } from '../memory/embedder.js'
import type { Experience } from '../types.js'

/**
 * Deterministic fake embedder for tests. Returns the same vector for the
 * same text (so identical lessons produce cosine similarity 1.0). Avoids
 * the local-bow Embedder's degenerate IDF=0 behavior with tiny corpora.
 */
function fakeEmbedder(): Embedder {
  function hash(s: string): number {
    let h = 0
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
    return Math.abs(h)
  }
  function embed(text: string): number[] {
    const dim = 16
    const vec = new Array<number>(dim).fill(0)
    for (const word of text.toLowerCase().split(/\s+/).filter(Boolean)) {
      vec[hash(word) % dim] += 1
    }
    let norm = 0
    for (const v of vec) norm += v * v
    norm = Math.sqrt(norm) || 1
    return vec.map((v) => v / norm)
  }
  return {
    embed: async (text: string) => embed(text),
    embedBatch: async (texts: string[]) => texts.map(embed),
  } as unknown as Embedder
}

import { ExperienceDistiller } from './distiller.js'
import { LESSON_TAG, type DistillFn, type DistillProposal } from './types.js'

function makeExperience(id: string, task: string, overrides?: Partial<Experience>): Experience {
  return {
    id,
    task,
    steps: [],
    result: 'success',
    reflection: { whatWorked: ['x'], whatFailed: [], lesson: 'learned' },
    tags: ['test'],
    timestamp: new Date().toISOString(),
    health: { referencedCount: 0, contradictionCount: 0 },
    admissionScore: 0.8,
    ...overrides,
  }
}

/** A `DistillFn` that records its input and returns canned proposals. */
function fakeDistiller(proposals: DistillProposal[]): {
  fn: DistillFn
  calls: Array<{ inputCount: number; maxLessons: number; ids: string[] }>
} {
  const calls: Array<{ inputCount: number; maxLessons: number; ids: string[] }> = []
  const fn: DistillFn = async ({ experiences, maxLessons }) => {
    calls.push({
      inputCount: experiences.length,
      maxLessons,
      ids: experiences.map((e) => e.id),
    })
    return proposals
  }
  return { fn, calls }
}

describe('ExperienceDistiller', () => {
  let tmpDir: string
  let store: ExperienceStore

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'distill-test-'))
    store = new ExperienceStore(tmpDir)
    await store.init()
  })

  describe('input filtering', () => {
    it('skips lessons and below-threshold experiences', async () => {
      await store.save(makeExperience('keep1', 'task A', { admissionScore: 0.9 }))
      await store.save(makeExperience('keep2', 'task B', { admissionScore: 0.7 }))
      await store.save(makeExperience('low', 'task C', { admissionScore: 0.3 }))
      await store.save(
        makeExperience('lesson1', 'an old lesson', { tags: [LESSON_TAG, 'foo'] }),
      )

      const { fn, calls } = fakeDistiller([])
      const distiller = new ExperienceDistiller({ store, distill: fn })
      await distiller.run({ minAdmissionScore: 0.6 })

      expect(calls).toHaveLength(1)
      expect(calls[0].ids.sort()).toEqual(['keep1', 'keep2'])
    })

    it('respects maxInputs cap and sorts by admission score desc', async () => {
      for (let i = 0; i < 5; i++) {
        await store.save(makeExperience(`e${i}`, `task ${i}`, { admissionScore: 0.6 + i * 0.05 }))
      }
      const { fn, calls } = fakeDistiller([])
      const distiller = new ExperienceDistiller({ store, distill: fn })
      await distiller.run({ maxInputs: 3 })

      expect(calls[0].inputCount).toBe(3)
      // Highest scores first → e4, e3, e2
      expect(calls[0].ids).toEqual(['e4', 'e3', 'e2'])
    })

    it('short-circuits when fewer than 2 inputs', async () => {
      await store.save(makeExperience('only', 'just one', { admissionScore: 0.9 }))
      const { fn, calls } = fakeDistiller([{ lesson: 'x', supportingExperienceIds: ['only'] }])
      const distiller = new ExperienceDistiller({ store, distill: fn })

      const run = await distiller.run()
      expect(run.status).toBe('completed')
      expect(run.candidates).toHaveLength(0)
      expect(calls).toHaveLength(0)
    })
  })

  describe('candidate validation', () => {
    beforeEach(async () => {
      await store.save(makeExperience('a', 'A', { admissionScore: 0.9 }))
      await store.save(makeExperience('b', 'B', { admissionScore: 0.9 }))
      await store.save(makeExperience('c', 'C', { admissionScore: 0.9 }))
    })

    it('drops proposals with fewer than 2 supporting ids', async () => {
      const { fn } = fakeDistiller([
        { lesson: 'good', supportingExperienceIds: ['a', 'b'] },
        { lesson: 'lonely', supportingExperienceIds: ['a'] },
      ])
      const distiller = new ExperienceDistiller({ store, distill: fn })
      const run = await distiller.run()
      expect(run.candidates.map((c) => c.lesson)).toEqual(['good'])
    })

    it('drops support ids that do not exist in the input set', async () => {
      const { fn } = fakeDistiller([
        { lesson: 'invented', supportingExperienceIds: ['a', 'ghost'] }, // only 'a' valid → dropped
        { lesson: 'kept', supportingExperienceIds: ['a', 'b', 'phantom'] }, // a,b valid → kept
      ])
      const distiller = new ExperienceDistiller({ store, distill: fn })
      const run = await distiller.run()
      expect(run.candidates).toHaveLength(1)
      expect(run.candidates[0].lesson).toBe('kept')
      expect(run.candidates[0].supportingExperienceIds).toEqual(['a', 'b'])
    })

    it('respects maxLessons cap', async () => {
      const { fn } = fakeDistiller([
        { lesson: 'L1', supportingExperienceIds: ['a', 'b'] },
        { lesson: 'L2', supportingExperienceIds: ['a', 'c'] },
        { lesson: 'L3', supportingExperienceIds: ['b', 'c'] },
      ])
      const distiller = new ExperienceDistiller({ store, distill: fn })
      const run = await distiller.run({ maxLessons: 2 })
      expect(run.candidates).toHaveLength(2)
    })

    it('skips empty/whitespace lessons', async () => {
      const { fn } = fakeDistiller([
        { lesson: '   ', supportingExperienceIds: ['a', 'b'] },
        { lesson: 'real one', supportingExperienceIds: ['a', 'b'] },
      ])
      const distiller = new ExperienceDistiller({ store, distill: fn })
      const run = await distiller.run()
      expect(run.candidates.map((c) => c.lesson)).toEqual(['real one'])
    })

    it('dedupes tags and skips empty', async () => {
      const { fn } = fakeDistiller([
        { lesson: 'x', tags: ['a', 'a', '', ' b '], supportingExperienceIds: ['a', 'b'] },
      ])
      const distiller = new ExperienceDistiller({ store, distill: fn })
      const run = await distiller.run()
      expect(run.candidates[0].tags).toEqual(['a', 'b'])
    })
  })

  describe('dedup against existing lessons', () => {
    it('flags candidates whose embedding matches existing lessons', async () => {
      const embedder = fakeEmbedder()

      // Existing lesson with embedding pre-computed by the same embedder
      const existing = makeExperience('lesson-old', 'always validate inputs before processing', {
        tags: [LESSON_TAG],
        embedding: await embedder.embed('always validate inputs before processing'),
      })
      await store.save(existing)

      // Two source experiences for the candidate
      await store.save(makeExperience('a', 'task A', { admissionScore: 0.9 }))
      await store.save(makeExperience('b', 'task B', { admissionScore: 0.9 }))

      const { fn } = fakeDistiller([
        // Identical text → should be flagged as duplicate
        { lesson: 'always validate inputs before processing', supportingExperienceIds: ['a', 'b'] },
        // Different text → should not be flagged
        { lesson: 'totally unrelated weather forecast pancake recipe', supportingExperienceIds: ['a', 'b'] },
      ])

      const distiller = new ExperienceDistiller({ store, embedder, distill: fn })
      const run = await distiller.run({ duplicateThreshold: 0.85 })

      expect(run.candidates).toHaveLength(2)
      const dupe = run.candidates.find((c) => c.lesson.startsWith('always'))
      const fresh = run.candidates.find((c) => c.lesson.startsWith('totally'))
      expect(dupe?.isDuplicate).toBe(true)
      expect(dupe?.closestExistingLessonId).toBe('lesson-old')
      expect(fresh?.isDuplicate).toBe(false)
    })

    it('skips dedup when no embedder is provided', async () => {
      await store.save(makeExperience('a', 'task A', { admissionScore: 0.9 }))
      await store.save(makeExperience('b', 'task B', { admissionScore: 0.9 }))

      const { fn } = fakeDistiller([
        { lesson: 'something', supportingExperienceIds: ['a', 'b'] },
      ])
      const distiller = new ExperienceDistiller({ store, distill: fn })
      const run = await distiller.run()
      expect(run.candidates[0].isDuplicate).toBe(false)
      expect(run.candidates[0].closestExistingLessonId).toBeUndefined()
    })
  })

  describe('materializeCandidate', () => {
    it('saves an Experience with the lesson tag and admissionScore 1.0', async () => {
      await store.save(makeExperience('a', 'A', { admissionScore: 0.9 }))
      await store.save(makeExperience('b', 'B', { admissionScore: 0.9 }))

      const { fn } = fakeDistiller([
        {
          lesson: 'prefer absolute paths over relative ones',
          rationale: 'avoids cwd surprises',
          tags: ['fs', 'paths'],
          supportingExperienceIds: ['a', 'b'],
        },
      ])
      const distiller = new ExperienceDistiller({ store, distill: fn })
      const run = await distiller.run()
      const cand = run.candidates[0]!

      const exp = await distiller.materializeCandidate(cand)
      expect(exp.tags).toContain(LESSON_TAG)
      expect(exp.tags).toContain('fs')
      expect(exp.tags).toContain('paths')
      expect(exp.admissionScore).toBe(1.0)
      expect(exp.task).toBe('prefer absolute paths over relative ones')
      expect(exp.steps).toEqual([])

      // Should be retrievable from the active pool
      const fetched = store.get(exp.id)
      expect(fetched?.id).toBe(exp.id)
    })
  })

  describe('failure handling', () => {
    it('returns a failed run when the DistillFn throws', async () => {
      await store.save(makeExperience('a', 'A', { admissionScore: 0.9 }))
      await store.save(makeExperience('b', 'B', { admissionScore: 0.9 }))

      const fn: DistillFn = async () => {
        throw new Error('LLM exploded')
      }
      const distiller = new ExperienceDistiller({ store, distill: fn })
      const run = await distiller.run()
      expect(run.status).toBe('failed')
      expect(run.error).toContain('LLM exploded')
    })
  })
})
