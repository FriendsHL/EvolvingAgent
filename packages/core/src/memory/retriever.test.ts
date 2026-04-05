import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryRetriever } from './retriever.js'
import { ExperienceStore } from './experience-store.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Experience } from '../types.js'

function makeExperience(overrides: Partial<Experience> & { id: string; task: string }): Experience {
  return {
    steps: [],
    result: 'success',
    reflection: { whatWorked: [], whatFailed: [], lesson: 'test lesson' },
    tags: [],
    timestamp: new Date().toISOString(),
    health: { referencedCount: 0, contradictionCount: 0 },
    admissionScore: 0.7,
    ...overrides,
  }
}

describe('MemoryRetriever', () => {
  let tmpDir: string
  let store: ExperienceStore
  let retriever: MemoryRetriever

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'retriever-test-'))
    store = new ExperienceStore(tmpDir)
    await store.init()
    retriever = new MemoryRetriever(store)
  })

  // afterEach not needed — tmpDir is unique per test

  it('returns empty for no experiences', async () => {
    const results = await retriever.search({ text: 'anything' })
    expect(results).toHaveLength(0)
  })

  it('finds experience by keyword match', async () => {
    await store.save(makeExperience({ id: 'exp1', task: 'debug server latency issue', tags: ['debug'] }))
    await store.save(makeExperience({ id: 'exp2', task: 'deploy frontend application', tags: ['deploy'] }))

    const results = await retriever.search({ text: 'debug server' })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].id).toBe('exp1')
    expect(results[0].matchSource).toContain('keyword')
  })

  it('finds experience by tag match', async () => {
    await store.save(makeExperience({ id: 'exp1', task: 'fix the crash', tags: ['production', 'crash'] }))
    await store.save(makeExperience({ id: 'exp2', task: 'add feature', tags: ['feature'] }))

    const results = await retriever.search({ text: 'something', tags: ['production'] })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].id).toBe('exp1')
    expect(results[0].matchSource).toContain('tag')
  })

  it('respects topK limit', async () => {
    for (let i = 0; i < 10; i++) {
      await store.save(makeExperience({ id: `exp${i}`, task: `debug issue number ${i}`, tags: ['debug'] }))
    }

    const results = await retriever.search({ text: 'debug issue', topK: 3 })
    expect(results.length).toBeLessThanOrEqual(3)
  })

  it('RRF fusion boosts items appearing in multiple ranked lists', async () => {
    // exp1 matches both keyword and tag, exp2 matches only keyword
    await store.save(makeExperience({ id: 'exp1', task: 'debug server crash', tags: ['debug', 'server'] }))
    await store.save(makeExperience({ id: 'exp2', task: 'debug network timeout', tags: ['network'] }))

    const results = await retriever.search({ text: 'debug server', tags: ['server'] })
    expect(results.length).toBeGreaterThan(0)
    // exp1 should rank higher due to both keyword + tag match
    expect(results[0].id).toBe('exp1')
  })

  it('respects minScore filter', async () => {
    await store.save(makeExperience({ id: 'exp1', task: 'completely unrelated task about cooking', tags: ['cooking'] }))

    const results = await retriever.search({ text: 'debug server', minScore: 0.1 })
    // Should not match — very different task
    expect(results).toHaveLength(0)
  })

  it('marks retrieved experiences as referenced', async () => {
    await store.save(makeExperience({ id: 'exp1', task: 'debug server issue', tags: ['debug'] }))

    await retriever.search({ text: 'debug server' })
    const exp = store.get('exp1')
    expect(exp?.health.referencedCount).toBe(1)
    expect(exp?.health.lastReferenced).toBeDefined()
  })
})
