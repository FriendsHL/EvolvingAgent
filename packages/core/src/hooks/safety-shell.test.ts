import { describe, it, expect, vi } from 'vitest'
import { safeExec } from './safety-shell.js'
import type { Hook, HookContext } from '../types.js'

function makeHook(overrides: Partial<Hook> & { handler: Hook['handler'] }): Hook {
  return {
    id: 'test',
    name: 'test',
    description: 'test',
    trigger: 'before:plan',
    priority: 50,
    enabled: true,
    source: 'evolved-new',
    health: { consecutiveFailures: 0, totalRuns: 0, successRate: 1 },
    safety: { timeout: 5000, maxRetries: 0, fallbackBehavior: 'skip', canBeDisabledByAgent: true },
    ...overrides,
  }
}

const ctx: HookContext = {
  trigger: 'before:plan',
  data: {},
  agent: { sessionId: 'test', totalCost: 0, tokenCount: 0 },
}

describe('safeExec', () => {
  it('returns handler result on success', async () => {
    const hook = makeHook({ handler: async () => 'ok' })
    const result = await safeExec(hook, ctx)
    expect(result).toBe('ok')
    expect(hook.health.consecutiveFailures).toBe(0)
    expect(hook.health.totalRuns).toBe(1)
  })

  it('resets consecutive failures on success', async () => {
    const hook = makeHook({ handler: async () => 'ok' })
    hook.health.consecutiveFailures = 2
    await safeExec(hook, ctx)
    expect(hook.health.consecutiveFailures).toBe(0)
  })

  it('increments failure count on error', async () => {
    const hook = makeHook({
      handler: async () => { throw new Error('boom') },
    })
    await safeExec(hook, ctx) // fallback: skip
    expect(hook.health.consecutiveFailures).toBe(1)
    expect(hook.health.lastError).toBe('Error: boom')
  })

  it('auto-disables hook after 3 consecutive failures', async () => {
    const hook = makeHook({
      handler: async () => { throw new Error('fail') },
    })
    hook.health.consecutiveFailures = 2 // Already at 2

    await safeExec(hook, ctx)
    expect(hook.enabled).toBe(false)
    expect(hook.health.consecutiveFailures).toBe(3)
  })

  it('does not auto-disable core hooks (canBeDisabledByAgent=false)', async () => {
    const hook = makeHook({
      handler: async () => { throw new Error('fail') },
      safety: { timeout: 5000, maxRetries: 0, fallbackBehavior: 'skip', canBeDisabledByAgent: false },
    })
    hook.health.consecutiveFailures = 2

    await safeExec(hook, ctx)
    expect(hook.enabled).toBe(true) // Not disabled
  })

  it('returns undefined on skip fallback', async () => {
    const hook = makeHook({
      handler: async () => { throw new Error('fail') },
      safety: { timeout: 5000, maxRetries: 0, fallbackBehavior: 'skip', canBeDisabledByAgent: true },
    })
    const result = await safeExec(hook, ctx)
    expect(result).toBeUndefined()
  })

  it('throws on abort fallback', async () => {
    const hook = makeHook({
      handler: async () => { throw new Error('critical') },
      safety: { timeout: 5000, maxRetries: 0, fallbackBehavior: 'abort', canBeDisabledByAgent: true },
    })
    await expect(safeExec(hook, ctx)).rejects.toThrow('critical')
  })

  it('times out slow hooks', async () => {
    const hook = makeHook({
      handler: async () => new Promise((resolve) => setTimeout(resolve, 10000)),
      safety: { timeout: 50, maxRetries: 0, fallbackBehavior: 'skip', canBeDisabledByAgent: true },
    })
    const result = await safeExec(hook, ctx)
    expect(result).toBeUndefined() // Skip fallback
    expect(hook.health.consecutiveFailures).toBe(1)
    expect(hook.health.lastError).toContain('timed out')
  })

  it('skips disabled hooks', async () => {
    const fn = vi.fn()
    const hook = makeHook({ handler: fn, enabled: false })
    const result = await safeExec(hook, ctx)
    expect(result).toBeUndefined()
    expect(fn).not.toHaveBeenCalled()
  })

  it('tracks success rate correctly', async () => {
    const hook = makeHook({
      handler: async () => 'ok',
    })

    await safeExec(hook, ctx)
    await safeExec(hook, ctx)
    expect(hook.health.successRate).toBe(1)
    expect(hook.health.totalRuns).toBe(2)

    // Now make it fail
    hook.handler = async () => { throw new Error('fail') }
    hook.safety.fallbackBehavior = 'skip'
    await safeExec(hook, ctx)
    expect(hook.health.totalRuns).toBe(3)
    expect(hook.health.successRate).toBeCloseTo(2 / 3, 1)
  })
})
