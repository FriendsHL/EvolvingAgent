import { useState } from 'react'
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

const PRESETS = ['anthropic', 'openai', 'bailian', 'bailian-coding', 'deepseek']

export default function AgentsPage() {
  const { data, refetch } = useApi<{ agents: AgentEntry[] }>(() => apiGet('/agents'))
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
