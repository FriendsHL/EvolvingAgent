import { Hono } from 'hono'
import {
  AGENT_TEMPLATES,
  profileFromTemplate,
  MessageBus,
  AgentCoordinator,
  TaskDelegator,
  LLMProvider,
} from '@evolving-agent/core'

// ============================================================
// Multi-Agent Coordination API (placeholder)
//
// Exposes templates, agent listing, delegation, and message log.
// Full integration with real Agent instances happens when agent.ts
// is updated to participate in the coordinator.
// ============================================================

export function coordinateRoutes(): Hono {
  const app = new Hono()

  // Shared coordinator instance for this route group
  const bus = new MessageBus()
  const coordinator = new AgentCoordinator(bus)

  // GET /templates — list available agent role templates
  app.get('/templates', (c) => {
    return c.json({ templates: AGENT_TEMPLATES })
  })

  // GET /agents — list all registered agent profiles
  app.get('/agents', (c) => {
    return c.json({ agents: coordinator.list() })
  })

  // POST /agents — register a placeholder agent from a template
  app.post('/agents', async (c) => {
    const body = await c.req.json<{ templateId: string; agentId?: string }>()
    const template = AGENT_TEMPLATES[body.templateId]
    if (!template) {
      return c.json({ error: `Unknown template: ${body.templateId}` }, 400)
    }

    const agentId = body.agentId ?? `${template.role}-${Date.now()}`
    const profile = profileFromTemplate(template, agentId)

    // Register with a stub handler (real handler requires a live Agent instance)
    coordinator.register(profile, async (msg: string) => {
      return `[placeholder] Agent ${agentId} received: ${msg.slice(0, 100)}`
    })

    return c.json({ profile }, 201)
  })

  // POST /delegate — create a delegation task
  app.post('/delegate', async (c) => {
    const body = await c.req.json<{ task: string; fromAgentId: string }>()
    if (!body.task || !body.fromAgentId) {
      return c.json({ error: 'task and fromAgentId are required' }, 400)
    }

    try {
      const llm = LLMProvider.fromEnv()
      const delegator = new TaskDelegator(coordinator, llm)

      const result = await delegator.delegate(
        body.task,
        body.fromAgentId,
        async (subtask: string) => `[fallback] No agent available for: ${subtask}`,
      )

      return c.json(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: message }, 500)
    }
  })

  // GET /messages — get message bus log
  app.get('/messages', (c) => {
    const agentId = c.req.query('agentId')
    const log = bus.getLog(agentId ? { agentId } : undefined)
    return c.json({ messages: log })
  })

  return app
}
