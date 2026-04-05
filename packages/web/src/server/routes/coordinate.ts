import { Hono } from 'hono'
import {
  Agent,
  AGENT_TEMPLATES,
  profileFromTemplate,
  MessageBus,
  AgentCoordinator,
  TaskDelegator,
  LLMProvider,
} from '@evolving-agent/core'
import type { PresetName } from '@evolving-agent/core'

// ============================================================
// Multi-Agent Coordination API
//
// Manages real Agent instances, coordination, delegation,
// and inter-agent messaging.
// ============================================================

export function coordinateRoutes(dataPath: string): Hono {
  const app = new Hono()

  // Shared infrastructure for this route group
  const bus = new MessageBus()
  const coordinator = new AgentCoordinator(bus)

  // Track live Agent instances alongside profiles
  const agentInstances = new Map<string, Agent>()

  // GET /templates — list available agent role templates
  app.get('/templates', (c) => {
    return c.json({ templates: AGENT_TEMPLATES })
  })

  // GET /agents — list all registered agent profiles with status
  app.get('/agents', (c) => {
    return c.json({ agents: coordinator.list() })
  })

  // GET /agents/:id — get a single agent profile + stats
  app.get('/agents/:id', (c) => {
    const id = c.req.param('id')
    const agents = coordinator.list()
    const profile = agents.find((a) => a.id === id)
    if (!profile) {
      return c.json({ error: `Agent not found: ${id}` }, 404)
    }
    const instance = agentInstances.get(id)
    const session = instance?.getSession()
    return c.json({
      profile,
      stats: session
        ? { totalCost: session.totalCost, totalTokens: session.totalTokens, status: session.status }
        : null,
    })
  })

  // POST /agents — create a real agent from a template
  app.post('/agents', async (c) => {
    const body = await c.req.json<{ templateId: string; name?: string; provider?: string }>()
    const template = AGENT_TEMPLATES[body.templateId]
    if (!template) {
      return c.json({ error: `Unknown template: ${body.templateId}` }, 400)
    }

    const agentId = `${template.role}-${Date.now()}`
    const profile = profileFromTemplate(template, agentId)
    if (body.name) {
      profile.name = body.name
    }

    // Determine provider: body override > template preference > env auto-detect
    const providerName = (body.provider ?? template.preferredProvider) as PresetName | undefined

    // Create a real Agent instance
    const agent = new Agent({
      dataPath,
      provider: providerName ?? undefined,
    })

    try {
      await agent.init()
    } catch {
      // Non-fatal — agent can still handle messages via LLM
    }

    agentInstances.set(agentId, agent)

    // Register with coordinator — handler delegates to the real agent
    coordinator.register(profile, async (msg: string) => {
      return agent.processMessage(msg)
    })

    return c.json({ profile }, 201)
  })

  // DELETE /agents/:id — unregister an agent
  app.delete('/agents/:id', (c) => {
    const id = c.req.param('id')
    const agents = coordinator.list()
    const exists = agents.some((a) => a.id === id)
    if (!exists) {
      return c.json({ error: `Agent not found: ${id}` }, 404)
    }
    coordinator.unregister(id)
    agentInstances.delete(id)
    return c.json({ ok: true })
  })

  // POST /delegate — delegate a task using TaskDelegator
  app.post('/delegate', async (c) => {
    const body = await c.req.json<{ task: string; fromAgentId?: string }>()
    if (!body.task) {
      return c.json({ error: 'task is required' }, 400)
    }

    // Use a synthetic "coordinator" agent id if no fromAgentId provided
    const fromAgentId = body.fromAgentId ?? '__coordinator__'

    try {
      const llm = LLMProvider.fromEnv()
      const delegator = new TaskDelegator(coordinator, llm)

      const result = await delegator.delegate(
        body.task,
        fromAgentId,
        async (subtask: string) => `[fallback] No agent available for: ${subtask}`,
      )

      return c.json(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: message }, 500)
    }
  })

  // GET /messages — get message bus log, optional ?agentId= filter
  app.get('/messages', (c) => {
    const agentId = c.req.query('agentId')
    const log = bus.getLog(agentId ? { agentId } : undefined)
    return c.json({ messages: log })
  })

  return app
}
