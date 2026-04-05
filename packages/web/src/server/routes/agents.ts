import { Hono } from 'hono'
import type { AgentRegistry } from '../services/agent-registry.js'

export function agentsRoutes(registry: AgentRegistry) {
  const app = new Hono()

  app.get('/', (c) => {
    return c.json({ agents: registry.getAll() })
  })

  app.get('/:id', (c) => {
    const agent = registry.getById(c.req.param('id'))
    if (!agent) return c.json({ error: 'Not found' }, 404)
    return c.json(agent)
  })

  app.post('/', async (c) => {
    const body = await c.req.json()
    const agent = await registry.create(body)
    return c.json(agent, 201)
  })

  app.put('/:id', async (c) => {
    const body = await c.req.json()
    const agent = await registry.update(c.req.param('id'), body)
    if (!agent) return c.json({ error: 'Not found' }, 404)
    return c.json(agent)
  })

  app.delete('/:id', async (c) => {
    const ok = await registry.delete(c.req.param('id'))
    if (!ok) return c.json({ error: 'Not found' }, 404)
    return c.json({ success: true })
  })

  return app
}
