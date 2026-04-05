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

const today = new Date().toISOString().slice(0, 10)
const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)

export default function MetricsPage() {
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
      <h2 className="text-xl font-semibold mb-6">Metrics</h2>

      {/* Filters */}
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

      {/* Aggregate Summary */}
      {agg && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          <SummaryCard label="Total Calls" value={agg.totalCalls} />
          <SummaryCard label="Total Cost" value={`$${agg.totalCost.toFixed(4)}`} />
          <SummaryCard label="Total Tokens" value={(agg.totalPromptTokens + agg.totalCompletionTokens).toLocaleString()} />
          <SummaryCard label="Avg Cache Hit" value={`${(agg.avgCacheHitRate * 100).toFixed(1)}%`} />
        </div>
      )}

      {/* Call Log Table */}
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
