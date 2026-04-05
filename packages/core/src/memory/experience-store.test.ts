import { describe, it, expect, beforeEach } from 'vitest'
import { ExperienceStore } from './experience-store.js'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Experience } from '../types.js'

function makeExperience(id: string, task: string, overrides?: Partial<Experience>): Experience {
  return {
    id,
    task,
    steps: [],
    result: 'success',
    reflection: { whatWorked: ['done'], whatFailed: [], lesson: 'learned' },
    tags: ['test'],
    timestamp: new Date().toISOString(),
    health: { referencedCount: 0, contradictionCount: 0 },
    admissionScore: 0.7,
    ...overrides,
  }
}

describe('ExperienceStore', () => {
  let tmpDir: string
  let store: ExperienceStore

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'exp-store-test-'))
    store = new ExperienceStore(tmpDir)
    await store.init()
  })

  describe('CRUD', () => {
    it('saves and retrieves an experience', async () => {
      const exp = makeExperience('exp1', 'test task')
      await store.save(exp)

      const retrieved = store.get('exp1')
      expect(retrieved).toBeDefined()
      expect(retrieved?.task).toBe('test task')
    })

    it('returns undefined for missing id', () => {
      expect(store.get('nonexistent')).toBeUndefined()
    })

    it('lists all active experiences', async () => {
      await store.save(makeExperience('e1', 'task 1'))
      await store.save(makeExperience('e2', 'task 2'))

      const all = store.getAll('active')
      expect(all).toHaveLength(2)
    })

    it('getAllTasks returns task strings', async () => {
      await store.save(makeExperience('e1', 'task alpha'))
      await store.save(makeExperience('e2', 'task beta'))

      const tasks = store.getAllTasks()
      expect(tasks).toContain('task alpha')
      expect(tasks).toContain('task beta')
    })
  })

  describe('markReferenced', () => {
    it('increments reference count and updates timestamp', async () => {
      await store.save(makeExperience('e1', 'task'))
      await store.markReferenced('e1')

      const exp = store.get('e1')
      expect(exp?.health.referencedCount).toBe(1)
      expect(exp?.health.lastReferenced).toBeDefined()
    })

    it('no-ops for missing id', async () => {
      // Should not throw
      await store.markReferenced('missing')
    })
  })

  describe('persistence', () => {
    it('survives reload from disk', async () => {
      await store.save(makeExperience('e1', 'persistent task'))

      // Create a new store instance pointing to same dir
      const store2 = new ExperienceStore(tmpDir)
      await store2.init()

      const exp = store2.get('e1')
      expect(exp?.task).toBe('persistent task')
    })
  })

  describe('pool management', () => {
    it('maintains experiences after maintenance with fresh data', async () => {
      await store.save(makeExperience('e1', 'fresh task', {
        health: { referencedCount: 5, contradictionCount: 0, lastReferenced: new Date().toISOString() },
      }))

      const result = await store.maintain()
      // Fresh experience should stay in active
      expect(store.get('e1')).toBeDefined()
      expect(result.movedToStale).toBe(0)
    })

    it('moves old unreferenced experiences to stale', async () => {
      const oldDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString() // 35 days ago
      await store.save(makeExperience('old1', 'old task', {
        timestamp: oldDate,
        health: { referencedCount: 0, contradictionCount: 0 },
        admissionScore: 0.5,
      }))

      const result = await store.maintain()
      expect(result.movedToStale).toBe(1)
      // Should still be findable in stale pool
      expect(store.getAll('stale')).toHaveLength(1)
    })

    it('promotes stale experience back to active on reference', async () => {
      const oldDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString()
      await store.save(makeExperience('old1', 'old task', {
        timestamp: oldDate,
        health: { referencedCount: 0, contradictionCount: 0 },
        admissionScore: 0.5,
      }))

      // Move to stale
      await store.maintain()
      expect(store.getAll('stale')).toHaveLength(1)
      expect(store.getAll('active')).toHaveLength(0)

      // Reference it — should promote back
      await store.markReferenced('old1')
      expect(store.getAll('active')).toHaveLength(1)
      expect(store.getAll('stale')).toHaveLength(0)
    })
  })
})
