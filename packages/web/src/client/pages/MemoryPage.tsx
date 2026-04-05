import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../hooks/useApi.js'
import { apiGet, apiPost } from '../api/client.js'
import StatusBadge from '../components/shared/StatusBadge.js'
import SummaryCard from '../components/shared/SummaryCard.js'

interface Experience {
  id: string
  task: string
  result: 'success' | 'partial' | 'failure'
  tags: string[]
  timestamp: string
  admissionScore: number
  health: { referencedCount: number; lastReferenced?: string }
  [key: string]: unknown
}

interface PoolStats {
  active: number
  stale: number
  archive: number
}

export default function MemoryPage() {
  const navigate = useNavigate()
  const [pool, setPool] = useState('all')
  const [result, setResult] = useState('')
  const [search, setSearch] = useState('')

  const { data: statsData } = useApi<PoolStats>(() => apiGet('/memory/stats'))

  const { data: expData, refetch } = useApi<{ experiences: Experience[] }>(
    () => search
      ? apiGet(`/memory/search?q=${encodeURIComponent(search)}`)
        .then((r: { results: { content: Experience }[] }) => ({
          experiences: r.results.map((x: { content: Experience }) => x.content),
        }))
      : apiGet(`/memory/experiences?pool=${pool}${result ? `&result=${result}` : ''}`),
    [pool, result, search],
  )

  const experiences = expData?.experiences ?? []

  const handleMaintain = async () => {
    await apiPost('/memory/maintain')
    refetch()
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">Memory</h2>
        <button
          onClick={handleMaintain}
          className="bg-gray-100 hover:bg-gray-200 text-sm px-3 py-1.5 rounded-lg transition-colors"
        >
          Run Maintenance
        </button>
      </div>

      {/* Pool Stats */}
      {statsData && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <SummaryCard label="Active Pool" value={statsData.active} subtitle="Cap: 200" />
          <SummaryCard label="Stale Pool" value={statsData.stale} subtitle="Cap: 100" />
          <SummaryCard label="Archive" value={statsData.archive} />
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3 mb-6 items-center">
        <input
          type="text"
          placeholder="Search experiences..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="border rounded-lg px-3 py-1.5 text-sm w-64"
        />
        <select value={pool} onChange={(e) => setPool(e.target.value)} className="border rounded-lg px-3 py-1.5 text-sm">
          <option value="all">All Pools</option>
          <option value="active">Active</option>
          <option value="stale">Stale</option>
        </select>
        <select value={result} onChange={(e) => setResult(e.target.value)} className="border rounded-lg px-3 py-1.5 text-sm">
          <option value="">All Results</option>
          <option value="success">Success</option>
          <option value="partial">Partial</option>
          <option value="failure">Failure</option>
        </select>
      </div>

      {/* Experience List */}
      <div className="space-y-3">
        {experiences.length === 0 && (
          <div className="text-center text-gray-400 py-12">No experiences found</div>
        )}
        {experiences.map((exp) => (
          <div
            key={exp.id}
            onClick={() => navigate(`/memory/${exp.id}`)}
            className="bg-white rounded-xl border border-gray-200 p-4 cursor-pointer hover:border-blue-300 transition-colors"
          >
            <div className="flex items-start justify-between">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{exp.task}</p>
                <div className="flex items-center gap-2 mt-2">
                  <StatusBadge status={exp.result} />
                  <span className="text-xs text-gray-400">
                    Score: {exp.admissionScore.toFixed(2)}
                  </span>
                  <span className="text-xs text-gray-400">
                    Refs: {exp.health.referencedCount}
                  </span>
                </div>
                {exp.tags.length > 0 && (
                  <div className="flex gap-1 mt-2">
                    {exp.tags.map((tag) => (
                      <span key={tag} className="bg-gray-100 text-gray-600 text-xs px-2 py-0.5 rounded">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <span className="text-xs text-gray-400 whitespace-nowrap ml-4">
                {new Date(exp.timestamp).toLocaleDateString()}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
