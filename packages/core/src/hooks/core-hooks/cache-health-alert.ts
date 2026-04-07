// ============================================================
// Core Hook: cache-health-alert
// ============================================================
//
// Trigger: cron (default every 5 minutes)
//
// Periodically reads the recent cache aggregate from the shared
// CacheMetricsRecorder and fires an alert when prompt-cache hit ratio drops
// below a configured floor. This is the watchdog for "we are paying full
// price for tokens we should have been caching".
//
// v1 dispatch is a console.warn plus an optional `onAlert` callback. Phase
// 3 Batch 5 will register a Channel listener (Feishu / etc.) onto the same
// callback so alerts can fan out to external systems without changing this
// hook.
//
// This hook is registered ONCE on a SessionManager-owned "system" HookRunner
// (not per-Agent) so it fires globally, not once per session.

import type { Hook, HookContext } from '../../types.js'
import type { CacheMetricsRecorder, CacheAggregate } from '../../metrics/cache-metrics.js'

export interface CacheHealthAlert {
  ts: number
  windowMs: number
  hitRatio: number
  threshold: number
  totalCalls: number
  totalInputTokens: number
  totalCacheReadTokens: number
  reason: string
}

export interface CacheHealthAlertOptions {
  /**
   * Cron schedule. Defaults to every 5 minutes (`*\/5 * * * *`).
   */
  schedule?: string
  /**
   * Window over which to compute the hit ratio. Defaults to 15 minutes.
   * The window should be longer than the cron interval so consecutive ticks
   * overlap and don't miss bursts.
   */
  windowMs?: number
  /**
   * Minimum hit-ratio floor (0..1). Below this an alert fires. Defaults to
   * 0.3 (i.e. fewer than 30% of input tokens were served from cache).
   */
  hitRatioFloor?: number
  /**
   * Minimum number of calls in the window before the hook bothers checking.
   * Avoids spurious alerts during cold start. Defaults to 5.
   */
  minCalls?: number
  /**
   * Optional alert sink. Called whenever an alert fires. Future Channel
   * implementations (Feishu, Slack, …) plug in here. Errors thrown by the
   * callback are caught and logged.
   */
  onAlert?: (alert: CacheHealthAlert) => void | Promise<void>
}

const DEFAULT_OPTIONS: Required<Omit<CacheHealthAlertOptions, 'onAlert'>> = {
  schedule: '*/5 * * * *',
  windowMs: 15 * 60 * 1000,
  hitRatioFloor: 0.3,
  minCalls: 5,
}

/**
 * Build a cache-health-alert cron hook bound to a shared CacheMetricsRecorder.
 *
 * Register on a SessionManager-owned HookRunner exactly once (not on every
 * Agent's per-session runner) so the cron fires globally.
 */
export function createCacheHealthAlert(
  recorder: CacheMetricsRecorder,
  options: CacheHealthAlertOptions = {},
): Hook {
  const { schedule, windowMs, hitRatioFloor, minCalls } = {
    ...DEFAULT_OPTIONS,
    ...options,
  }
  const onAlert = options.onAlert

  return {
    id: 'core:cache-health-alert',
    name: 'cache-health-alert',
    description:
      'Periodically check prompt-cache hit ratio; alert when it drops below the configured floor',
    trigger: 'cron',
    schedule,
    priority: 50,
    enabled: true,
    source: 'core',

    async handler(_context: HookContext): Promise<unknown> {
      const agg: CacheAggregate = recorder.aggregateRecent(windowMs)

      // Cold-start guard: not enough samples to be meaningful.
      if (agg.totalCalls < minCalls) return undefined

      // Anthropic-style cache reads dominate the win; the ratio is computed
      // server-side as cacheReadTokens / (cacheReadTokens + inputTokens).
      if (agg.hitRatio >= hitRatioFloor) return undefined

      const alert: CacheHealthAlert = {
        ts: Date.now(),
        windowMs,
        hitRatio: agg.hitRatio,
        threshold: hitRatioFloor,
        totalCalls: agg.totalCalls,
        totalInputTokens: agg.totalInputTokens,
        totalCacheReadTokens: agg.totalCacheReadTokens,
        reason:
          `cache hit ratio ${(agg.hitRatio * 100).toFixed(1)}% < floor ` +
          `${(hitRatioFloor * 100).toFixed(0)}% over last ` +
          `${Math.round(windowMs / 60000)}m (${agg.totalCalls} calls)`,
      }

      // v1 dispatch — log + optional callback. Batch 5 wires Channels here.
      // eslint-disable-next-line no-console
      console.warn(`[cache-health-alert] ${alert.reason}`)

      if (onAlert) {
        try {
          await onAlert(alert)
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[cache-health-alert] onAlert callback threw:', err)
        }
      }

      return alert
    },

    health: { consecutiveFailures: 0, totalRuns: 0, successRate: 1 },
    safety: {
      timeout: 2000,
      maxRetries: 0,
      fallbackBehavior: 'skip',
      canBeDisabledByAgent: true,
    },
  }
}
