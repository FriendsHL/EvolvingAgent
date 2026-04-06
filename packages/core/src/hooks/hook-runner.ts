import type { Hook, HookContext, HookTrigger } from '../types.js'
import type { HookSandbox, SandboxedHook } from './hook-sandbox.js'
import { HookScheduler } from './hook-scheduler.js'
import { safeExec } from './safety-shell.js'

// Trigger → execution mode mapping
const VOID_TRIGGERS: HookTrigger[] = ['after:llm-call', 'on:error', 'cron', 'on:startup']
const MODIFYING_TRIGGERS: HookTrigger[] = [
  'before:plan', 'before:llm-call', 'after:reflect', 'after:tool-call', 'after:plan',
]
const CLAIMING_TRIGGERS: HookTrigger[] = [] // Phase 2+: sub-agent task routing

function byPriority(a: Hook, b: Hook): number {
  return b.priority - a.priority // Higher priority first
}

export class HookRunner {
  private hooks: Hook[] = []
  private sandbox?: HookSandbox
  private scheduler?: HookScheduler

  /** Set the sandbox for evolved hooks */
  setSandbox(sandbox: HookSandbox): void {
    this.sandbox = sandbox
  }

  /** Start the cron scheduler (idempotent). Call after core hooks are registered. */
  startScheduler(): HookScheduler {
    if (!this.scheduler) {
      this.scheduler = new HookScheduler(this)
    }
    this.scheduler.start()
    return this.scheduler
  }

  /** Stop and discard the cron scheduler if running. */
  stopScheduler(): void {
    this.scheduler?.stop()
  }

  /** Access the scheduler (undefined if never started). */
  getScheduler(): HookScheduler | undefined {
    return this.scheduler
  }

  /** Register an evolved hook (goes to sandbox first if sandbox is set) */
  registerEvolved(hook: Hook): void {
    if (this.sandbox) {
      this.sandbox.add(hook)
    } else {
      this.hooks.push(hook)
    }
  }

  /** Graduate sandboxed hooks that have proven themselves */
  graduateSandboxedHooks(): Hook[] {
    if (!this.sandbox) return []
    const graduated = this.sandbox.getGraduated()
    for (const hook of graduated) {
      hook.source = 'evolved-verified'
      this.hooks.push(hook)
      this.sandbox.remove(hook.id)
    }
    return graduated
  }

  /** Get all hooks including sandboxed */
  getAllIncludingSandbox(): Array<Hook & { sandboxed?: boolean; sandboxStatus?: SandboxedHook }> {
    const main = this.hooks.map((h) => ({ ...h, sandboxed: false as const }))
    if (!this.sandbox) return main
    const sandboxed = this.sandbox.list().map((entry) => ({
      ...entry.hook,
      sandboxed: true as const,
      sandboxStatus: entry,
    }))
    return [...main, ...sandboxed]
  }

  register(hook: Hook): void {
    this.hooks.push(hook)
    if (hook.trigger === 'cron') this.scheduler?.refresh()
  }

  registerAll(hooks: Hook[]): void {
    this.hooks.push(...hooks)
    if (hooks.some((h) => h.trigger === 'cron')) this.scheduler?.refresh()
  }

  getEnabled(trigger: HookTrigger): Hook[] {
    return this.hooks
      .filter((h) => h.trigger === trigger && h.enabled)
      .sort(byPriority)
  }

  /**
   * Void mode: all hooks run in parallel, fire-and-forget.
   * Used for logging, metrics, error reporting.
   */
  async runVoid(trigger: HookTrigger, context: HookContext): Promise<void> {
    const hooks = this.getEnabled(trigger)
    await Promise.all(hooks.map((h) => safeExec(h, context)))
  }

  /**
   * Modifying mode: hooks run sequentially, each can transform data.
   * Returns the final modified data.
   */
  async runModifying<T>(trigger: HookTrigger, context: HookContext, data: T): Promise<T> {
    const hooks = this.getEnabled(trigger)
    let result = data
    for (const hook of hooks) {
      const modified = await safeExec(hook, { ...context, data: result })
      if (modified !== undefined) {
        result = modified as T
      }
    }
    return result
  }

  /**
   * Claiming mode: hooks run sequentially, first one to handle wins.
   * Returns the result from the first claiming hook, or undefined.
   */
  async runClaiming(trigger: HookTrigger, context: HookContext): Promise<unknown> {
    const hooks = this.getEnabled(trigger)
    for (const hook of hooks) {
      const result = await safeExec(hook, context) as { handled?: boolean } | undefined
      if (result?.handled) return result
    }
    return undefined
  }

  // === Introspection API (for web dashboard) ===

  getAll(): Hook[] {
    return [...this.hooks]
  }

  getById(id: string): Hook | undefined {
    return this.hooks.find((h) => h.id === id)
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const hook = this.hooks.find((h) => h.id === id)
    if (!hook) return false
    hook.enabled = enabled
    if (hook.trigger === 'cron') this.scheduler?.refresh()
    return true
  }

  setPriority(id: string, priority: number): boolean {
    const hook = this.hooks.find((h) => h.id === id)
    if (!hook) return false
    hook.priority = priority
    return true
  }

  /**
   * Auto-detect execution mode from trigger type and run.
   */
  async run<T>(trigger: HookTrigger, context: HookContext, data?: T): Promise<T | undefined> {
    let result: T | undefined

    if (VOID_TRIGGERS.includes(trigger)) {
      await this.runVoid(trigger, context)
      result = data
    } else if (CLAIMING_TRIGGERS.includes(trigger)) {
      result = (await this.runClaiming(trigger, context)) as T | undefined
    } else if (data !== undefined) {
      // Default to modifying
      result = await this.runModifying(trigger, context, data)
    } else {
      await this.runVoid(trigger, context)
      result = undefined
    }

    // Run sandboxed hooks (fire-and-forget, errors swallowed)
    await this.runSandboxed(trigger, context)

    return result
  }

  /** Run sandboxed hooks for the given trigger — errors never propagate */
  private async runSandboxed(trigger: HookTrigger, context: HookContext): Promise<void> {
    if (!this.sandbox) return
    const entries = this.sandbox.list().filter((e) => e.hook.trigger === trigger && e.hook.enabled)
    await Promise.all(
      entries.map((entry) => this.sandbox!.execute(entry.hook.id, context)),
    )
  }
}
