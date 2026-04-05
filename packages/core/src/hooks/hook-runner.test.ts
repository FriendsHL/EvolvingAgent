import { describe, it, expect, vi } from 'vitest'
import { HookRunner } from './hook-runner.js'
import type { Hook, HookContext } from '../types.js'

function makeHook(overrides: Partial<Hook> & { handler: Hook['handler'] }): Hook {
  return {
    id: 'test-hook',
    name: 'test-hook',
    description: 'test',
    trigger: 'before:plan',
    priority: 50,
    enabled: true,
    source: 'core',
    health: { consecutiveFailures: 0, totalRuns: 0, successRate: 1 },
    safety: { timeout: 5000, maxRetries: 0, fallbackBehavior: 'skip', canBeDisabledByAgent: true },
    ...overrides,
  }
}

const baseContext: HookContext = {
  trigger: 'before:plan',
  data: {},
  agent: { sessionId: 'test', totalCost: 0, tokenCount: 0 },
}

describe('HookRunner', () => {
  describe('runVoid', () => {
    it('runs all hooks in parallel', async () => {
      const runner = new HookRunner()
      const calls: number[] = []

      runner.register(makeHook({
        id: 'h1',
        trigger: 'after:llm-call',
        handler: async () => { calls.push(1) },
      }))
      runner.register(makeHook({
        id: 'h2',
        trigger: 'after:llm-call',
        handler: async () => { calls.push(2) },
      }))

      await runner.runVoid('after:llm-call', { ...baseContext, trigger: 'after:llm-call' })
      expect(calls).toHaveLength(2)
      expect(calls).toContain(1)
      expect(calls).toContain(2)
    })

    it('ignores disabled hooks', async () => {
      const runner = new HookRunner()
      const fn = vi.fn()

      runner.register(makeHook({
        trigger: 'after:llm-call',
        enabled: false,
        handler: fn,
      }))

      await runner.runVoid('after:llm-call', { ...baseContext, trigger: 'after:llm-call' })
      expect(fn).not.toHaveBeenCalled()
    })
  })

  describe('runModifying', () => {
    it('transforms data through hook chain sequentially', async () => {
      const runner = new HookRunner()

      runner.register(makeHook({
        id: 'h1',
        priority: 100,
        trigger: 'before:plan',
        handler: async (ctx) => ({ ...(ctx.data as object), step1: true }),
      }))
      runner.register(makeHook({
        id: 'h2',
        priority: 50,
        trigger: 'before:plan',
        handler: async (ctx) => ({ ...(ctx.data as object), step2: true }),
      }))

      const result = await runner.runModifying('before:plan', baseContext, { original: true })
      expect(result).toEqual({ original: true, step1: true, step2: true })
    })

    it('runs hooks in priority order (higher first)', async () => {
      const runner = new HookRunner()
      const order: string[] = []

      runner.register(makeHook({
        id: 'low',
        priority: 10,
        trigger: 'before:plan',
        handler: async () => { order.push('low') },
      }))
      runner.register(makeHook({
        id: 'high',
        priority: 100,
        trigger: 'before:plan',
        handler: async () => { order.push('high') },
      }))

      await runner.runModifying('before:plan', baseContext, {})
      expect(order).toEqual(['high', 'low'])
    })

    it('skips hook that returns undefined (no modification)', async () => {
      const runner = new HookRunner()

      runner.register(makeHook({
        trigger: 'before:plan',
        handler: async () => undefined,
      }))

      const result = await runner.runModifying('before:plan', baseContext, { kept: true })
      expect(result).toEqual({ kept: true })
    })
  })

  describe('runClaiming', () => {
    it('returns result from first claiming hook', async () => {
      const runner = new HookRunner()

      runner.register(makeHook({
        id: 'h1',
        priority: 100,
        trigger: 'before:plan',
        handler: async () => ({ handled: true, by: 'h1' }),
      }))
      runner.register(makeHook({
        id: 'h2',
        priority: 50,
        trigger: 'before:plan',
        handler: async () => ({ handled: true, by: 'h2' }),
      }))

      const result = await runner.runClaiming('before:plan', baseContext) as { handled: boolean; by: string }
      expect(result.by).toBe('h1')
    })

    it('returns undefined when no hook claims', async () => {
      const runner = new HookRunner()

      runner.register(makeHook({
        trigger: 'before:plan',
        handler: async () => ({ handled: false }),
      }))

      const result = await runner.runClaiming('before:plan', baseContext)
      expect(result).toBeUndefined()
    })
  })

  describe('auto-detection via run()', () => {
    it('uses void mode for after:llm-call', async () => {
      const runner = new HookRunner()
      const fn = vi.fn()

      runner.register(makeHook({
        trigger: 'after:llm-call',
        handler: fn,
      }))

      await runner.run('after:llm-call', { ...baseContext, trigger: 'after:llm-call' }, {})
      expect(fn).toHaveBeenCalled()
    })

    it('uses modifying mode for before:plan', async () => {
      const runner = new HookRunner()

      runner.register(makeHook({
        trigger: 'before:plan',
        handler: async () => ({ modified: true }),
      }))

      const result = await runner.run('before:plan', baseContext, { original: true })
      expect(result).toEqual({ modified: true })
    })
  })
})
