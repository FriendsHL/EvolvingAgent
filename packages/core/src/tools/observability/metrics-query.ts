import type { Tool, ToolResult } from '../../types.js'
import type { CacheAggregate, CacheMetricsRecorder } from '../../metrics/cache-metrics.js'
import type { BudgetManager } from '../../metrics/budget.js'

/**
 * metrics-query — a built-in observability tool the Agent can call to inspect
 * its own cache metrics and token budget state. Closure-binds the shared
 * CacheMetricsRecorder + BudgetManager from SessionManager so every session
 * sees the same numbers.
 */
export function createMetricsQueryTool(
  recorder: CacheMetricsRecorder,
  budgetManager: BudgetManager,
): Tool {
  return {
    name: 'metrics-query',
    description:
      "Query the agent's own cache metrics and token budget. Use this when the user asks about cache hit ratio, token spending, recent LLM calls, or budget remaining.",
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['session', 'day', 'recent', 'budget'],
          description:
            "What to query: 'session' = current session aggregate, 'day' = a specific YYYY-MM-DD, 'recent' = last N minutes, 'budget' = current budget consumption",
        },
        sessionId: { type: 'string', description: "Required when scope='session'" },
        date: { type: 'string', description: "YYYY-MM-DD; required when scope='day'" },
        windowMinutes: {
          type: 'number',
          description: "Required when scope='recent'; minutes back from now",
        },
      },
      required: ['scope'],
    },
    async execute(params): Promise<ToolResult> {
      const scope = params.scope as string | undefined
      if (!scope) {
        return { success: false, output: '', error: 'scope is required' }
      }

      switch (scope) {
        case 'session': {
          const sessionId = params.sessionId as string | undefined
          if (!sessionId) {
            return { success: false, output: '', error: "sessionId is required when scope='session'" }
          }
          const agg = recorder.aggregateBySession(sessionId)
          return {
            success: true,
            output: formatAggregate(`Session ${sessionId}`, agg),
          }
        }
        case 'day': {
          const date = params.date as string | undefined
          if (!date) {
            return { success: false, output: '', error: "date is required when scope='day'" }
          }
          const agg = recorder.aggregateByDay(date)
          return { success: true, output: formatAggregate(`Day ${date}`, agg) }
        }
        case 'recent': {
          const windowMinutes = params.windowMinutes as number | undefined
          if (typeof windowMinutes !== 'number' || windowMinutes <= 0) {
            return {
              success: false,
              output: '',
              error: "windowMinutes (positive number) is required when scope='recent'",
            }
          }
          const agg = recorder.aggregateRecent(windowMinutes * 60_000)
          return {
            success: true,
            output: formatAggregate(`Last ${windowMinutes} minutes`, agg),
          }
        }
        case 'budget': {
          return { success: true, output: formatBudget(budgetManager, params.sessionId as string | undefined) }
        }
        default:
          return { success: false, output: '', error: `Unknown scope: ${scope}` }
      }
    },
  }
}

function formatAggregate(label: string, agg: CacheAggregate): string {
  if (agg.totalCalls === 0) {
    return `${label}: no LLM calls recorded in this window.`
  }
  const hitPct = (agg.hitRatio * 100).toFixed(1)
  const lines = [
    `${label} — cache aggregate`,
    `  total calls:          ${fmt(agg.totalCalls)}`,
    `  hit ratio:            ${hitPct}%`,
    `  input tokens:         ${fmt(agg.totalInputTokens)}`,
    `  output tokens:        ${fmt(agg.totalOutputTokens)}`,
    `  cache read tokens:    ${fmt(agg.totalCacheReadTokens)}`,
    `  cache create tokens:  ${fmt(agg.totalCacheCreationTokens)}`,
    `  avg latency:          ${agg.avgLatencyMs.toFixed(0)} ms`,
  ]
  if (agg.windowStart > 0) {
    lines.push(
      `  window:               ${new Date(agg.windowStart).toISOString()} → ${new Date(agg.windowEnd).toISOString()}`,
    )
  }
  return lines.join('\n')
}

function formatBudget(bm: BudgetManager, sessionId: string | undefined): string {
  const cfg = bm.getConfig()
  const today = new Date().toISOString().slice(0, 10)
  const dailyUsed = bm.getDailyUsage(today)
  const lines: string[] = ['Token budget snapshot', '', 'Global (process-wide):']
  lines.push(
    `  daily used:    ${fmt(dailyUsed)} / ${fmt(cfg.global.perDay)} (${pct(dailyUsed, cfg.global.perDay)})`,
  )
  if (sessionId) {
    const sessionUsed = bm.getSessionUsage(sessionId)
    lines.push(
      `  session used:  ${fmt(sessionUsed)} / ${fmt(cfg.global.perSession)} (${pct(sessionUsed, cfg.global.perSession)}) [${sessionId}]`,
    )
  } else {
    lines.push(`  session cap:   ${fmt(cfg.global.perSession)} per session`)
  }
  lines.push('', 'Main agent:')
  lines.push(`  per-task budget: ${fmt(cfg.main.perTask)}  (warn at ${(cfg.main.warnRatio * 100).toFixed(0)}%)`)
  lines.push('', 'Sub-agent:')
  lines.push(
    `  default per-task: ${fmt(cfg.subAgent.defaultPerTask)}  (warn at ${(cfg.subAgent.warnRatio * 100).toFixed(0)}%)`,
  )
  if (cfg.subAgent.downgradeModel) {
    lines.push(`  downgrade model:  ${cfg.subAgent.downgradeModel}`)
  }
  return lines.join('\n')
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

function pct(used: number, total: number): string {
  if (total <= 0) return '0.0%'
  return `${((used / total) * 100).toFixed(1)}%`
}
