import { useState } from 'react'
import { useApi } from '../hooks/useApi.js'
import { apiGet } from '../api/client.js'
import DataTable, { type Column } from '../components/shared/DataTable.js'
import SummaryCard from '../components/shared/SummaryCard.js'

interface MetricCall {
  callId: string
  model: string
  timestamp: string
  tokens: { prompt: number; completion: number; cacheRead: number; cacheWrite: number }
  cacheHitRate: number
  cost: number
  savedCost: number
  duration: number
  [key: string]: unknown
}

interface Aggregate {
  totalCalls: number
  totalPromptTokens: number
  totalCompletionTokens: number
  totalCacheRead: number
  totalCacheWrite: number
  avgCacheHitRate: number
  totalCost: number
  totalSavedCost: number
}

interface CacheAggregate {
  totalCalls: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheCreationTokens: number
  totalCacheReadTokens: number
  hitRatio: number
  avgLatencyMs: number
  windowStart: number
  windowEnd: number
}

interface CacheCallRecord {
  ts: number
  sessionId: string
  taskId?: string
  subAgentTaskId?: string
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  latencyMs: number
  [key: string]: unknown
}

interface CacheResponse {
  recent: CacheAggregate
  daily: Array<{ date: string; aggregate: CacheAggregate }>
  windowMs: number
  days: number
}

interface BudgetStatus {
  config: {
    global: { perSession: number; perDay: number }
    main: { perTask: number; warnRatio: number; overBehavior: string }
    subAgent: { enabled: boolean; defaultPerTask: number; warnRatio: number; overBehavior: string; downgradeModel: string }
  }
  today: { date: string; tokens: number }
  daily: Record<string, number>
  sessionTotals: Record<string, number>
  mainTaskTotals: Record<string, number>
  subAgentTaskTotals: Record<string, number>
}

type Tab = 'calls' | 'cache' | 'budget'

const today = new Date().toISOString().slice(0, 10)
const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)

export default function MetricsPage() {
  const [tab, setTab] = useState<Tab>('calls')

  return (
    <div>
      <h2 className="text-xl font-semibold mb-6">Metrics</h2>

      <div className="flex gap-1 mb-6 border-b border-gray-200">
        <TabButton active={tab === 'calls'} onClick={() => setTab('calls')}>Calls</TabButton>
        <TabButton active={tab === 'cache'} onClick={() => setTab('cache')}>Cache health</TabButton>
        <TabButton active={tab === 'budget'} onClick={() => setTab('budget')}>Budget</TabButton>
      </div>

      {tab === 'calls' && <CallsTab />}
      {tab === 'cache' && <CacheTab />}
      {tab === 'budget' && <BudgetTab />}
    </div>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active
          ? 'border-blue-600 text-blue-600'
          : 'border-transparent text-gray-500 hover:text-gray-700'
      }`}
    >
      {children}
    </button>
  )
}

// ============================================================
// Tab 1 — Per-call log (existing view, unchanged)
// ============================================================

function CallsTab() {
  const [start, setStart] = useState(weekAgo)
  const [end, setEnd] = useState(today)
  const [model, setModel] = useState('')

  const { data: callsData } = useApi<{ calls: MetricCall[] }>(
    () => apiGet(`/metrics/calls?start=${start}&end=${end}${model ? `&model=${model}` : ''}`),
    [start, end, model],
  )

  const { data: agg } = useApi<Aggregate>(
    () => apiGet(`/metrics/aggregate?start=${start}&end=${end}`),
    [start, end],
  )

  const calls = callsData?.calls ?? []
  const models = [...new Set(calls.map((c) => c.model))]

  const columns: Column<MetricCall>[] = [
    {
      key: 'timestamp',
      label: 'Time',
      sortable: true,
      render: (row) => new Date(row.timestamp).toLocaleString(),
    },
    { key: 'model', label: 'Model' },
    {
      key: 'tokens',
      label: 'Tokens (in/out)',
      render: (row) => `${row.tokens.prompt} / ${row.tokens.completion}`,
    },
    {
      key: 'cacheHitRate',
      label: 'Cache',
      render: (row) => `${(row.cacheHitRate * 100).toFixed(1)}%`,
    },
    {
      key: 'cost',
      label: 'Cost',
      sortable: true,
      render: (row) => `$${row.cost.toFixed(6)}`,
    },
    {
      key: 'duration',
      label: 'Duration',
      sortable: true,
      render: (row) => `${row.duration}ms`,
    },
  ]

  return (
    <div>
      <div className="flex gap-3 mb-6 items-center">
        <label className="text-sm text-gray-500">From</label>
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="border rounded-lg px-3 py-1.5 text-sm" />
        <label className="text-sm text-gray-500">To</label>
        <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="border rounded-lg px-3 py-1.5 text-sm" />
        <select value={model} onChange={(e) => setModel(e.target.value)} className="border rounded-lg px-3 py-1.5 text-sm">
          <option value="">All models</option>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      {agg && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          <SummaryCard label="Total Calls" value={agg.totalCalls} />
          <SummaryCard label="Total Cost" value={`$${agg.totalCost.toFixed(4)}`} />
          <SummaryCard label="Total Tokens" value={(agg.totalPromptTokens + agg.totalCompletionTokens).toLocaleString()} />
          <SummaryCard label="Avg Cache Hit" value={`${(agg.avgCacheHitRate * 100).toFixed(1)}%`} />
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200">
        <DataTable<MetricCall>
          columns={columns}
          data={calls}
          keyField="callId"
          emptyMessage="No metrics data for this period"
        />
      </div>
    </div>
  )
}

// ============================================================
// Tab 2 — Cache health (recent window + daily series + recent calls)
// ============================================================

function CacheTab() {
  const [days, setDays] = useState(7)
  const { data: cache } = useApi<CacheResponse>(
    () => apiGet(`/metrics/cache?days=${days}`),
    [days],
  )
  const { data: recent } = useApi<{ calls: CacheCallRecord[] }>(
    () => apiGet(`/metrics/cache/recent?limit=50`),
    [],
  )

  if (!cache) return <div className="text-sm text-gray-500">Loading…</div>

  const recentAgg = cache.recent
  const series = cache.daily
  const peakHitRatio = Math.max(0, ...series.map((d) => d.aggregate.hitRatio))

  return (
    <div>
      <div className="flex gap-3 mb-6 items-center">
        <label className="text-sm text-gray-500">Window</label>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="border rounded-lg px-3 py-1.5 text-sm">
          <option value={3}>3 days</option>
          <option value={7}>7 days</option>
          <option value={14}>14 days</option>
          <option value={30}>30 days</option>
        </select>
      </div>

      {/* Recent (last 24h from ring buffer) */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <SummaryCard
          label="Calls (24h)"
          value={recentAgg.totalCalls}
          subtitle={recentAgg.totalCalls > 0 ? `avg ${recentAgg.avgLatencyMs.toFixed(0)}ms` : 'no calls'}
        />
        <SummaryCard
          label="Hit ratio (24h)"
          value={`${(recentAgg.hitRatio * 100).toFixed(1)}%`}
          subtitle={`${recentAgg.totalCacheReadTokens.toLocaleString()} cache-read tokens`}
        />
        <SummaryCard
          label="Input tokens (24h)"
          value={recentAgg.totalInputTokens.toLocaleString()}
          subtitle={`${recentAgg.totalCacheCreationTokens.toLocaleString()} cache-write`}
        />
        <SummaryCard
          label="Output tokens (24h)"
          value={recentAgg.totalOutputTokens.toLocaleString()}
        />
      </div>

      {/* Daily series — simple bar list */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
        <h3 className="text-sm font-semibold mb-4">Hit ratio by day</h3>
        {series.length === 0 ? (
          <p className="text-sm text-gray-500">No data</p>
        ) : (
          <div className="space-y-2">
            {series.map((d) => (
              <div key={d.date} className="flex items-center gap-3 text-xs">
                <span className="w-24 text-gray-500 font-mono">{d.date}</span>
                <div className="flex-1 bg-gray-100 rounded h-5 relative overflow-hidden">
                  <div
                    className="bg-blue-500 h-full transition-all"
                    style={{ width: `${peakHitRatio > 0 ? (d.aggregate.hitRatio / peakHitRatio) * 100 : 0}%` }}
                  />
                  <span className="absolute inset-0 flex items-center justify-end pr-2 text-gray-700 font-medium">
                    {(d.aggregate.hitRatio * 100).toFixed(1)}% · {d.aggregate.totalCalls} calls
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent raw calls from ring buffer */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-semibold mb-4">Recent calls (ring buffer)</h3>
        {!recent || recent.calls.length === 0 ? (
          <p className="text-sm text-gray-500">No recent calls</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-gray-500 border-b border-gray-200">
                <tr>
                  <th className="py-2 pr-4">Time</th>
                  <th className="py-2 pr-4">Model</th>
                  <th className="py-2 pr-4">Session</th>
                  <th className="py-2 pr-4 text-right">In</th>
                  <th className="py-2 pr-4 text-right">Out</th>
                  <th className="py-2 pr-4 text-right">Cache R/W</th>
                  <th className="py-2 pr-4 text-right">Latency</th>
                </tr>
              </thead>
              <tbody>
                {recent.calls.map((c, i) => (
                  <tr key={`${c.ts}-${i}`} className="border-b border-gray-100">
                    <td className="py-2 pr-4 font-mono">{new Date(c.ts).toLocaleTimeString()}</td>
                    <td className="py-2 pr-4">{c.model}</td>
                    <td className="py-2 pr-4 truncate max-w-[140px]">{c.sessionId}</td>
                    <td className="py-2 pr-4 text-right">{c.inputTokens.toLocaleString()}</td>
                    <td className="py-2 pr-4 text-right">{c.outputTokens.toLocaleString()}</td>
                    <td className="py-2 pr-4 text-right">
                      {c.cacheReadTokens.toLocaleString()} / {c.cacheCreationTokens.toLocaleString()}
                    </td>
                    <td className="py-2 pr-4 text-right">{c.latencyMs}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================
// Tab 3 — Budget burn-down (three layers)
// ============================================================

function BudgetTab() {
  const { data: budget } = useApi<BudgetStatus>(() => apiGet('/metrics/budget'), [])
  if (!budget) return <div className="text-sm text-gray-500">Loading…</div>

  const todayPct = (budget.today.tokens / budget.config.global.perDay) * 100
  const sessionEntries = Object.entries(budget.sessionTotals).sort((a, b) => b[1] - a[1])
  const dailyEntries = Object.entries(budget.daily)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-14)
  const peakDay = Math.max(0, ...dailyEntries.map(([, n]) => n))

  return (
    <div>
      {/* Layer 3 — Global */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <SummaryCard
          label="Today's tokens"
          value={budget.today.tokens.toLocaleString()}
          subtitle={`${todayPct.toFixed(1)}% of daily ceiling`}
        />
        <SummaryCard
          label="Per-day ceiling"
          value={budget.config.global.perDay.toLocaleString()}
          subtitle="Layer 3 — Global"
        />
        <SummaryCard
          label="Per-session ceiling"
          value={budget.config.global.perSession.toLocaleString()}
          subtitle={`${sessionEntries.length} active session(s)`}
        />
      </div>

      <BurnDown label="Today" used={budget.today.tokens} budget={budget.config.global.perDay} />

      {/* Per-layer config snapshot */}
      <div className="grid grid-cols-2 gap-4 mb-6 mt-6">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold mb-3">Layer 2 — Main agent (per task)</h3>
          <dl className="text-xs space-y-1">
            <Row label="Per-task budget" value={budget.config.main.perTask.toLocaleString()} />
            <Row label="Warn ratio" value={`${(budget.config.main.warnRatio * 100).toFixed(0)}%`} />
            <Row label="Over behavior" value={budget.config.main.overBehavior} />
            <Row label="In-flight tasks" value={Object.keys(budget.mainTaskTotals).length} />
          </dl>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold mb-3">Layer 1 — Sub-agent (per task)</h3>
          <dl className="text-xs space-y-1">
            <Row label="Enabled" value={String(budget.config.subAgent.enabled)} />
            <Row label="Default per-task" value={budget.config.subAgent.defaultPerTask.toLocaleString()} />
            <Row label="Warn ratio" value={`${(budget.config.subAgent.warnRatio * 100).toFixed(0)}%`} />
            <Row label="Over behavior" value={budget.config.subAgent.overBehavior} />
            <Row label="Downgrade model" value={budget.config.subAgent.downgradeModel} />
            <Row label="In-flight tasks" value={Object.keys(budget.subAgentTaskTotals).length} />
          </dl>
        </div>
      </div>

      {/* Daily 14-day burn series */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
        <h3 className="text-sm font-semibold mb-4">Daily token usage (last 14 days)</h3>
        {dailyEntries.length === 0 ? (
          <p className="text-sm text-gray-500">No usage recorded</p>
        ) : (
          <div className="space-y-2">
            {dailyEntries.map(([date, tokens]) => (
              <div key={date} className="flex items-center gap-3 text-xs">
                <span className="w-24 text-gray-500 font-mono">{date}</span>
                <div className="flex-1 bg-gray-100 rounded h-5 relative overflow-hidden">
                  <div
                    className="bg-amber-500 h-full"
                    style={{ width: `${peakDay > 0 ? (tokens / peakDay) * 100 : 0}%` }}
                  />
                  <span className="absolute inset-0 flex items-center justify-end pr-2 text-gray-700 font-medium">
                    {tokens.toLocaleString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Per-session totals (process-lifetime) */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-semibold mb-4">Per-session usage (since process start)</h3>
        {sessionEntries.length === 0 ? (
          <p className="text-sm text-gray-500">No session activity</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-left text-gray-500 border-b border-gray-200">
              <tr>
                <th className="py-2 pr-4">Session</th>
                <th className="py-2 pr-4 text-right">Tokens used</th>
                <th className="py-2 pr-4 text-right">% of session ceiling</th>
              </tr>
            </thead>
            <tbody>
              {sessionEntries.map(([sid, used]) => (
                <tr key={sid} className="border-b border-gray-100">
                  <td className="py-2 pr-4 font-mono">{sid}</td>
                  <td className="py-2 pr-4 text-right">{used.toLocaleString()}</td>
                  <td className="py-2 pr-4 text-right">
                    {((used / budget.config.global.perSession) * 100).toFixed(2)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between">
      <dt className="text-gray-500">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  )
}

function BurnDown({ label, used, budget }: { label: string; used: number; budget: number }) {
  const pct = budget > 0 ? Math.min(100, (used / budget) * 100) : 0
  const color = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-green-500'
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex justify-between mb-2 text-sm">
        <span className="text-gray-500">{label}</span>
        <span className="font-medium">
          {used.toLocaleString()} / {budget.toLocaleString()} ({pct.toFixed(1)}%)
        </span>
      </div>
      <div className="bg-gray-100 rounded h-3 overflow-hidden">
        <div className={`${color} h-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
