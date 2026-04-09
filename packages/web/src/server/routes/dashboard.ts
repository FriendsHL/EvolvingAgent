import { Hono } from 'hono'
import type { LLMCallMetrics, MetricsCollector, SessionManager } from '@evolving-agent/core'
import type { SessionStore } from '../services/session-store.js'
import type { AgentRegistry } from '../services/agent-registry.js'

/**
 * Dashboard data sources (post Phase 4 E2E fix #2):
 *
 * - Top numbers + trends → file-backed MetricsCollector (single source of
 *   truth; every LLM call appends to `metrics/calls/YYYY-MM-DD.jsonl`).
 * - Session list → SessionManager (Phase 3 hot path). Falls back to the
 *   legacy SessionStore so smoke tests with synthetic sessionStore data
 *   still see something.
 * - Per-agent breakdown → AgentRegistry when populated; otherwise we
 *   synthesize a single "main" row so the All Agents card row never
 *   renders empty in the env-driven default deployment.
 *
 * The collector currently does NOT tag calls by agentId/sessionId, so
 * those query params are no-ops on `/trends` and `/summary` totals.
 */
export function dashboardRoutes(
  metrics: MetricsCollector,
  sessionStore: SessionStore,
  agentRegistry: AgentRegistry,
  sessionManager?: SessionManager,
) {
  const app = new Hono()

  app.get('/summary', async (c) => {
    const agg = await metrics.aggregate().catch(() => ({
      totalCalls: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalCost: 0,
      totalSavedCost: 0,
      avgCacheHitRate: 0,
    }))

    const managerSessions = sessionManager?.list() ?? []
    const legacySessions = sessionStore.getAll()
    const totalSessions = Math.max(managerSessions.length, legacySessions.length)
    const activeSessions = Math.max(
      managerSessions.length,
      legacySessions.filter((s) => s.status === 'active').length,
    )

    // Per-agent breakdown. The AgentRegistry is informational in the
    // env-driven default deployment, so when it is empty we synthesize a
    // single "main" row from the global aggregate so the dashboard's All
    // Agents card row + Cost-by-Agent chart render with real numbers.
    const registryAgents = agentRegistry.getAll()
    const agentBreakdown = registryAgents.length > 0
      ? registryAgents.map((agent) => {
          const agentSessions = legacySessions.filter((s) => s.agentId === agent.id)
          return {
            id: agent.id,
            name: agent.name,
            provider: typeof agent.provider === 'string' ? agent.provider : agent.provider.type,
            sessionCount: agentSessions.length,
            activeSessions: agentSessions.filter((s) => s.status === 'active').length,
            totalCost: agentSessions.reduce((s, sess) => s + sess.totalCost, 0),
            totalTokens: agentSessions.reduce((s, sess) => s + sess.totalTokens, 0),
            totalMessages: agentSessions.reduce((s, sess) => s + sess.messages.length, 0),
          }
        })
      : [{
          id: 'main',
          name: 'Main Agent',
          provider: process.env.EVOLVING_AGENT_PROVIDER ?? 'default',
          sessionCount: managerSessions.length,
          activeSessions: managerSessions.length,
          totalCost: agg.totalCost,
          totalTokens: agg.totalPromptTokens + agg.totalCompletionTokens,
          totalMessages: agg.totalCalls,
        }]

    return c.json({
      totalCost: agg.totalCost,
      totalTokens: agg.totalPromptTokens + agg.totalCompletionTokens,
      totalCalls: agg.totalCalls,
      totalSessions,
      activeSessions,
      avgCacheHitRate: agg.avgCacheHitRate,
      totalSavedCost: agg.totalSavedCost,
      agents: agentBreakdown,
    })
  })

  // Session list — SessionManager is the hot path; fall back to legacy
  // SessionStore only when the manager has nothing (or for tests that
  // pre-populate sessionStore directly).
  app.get('/sessions', (c) => {
    const agentId = c.req.query('agentId')
    const managerSessions = sessionManager?.list() ?? []

    if (managerSessions.length > 0) {
      // SessionMetadata has no agentId binding; in the env-driven runtime
      // every session is owned by the synthetic "main" agent. Filter only
      // when the requested agentId matches that synthetic id.
      const matched = !agentId || agentId === 'main' ? managerSessions : []
      return c.json({
        sessions: matched.map((s) => ({
          id: s.id,
          agentId: 'main',
          status: 'active' as const,
          startedAt: new Date(s.createdAt).toISOString(),
          closedAt: undefined,
          totalCost: 0,
          totalTokens: 0,
          messageCount: s.messageCount,
          lastMessage: s.title,
        })),
      })
    }

    // Legacy fallback
    let sessions = sessionStore.getAll()
    if (agentId) sessions = sessions.filter((s) => s.agentId === agentId)
    return c.json({
      sessions: sessions.map((s) => ({
        id: s.id,
        agentId: s.agentId,
        status: s.status,
        startedAt: s.startedAt,
        closedAt: s.closedAt,
        totalCost: s.totalCost,
        totalTokens: s.totalTokens,
        messageCount: s.messages.length,
        lastMessage: s.messages.length > 0
          ? s.messages[s.messages.length - 1].content.slice(0, 80)
          : '',
      })),
    })
  })

  // Trend data — pull real LLM-call metrics from MetricsCollector and
  // bucket them by day or hour. agentId/sessionId filters are no-ops
  // because the collector does not currently tag by either; we keep the
  // params accepted so the client URL shape stays stable.
  app.get('/trends', async (c) => {
    const period = c.req.query('period') ?? 'day'
    const range = Number(c.req.query('range') ?? (period === 'hour' ? 24 : 7))

    if (period === 'hour') {
      const now = new Date()
      const start = new Date(now.getTime() - range * 3600_000)
      const calls = await metrics
        .getByDateRange(start.toISOString().slice(0, 10), now.toISOString().slice(0, 10))
        .catch(() => [] as LLMCallMetrics[])
      return c.json({ points: buildHourlyTrends(calls, range, now) })
    }

    const now = new Date()
    const start = new Date(now)
    start.setDate(start.getDate() - (range - 1))
    const calls = await metrics
      .getByDateRange(start.toISOString().slice(0, 10), now.toISOString().slice(0, 10))
      .catch(() => [] as LLMCallMetrics[])
    return c.json({ points: buildDailyTrends(calls, range, now) })
  })

  return app
}

interface TrendPoint {
  date: string
  inputTokens: number
  outputTokens: number
  cost: number
  cacheHitRate: number
  calls: number
  models: Record<string, number>
}

function emptyPoint(date: string): TrendPoint {
  return {
    date,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    cacheHitRate: 0,
    calls: 0,
    models: {},
  }
}

function addCall(point: TrendPoint, m: LLMCallMetrics): void {
  point.inputTokens += m.tokens.prompt
  point.outputTokens += m.tokens.completion
  point.cost += m.cost
  point.calls += 1
  point.cacheHitRate += m.cacheHitRate
  point.models[m.model] = (point.models[m.model] ?? 0) + 1
}

function finalizePoint(point: TrendPoint): TrendPoint {
  if (point.calls > 0) {
    point.cacheHitRate = point.cacheHitRate / point.calls
  }
  return point
}

function buildDailyTrends(calls: LLMCallMetrics[], range: number, now: Date): TrendPoint[] {
  const points = new Map<string, TrendPoint>()
  for (let i = range - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const date = d.toISOString().slice(0, 10)
    points.set(date, emptyPoint(date))
  }

  for (const call of calls) {
    const date = call.timestamp.slice(0, 10)
    const point = points.get(date)
    if (point) addCall(point, call)
  }

  return [...points.values()].map(finalizePoint)
}

function buildHourlyTrends(calls: LLMCallMetrics[], range: number, now: Date): TrendPoint[] {
  const buckets: TrendPoint[] = []
  const bucketStarts: number[] = []

  for (let i = range - 1; i >= 0; i--) {
    const start = new Date(now.getTime() - i * 3600_000)
    start.setMinutes(0, 0, 0)
    bucketStarts.push(start.getTime())
    buckets.push(emptyPoint(start.toISOString().slice(0, 13) + ':00'))
  }

  for (const call of calls) {
    const t = new Date(call.timestamp).getTime()
    for (let i = 0; i < bucketStarts.length; i++) {
      const bucketStart = bucketStarts[i]
      if (t >= bucketStart && t < bucketStart + 3600_000) {
        addCall(buckets[i], call)
        break
      }
    }
  }

  return buckets.map(finalizePoint)
}
