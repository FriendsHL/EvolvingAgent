import { Hono } from 'hono'
import type { MetricsCollector } from '@evolving-agent/core'
import type { SessionStore, PersistedSession } from '../services/session-store.js'
import type { AgentRegistry } from '../services/agent-registry.js'

export function dashboardRoutes(
  metrics: MetricsCollector,
  sessionStore: SessionStore,
  agentRegistry: AgentRegistry,
) {
  const app = new Hono()

  // Overview: per-agent breakdown + global totals
  app.get('/summary', async (c) => {
    const agentId = c.req.query('agentId')
    const sessionId = c.req.query('sessionId')

    let sessions = sessionStore.getAll()
    if (agentId) sessions = sessions.filter((s) => s.agentId === agentId)
    if (sessionId) sessions = sessions.filter((s) => s.id === sessionId)

    const totalCost = sessions.reduce((s, sess) => s + sess.totalCost, 0)
    const totalTokens = sessions.reduce((s, sess) => s + sess.totalTokens, 0)
    const totalMessages = sessions.reduce((s, sess) => s + sess.messages.length, 0)
    const activeSessions = sessions.filter((s) => s.status === 'active').length

    // Per-agent breakdown (only when not filtered to single agent)
    const agents = agentRegistry.getAll()
    const agentBreakdown = agents.map((agent) => {
      const agentSessions = sessionStore.getAll().filter((s) => s.agentId === agent.id)
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

    return c.json({
      totalCost,
      totalTokens,
      totalCalls: totalMessages,
      totalSessions: sessions.length,
      activeSessions,
      avgCacheHitRate: 0,
      totalSavedCost: 0,
      agents: agentBreakdown,
    })
  })

  // Session list for a specific agent (or all)
  app.get('/sessions', (c) => {
    const agentId = c.req.query('agentId')
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

  // Trend data — supports period=hour|day, filtered by agentId/sessionId
  app.get('/trends', async (c) => {
    const period = c.req.query('period') ?? 'day'
    const range = Number(c.req.query('range') ?? (period === 'hour' ? 24 : 7))
    const agentId = c.req.query('agentId')
    const sessionId = c.req.query('sessionId')

    let sessions = sessionStore.getAll()
    if (agentId) sessions = sessions.filter((s) => s.agentId === agentId)
    if (sessionId) sessions = sessions.filter((s) => s.id === sessionId)

    if (period === 'hour') {
      return c.json({ points: buildHourlyTrends(sessions, range) })
    }
    return c.json({ points: buildDailyTrends(sessions, range) })
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

interface SessionLike {
  messages: Array<{ role: string; content: string; timestamp: string }>
  totalCost: number
  totalTokens: number
  startedAt: string
}

function buildDailyTrends(sessions: SessionLike[], range: number): TrendPoint[] {
  const now = new Date()
  const points: TrendPoint[] = []

  for (let i = range - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const date = d.toISOString().slice(0, 10)
    const daySessions = sessions.filter((s) => s.startedAt.slice(0, 10) === date)
    points.push(aggregateSessionsToPoint(date, daySessions))
  }

  return points
}

function buildHourlyTrends(sessions: SessionLike[], range: number): TrendPoint[] {
  const now = new Date()
  const points: TrendPoint[] = []

  for (let i = range - 1; i >= 0; i--) {
    const bucketStart = new Date(now.getTime() - i * 3600_000)
    bucketStart.setMinutes(0, 0, 0)
    const bucketEnd = new Date(bucketStart.getTime() + 3600_000)
    const hourLabel = bucketStart.toISOString().slice(0, 13) + ':00'

    let msgCount = 0
    let totalCost = 0
    let totalTokens = 0

    for (const sess of sessions) {
      for (const msg of sess.messages) {
        const t = new Date(msg.timestamp).getTime()
        if (t >= bucketStart.getTime() && t < bucketEnd.getTime()) {
          msgCount++
        }
      }
      const sessStart = new Date(sess.startedAt).getTime()
      if (sessStart >= bucketStart.getTime() && sessStart < bucketEnd.getTime()) {
        totalCost += sess.totalCost
        totalTokens += sess.totalTokens
      }
    }

    points.push({
      date: hourLabel,
      inputTokens: Math.round(totalTokens * 0.7),
      outputTokens: Math.round(totalTokens * 0.3),
      cost: totalCost,
      cacheHitRate: 0,
      calls: msgCount,
      models: {},
    })
  }

  return points
}

function aggregateSessionsToPoint(date: string, sessions: SessionLike[]): TrendPoint {
  const totalCost = sessions.reduce((s, sess) => s + sess.totalCost, 0)
  const totalTokens = sessions.reduce((s, sess) => s + sess.totalTokens, 0)
  const totalMessages = sessions.reduce((s, sess) => s + sess.messages.length, 0)

  return {
    date,
    inputTokens: Math.round(totalTokens * 0.7),
    outputTokens: Math.round(totalTokens * 0.3),
    cost: totalCost,
    cacheHitRate: 0,
    calls: totalMessages,
    models: {},
  }
}
