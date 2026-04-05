import type { Hook, HookContext, LLMCallMetrics } from '../../types.js'

/**
 * Collects LLM call metrics for later analysis.
 * Stores metrics in-memory; the MetricsCollector class handles persistence.
 */
const collectedMetrics: LLMCallMetrics[] = []

export function getCollectedMetrics(): LLMCallMetrics[] {
  return collectedMetrics
}

export function clearCollectedMetrics(): void {
  collectedMetrics.length = 0
}

/**
 * Core Hook: metrics-collector
 * Trigger: after:llm-call (void)
 * Records token usage and cache metrics after every LLM call.
 */
export const metricsCollectorHook: Hook = {
  id: 'core:metrics-collector',
  name: 'metrics-collector',
  description: 'Record token/cache metrics after every LLM call',
  trigger: 'after:llm-call',
  priority: 100,
  enabled: true,
  source: 'core',

  async handler(context: HookContext): Promise<unknown> {
    const metrics = context.data as LLMCallMetrics
    if (metrics?.callId) {
      collectedMetrics.push(metrics)
    }
    return undefined
  },

  health: { consecutiveFailures: 0, totalRuns: 0, successRate: 1 },
  safety: { timeout: 500, maxRetries: 0, fallbackBehavior: 'skip', canBeDisabledByAgent: false },
}
