import { useState, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useApi } from '../hooks/useApi.js'
import { apiGet } from '../api/client.js'
import StatusBadge from '../components/shared/StatusBadge.js'
import SummaryCard from '../components/shared/SummaryCard.js'
import EventStream from '../components/EventStream.js'

// === Wire types ====================================================
// Mirrors PersistedSession from web/server/services/session-store.ts.
// Kept inline so we don't pull a server-only type into the client bundle.

interface AgentEventLike {
  type: string
  data: unknown
  timestamp: string
}

interface MessageLike {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  experienceId?: string
}

interface SessionDetail {
  id: string
  status: string
  startedAt: string
  closedAt?: string
  totalCost: number
  totalTokens: number
  agentId?: string
  messages: MessageLike[]
  events: AgentEventLike[]
}

// === Plan / step shapes (best-effort) ===============================
// Planner emits the full Plan object as an event. We type it loosely so
// the page never crashes if the shape drifts.

interface PlanStepLike {
  id?: string | number
  description?: string
  tool?: string
  args?: unknown
  status?: string
}
interface PlanLike {
  goal?: string
  rationale?: string
  steps?: PlanStepLike[]
}
function isPlanLike(x: unknown): x is PlanLike {
  return typeof x === 'object' && x !== null && 'steps' in x && Array.isArray((x as { steps?: unknown }).steps)
}

// === Tabs ============================================================
type TabId = 'timeline' | 'plans' | 'tools' | 'cost' | 'messages' | 'reflection' | 'live'
const TAB_LABELS: Array<{ id: TabId; label: string; icon: string }> = [
  { id: 'timeline',   label: 'Timeline',   icon: '📜' },
  { id: 'plans',      label: 'Plans',      icon: '🗺️' },
  { id: 'tools',      label: 'Tool calls', icon: '🔧' },
  { id: 'cost',       label: 'Cost',       icon: '💰' },
  { id: 'messages',   label: 'Messages',   icon: '💬' },
  { id: 'reflection', label: 'Reflection', icon: '🔍' },
  { id: 'live',       label: 'Live',       icon: '📡' },
]

const EVENT_ICONS: Record<string, string> = {
  planning: '🗺️',
  executing: '⚙️',
  'tool-call': '🔧',
  'tool-result': '📤',
  reflecting: '🔍',
  message: '💬',
  error: '❌',
  hook: '🔗',
}

// === Helpers ========================================================
function fmtTime(ts: string): string {
  return new Date(ts).toLocaleTimeString()
}
function fmtData(x: unknown, max = 200): string {
  if (x == null) return ''
  if (typeof x === 'string') return x.length > max ? x.slice(0, max) + '…' : x
  try {
    const s = JSON.stringify(x)
    return s.length > max ? s.slice(0, max) + '…' : s
  } catch {
    return String(x)
  }
}

export default function SessionDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data: session, loading } = useApi<SessionDetail>(() => apiGet(`/sessions/${id}`), [id])
  const [tab, setTab] = useState<TabId>('timeline')

  // === Derived views (recomputed from events whenever session changes) ===
  const plans = useMemo(() => {
    if (!session) return [] as Array<{ ts: string; plan: PlanLike }>
    return session.events
      .filter((e) => e.type === 'planning' && isPlanLike(e.data))
      .map((e) => ({ ts: e.timestamp, plan: e.data as PlanLike }))
  }, [session])

  const toolCalls = useMemo(() => {
    if (!session) return [] as Array<{ call: AgentEventLike; result?: AgentEventLike }>
    const calls: Array<{ call: AgentEventLike; result?: AgentEventLike }> = []
    let pending: AgentEventLike | null = null
    for (const ev of session.events) {
      if (ev.type === 'tool-call') {
        if (pending) calls.push({ call: pending })
        pending = ev
      } else if (ev.type === 'tool-result' && pending) {
        calls.push({ call: pending, result: ev })
        pending = null
      }
    }
    if (pending) calls.push({ call: pending })
    return calls
  }, [session])

  const reflections = useMemo(() => {
    if (!session) return [] as AgentEventLike[]
    return session.events.filter((e) => e.type === 'reflecting' && typeof e.data !== 'string')
  }, [session])

  const eventCounts = useMemo(() => {
    if (!session) return {} as Record<string, number>
    const counts: Record<string, number> = {}
    for (const ev of session.events) {
      counts[ev.type] = (counts[ev.type] ?? 0) + 1
    }
    return counts
  }, [session])

  if (loading) return <div className="text-gray-400 p-6">Loading…</div>
  if (!session) return <div className="text-gray-400 p-6">Session not found</div>

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <button onClick={() => navigate('/sessions')} className="text-sm text-blue-600 hover:underline mb-4 block">
        &larr; Back to Sessions
      </button>

      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <h2 className="text-lg font-semibold font-mono">{session.id.slice(0, 12)}…</h2>
        <StatusBadge status={session.status} />
        <span className="text-xs text-gray-500">started {new Date(session.startedAt).toLocaleString()}</span>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-5 gap-4 mb-6">
        <SummaryCard label="Messages" value={session.messages.length} />
        <SummaryCard label="Events" value={session.events.length} />
        <SummaryCard label="Tool calls" value={toolCalls.length} />
        <SummaryCard label="Tokens" value={session.totalTokens.toLocaleString()} />
        <SummaryCard label="Cost" value={`$${session.totalCost.toFixed(4)}`} />
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-4 flex gap-1 overflow-x-auto">
        {TAB_LABELS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm border-b-2 transition-colors whitespace-nowrap ${
              tab === t.id
                ? 'border-blue-600 text-blue-600 font-medium'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'timeline' && <TimelineView events={session.events} />}
      {tab === 'plans' && <PlansView plans={plans} />}
      {tab === 'tools' && <ToolCallsView calls={toolCalls} />}
      {tab === 'cost' && (
        <CostView
          totalCost={session.totalCost}
          totalTokens={session.totalTokens}
          eventCounts={eventCounts}
          toolCalls={toolCalls}
        />
      )}
      {tab === 'messages' && <MessagesView messages={session.messages} />}
      {tab === 'reflection' && <ReflectionView reflections={reflections} />}
      {tab === 'live' && (
        <EventStream
          sessionId={session.id}
          showSessionColumn={false}
          height="calc(100vh - 380px)"
        />
      )}
    </div>
  )
}

// === Timeline tab — chronological event list ========================
function TimelineView({ events }: { events: AgentEventLike[] }) {
  const [expanded, setExpanded] = useState<number | null>(null)
  if (events.length === 0) {
    return <div className="text-gray-400 text-sm p-4">No events recorded for this session.</div>
  }
  return (
    <div className="bg-white rounded-lg border border-gray-200 max-h-[600px] overflow-y-auto divide-y divide-gray-100">
      {events.map((ev, i) => {
        const icon = EVENT_ICONS[ev.type] ?? '•'
        const isExpanded = expanded === i
        return (
          <div
            key={`${ev.timestamp}-${i}`}
            className="px-4 py-2 hover:bg-gray-50 cursor-pointer text-sm"
            onClick={() => setExpanded(isExpanded ? null : i)}
          >
            <div className="flex items-center gap-3">
              <span className="text-gray-400 text-xs w-20 shrink-0">{fmtTime(ev.timestamp)}</span>
              <span className="w-6 text-center">{icon}</span>
              <span className="text-gray-700 font-mono text-xs w-24 shrink-0">{ev.type}</span>
              <span className="text-gray-600 truncate flex-1">{fmtData(ev.data, 120)}</span>
            </div>
            {isExpanded && (
              <pre className="mt-2 ml-32 text-xs text-gray-600 bg-gray-50 p-2 rounded overflow-x-auto whitespace-pre-wrap">
                {JSON.stringify(ev.data, null, 2)}
              </pre>
            )}
          </div>
        )
      })}
    </div>
  )
}

// === Plans tab — every Plan emitted, structured =====================
function PlansView({ plans }: { plans: Array<{ ts: string; plan: PlanLike }> }) {
  if (plans.length === 0) {
    return <div className="text-gray-400 text-sm p-4">No structured plans were emitted in this session.</div>
  }
  return (
    <div className="space-y-4">
      {plans.map((p, i) => (
        <div key={i} className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-gray-700">Plan #{i + 1}</h3>
            <span className="text-xs text-gray-400">{fmtTime(p.ts)}</span>
          </div>
          {p.plan.goal && (
            <div className="text-sm text-gray-700 mb-2">
              <span className="text-gray-500">Goal:</span> {p.plan.goal}
            </div>
          )}
          {p.plan.rationale && (
            <div className="text-xs text-gray-500 italic mb-3">{p.plan.rationale}</div>
          )}
          <ol className="space-y-1.5 ml-4">
            {(p.plan.steps ?? []).map((step, si) => (
              <li key={si} className="text-sm flex gap-2">
                <span className="text-gray-400 font-mono w-6 shrink-0">{si + 1}.</span>
                <div className="flex-1">
                  {step.tool && (
                    <span className="inline-block px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-xs font-mono mr-2">
                      {step.tool}
                    </span>
                  )}
                  <span className="text-gray-700">{step.description ?? '(no description)'}</span>
                  {step.status && (
                    <span className="ml-2 text-xs text-gray-500">[{step.status}]</span>
                  )}
                  {step.args !== undefined && (
                    <pre className="mt-1 text-xs text-gray-500 bg-gray-50 p-1.5 rounded overflow-x-auto">
                      {fmtData(step.args, 200)}
                    </pre>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  )
}

// === Tool calls tab — paired call+result timeline ===================
function ToolCallsView({ calls }: { calls: Array<{ call: AgentEventLike; result?: AgentEventLike }> }) {
  const [expanded, setExpanded] = useState<number | null>(null)
  if (calls.length === 0) {
    return <div className="text-gray-400 text-sm p-4">No tool calls were recorded in this session.</div>
  }
  return (
    <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
      {calls.map((tc, i) => {
        const isExpanded = expanded === i
        return (
          <div key={i} className="p-3 hover:bg-gray-50">
            <div
              className="flex items-center gap-3 cursor-pointer"
              onClick={() => setExpanded(isExpanded ? null : i)}
            >
              <span className="text-xs text-gray-400 w-20">{fmtTime(tc.call.timestamp)}</span>
              <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-xs font-mono">
                🔧 call
              </span>
              <span className="text-sm text-gray-700 truncate flex-1">{fmtData(tc.call.data, 100)}</span>
              {tc.result ? (
                <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 text-xs">✓ done</span>
              ) : (
                <span className="px-2 py-0.5 rounded bg-yellow-100 text-yellow-800 text-xs">⏳ no result</span>
              )}
            </div>
            {isExpanded && (
              <div className="mt-3 ml-24 space-y-2">
                <div>
                  <div className="text-xs text-gray-500 mb-1">Call payload:</div>
                  <pre className="text-xs bg-amber-50 p-2 rounded overflow-x-auto whitespace-pre-wrap">
                    {JSON.stringify(tc.call.data, null, 2)}
                  </pre>
                </div>
                {tc.result && (
                  <div>
                    <div className="text-xs text-gray-500 mb-1">Result:</div>
                    <pre className="text-xs bg-emerald-50 p-2 rounded overflow-x-auto whitespace-pre-wrap">
                      {JSON.stringify(tc.result.data, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// === Cost tab — totals + per-event-type breakdown ===================
function CostView({
  totalCost,
  totalTokens,
  eventCounts,
  toolCalls,
}: {
  totalCost: number
  totalTokens: number
  eventCounts: Record<string, number>
  toolCalls: Array<{ call: AgentEventLike; result?: AgentEventLike }>
}) {
  // Tool name frequency — best-effort: try common shapes for tool name.
  const toolFreq = useMemo(() => {
    const freq: Record<string, number> = {}
    for (const tc of toolCalls) {
      const data = tc.call.data as Record<string, unknown> | string | undefined
      let name = 'unknown'
      if (typeof data === 'object' && data) {
        const candidate = (data.tool ?? data.name ?? data.toolName) as string | undefined
        if (typeof candidate === 'string') name = candidate
      } else if (typeof data === 'string') {
        name = data.split(/[\s(]/)[0]
      }
      freq[name] = (freq[name] ?? 0) + 1
    }
    return Object.entries(freq).sort((a, b) => b[1] - a[1])
  }, [toolCalls])

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-xs text-gray-500">Total cost</div>
          <div className="text-2xl font-semibold text-gray-900 mt-1">${totalCost.toFixed(4)}</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-xs text-gray-500">Total tokens</div>
          <div className="text-2xl font-semibold text-gray-900 mt-1">{totalTokens.toLocaleString()}</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-xs text-gray-500">Tool calls</div>
          <div className="text-2xl font-semibold text-gray-900 mt-1">{toolCalls.length}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Events by type</h3>
          <div className="space-y-1.5">
            {Object.entries(eventCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([type, n]) => (
                <div key={type} className="flex items-center gap-2 text-sm">
                  <span className="w-6 text-center">{EVENT_ICONS[type] ?? '•'}</span>
                  <span className="font-mono text-xs text-gray-600 w-24">{type}</span>
                  <div className="flex-1 bg-gray-100 rounded h-2 overflow-hidden">
                    <div
                      className="bg-blue-400 h-full"
                      style={{ width: `${Math.min(100, (n / Math.max(...Object.values(eventCounts))) * 100)}%` }}
                    />
                  </div>
                  <span className="text-xs text-gray-500 w-8 text-right">{n}</span>
                </div>
              ))}
          </div>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Tool call frequency</h3>
          {toolFreq.length === 0 ? (
            <div className="text-gray-400 text-sm">No tool calls in this session.</div>
          ) : (
            <div className="space-y-1.5">
              {toolFreq.map(([name, n]) => (
                <div key={name} className="flex items-center gap-2 text-sm">
                  <span className="font-mono text-xs text-gray-600 truncate w-32">{name}</span>
                  <div className="flex-1 bg-gray-100 rounded h-2 overflow-hidden">
                    <div
                      className="bg-amber-400 h-full"
                      style={{ width: `${Math.min(100, (n / toolFreq[0][1]) * 100)}%` }}
                    />
                  </div>
                  <span className="text-xs text-gray-500 w-8 text-right">{n}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="text-xs text-gray-500 italic px-1">
        Cost is reported as the session-wide totals collected by the agent's metrics hook. A
        per-call breakdown will land in a follow-up phase once the metrics collector exposes
        per-step attribution.
      </div>
    </div>
  )
}

// === Messages tab — existing conversation view ======================
function MessagesView({ messages }: { messages: MessageLike[] }) {
  if (messages.length === 0) {
    return <div className="text-gray-400 text-sm p-4">No messages yet.</div>
  }
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="space-y-3 max-h-[600px] overflow-y-auto">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`rounded-lg p-3 text-sm ${
              msg.role === 'user' ? 'bg-blue-50 border border-blue-100' : 'bg-gray-50 border border-gray-100'
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-medium text-gray-500">{msg.role}</span>
              <span className="text-xs text-gray-400">{fmtTime(msg.timestamp)}</span>
            </div>
            <p className="whitespace-pre-wrap">{msg.content}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// === Reflection tab — emitted reflections only =====================
function ReflectionView({ reflections }: { reflections: AgentEventLike[] }) {
  if (reflections.length === 0) {
    return <div className="text-gray-400 text-sm p-4">No structured reflections were emitted in this session.</div>
  }
  return (
    <div className="space-y-3">
      {reflections.map((r, i) => (
        <div key={i} className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-gray-700">🔍 Reflection #{i + 1}</h3>
            <span className="text-xs text-gray-400">{fmtTime(r.timestamp)}</span>
          </div>
          <pre className="text-xs text-gray-700 bg-gray-50 p-3 rounded overflow-x-auto whitespace-pre-wrap">
            {JSON.stringify(r.data, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  )
}
