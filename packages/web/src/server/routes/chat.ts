import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { Agent, LLMProvider, PROVIDER_PRESETS, type PresetName, MetricsCollector, type SessionManager } from '@evolving-agent/core'
import type { AgentRegistry } from '../services/agent-registry.js'
import type { SessionStore, PersistedSession } from '../services/session-store.js'

interface ActiveSession {
  agent: Agent
  session: PersistedSession
}

export function chatRoutes(
  agentRegistry: AgentRegistry,
  sessionStore: SessionStore,
  dataPath: string,
  broadcast: (event: unknown) => void,
  metricsCollector?: MetricsCollector,
  sessionManager?: SessionManager,
) {
  const app = new Hono()
  const activeSessions = new Map<string, ActiveSession>()

  // Phase 3 Batch 3 — unified chat endpoint backed by SessionManager.
  // Body: { message, sessionId? }. If sessionId is omitted, the "default"
  // session is used so legacy clients keep working.
  app.post('/', async (c) => {
    if (!sessionManager) {
      return c.json({ error: 'SessionManager not configured' }, 500)
    }
    const body = await c.req.json<{ message: string; sessionId?: string }>()
    const targetId = body.sessionId ?? 'default'
    const session =
      (await sessionManager.getOrLoad(targetId)) ??
      (await sessionManager.create({ id: targetId }))

    return streamSSE(c, async (stream) => {
      try {
        for await (const event of session.streamMessage(body.message)) {
          switch (event.type) {
            case 'status':
              await stream.writeSSE({ data: JSON.stringify({ type: 'status', content: event.message }) })
              break
            case 'text-delta':
              await stream.writeSSE({ data: JSON.stringify({ type: 'text-delta', content: event.text }) })
              break
            case 'tool-call':
              await stream.writeSSE({ data: JSON.stringify({ type: 'tool-call', step: event.step }) })
              break
            case 'done':
              await sessionManager.persistSession(session)
              await stream.writeSSE({
                data: JSON.stringify({
                  type: 'message',
                  content: event.response,
                  experienceId: event.experienceId,
                }),
              })
              await stream.writeSSE({
                data: JSON.stringify({
                  type: 'metrics',
                  totalCost: event.metrics.cost,
                  totalTokens: event.metrics.tokens,
                }),
              })
              break
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        await stream.writeSSE({ data: JSON.stringify({ type: 'error', content: errMsg }) })
      }
      await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) })
    })
  })

  // List available providers/presets
  app.get('/providers', (c) => {
    const presets = Object.entries(PROVIDER_PRESETS).map(([name, config]) => ({
      name,
      type: config.type,
      models: config.models,
      baseURL: 'baseURL' in config ? config.baseURL : undefined,
    }))
    return c.json({ presets })
  })

  // Start a new chat session for an agent
  app.post('/sessions', async (c) => {
    const { agentId, provider } = await c.req.json<{ agentId?: string; provider?: string }>()

    // Determine provider config
    let providerConfig: PresetName | undefined
    if (provider && provider in PROVIDER_PRESETS) {
      providerConfig = provider as PresetName
    } else if (agentId) {
      const entry = agentRegistry.getById(agentId)
      if (entry && typeof entry.provider === 'string' && entry.provider in PROVIDER_PRESETS) {
        providerConfig = entry.provider as PresetName
      }
    }

    const agent = new Agent({
      dataPath,
      provider: providerConfig,
    })
    await agent.init()

    const session = agent.getSession()
    const persisted: PersistedSession = {
      ...session,
      agentId,
      messages: [],
      events: [],
    }

    // Wire up event capture
    agent.onEvent((event) => {
      persisted.events.push(event)
      broadcast({ sessionId: session.id, ...event })
    })

    activeSessions.set(session.id, { agent, session: persisted })
    await sessionStore.save(persisted)

    return c.json({
      sessionId: session.id,
      provider: providerConfig ?? 'auto',
      model: agent.getLLMProvider().getModelId('executor'),
    })
  })

  // List chat sessions (with messages) for the session picker
  app.get('/sessions', (c) => {
    const all = sessionStore.getAll().map((s) => ({
      id: s.id,
      agentId: s.agentId,
      status: s.status,
      startedAt: s.startedAt,
      closedAt: s.closedAt,
      totalCost: s.totalCost,
      totalTokens: s.totalTokens,
      messageCount: s.messages.length,
      lastMessage: s.messages.length > 0 ? s.messages[s.messages.length - 1].content.slice(0, 100) : '',
    }))
    return c.json({ sessions: all })
  })

  // Resume an existing session — recreate Agent with history loaded
  app.post('/sessions/:id/resume', async (c) => {
    const sessionId = c.req.param('id')

    // Already active?
    const existing = activeSessions.get(sessionId)
    if (existing) {
      return c.json({
        sessionId,
        provider: existing.agent.getLLMProvider().getProviderType(),
        model: existing.agent.getLLMProvider().getModelId('executor'),
        messages: existing.session.messages,
      })
    }

    const persisted = sessionStore.getById(sessionId)
    if (!persisted) return c.json({ error: 'Session not found' }, 404)

    // Determine provider from the agent config or default
    let providerConfig: PresetName | undefined
    if (persisted.agentId) {
      const entry = agentRegistry.getById(persisted.agentId)
      if (entry && typeof entry.provider === 'string' && entry.provider in PROVIDER_PRESETS) {
        providerConfig = entry.provider as PresetName
      }
    }

    // Allow overriding provider via request body
    try {
      const body = await c.req.json<{ provider?: string }>()
      if (body.provider && body.provider in PROVIDER_PRESETS) {
        providerConfig = body.provider as PresetName
      }
    } catch { /* no body is fine */ }

    const agent = new Agent({ dataPath, provider: providerConfig })
    await agent.init()

    // Load conversation history into Agent's short-term memory
    agent.loadHistory(persisted.messages)

    // Reactivate the session
    persisted.status = 'active'
    delete persisted.closedAt

    agent.onEvent((event) => {
      persisted.events.push(event)
      broadcast({ sessionId, ...event })
    })

    activeSessions.set(sessionId, { agent, session: persisted })
    await sessionStore.save(persisted)

    return c.json({
      sessionId,
      provider: providerConfig ?? 'auto',
      model: agent.getLLMProvider().getModelId('executor'),
      messages: persisted.messages,
    })
  })

  // Send a message (streaming response)
  app.post('/sessions/:id/message', async (c) => {
    const sessionId = c.req.param('id')
    const active = activeSessions.get(sessionId)
    if (!active) return c.json({ error: 'Session not found or expired' }, 404)

    const { message } = await c.req.json<{ message: string }>()
    const { agent, session: persisted } = active

    // Record user message
    persisted.messages.push({ role: 'user', content: message, timestamp: new Date().toISOString() })

    // Stream the response via SSE using processMessageStream
    return streamSSE(c, async (stream) => {
      try {
        const metricsBefore = agent.getMetrics().length

        for await (const event of agent.processMessageStream(message)) {
          switch (event.type) {
            case 'status':
              await stream.writeSSE({ data: JSON.stringify({ type: 'status', content: event.message }) })
              break
            case 'text-delta':
              await stream.writeSSE({ data: JSON.stringify({ type: 'text-delta', content: event.text }) })
              break
            case 'tool-call':
              await stream.writeSSE({ data: JSON.stringify({ type: 'tool-call', step: event.step }) })
              break
            case 'done':
              // Record assistant message and update session stats.
              // Attach experienceId so the client can surface feedback UI.
              persisted.messages.push({
                role: 'assistant',
                content: event.response,
                timestamp: new Date().toISOString(),
                experienceId: event.experienceId,
              })
              persisted.totalCost = event.metrics.cost
              persisted.totalTokens = event.metrics.tokens
              await sessionStore.save(persisted)

              // Persist new metrics to file-based collector
              if (metricsCollector) {
                const allMetrics = agent.getMetrics()
                const newMetrics = allMetrics.slice(metricsBefore)
                if (newMetrics.length > 0) {
                  await metricsCollector.recordAll(newMetrics)
                }
              }

              await stream.writeSSE({
                data: JSON.stringify({
                  type: 'message',
                  content: event.response,
                  experienceId: event.experienceId,
                }),
              })
              await stream.writeSSE({
                data: JSON.stringify({
                  type: 'metrics',
                  totalCost: event.metrics.cost,
                  totalTokens: event.metrics.tokens,
                }),
              })
              break
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        await stream.writeSSE({ data: JSON.stringify({ type: 'error', content: errMsg }) })
      }

      await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) })
    })
  })

  // Switch provider for an active session
  app.patch('/sessions/:id/provider', async (c) => {
    const sessionId = c.req.param('id')
    const { provider } = await c.req.json<{ provider: string }>()

    if (!(provider in PROVIDER_PRESETS)) {
      return c.json({ error: `Unknown provider: ${provider}` }, 400)
    }

    // Close old session, create new agent with new provider
    const old = activeSessions.get(sessionId)
    if (old) {
      old.session.status = 'closed'
      old.session.closedAt = new Date().toISOString()
      await sessionStore.save(old.session)
      activeSessions.delete(sessionId)
    }

    // Create new session with the new provider
    const agent = new Agent({
      dataPath,
      provider: provider as PresetName,
    })
    await agent.init()

    const session = agent.getSession()
    const persisted: PersistedSession = {
      ...session,
      agentId: old?.session.agentId,
      messages: old?.session.messages ?? [], // Carry over conversation history
      events: [],
    }

    agent.onEvent((event) => {
      persisted.events.push(event)
      broadcast({ sessionId: session.id, ...event })
    })

    activeSessions.set(session.id, { agent, session: persisted })
    await sessionStore.save(persisted)

    return c.json({
      sessionId: session.id,
      provider,
      model: agent.getLLMProvider().getModelId('executor'),
    })
  })

  // Get active session info
  app.get('/sessions/:id', (c) => {
    const active = activeSessions.get(c.req.param('id'))
    if (!active) return c.json({ error: 'Session not found' }, 404)

    const { session: persisted, agent } = active
    return c.json({
      ...persisted,
      provider: agent.getLLMProvider().getProviderType(),
      model: agent.getLLMProvider().getModelId('executor'),
    })
  })

  // Close a session
  app.post('/sessions/:id/close', async (c) => {
    const active = activeSessions.get(c.req.param('id'))
    if (!active) return c.json({ error: 'Session not found' }, 404)

    active.session.status = 'closed'
    active.session.closedAt = new Date().toISOString()
    await sessionStore.save(active.session)
    activeSessions.delete(c.req.param('id'))

    return c.json({ success: true })
  })

  return app
}
