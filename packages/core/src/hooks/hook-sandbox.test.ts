import { describe, it, expect, beforeEach } from 'vitest'
import { HookSandbox } from './hook-sandbox.js'
import type { Hook, HookContext } from '../types.js'

function makeHook(overrides?: Partial<Hook>): Hook {
  return {
    id: `hook-test-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Test Hook',
    description: 'A test hook',
    trigger: 'before:tool-call',
    priority: 50,
    enabled: true,
    source: 'evolved-new',
    handler: async (_ctx: HookContext) => 'ok',
    health: { consecutiveFailures: 0, totalRuns: 0, successRate: 1.0 },
    safety: { timeout: 5000, maxRetries: 0, fallbackBehavior: 'skip', canBeDisabledByAgent: true },
    ...overrides,
  }
}

function makeContext(): HookContext {
  return {
    trigger: 'before:tool-call',
    data: { toolName: 'shell', params: {} },
    agent: { sessionId: 'test-session', totalCost: 0, tokenCount: 0 },
  }
}

describe('HookSandbox', () => {
  let sandbox: HookSandbox

  beforeEach(() => {
    sandbox = new HookSandbox()
  })

  it('add() adds hook to sandbox', () => {
    const hook = makeHook()
    sandbox.add(hook)
    expect(sandbox.list()).toHaveLength(1)
    expect(sandbox.list()[0].hook.id).toBe(hook.id)
  })

  it('list() returns all sandboxed hooks', () => {
    sandbox.add(makeHook({ id: 'h1' }))
    sandbox.add(makeHook({ id: 'h2' }))
    sandbox.add(makeHook({ id: 'h3' }))
    expect(sandbox.list()).toHaveLength(3)
  })

  it('execute() records success on successful handler', async () => {
    const hook = makeHook({ handler: async () => 'ok' })
    sandbox.add(hook)

    const result = await sandbox.execute(hook.id, makeContext())
    expect(result.success).toBe(true)

    const status = sandbox.getStatus(hook.id)!
    expect(status.runs).toBe(1)
    expect(status.successes).toBe(1)
    expect(status.failures).toBe(0)
  })

  it('execute() catches errors and records failure', async () => {
    const hook = makeHook({ handler: async () => { throw new Error('boom') } })
    sandbox.add(hook)

    const result = await sandbox.execute(hook.id, makeContext())
    expect(result.success).toBe(false)
    expect(result.error).toContain('boom')

    const status = sandbox.getStatus(hook.id)!
    expect(status.runs).toBe(1)
    expect(status.failures).toBe(1)
    expect(status.errors).toHaveLength(1)
  })

  it('errors never propagate from execute()', async () => {
    const hook = makeHook({ handler: async () => { throw new Error('should not propagate') } })
    sandbox.add(hook)

    // Should not throw
    const result = await sandbox.execute(hook.id, makeContext())
    expect(result.success).toBe(false)
  })

  it('isGraduated() returns true after enough successful runs (default 10)', async () => {
    const hook = makeHook({ handler: async () => 'ok' })
    sandbox.add(hook)

    for (let i = 0; i < 10; i++) {
      await sandbox.execute(hook.id, makeContext())
    }
    expect(sandbox.isGraduated(hook.id)).toBe(true)
  })

  it('isGraduated() returns false if success rate too low', async () => {
    const callCount = { n: 0 }
    const hook = makeHook({
      handler: async () => {
        callCount.n++
        // Fail 5 out of 10 times (50% rate, below 80% threshold)
        if (callCount.n <= 5) throw new Error('fail')
        return 'ok'
      },
    })
    sandbox.add(hook)

    for (let i = 0; i < 10; i++) {
      await sandbox.execute(hook.id, makeContext())
    }
    // 50% success rate, threshold is 80%
    expect(sandbox.isGraduated(hook.id)).toBe(false)
  })

  it('getGraduated() returns graduated hooks', async () => {
    const hook = makeHook({ handler: async () => 'ok' })
    sandbox.add(hook)

    for (let i = 0; i < 10; i++) {
      await sandbox.execute(hook.id, makeContext())
    }

    const graduated = sandbox.getGraduated()
    expect(graduated).toHaveLength(1)
    expect(graduated[0].id).toBe(hook.id)
  })

  it('remove() removes hook from sandbox', () => {
    const hook = makeHook()
    sandbox.add(hook)
    expect(sandbox.list()).toHaveLength(1)
    sandbox.remove(hook.id)
    expect(sandbox.list()).toHaveLength(0)
  })

  it('getStatus() returns correct run counts', async () => {
    const callCount = { n: 0 }
    const hook = makeHook({
      handler: async () => {
        callCount.n++
        if (callCount.n === 2) throw new Error('fail once')
        return 'ok'
      },
    })
    sandbox.add(hook)

    await sandbox.execute(hook.id, makeContext())
    await sandbox.execute(hook.id, makeContext()) // fails
    await sandbox.execute(hook.id, makeContext())

    const status = sandbox.getStatus(hook.id)!
    expect(status.runs).toBe(3)
    expect(status.successes).toBe(2)
    expect(status.failures).toBe(1)
  })
})
