/**
 * Hono app factory — Phase 4 / smoke-test stage.
 *
 * Extracted from `index.ts main()` so smoke tests can construct the same
 * routing surface against an in-process tmp data dir, without binding a
 * port. The production entrypoint (`index.ts`) imports this and adds the
 * static-file fallback + `serve()` call.
 *
 * Inputs are deps the caller has already initialized — this factory does
 * NOT call `.init()` on anything. That keeps test setup explicit.
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'

import type { FeishuChannel, MetricsCollector, SessionManager, SkillRegistry } from '@evolving-agent/core'

import { dashboardRoutes } from './routes/dashboard.js'
import { metricsRoutes } from './routes/metrics.js'
import { memoryRoutes } from './routes/memory.js'
import { hooksRoutes } from './routes/hooks.js'
import { skillsRoutes } from './routes/skills.js'
import { agentsRoutes } from './routes/agents.js'
import { sessionsRoutes } from './routes/sessions.js'
import { chatRoutes } from './routes/chat.js'
import { toolsRoutes } from './routes/tools.js'
import { coordinateRoutes } from './routes/coordinate.js'
import { configRoutes } from './routes/config.js'
import { mcpRoutes } from './routes/mcp.js'
import { promptsRoutes } from './routes/prompts.js'
import { distillRoutes } from './routes/distill.js'
import { feishuRoutes } from './routes/feishu.js'

import type { AgentRegistry } from './services/agent-registry.js'
import type { SessionStore } from './services/session-store.js'

export interface BuildAppDeps {
  dataPath: string
  metrics: MetricsCollector
  /**
   * Optional override for the skill registry exposed to /api/skills.
   * Defaults to `sessionManager.getSkills()` so the dashboard always sees
   * the built-in skills (the SessionManager-owned registry is the
   * authoritative one).
   */
  skillRegistry?: SkillRegistry
  agentRegistry: AgentRegistry
  sessionStore: SessionStore
  sessionManager: SessionManager
  feishuChannel: FeishuChannel | null
  /** SSE broadcast hook used by chat routes. Tests pass a no-op. */
  broadcast: (event: unknown) => void
}

export function buildApp(deps: BuildAppDeps): Hono {
  const {
    dataPath,
    metrics,
    agentRegistry,
    sessionStore,
    sessionManager,
    feishuChannel,
    broadcast,
  } = deps
  // Default to the SessionManager's own SkillRegistry so /api/skills
  // returns the built-in 8 skills (web-search, summarize-url, self-repair,
  // github, code-analysis, file-batch, schedule, data-extract).
  const skillRegistry = deps.skillRegistry ?? sessionManager.getSkills()

  const app = new Hono()

  app.use('/api/*', cors())

  app.get('/api/health', (c) =>
    c.json({ status: 'ok', timestamp: new Date().toISOString() }),
  )

  app.route('/api/dashboard', dashboardRoutes(metrics, sessionStore, agentRegistry, sessionManager))
  app.route('/api/metrics', metricsRoutes(metrics, sessionManager))
  // Mount distill BEFORE the broader /api/memory so Hono picks the more
  // specific prefix first.
  app.route('/api/memory/distill', distillRoutes(sessionManager))
  app.route('/api/memory', memoryRoutes(dataPath))
  app.route('/api/hooks', hooksRoutes())
  app.route('/api/skills', skillsRoutes(skillRegistry, dataPath))
  app.route('/api/agents', agentsRoutes(agentRegistry, sessionManager))
  app.route('/api/sessions', sessionsRoutes(sessionManager, sessionStore, dataPath))
  app.route('/api/tools', toolsRoutes())
  app.route('/api/coordinate', coordinateRoutes(dataPath))
  app.route('/api/config', configRoutes(sessionManager))
  app.route('/api/mcp', mcpRoutes(sessionManager, dataPath))
  app.route('/api/prompts', promptsRoutes(sessionManager))
  app.route('/api/channels/feishu', feishuRoutes({ channel: feishuChannel }))
  app.route(
    '/api/chat',
    chatRoutes(agentRegistry, sessionStore, dataPath, broadcast, metrics, sessionManager),
  )

  return app
}
