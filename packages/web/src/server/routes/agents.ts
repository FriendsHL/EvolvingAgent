import { Hono } from 'hono'
import type { SessionManager } from '@evolving-agent/core'
import type { AgentRegistry } from '../services/agent-registry.js'

export function agentsRoutes(registry: AgentRegistry, sessionManager?: SessionManager) {
  const app = new Hono()

  app.get('/', (c) => {
    return c.json({ agents: registry.getAll() })
  })

  // Runtime "main" agent — reflects what `/api/chat` actually uses for the
  // default session. Custom AgentRegistry entries are informational only;
  // Phase 3 SessionManager uses the env-based provider, so this endpoint
  // is the authoritative view for the user.
  //
  // IMPORTANT: this route must be declared BEFORE `/:id` so Hono matches
  // the literal path first.
  app.get('/main', async (c) => {
    if (!sessionManager) return c.json({ error: 'SessionManager not configured' }, 500)
    const session =
      (await sessionManager.getOrLoad('default')) ??
      (await sessionManager.create({ id: 'default', title: 'Default chat' }))
    const llm = session.agent.getLLMProvider()
    const promptRegistry = sessionManager.getPromptRegistry()

    const toolNames = sessionManager.getTools().list().map((t) => t.name)
    const skillNames = sessionManager.getSkills().list().map((s) => s.name)

    // Surface the user-facing preset name (from the env var) as the primary
    // provider label, falling back to the underlying llm family. The Dashboard
    // card does the same thing; using two different sources produced a
    // confusing mismatch where Dashboard said "bailian-coding" and Agents
    // said "openai-compatible" for the same runtime.
    const providerPreset =
      process.env.EVOLVING_AGENT_PROVIDER ?? llm.getProviderType()
    return c.json({
      id: 'main',
      name: 'Main Agent (default session)',
      provider: providerPreset,
      providerType: llm.getProviderType(),
      models: {
        planner: llm.getModelId('planner'),
        executor: llm.getModelId('executor'),
        reflector: llm.getModelId('reflector'),
      },
      prompts: promptRegistry.list().map((entry) => ({
        id: entry.id,
        source: entry.source,
        length: entry.content.length,
        preview: entry.content.slice(0, 160),
      })),
      tools: toolNames,
      skills: skillNames,
      note: 'Main agent is runtime-configured via EVOLVING_AGENT_PROVIDER in .env. Edit prompts on the Prompts page.',
    })
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
