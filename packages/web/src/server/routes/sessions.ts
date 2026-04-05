import { Hono } from 'hono'
import type { SessionStore } from '../services/session-store.js'

export function sessionsRoutes(store: SessionStore) {
  const app = new Hono()

  app.get('/', (c) => {
    const sessions = store.getAll().map((s) => ({
      id: s.id,
      status: s.status,
      startedAt: s.startedAt,
      closedAt: s.closedAt,
      totalCost: s.totalCost,
      totalTokens: s.totalTokens,
      agentId: s.agentId,
      messageCount: s.messages.length,
    }))
    return c.json({ sessions })
  })

  app.get('/:id', (c) => {
    const session = store.getById(c.req.param('id'))
    if (!session) return c.json({ error: 'Not found' }, 404)
    return c.json(session)
  })

  return app
}
