import { CronExpressionParser } from 'cron-parser'
import type { Hook, HookContext } from '../types.js'
import type { HookRunner } from './hook-runner.js'
import { safeExec } from './safety-shell.js'

/**
 * HookScheduler fires `trigger: 'cron'` hooks on their configured `schedule`.
 *
 * - Uses recursive setTimeout (not setInterval) to avoid drift and handle
 *   variable intervals (e.g. `0 9 * * 1-5`).
 * - `refresh()` should be called after any hook registration change so new
 *   cron hooks start ticking (and removed/disabled ones stop).
 */
export class HookScheduler {
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private running = false

  constructor(private readonly runner: HookRunner) {}

  /** Begin scanning hooks and scheduling next-fire timers for each cron hook. */
  start(): void {
    if (this.running) return
    this.running = true
    this.refresh()
  }

  /** Stop all pending timers. No-op if not running. */
  stop(): void {
    this.running = false
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
  }

  /** Re-scan registered hooks; schedule new cron hooks, drop stale ones. */
  refresh(): void {
    if (!this.running) return
    const cronHooks = this.runner
      .getAll()
      .filter((h) => h.trigger === 'cron' && h.enabled && typeof h.schedule === 'string')

    const activeIds = new Set(cronHooks.map((h) => h.id))

    // Drop timers for hooks that are no longer active
    for (const [id, timer] of this.timers) {
      if (!activeIds.has(id)) {
        clearTimeout(timer)
        this.timers.delete(id)
      }
    }

    // Schedule any new cron hooks
    for (const hook of cronHooks) {
      if (!this.timers.has(hook.id)) {
        this.scheduleNext(hook)
      }
    }
  }

  /** Number of currently armed timers (for tests/introspection). */
  get activeCount(): number {
    return this.timers.size
  }

  private scheduleNext(hook: Hook): void {
    if (!this.running) return
    const schedule = hook.schedule
    if (!schedule) return

    let delay: number
    try {
      const interval = CronExpressionParser.parse(schedule)
      const next = interval.next().getTime()
      delay = Math.max(0, next - Date.now())
    } catch (err) {
      // Invalid cron expression — log and skip (don't throw; bad user data
      // shouldn't crash the scheduler).
      // eslint-disable-next-line no-console
      console.error(`[hook-scheduler] invalid schedule for hook ${hook.id}:`, err)
      return
    }

    const timer = setTimeout(() => {
      this.timers.delete(hook.id)
      void this.fire(hook)
    }, delay)
    this.timers.set(hook.id, timer)
  }

  private async fire(hook: Hook): Promise<void> {
    if (!this.running) return

    // Re-fetch the latest copy: hook may have been disabled since we armed.
    const latest = this.runner.getById(hook.id)
    if (!latest || !latest.enabled || latest.trigger !== 'cron') {
      return
    }

    const context: HookContext = {
      trigger: 'cron',
      data: { firedAt: new Date().toISOString(), hookId: latest.id },
      agent: { sessionId: 'scheduler', totalCost: 0, tokenCount: 0 },
    }

    try {
      await safeExec(latest, context)
    } catch (err) {
      // safeExec already handles most errors; belt-and-suspenders.
      // eslint-disable-next-line no-console
      console.error(`[hook-scheduler] hook ${latest.id} threw:`, err)
    }

    // Chain to next fire time
    this.scheduleNext(latest)
  }
}
