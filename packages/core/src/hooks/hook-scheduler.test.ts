import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HookRunner } from './hook-runner.js'
import { HookScheduler } from './hook-scheduler.js'
import type { Hook } from '../types.js'

function makeCronHook(overrides: Partial<Hook> & { handler: Hook['handler']; schedule: string }): Hook {
  return {
    id: 'cron-hook',
    name: 'cron-hook',
    description: 'test cron hook',
    trigger: 'cron',
    priority: 50,
    enabled: true,
    source: 'core',
    health: { consecutiveFailures: 0, totalRuns: 0, successRate: 1 },
    safety: { timeout: 5000, maxRetries: 0, fallbackBehavior: 'skip', canBeDisabledByAgent: true },
    ...overrides,
  }
}

describe('HookScheduler', () => {
  beforeEach(() => {
    // Pin to a known wall-clock so cron math is predictable.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('schedules a timer for a cron hook on start()', () => {
    const runner = new HookRunner()
    runner.register(
      makeCronHook({
        id: 'h1',
        schedule: '*/5 * * * *',
        handler: async () => undefined,
      }),
    )

    const scheduler = new HookScheduler(runner)
    scheduler.start()
    expect(scheduler.activeCount).toBe(1)
    scheduler.stop()
  })

  it('fires the hook handler when its next time arrives', async () => {
    const runner = new HookRunner()
    const handler = vi.fn(async () => undefined)

    runner.register(
      makeCronHook({
        id: 'h-fire',
        // Every minute — next fire is 60s away from 00:00:00.
        schedule: '* * * * *',
        handler,
      }),
    )

    const scheduler = new HookScheduler(runner)
    scheduler.start()

    // Advance past the first fire plus microtask drain for safeExec.
    await vi.advanceTimersByTimeAsync(61_000)

    expect(handler).toHaveBeenCalledTimes(1)
    // After firing, scheduler should chain a new timer.
    expect(scheduler.activeCount).toBe(1)

    scheduler.stop()
  })

  it('refresh() picks up newly registered cron hooks', () => {
    const runner = new HookRunner()
    const scheduler = runner.startScheduler()
    expect(scheduler.activeCount).toBe(0)

    runner.register(
      makeCronHook({
        id: 'late',
        schedule: '0 * * * *',
        handler: async () => undefined,
      }),
    )

    // register() should have auto-refreshed the scheduler.
    expect(scheduler.activeCount).toBe(1)
    scheduler.stop()
  })

  it('stop() clears all timers', () => {
    const runner = new HookRunner()
    runner.registerAll([
      makeCronHook({ id: 'a', schedule: '*/5 * * * *', handler: async () => undefined }),
      makeCronHook({ id: 'b', schedule: '0 * * * *', handler: async () => undefined }),
    ])

    const scheduler = new HookScheduler(runner)
    scheduler.start()
    expect(scheduler.activeCount).toBe(2)

    scheduler.stop()
    expect(scheduler.activeCount).toBe(0)
  })

  it('ignores hooks with an invalid cron expression (does not throw)', () => {
    const runner = new HookRunner()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    runner.register(
      makeCronHook({
        id: 'bad',
        schedule: 'not-a-cron',
        handler: async () => undefined,
      }),
    )

    const scheduler = new HookScheduler(runner)
    expect(() => scheduler.start()).not.toThrow()
    expect(scheduler.activeCount).toBe(0)
    expect(errSpy).toHaveBeenCalled()

    scheduler.stop()
    errSpy.mockRestore()
  })

  it('does not fire hooks that were disabled after scheduling', async () => {
    const runner = new HookRunner()
    const handler = vi.fn(async () => undefined)

    runner.register(
      makeCronHook({
        id: 'h-disable',
        schedule: '* * * * *',
        handler,
      }),
    )

    const scheduler = runner.startScheduler()
    runner.setEnabled('h-disable', false)

    await vi.advanceTimersByTimeAsync(61_000)
    expect(handler).not.toHaveBeenCalled()

    scheduler.stop()
  })
})
