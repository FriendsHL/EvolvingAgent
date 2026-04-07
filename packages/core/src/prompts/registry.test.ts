import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { PromptRegistry } from './registry.js'
import type { PromptId } from './types.js'

const DEFAULTS: Record<PromptId, string> = {
  planner: 'BASE_PLANNER',
  reflector: 'BASE_REFLECTOR',
  conversational: 'BASE_CONVO',
}

async function makeTmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-registry-'))
}

describe('PromptRegistry', () => {
  let dataPath: string

  beforeEach(async () => {
    dataPath = await makeTmpDir()
  })

  afterEach(async () => {
    await fs.rm(dataPath, { recursive: true, force: true })
  })

  describe('init + get', () => {
    it('falls back to defaults when active.json is missing', async () => {
      const reg = new PromptRegistry({ dataPath, defaults: DEFAULTS })
      await reg.init()
      expect(reg.get('planner')).toBe('BASE_PLANNER')
      expect(reg.get('reflector')).toBe('BASE_REFLECTOR')
      expect(reg.get('conversational')).toBe('BASE_CONVO')
      expect(reg.isLoaded()).toBe(true)
    })

    it('loads overrides from active.json when present', async () => {
      await fs.mkdir(path.join(dataPath, 'prompts'), { recursive: true })
      const activeFile = {
        prompts: {
          planner: {
            content: 'OVERRIDE_PLANNER',
            acceptedAt: '2026-04-07T00:00:00.000Z',
            note: 'test',
          },
        },
      }
      await fs.writeFile(
        path.join(dataPath, 'prompts', 'active.json'),
        JSON.stringify(activeFile),
        'utf8',
      )
      const reg = new PromptRegistry({ dataPath, defaults: DEFAULTS })
      await reg.init()
      expect(reg.get('planner')).toBe('OVERRIDE_PLANNER')
      expect(reg.get('reflector')).toBe('BASE_REFLECTOR')
    })

    it('silently ignores malformed active.json and falls back to defaults', async () => {
      await fs.mkdir(path.join(dataPath, 'prompts'), { recursive: true })
      await fs.writeFile(
        path.join(dataPath, 'prompts', 'active.json'),
        '{not-valid-json',
        'utf8',
      )
      const reg = new PromptRegistry({ dataPath, defaults: DEFAULTS })
      await reg.init()
      expect(reg.get('planner')).toBe('BASE_PLANNER')
    })

    it('getBaseline always returns source-code default even with override active', async () => {
      const reg = new PromptRegistry({ dataPath, defaults: DEFAULTS })
      await reg.init()
      await reg.set('planner', 'NEW_PLANNER')
      expect(reg.get('planner')).toBe('NEW_PLANNER')
      expect(reg.getBaseline('planner')).toBe('BASE_PLANNER')
    })
  })

  describe('set + persistence', () => {
    it('writes active.json and appends a history file on set()', async () => {
      const reg = new PromptRegistry({ dataPath, defaults: DEFAULTS })
      await reg.init()
      await reg.set('planner', 'NEW_PLANNER_V1', {
        note: 'accepted from run abc',
        evalPassRate: 0.9,
        baselinePassRate: 0.7,
      })

      // active.json written
      const raw = await fs.readFile(
        path.join(dataPath, 'prompts', 'active.json'),
        'utf8',
      )
      const parsed = JSON.parse(raw)
      expect(parsed.prompts.planner.content).toBe('NEW_PLANNER_V1')
      expect(parsed.prompts.planner.evalPassRate).toBe(0.9)

      // history file present
      const historyFiles = await fs.readdir(path.join(dataPath, 'prompts', 'history'))
      expect(historyFiles).toHaveLength(1)
      expect(historyFiles[0]).toMatch(/-planner\.md$/)

      // history() round-trips
      const history = await reg.history('planner')
      expect(history).toHaveLength(1)
      expect(history[0].content).toBe('NEW_PLANNER_V1')
      expect(history[0].action).toBe('accept')
      expect(history[0].evalPassRate).toBe(0.9)
      expect(history[0].note).toBe('accepted from run abc')
    })

    it('survives a reload by constructing a new registry', async () => {
      const reg1 = new PromptRegistry({ dataPath, defaults: DEFAULTS })
      await reg1.init()
      await reg1.set('reflector', 'REFLECTOR_V2')

      const reg2 = new PromptRegistry({ dataPath, defaults: DEFAULTS })
      await reg2.init()
      expect(reg2.get('reflector')).toBe('REFLECTOR_V2')
    })

    it('revertToBaseline removes active override and logs history', async () => {
      const reg = new PromptRegistry({ dataPath, defaults: DEFAULTS })
      await reg.init()
      await reg.set('planner', 'NEW_PLANNER', { note: 'accept' })
      await reg.revertToBaseline('planner', 'rollback test')
      expect(reg.get('planner')).toBe('BASE_PLANNER')

      const history = await reg.history('planner')
      expect(history).toHaveLength(2)
      // Newest first — the rollback should be the first entry.
      expect(history[0].action).toBe('rollback')
      expect(history[1].action).toBe('accept')
    })
  })

  describe('transient overrides', () => {
    it('setTransient wins over active and defaults, clearTransient restores', async () => {
      const reg = new PromptRegistry({ dataPath, defaults: DEFAULTS })
      await reg.init()
      await reg.set('planner', 'ACTIVE_PLANNER')
      expect(reg.get('planner')).toBe('ACTIVE_PLANNER')

      reg.setTransient('planner', 'TRANSIENT_PLANNER')
      expect(reg.get('planner')).toBe('TRANSIENT_PLANNER')

      reg.clearTransient('planner')
      expect(reg.get('planner')).toBe('ACTIVE_PLANNER')
    })

    it('withTransient installs override for the duration of the callback', async () => {
      const reg = new PromptRegistry({ dataPath, defaults: DEFAULTS })
      await reg.init()

      const snapshot = await reg.withTransient('planner', 'SANDBOX', async () => {
        return reg.get('planner')
      })
      expect(snapshot).toBe('SANDBOX')
      // After the callback, the transient must be cleared.
      expect(reg.get('planner')).toBe('BASE_PLANNER')
    })

    it('withTransient restores prior transient on exit (nesting support)', async () => {
      const reg = new PromptRegistry({ dataPath, defaults: DEFAULTS })
      await reg.init()
      reg.setTransient('planner', 'OUTER')
      await reg.withTransient('planner', 'INNER', async () => {
        expect(reg.get('planner')).toBe('INNER')
      })
      expect(reg.get('planner')).toBe('OUTER')
    })

    it('withTransient clears override even when callback throws', async () => {
      const reg = new PromptRegistry({ dataPath, defaults: DEFAULTS })
      await reg.init()
      await expect(
        reg.withTransient('planner', 'FAIL', async () => {
          throw new Error('boom')
        }),
      ).rejects.toThrow('boom')
      expect(reg.get('planner')).toBe('BASE_PLANNER')
    })
  })

  describe('list', () => {
    it('reports baseline vs active source for every id', async () => {
      const reg = new PromptRegistry({ dataPath, defaults: DEFAULTS })
      await reg.init()
      await reg.set('planner', 'OVERRIDE')

      const list = reg.list()
      expect(list).toHaveLength(3)
      const planner = list.find((e) => e.id === 'planner')!
      const reflector = list.find((e) => e.id === 'reflector')!
      expect(planner.source).toBe('active')
      expect(planner.content).toBe('OVERRIDE')
      expect(reflector.source).toBe('baseline')
      expect(reflector.content).toBe('BASE_REFLECTOR')
    })
  })

  describe('history + restoreFromHistory', () => {
    it('restoreFromHistory writes the old content back as active', async () => {
      const reg = new PromptRegistry({ dataPath, defaults: DEFAULTS })
      await reg.init()
      await reg.set('planner', 'V1')
      // Force distinct timestamps.
      await new Promise((r) => setTimeout(r, 5))
      await reg.set('planner', 'V2')

      const history = await reg.history('planner')
      expect(history).toHaveLength(2)
      // history is newest first.
      const oldest = history[history.length - 1]
      expect(oldest.content).toBe('V1')

      await reg.restoreFromHistory('planner', oldest.timestamp)
      expect(reg.get('planner')).toBe('V1')

      // A new history entry should have been appended.
      const allAfter = await reg.history('planner')
      expect(allAfter.length).toBe(3)
    })
  })
})
