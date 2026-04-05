import { Hono } from 'hono'
import type { MetricsCollector } from '@evolving-agent/core'

export function metricsRoutes(metrics: MetricsCollector) {
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

  return app
}
