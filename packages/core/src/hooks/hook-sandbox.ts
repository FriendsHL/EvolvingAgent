import type { Hook, HookContext } from '../types.js'

export interface SandboxConfig {
  graduationThreshold: number
  minSuccessRate: number
}

export interface SandboxedHook {
  hook: Hook
  runs: number
  successes: number
  failures: number
  errors: string[]
  graduated: boolean
}

const DEFAULT_CONFIG: SandboxConfig = {
  graduationThreshold: 10,
  minSuccessRate: 0.8,
}

const MAX_RECORDED_ERRORS = 5

export class HookSandbox {
  private sandboxed = new Map<string, SandboxedHook>()
  private config: SandboxConfig

  constructor(config?: Partial<SandboxConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /** Add a new hook to the sandbox */
  add(hook: Hook): void {
    this.sandboxed.set(hook.id, {
      hook,
      runs: 0,
      successes: 0,
      failures: 0,
      errors: [],
      graduated: false,
    })
  }

  /** Execute a sandboxed hook — errors are caught and recorded, never propagated */
  async execute(hookId: string, context: HookContext): Promise<{ success: boolean; error?: string }> {
    const entry = this.sandboxed.get(hookId)
    if (!entry) return { success: false, error: 'Hook not found in sandbox' }

    try {
      await entry.hook.handler(context)

      entry.runs++
      entry.successes++
      entry.hook.health.totalRuns++
      entry.hook.health.consecutiveFailures = 0
      entry.hook.health.lastSuccess = new Date().toISOString()
      entry.hook.health.successRate = entry.successes / entry.runs

      this.checkGraduation(entry)
      return { success: true }
    } catch (err) {
      const errorMessage = String(err)

      entry.runs++
      entry.failures++
      entry.errors.push(errorMessage)
      // Keep only last N errors
      if (entry.errors.length > MAX_RECORDED_ERRORS) {
        entry.errors = entry.errors.slice(-MAX_RECORDED_ERRORS)
      }

      entry.hook.health.totalRuns++
      entry.hook.health.consecutiveFailures++
      entry.hook.health.lastError = errorMessage
      entry.hook.health.successRate = entry.successes / entry.runs

      this.checkGraduation(entry)
      return { success: false, error: errorMessage }
    }
  }

  /** Check if a hook has graduated (enough successful runs with good success rate) */
  isGraduated(hookId: string): boolean {
    const entry = this.sandboxed.get(hookId)
    return entry?.graduated ?? false
  }

  /** Get all hooks ready for graduation */
  getGraduated(): Hook[] {
    const graduated: Hook[] = []
    for (const entry of this.sandboxed.values()) {
      if (entry.graduated) {
        graduated.push(entry.hook)
      }
    }
    return graduated
  }

  /** Get sandbox status for a hook */
  getStatus(hookId: string): SandboxedHook | undefined {
    return this.sandboxed.get(hookId)
  }

  /** List all sandboxed hooks */
  list(): SandboxedHook[] {
    return [...this.sandboxed.values()]
  }

  /** Remove a hook from sandbox (after graduation or rejection) */
  remove(hookId: string): void {
    this.sandboxed.delete(hookId)
  }

  private checkGraduation(entry: SandboxedHook): void {
    if (entry.graduated) return
    if (
      entry.runs >= this.config.graduationThreshold &&
      entry.successes / entry.runs >= this.config.minSuccessRate
    ) {
      entry.graduated = true
    }
  }
}
