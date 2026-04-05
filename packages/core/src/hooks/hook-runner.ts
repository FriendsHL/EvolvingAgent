import type { Hook, HookContext, HookTrigger } from '../types.js'
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

  register(hook: Hook): void {
    this.hooks.push(hook)
  }

  registerAll(hooks: Hook[]): void {
    this.hooks.push(...hooks)
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

  /**
   * Auto-detect execution mode from trigger type and run.
   */
  async run<T>(trigger: HookTrigger, context: HookContext, data?: T): Promise<T | undefined> {
    if (VOID_TRIGGERS.includes(trigger)) {
      await this.runVoid(trigger, context)
      return data
    }
    if (CLAIMING_TRIGGERS.includes(trigger)) {
      return (await this.runClaiming(trigger, context)) as T | undefined
    }
    // Default to modifying
    if (data !== undefined) {
      return await this.runModifying(trigger, context, data)
    }
    await this.runVoid(trigger, context)
    return undefined
  }
}
