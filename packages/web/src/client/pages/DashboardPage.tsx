import { useState, useEffect } from 'react'
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import { useApi } from '../hooks/useApi.js'
import { apiGet } from '../api/client.js'
import SummaryCard from '../components/shared/SummaryCard.js'

interface AgentBreakdown {
  id: string
  name: string
  provider: string
  sessionCount: number
  activeSessions: number
  totalCost: number
  totalTokens: number
  totalMessages: number
}

interface Summary {
  totalCost: number
  totalTokens: number
  totalCalls: number
  totalSessions: number
  activeSessions: number
  avgCacheHitRate: number
  totalSavedCost: number
  agents: AgentBreakdown[]
}

interface SessionSummary {
  id: string
  agentId: string
  status: string
  startedAt: string
  totalCost: number
  totalTokens: number
  messageCount: number
  lastMessage: string
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

type Period = 'hour' | 'day'

const RANGE_OPTIONS: Record<Period, Array<{ value: number; label: string }>> = {
  hour: [
    { value: 6, label: '6h' },
    { value: 12, label: '12h' },
    { value: 24, label: '24h' },
    { value: 48, label: '48h' },
  ],
  day: [
    { value: 7, label: '7d' },
    { value: 14, label: '14d' },
    { value: 30, label: '30d' },
  ],
}

export default function DashboardPage() {
  const [period, setPeriod] = useState<Period>('hour')
  const [range, setRange] = useState(24)
  const [selectedAgent, setSelectedAgent] = useState<string>('')
  const [selectedSession, setSelectedSession] = useState<string>('')
  const [agentSessions, setAgentSessions] = useState<SessionSummary[]>([])

  // Build query params
  const filterParams = selectedSession
    ? `&sessionId=${selectedSession}`
    : selectedAgent
      ? `&agentId=${selectedAgent}`
      : ''

  const { data: summary, refetch: refetchSummary } = useApi<Summary>(
    () => apiGet(`/dashboard/summary${selectedSession ? `?sessionId=${selectedSession}` : selectedAgent ? `?agentId=${selectedAgent}` : ''}`),
    [selectedAgent, selectedSession],
  )

  const { data: trends } = useApi<{ points: TrendPoint[] }>(
    () => apiGet(`/dashboard/trends?period=${period}&range=${range}${filterParams}`),
    [period, range, selectedAgent, selectedSession],
  )

  // Load sessions when agent changes
  useEffect(() => {
    if (selectedAgent) {
      apiGet<{ sessions: SessionSummary[] }>(`/dashboard/sessions?agentId=${selectedAgent}`)
        .then((r) => setAgentSessions(r.sessions))
    } else {
      setAgentSessions([])
      setSelectedSession('')
    }
  }, [selectedAgent])

  const points = trends?.points ?? []
  const agents = summary?.agents ?? []

  const formatDate = (date: string) => {
    if (period === 'hour') return date.slice(11, 16)
    return date.slice(5)
  }

  const handlePeriodChange = (p: Period) => {
    setPeriod(p)
    setRange(RANGE_OPTIONS[p][0].value)
  }

  const handleAgentSelect = (agentId: string) => {
    setSelectedAgent(agentId)
    setSelectedSession('')
  }

  // Current scope label
  const scopeLabel = selectedSession
    ? `Session ${selectedSession.slice(0, 8)}...`
    : selectedAgent
      ? agents.find((a) => a.id === selectedAgent)?.name ?? 'Agent'
      : 'All Agents'

  return (
    <div>
      {/* Header with filters */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold">Dashboard</h2>
          <span className="text-sm text-gray-400">/ {scopeLabel}</span>
        </div>
        <div className="flex items-center gap-3">
          {/* Period toggle */}
          <div className="flex bg-gray-100 rounded-lg p-0.5">
            {(['hour', 'day'] as const).map((p) => (
              <button
                key={p}
                onClick={() => handlePeriodChange(p)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                  period === p ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {p === 'hour' ? 'Hourly' : 'Daily'}
              </button>
            ))}
          </div>
          {/* Range */}
          <div className="flex bg-gray-100 rounded-lg p-0.5">
            {RANGE_OPTIONS[period].map((opt) => (
              <button
                key={opt.value}
                onClick={() => setRange(opt.value)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                  range === opt.value ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Agent cards row */}
      <div className="mb-6">
        <div className="flex gap-3 overflow-x-auto pb-2">
          {/* "All" card */}
          <button
            onClick={() => { setSelectedAgent(''); setSelectedSession('') }}
            className={`flex-shrink-0 rounded-xl border px-4 py-3 text-left transition-colors min-w-[160px] ${
              !selectedAgent ? 'border-blue-400 bg-blue-50' : 'border-gray-200 bg-white hover:border-gray-300'
            }`}
          >
            <div className="text-xs text-gray-500 mb-1">All Agents</div>
            <div className="text-lg font-semibold">{summary?.totalSessions ?? 0} <span className="text-xs font-normal text-gray-400">sessions</span></div>
            <div className="text-xs text-gray-400 mt-0.5">
              ${summary?.totalCost.toFixed(4) ?? '0'} / {summary?.totalTokens.toLocaleString() ?? 0} tokens
            </div>
          </button>
          {agents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => handleAgentSelect(agent.id)}
              className={`flex-shrink-0 rounded-xl border px-4 py-3 text-left transition-colors min-w-[160px] ${
                selectedAgent === agent.id ? 'border-blue-400 bg-blue-50' : 'border-gray-200 bg-white hover:border-gray-300'
              }`}
            >
              <div className="text-xs text-gray-500 mb-1 truncate">{agent.name}</div>
              <div className="text-lg font-semibold">
                {agent.sessionCount} <span className="text-xs font-normal text-gray-400">sessions</span>
                {agent.activeSessions > 0 && (
                  <span className="ml-1.5 text-xs font-normal text-green-500">{agent.activeSessions} active</span>
                )}
              </div>
              <div className="text-xs text-gray-400 mt-0.5">
                ${agent.totalCost.toFixed(4)} / {agent.totalTokens.toLocaleString()} tokens
              </div>
              <div className="text-xs text-gray-300 mt-0.5">{agent.provider}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Session filter bar (when agent selected) */}
      {selectedAgent && agentSessions.length > 0 && (
        <div className="mb-6 bg-white rounded-xl border border-gray-200 p-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-medium text-gray-500">Sessions:</span>
            <button
              onClick={() => setSelectedSession('')}
              className={`text-xs px-2 py-0.5 rounded-full transition-colors ${
                !selectedSession ? 'bg-blue-100 text-blue-700' : 'text-gray-500 hover:bg-gray-100'
              }`}
            >
              All ({agentSessions.length})
            </button>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {agentSessions.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedSession(s.id)}
                className={`flex-shrink-0 text-left rounded-lg border px-3 py-2 transition-colors ${
                  selectedSession === s.id ? 'border-blue-400 bg-blue-50' : 'border-gray-100 hover:border-gray-200'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full ${s.status === 'active' ? 'bg-green-400' : 'bg-gray-300'}`} />
                  <span className="text-xs font-mono text-gray-600">{s.id.slice(0, 8)}</span>
                  <span className="text-xs text-gray-400">{s.messageCount} msgs</span>
                </div>
                {s.lastMessage && (
                  <div className="text-xs text-gray-400 mt-1 truncate max-w-[200px]">{s.lastMessage}</div>
                )}
                <div className="text-xs text-gray-300 mt-0.5">
                  {new Date(s.startedAt).toLocaleString()} · ${s.totalCost.toFixed(4)}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        <SummaryCard
          label="Total Cost"
          value={summary ? `$${summary.totalCost.toFixed(4)}` : '-'}
        />
        <SummaryCard
          label="Total Tokens"
          value={summary ? summary.totalTokens.toLocaleString() : '-'}
        />
        <SummaryCard
          label="Messages"
          value={summary?.totalCalls ?? '-'}
        />
        <SummaryCard
          label="Sessions"
          value={summary ? `${summary.activeSessions} active / ${summary.totalSessions} total` : '-'}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-2 gap-6">
        {/* Token Usage Trend */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-medium text-gray-600 mb-4">Token Usage</h3>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={points}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={formatDate} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip labelFormatter={formatDate} />
              <Legend />
              <Line type="monotone" dataKey="inputTokens" name="Input" stroke="#3b82f6" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="outputTokens" name="Output" stroke="#8b5cf6" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Cost Trend */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-medium text-gray-600 mb-4">Cost Trend</h3>
          <ResponsiveContainer width="100%" height={250}>
            <AreaChart data={points}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={formatDate} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v.toFixed(3)}`} />
              <Tooltip labelFormatter={formatDate} formatter={(v: number) => `$${v.toFixed(6)}`} />
              <Area type="monotone" dataKey="cost" name="Cost" fill="#dbeafe" stroke="#3b82f6" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Messages Trend */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-medium text-gray-600 mb-4">Messages</h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={points}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={formatDate} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip labelFormatter={formatDate} />
              <Bar dataKey="calls" name="Messages" fill="#6366f1" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Cost per session (agent breakdown) */}
        {!selectedSession && agents.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h3 className="text-sm font-medium text-gray-600 mb-4">Cost by Agent</h3>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={agents.filter((a) => a.totalCost > 0)} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v.toFixed(4)}`} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={100} />
                <Tooltip formatter={(v: number) => `$${v.toFixed(6)}`} />
                <Bar dataKey="totalCost" name="Cost" fill="#10b981" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Session detail card when session selected */}
        {selectedSession && (
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h3 className="text-sm font-medium text-gray-600 mb-4">Session Detail</h3>
            {(() => {
              const sess = agentSessions.find((s) => s.id === selectedSession)
              if (!sess) return <p className="text-sm text-gray-400">Session not found</p>
              return (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${sess.status === 'active' ? 'bg-green-400' : 'bg-gray-300'}`} />
                    <span className="text-sm font-medium">{sess.status}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <div className="text-gray-400 text-xs">Started</div>
                      <div>{new Date(sess.startedAt).toLocaleString()}</div>
                    </div>
                    <div>
                      <div className="text-gray-400 text-xs">Messages</div>
                      <div>{sess.messageCount}</div>
                    </div>
                    <div>
                      <div className="text-gray-400 text-xs">Cost</div>
                      <div>${sess.totalCost.toFixed(6)}</div>
                    </div>
                    <div>
                      <div className="text-gray-400 text-xs">Tokens</div>
                      <div>{sess.totalTokens.toLocaleString()}</div>
                    </div>
                  </div>
                  {sess.lastMessage && (
                    <div>
                      <div className="text-gray-400 text-xs mb-1">Last message</div>
                      <div className="text-sm text-gray-600 bg-gray-50 rounded-lg px-3 py-2">{sess.lastMessage}</div>
                    </div>
                  )}
                </div>
              )
            })()}
          </div>
        )}
      </div>
    </div>
  )
}
