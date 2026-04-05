import type { Hook, HookContext } from '../../types.js'

const DEFAULT_SESSION_COST_LIMIT = 5.0 // $5 per session

/**
 * Core Hook: cost-hard-limit
 * Trigger: before:llm-call (modifying)
 * Aborts execution if session cost exceeds the hard limit.
 */
export const costHardLimit: Hook = {
  id: 'core:cost-hard-limit',
  name: 'cost-hard-limit',
  description: 'Abort execution if session cost exceeds the hard limit',
  trigger: 'before:llm-call',
  priority: 100,
  enabled: true,
  source: 'core',

  async handler(context: HookContext): Promise<unknown> {
    const limit = DEFAULT_SESSION_COST_LIMIT
    if (context.agent.totalCost >= limit) {
      throw new Error(
        `[cost-hard-limit] Session cost ($${context.agent.totalCost.toFixed(4)}) exceeded limit ($${limit.toFixed(2)}). Aborting.`,
      )
    }
    return undefined
  },

  health: { consecutiveFailures: 0, totalRuns: 0, successRate: 1 },
  safety: { timeout: 500, maxRetries: 0, fallbackBehavior: 'abort', canBeDisabledByAgent: false },
}
