// ============================================================
// Core Hook: budget-guard
// ============================================================
//
// Trigger: before:llm-call (modifying)
//
// Runs three layers of token-budget enforcement in order:
//   1. Global   — per session + per day hard ceilings
//   2. Main     — per user-task soft budget
//   3. Sub-agent — per TaskAssign.config.tokenBudget (inner-most)
//
// Each layer can:
//   - allow    → pass through
//   - warn     → log and continue
//   - downgrade → mutate the in-flight request to use a cheaper model
//   - block    → throw an Error so the caller (HookRunner modifying mode via
//                safeExec) aborts the outgoing LLM call
//
// Paired with an after:llm-call recorder below that feeds actual token usage
// back into the BudgetManager.

import type { Hook, HookContext, LLMCallMetrics } from '../../types.js'
import {
  BudgetManager,
  estimateHistoryTokens,
} from '../../metrics/budget.js'

interface HistoryData {
  history?: Array<{ role: string; content: string }>
  /** Optional pre-computed estimate; if present we trust it over the fallback. */
  estimatedTokens?: number
  /** Optional model name that downstream will use; guard can mutate this. */
  model?: string
}

/**
 * Build a budget-guard hook bound to a shared BudgetManager.
 *
 * The hook lives on `before:llm-call` and reads the pending call's history
 * from `context.data` (same shape the context-window-guard uses) to produce
 * a pre-call token estimate.
 */
export function createBudgetGuard(budgetManager: BudgetManager): Hook {
  return {
    id: 'core:budget-guard',
    name: 'budget-guard',
    description: 'Three-layer token budget enforcement (global / main / sub-agent)',
    trigger: 'before:llm-call',
    // Run BEFORE context-window-guard (priority 100) so we abort early when
    // we're already over a hard ceiling. Slightly higher priority.
    priority: 110,
    enabled: true,
    source: 'core',

    async handler(context: HookContext): Promise<unknown> {
      const data = (context.data ?? {}) as HistoryData
      const estimate = typeof data.estimatedTokens === 'number'
        ? data.estimatedTokens
        : estimateHistoryTokens(data.history)

      const { sessionId, taskId, subAgentTaskId, subAgentTokenBudget } = context.agent

      // --- Layer 3: global (session + daily) ---
      const globalCheck = budgetManager.checkGlobal(sessionId, estimate)
      if (globalCheck.decision === 'block') {
        throw new Error(`[budget-guard] ${globalCheck.reason} [layer=global]`)
      }

      // --- Layer 2: main per-task ---
      if (taskId) {
        const mainCheck = budgetManager.checkMain(taskId, estimate)
        if (mainCheck.decision === 'block') {
          throw new Error(`[budget-guard] ${mainCheck.reason} [layer=main]`)
        }
        if (mainCheck.decision === 'warn') {
          console.warn(
            `[budget-guard] main task ${taskId} at ${(mainCheck.ratio * 100).toFixed(0)}% of budget`,
          )
        }
      }

      // --- Layer 1: sub-agent per-task ---
      let mutatedModel: string | undefined
      if (subAgentTaskId) {
        const subCheck = budgetManager.checkSubAgent(
          subAgentTaskId,
          subAgentTokenBudget,
          estimate,
        )
        if (subCheck.decision === 'block') {
          throw new Error(`[budget-guard] ${subCheck.reason} [layer=sub-agent]`)
        }
        if (subCheck.decision === 'warn') {
          console.warn(
            `[budget-guard] sub-agent task ${subAgentTaskId} at ${(subCheck.ratio * 100).toFixed(0)}% of budget`,
          )
        }
        if (subCheck.decision === 'downgrade') {
          console.warn(`[budget-guard] ${subCheck.reason}`)
          mutatedModel = subCheck.toModel
        }
      }

      // If nothing to mutate, return undefined (HookRunner treats undefined as "pass through").
      if (mutatedModel === undefined) {
        return undefined
      }
      return { ...data, model: mutatedModel }
    },

    health: { consecutiveFailures: 0, totalRuns: 0, successRate: 1 },
    safety: { timeout: 500, maxRetries: 0, fallbackBehavior: 'abort', canBeDisabledByAgent: false },
  }
}

/**
 * After-call recorder — feeds actual token usage back into the BudgetManager.
 * Paired with createBudgetGuard; register both from the same wiring site.
 */
export function createBudgetRecorder(budgetManager: BudgetManager): Hook {
  return {
    id: 'core:budget-recorder',
    name: 'budget-recorder',
    description: 'Record actual LLM token usage into the BudgetManager after each call',
    trigger: 'after:llm-call',
    priority: 110,
    enabled: true,
    source: 'core',

    async handler(context: HookContext): Promise<unknown> {
      const metrics = context.data as LLMCallMetrics | undefined
      if (!metrics || !metrics.tokens) return undefined
      const used = (metrics.tokens.prompt ?? 0) + (metrics.tokens.completion ?? 0)
      if (used <= 0) return undefined

      budgetManager.recordUsage(
        {
          sessionId: context.agent.sessionId,
          taskId: context.agent.taskId,
          subAgentTaskId: context.agent.subAgentTaskId,
        },
        used,
      )
      // Fire-and-forget flush; errors swallowed inside BudgetManager.
      void budgetManager.flush()
      return undefined
    },

    health: { consecutiveFailures: 0, totalRuns: 0, successRate: 1 },
    safety: { timeout: 500, maxRetries: 0, fallbackBehavior: 'skip', canBeDisabledByAgent: false },
  }
}
