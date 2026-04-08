import { Hono } from 'hono'
import type { MetricsCollector, SessionManager } from '@evolving-agent/core'

export function metricsRoutes(metrics: MetricsCollector, sessionManager: SessionManager) {
  const app = new Hono()

  // Per-call log with filters
  app.get('/calls', async (c) => {
    const start = c.req.query('start')
    const end = c.req.query('end')
    const model = c.req.query('model')

    const today = new Date().toISOString().slice(0, 10)
    const startDate = start ?? today
    const endDate = end ?? today

    let calls = await metrics.getByDateRange(startDate, endDate)

    if (model) {
      calls = calls.filter((m) => m.model === model)
    }

    // Sort by timestamp descending
    calls.sort((a, b) => b.timestamp.localeCompare(a.timestamp))

    return c.json({ calls, total: calls.length })
  })

  // Aggregated stats
  app.get('/aggregate', async (c) => {
    const start = c.req.query('start')
    const end = c.req.query('end')
    const agg = await metrics.aggregate(start ?? undefined, end ?? undefined)
    return c.json(agg)
  })

  // Cache health — recent window aggregate + per-day series.
  // The recent window comes from the in-memory ring buffer; daily comes
  // from the persisted cache-daily-summary.json so it survives restart.
  app.get('/cache', (c) => {
    const cache = sessionManager.getCacheMetrics()
    const daysParam = Number(c.req.query('days') ?? '7')
    const days = Number.isFinite(daysParam) && daysParam > 0 && daysParam <= 90 ? Math.floor(daysParam) : 7
    const windowMsParam = Number(c.req.query('windowMs') ?? '')
    const windowMs = Number.isFinite(windowMsParam) && windowMsParam > 0 ? windowMsParam : 24 * 3600 * 1000

    const today = new Date().toISOString().slice(0, 10)
    const startDate = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10)

    return c.json({
      recent: cache.aggregateRecent(windowMs),
      daily: cache.getDailySummaryRange(startDate, today),
      windowMs,
      days,
    })
  })

  // Recent raw cache calls (newest first) from the ring buffer.
  app.get('/cache/recent', (c) => {
    const cache = sessionManager.getCacheMetrics()
    const limitParam = Number(c.req.query('limit') ?? '50')
    const limit = Number.isFinite(limitParam) && limitParam > 0 && limitParam <= 500 ? Math.floor(limitParam) : 50
    return c.json({ calls: cache.getRecentCalls(limit) })
  })

  // Three-layer budget snapshot — config + live in-memory totals + persisted
  // daily counter. See BudgetManager.getStatus() for the shape.
  app.get('/budget', (c) => {
    const budget = sessionManager.getBudgetManager()
    return c.json(budget.getStatus())
  })

  return app
}
