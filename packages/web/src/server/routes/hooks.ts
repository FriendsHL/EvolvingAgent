import { Hono } from 'hono'
import {
  HookRunner,
  contextWindowGuard,
  costHardLimit,
  safetyCheck,
  metricsCollectorHook,
} from '@evolving-agent/core'

export function hooksRoutes() {
  const app = new Hono()

  // Create a standalone HookRunner with core hooks for introspection
  const runner = new HookRunner()
  runner.registerAll([contextWindowGuard, costHardLimit, safetyCheck, metricsCollectorHook])

  // List all hooks
  app.get('/', (c) => {
    const hooks = runner.getAll().map((h) => ({
      id: h.id,
      name: h.name,
      description: h.description,
      trigger: h.trigger,
      priority: h.priority,
      enabled: h.enabled,
      source: h.source,
      health: h.health,
      safety: h.safety,
    }))
    return c.json({ hooks })
  })

  // Toggle enable/disable
  app.patch('/:id/toggle', async (c) => {
    const { enabled } = await c.req.json<{ enabled: boolean }>()
    const ok = runner.setEnabled(c.req.param('id'), enabled)
    if (!ok) return c.json({ error: 'Hook not found' }, 404)
    return c.json({ success: true })
  })

  // Adjust priority
  app.patch('/:id/priority', async (c) => {
    const { priority } = await c.req.json<{ priority: number }>()
    const ok = runner.setPriority(c.req.param('id'), priority)
    if (!ok) return c.json({ error: 'Hook not found' }, 404)
    return c.json({ success: true })
  })

  return app
}
