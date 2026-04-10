import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../hooks/useApi.js'
import { apiGet, apiPost } from '../api/client.js'
import StatusBadge from '../components/shared/StatusBadge.js'
import SummaryCard from '../components/shared/SummaryCard.js'
import DistillationPanel from '../components/memory/DistillationPanel.js'

type MemoryTab = 'experiences' | 'distillation'

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
  const [tab, setTab] = useState<MemoryTab>('experiences')
  const [pool, setPool] = useState('all')
  const [result, setResult] = useState('')
  const [search, setSearch] = useState('')

  const { data: statsData } = useApi<PoolStats>(() => apiGet('/memory/stats'))

  const { data: expData, refetch } = useApi<{ experiences: Experience[] }>(
    () => search
      ? apiGet<{ results: { content: Experience }[] }>(`/memory/search?q=${encodeURIComponent(search)}`)
        .then((r) => ({
          experiences: r.results.map((x) => x.content),
        }))
      : apiGet<{ experiences: Experience[] }>(`/memory/experiences?pool=${pool}${result ? `&result=${result}` : ''}`),
    [pool, result, search],
  )

  const experiences = expData?.experiences ?? []

  const handleMaintain = async () => {
    await apiPost('/memory/maintain')
    refetch()
  }

  return (
    <div className="overflow-hidden">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">Memory</h2>
        {tab === 'experiences' && (
          <button
            onClick={handleMaintain}
            className="bg-gray-100 hover:bg-gray-200 text-sm px-3 py-1.5 rounded-lg transition-colors"
          >
            Run Maintenance
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 mb-6">
        {(['experiences', 'distillation'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t === 'experiences' ? 'Experiences' : 'Distillation'}
          </button>
        ))}
      </div>

      {tab === 'distillation' ? (
        <DistillationPanel />
      ) : (
        <ExperiencesView
          statsData={statsData}
          experiences={experiences}
          search={search}
          setSearch={setSearch}
          pool={pool}
          setPool={setPool}
          result={result}
          setResult={setResult}
          onNavigate={(id) => navigate(`/memory/${id}`)}
        />
      )}
    </div>
  )
}

function ExperiencesView({
  statsData,
  experiences,
  search,
  setSearch,
  pool,
  setPool,
  result,
  setResult,
  onNavigate,
}: {
  statsData: PoolStats | null
  experiences: Experience[]
  search: string
  setSearch: (s: string) => void
  pool: string
  setPool: (s: string) => void
  result: string
  setResult: (s: string) => void
  onNavigate: (id: string) => void
}) {
  return (
    <div>
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
            onClick={() => onNavigate(exp.id)}
            className="bg-white rounded-xl border border-gray-200 p-4 cursor-pointer hover:border-blue-300 transition-colors overflow-hidden"
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
                  <div className="flex flex-wrap gap-1 mt-2">
                    {exp.tags.map((tag) => (
                      <span key={tag} className="bg-gray-100 text-gray-600 text-xs px-2 py-0.5 rounded truncate max-w-[200px]">
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
