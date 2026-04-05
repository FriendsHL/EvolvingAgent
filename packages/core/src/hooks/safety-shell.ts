import type { Hook, HookContext } from '../types.js'

const AUTO_DISABLE_THRESHOLD = 3

/**
 * Execute a hook with timeout and failure tracking.
 * If a hook fails 3 consecutive times, it is auto-disabled.
 */
export async function safeExec(hook: Hook, context: HookContext): Promise<unknown> {
  if (!hook.enabled) return undefined

  try {
    const result = await Promise.race([
      hook.handler(context),
      timeout(hook.safety.timeout),
    ])

    // Success — reset failure counter
    hook.health.consecutiveFailures = 0
    hook.health.totalRuns++
    hook.health.successRate =
      (hook.health.successRate * (hook.health.totalRuns - 1) + 1) / hook.health.totalRuns
    hook.health.lastSuccess = new Date().toISOString()

    return result
  } catch (err) {
    hook.health.consecutiveFailures++
    hook.health.totalRuns++
    hook.health.successRate =
      (hook.health.successRate * (hook.health.totalRuns - 1)) / hook.health.totalRuns
    hook.health.lastError = String(err)

    // Auto-disable after threshold
    if (
      hook.health.consecutiveFailures >= AUTO_DISABLE_THRESHOLD &&
      hook.safety.canBeDisabledByAgent
    ) {
      hook.enabled = false
      console.warn(`[SafetyShell] Hook "${hook.name}" auto-disabled after ${AUTO_DISABLE_THRESHOLD} consecutive failures`)
    }

    // Apply fallback behavior
    switch (hook.safety.fallbackBehavior) {
      case 'skip':
        return undefined
      case 'use-default':
        return undefined
      case 'abort':
        throw err
    }
  }
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Hook timed out after ${ms}ms`)), ms),
  )
}
