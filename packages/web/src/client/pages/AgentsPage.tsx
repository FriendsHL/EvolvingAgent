import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi.js'
import { apiGet, apiPost, apiDelete } from '../api/client.js'

interface AgentEntry {
  id: string
  name: string
  description: string
  provider: string | { type: string; models: Record<string, string> }
  createdAt: string
  updatedAt: string
  [key: string]: unknown
}

interface MainAgentInfo {
  id: 'main'
  name: string
  provider: string
  models: { planner: string; executor: string; reflector: string }
  prompts: Array<{ id: string; source: string; length: number; preview: string }>
  tools: string[]
  skills: string[]
  note: string
}

const PRESETS = ['anthropic', 'openai', 'bailian', 'bailian-coding', 'bailian-glm5', 'deepseek']

export default function AgentsPage() {
  const { data, refetch } = useApi<{ agents: AgentEntry[] }>(() => apiGet('/agents'))
  const { data: mainData } = useApi<MainAgentInfo>(() => apiGet('/agents/main'))
  const agents = data?.agents ?? []
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: '', description: '', provider: 'bailian-coding' })

  const handleCreate = async () => {
    await apiPost('/agents', form)
    setShowForm(false)
    setForm({ name: '', description: '', provider: 'bailian-coding' })
    refetch()
  }

  const handleDelete = async (id: string) => {
    await apiDelete(`/agents/${id}`)
    refetch()
  }

  const getProviderLabel = (provider: AgentEntry['provider']) => {
    if (typeof provider === 'string') return provider
    return `${provider.type} (${Object.values(provider.models).join(', ')})`
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">Agents</h2>
        <button onClick={() => setShowForm(true)} className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700">
          Create Agent
        </button>
      </div>

      {/* Main agent — the one /api/chat actually uses */}
      {mainData && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-5 mb-6">
          <div className="flex items-start justify-between mb-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 bg-blue-600 text-white text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide">
                  Main
                </span>
                <h3 className="text-base font-semibold text-gray-900">{mainData.name}</h3>
              </div>
              <p className="text-xs text-gray-500 mt-1">{mainData.note}</p>
            </div>
            <div className="text-right text-xs text-gray-500">
              <div>Provider: <span className="font-mono text-gray-800">{mainData.provider}</span></div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
            <div className="bg-white rounded-lg border border-blue-100 p-3">
              <div className="text-[11px] text-gray-400 uppercase tracking-wide">Planner</div>
              <div className="text-sm font-mono text-gray-800 truncate">{mainData.models.planner}</div>
            </div>
            <div className="bg-white rounded-lg border border-blue-100 p-3">
              <div className="text-[11px] text-gray-400 uppercase tracking-wide">Executor</div>
              <div className="text-sm font-mono text-gray-800 truncate">{mainData.models.executor}</div>
            </div>
            <div className="bg-white rounded-lg border border-blue-100 p-3">
              <div className="text-[11px] text-gray-400 uppercase tracking-wide">Reflector</div>
              <div className="text-sm font-mono text-gray-800 truncate">{mainData.models.reflector}</div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
            <div>
              <div className="text-[11px] text-gray-400 uppercase tracking-wide mb-1">
                Tools ({mainData.tools.length})
              </div>
              <div className="flex flex-wrap gap-1">
                {mainData.tools.map((t) => (
                  <span key={t} className="text-[11px] font-mono bg-white border border-gray-200 text-gray-700 px-1.5 py-0.5 rounded">
                    {t}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-gray-400 uppercase tracking-wide mb-1">
                Skills ({mainData.skills.length})
              </div>
              <div className="flex flex-wrap gap-1">
                {mainData.skills.map((s) => (
                  <span key={s} className="text-[11px] font-mono bg-white border border-gray-200 text-gray-700 px-1.5 py-0.5 rounded">
                    {s}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div>
            <div className="text-[11px] text-gray-400 uppercase tracking-wide mb-1 flex items-center gap-2">
              Prompts
              <Link to="/prompts" className="text-blue-600 hover:underline normal-case tracking-normal">
                edit →
              </Link>
            </div>
            <div className="space-y-2">
              {mainData.prompts.map((p) => (
                <div key={p.id} className="bg-white rounded-lg border border-blue-100 p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-xs font-semibold">{p.id}</span>
                    <span className="text-[10px] text-gray-400">{p.source}</span>
                    <span className="text-[10px] text-gray-400 ml-auto">{p.length} chars</span>
                  </div>
                  <p className="text-xs text-gray-600 font-mono whitespace-pre-wrap line-clamp-2">
                    {p.preview}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <h3 className="text-sm font-medium text-gray-500 mb-3">Custom agent registry</h3>

      {showForm && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
          <h3 className="text-sm font-medium mb-4">New Agent</h3>
          <div className="space-y-3">
            <input
              placeholder="Agent name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm"
            />
            <input
              placeholder="Description"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm"
            />
            <select
              value={form.provider}
              onChange={(e) => setForm({ ...form, provider: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm"
            >
              {PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div className="flex gap-2 mt-4">
            <button onClick={handleCreate} className="bg-blue-600 text-white text-sm px-4 py-1.5 rounded-lg">Create</button>
            <button onClick={() => setShowForm(false)} className="text-gray-500 text-sm px-4 py-1.5">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {agents.length === 0 && !showForm && (
          <div className="text-center text-gray-400 py-12">No agents configured yet</div>
        )}
        {agents.map((agent) => (
          <div key={agent.id} className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-sm font-medium">{agent.name}</h3>
                {agent.description && <p className="text-xs text-gray-500 mt-1">{agent.description}</p>}
                <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
                  <span>Provider: <span className="font-medium text-gray-600">{getProviderLabel(agent.provider)}</span></span>
                  <span>Created: {new Date(agent.createdAt).toLocaleDateString()}</span>
                </div>
              </div>
              <button onClick={() => handleDelete(agent.id)} className="text-red-500 text-xs hover:underline">Delete</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
