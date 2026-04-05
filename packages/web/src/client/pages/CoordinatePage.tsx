import { useState } from 'react'
import { useApi } from '../hooks/useApi.js'
import { apiGet, apiPost, apiDelete } from '../api/client.js'

// === Types ===

interface AgentTemplate {
  role: string
  name: string
  description: string
  capabilities: string[]
  preferredSkills: string[]
  preferredProvider?: string
}

interface AgentProfile {
  id: string
  name: string
  role: string
  description: string
  capabilities: string[]
  status: 'idle' | 'busy' | 'offline'
  provider?: string
}

interface DelegationTask {
  id: string
  description: string
  assignedTo?: string
  status: string
  result?: string
  error?: string
}

interface DelegationResult {
  taskId: string
  subtasks: DelegationTask[]
  aggregatedResult: string
  success: boolean
}

interface InterAgentMessage {
  id: string
  from: string
  to: string
  type: string
  payload: unknown
  correlationId?: string
  timestamp: string
}

// === Role icons ===

const roleIcons: Record<string, string> = {
  researcher: 'magnifying-glass',
  developer: 'code',
  writer: 'pencil',
  analyst: 'chart',
}

function RoleIcon({ role }: { role: string }) {
  const icons: Record<string, string> = {
    researcher: '\uD83D\uDD0D',
    developer: '\uD83D\uDCBB',
    writer: '\u270D\uFE0F',
    analyst: '\uD83D\uDCC8',
  }
  return <span className="text-2xl">{icons[role] ?? '\uD83E\uDD16'}</span>
}

// === Status badge colors ===

const statusColors: Record<string, { bg: string; text: string }> = {
  idle: { bg: 'bg-green-100', text: 'text-green-700' },
  busy: { bg: 'bg-yellow-100', text: 'text-yellow-700' },
  offline: { bg: 'bg-gray-100', text: 'text-gray-500' },
}

// === Component ===

export default function CoordinatePage() {
  // Fetch templates and agents
  const { data: templateData } = useApi<{ templates: Record<string, AgentTemplate> }>(
    () => apiGet('/coordinate/templates'),
  )
  const { data: agentData, refetch: refetchAgents } = useApi<{ agents: AgentProfile[] }>(
    () => apiGet('/coordinate/agents'),
  )
  const { data: messageData, refetch: refetchMessages } = useApi<{ messages: InterAgentMessage[] }>(
    () => apiGet('/coordinate/messages'),
  )

  const templates = templateData?.templates ?? {}
  const agents = agentData?.agents ?? []
  const messages = messageData?.messages ?? []

  // Creation state
  const [creating, setCreating] = useState<string | null>(null)
  const [createName, setCreateName] = useState('')

  // Delegation state
  const [delegateTask, setDelegateTask] = useState('')
  const [delegateFrom, setDelegateFrom] = useState('')
  const [delegating, setDelegating] = useState(false)
  const [delegationResult, setDelegationResult] = useState<DelegationResult | null>(null)
  const [delegationError, setDelegationError] = useState<string | null>(null)

  // Message filter
  const [messageFilter, setMessageFilter] = useState('')

  // === Handlers ===

  const handleCreate = async (templateId: string) => {
    try {
      await apiPost('/coordinate/agents', {
        templateId,
        name: createName || undefined,
      })
      setCreating(null)
      setCreateName('')
      refetchAgents()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create agent')
    }
  }

  const handleDelete = async (agentId: string) => {
    try {
      await apiDelete(`/coordinate/agents/${agentId}`)
      refetchAgents()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete agent')
    }
  }

  const handleDelegate = async () => {
    if (!delegateTask.trim()) return
    setDelegating(true)
    setDelegationError(null)
    setDelegationResult(null)
    try {
      const result = await apiPost<DelegationResult>('/coordinate/delegate', {
        task: delegateTask,
        fromAgentId: delegateFrom || undefined,
      })
      setDelegationResult(result)
      refetchMessages()
      refetchAgents()
    } catch (err) {
      setDelegationError(err instanceof Error ? err.message : 'Delegation failed')
    } finally {
      setDelegating(false)
    }
  }

  const filteredMessages = messageFilter
    ? messages.filter((m) => m.from === messageFilter || m.to === messageFilter)
    : messages

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h2 className="text-xl font-semibold">Multi-Agent Coordination</h2>
        <p className="text-sm text-gray-500 mt-1">
          Create agents from templates, delegate tasks, and monitor inter-agent communication.
        </p>
      </div>

      {/* Section A: Agent Templates */}
      <div className="mb-8">
        <h3 className="text-sm font-medium text-gray-700 mb-3">Agent Templates</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Object.entries(templates).map(([id, template]) => (
            <div key={id} className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="flex items-center gap-2 mb-2">
                <RoleIcon role={template.role} />
                <div>
                  <h4 className="text-sm font-medium">{template.name}</h4>
                  <span className="text-[10px] text-gray-400">{template.role}</span>
                </div>
              </div>
              <p className="text-xs text-gray-500 mb-3">{template.description}</p>
              <div className="flex flex-wrap gap-1 mb-3">
                {template.capabilities.map((cap) => (
                  <span
                    key={cap}
                    className="text-[10px] bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded"
                  >
                    {cap}
                  </span>
                ))}
              </div>

              {creating === id ? (
                <div className="space-y-2">
                  <input
                    placeholder="Custom name (optional)"
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
                    className="w-full border rounded-lg px-2 py-1 text-xs"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleCreate(id)}
                      className="bg-blue-600 text-white text-xs px-3 py-1 rounded-lg hover:bg-blue-700"
                    >
                      Create
                    </button>
                    <button
                      onClick={() => { setCreating(null); setCreateName('') }}
                      className="text-gray-500 text-xs px-2 py-1"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setCreating(id)}
                  className="w-full bg-gray-50 text-gray-700 text-xs px-3 py-1.5 rounded-lg hover:bg-gray-100 border border-gray-200"
                >
                  Create Agent
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Section B: Active Agents */}
      <div className="mb-8">
        <h3 className="text-sm font-medium text-gray-700 mb-3">
          Active Agents
          <span className="ml-2 text-xs text-gray-400">({agents.length})</span>
        </h3>
        {agents.length === 0 ? (
          <div className="text-center text-gray-400 py-8 bg-white rounded-xl border border-gray-200">
            No agents created yet. Use a template above to create one.
          </div>
        ) : (
          <div className="space-y-3">
            {agents.map((agent) => {
              const sc = statusColors[agent.status] ?? statusColors.offline
              return (
                <div key={agent.id} className="bg-white rounded-xl border border-gray-200 p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <RoleIcon role={agent.role} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h4 className="text-sm font-medium truncate">{agent.name}</h4>
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${sc.bg} ${sc.text}`}
                          >
                            {agent.status}
                          </span>
                        </div>
                        <p className="text-xs text-gray-400 truncate">{agent.id}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 ml-4 shrink-0">
                      <div className="flex flex-wrap gap-1">
                        {agent.capabilities.slice(0, 3).map((cap) => (
                          <span
                            key={cap}
                            className="text-[10px] bg-gray-50 text-gray-500 px-1.5 py-0.5 rounded"
                          >
                            {cap}
                          </span>
                        ))}
                        {agent.capabilities.length > 3 && (
                          <span className="text-[10px] text-gray-400">
                            +{agent.capabilities.length - 3}
                          </span>
                        )}
                      </div>
                      {agent.provider && (
                        <span className="text-[10px] bg-purple-50 text-purple-600 px-1.5 py-0.5 rounded">
                          {agent.provider}
                        </span>
                      )}
                      <button
                        onClick={() => handleDelete(agent.id)}
                        className="text-red-500 text-xs hover:underline"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Section C: Delegate Task */}
      <div className="mb-8">
        <h3 className="text-sm font-medium text-gray-700 mb-3">Delegate Task</h3>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="space-y-3">
            <textarea
              placeholder="Describe the task to delegate..."
              value={delegateTask}
              onChange={(e) => setDelegateTask(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm"
              rows={3}
            />
            <div className="flex items-center gap-3">
              <select
                value={delegateFrom}
                onChange={(e) => setDelegateFrom(e.target.value)}
                className="border rounded-lg px-3 py-1.5 text-sm text-gray-700"
              >
                <option value="">From: Coordinator (default)</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    From: {a.name}
                  </option>
                ))}
              </select>
              <button
                onClick={handleDelegate}
                disabled={delegating || !delegateTask.trim()}
                className={`text-sm px-4 py-1.5 rounded-lg ${
                  delegating || !delegateTask.trim()
                    ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    : 'bg-blue-600 text-white hover:bg-blue-700'
                }`}
              >
                {delegating ? 'Delegating...' : 'Delegate'}
              </button>
            </div>
          </div>

          {/* Delegation error */}
          {delegationError && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-red-700">{delegationError}</p>
            </div>
          )}

          {/* Delegation result */}
          {delegationResult && (
            <div className="mt-4 border-t border-gray-100 pt-4">
              <div className="flex items-center gap-2 mb-3">
                <h4 className="text-xs font-medium text-gray-700">Delegation Result</h4>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                    delegationResult.success
                      ? 'bg-green-100 text-green-700'
                      : 'bg-red-100 text-red-700'
                  }`}
                >
                  {delegationResult.success ? 'Success' : 'Partial/Failed'}
                </span>
              </div>

              {/* Subtasks */}
              <div className="space-y-2 mb-3">
                {delegationResult.subtasks.map((st) => (
                  <div key={st.id} className="bg-gray-50 rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                          st.status === 'completed'
                            ? 'bg-green-100 text-green-700'
                            : 'bg-red-100 text-red-700'
                        }`}
                      >
                        {st.status}
                      </span>
                      {st.assignedTo && (
                        <span className="text-[10px] text-gray-400">
                          Agent: {st.assignedTo}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-700">{st.description}</p>
                    {st.result && (
                      <p className="text-xs text-gray-500 mt-1 whitespace-pre-wrap">
                        {st.result.slice(0, 500)}
                      </p>
                    )}
                    {st.error && (
                      <p className="text-xs text-red-500 mt-1">{st.error}</p>
                    )}
                  </div>
                ))}
              </div>

              {/* Aggregated result */}
              <div className="bg-blue-50 rounded-lg p-3">
                <h5 className="text-[10px] font-medium text-blue-700 mb-1">Aggregated Result</h5>
                <p className="text-xs text-gray-700 whitespace-pre-wrap">
                  {delegationResult.aggregatedResult}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Section D: Message Log */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-gray-700">
            Message Log
            <span className="ml-2 text-xs text-gray-400">({filteredMessages.length})</span>
          </h3>
          <div className="flex items-center gap-2">
            <select
              value={messageFilter}
              onChange={(e) => setMessageFilter(e.target.value)}
              className="border rounded-lg px-2 py-1 text-xs text-gray-700"
            >
              <option value="">All agents</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <button
              onClick={refetchMessages}
              className="text-xs text-blue-600 hover:underline"
            >
              Refresh
            </button>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {filteredMessages.length === 0 ? (
            <div className="text-center text-gray-400 py-8 text-sm">
              No messages yet. Delegate a task to see inter-agent communication.
            </div>
          ) : (
            <div className="max-h-96 overflow-y-auto divide-y divide-gray-100">
              {filteredMessages
                .slice()
                .reverse()
                .map((msg) => {
                  const typeBadgeColors: Record<string, string> = {
                    'task-request': 'bg-blue-100 text-blue-700',
                    'task-result': 'bg-green-100 text-green-700',
                    'info-query': 'bg-yellow-100 text-yellow-700',
                    'info-reply': 'bg-purple-100 text-purple-700',
                    broadcast: 'bg-gray-100 text-gray-700',
                  }
                  const badgeClass = typeBadgeColors[msg.type] ?? 'bg-gray-100 text-gray-500'
                  const payloadPreview =
                    typeof msg.payload === 'string'
                      ? msg.payload.slice(0, 120)
                      : JSON.stringify(msg.payload)?.slice(0, 120) ?? ''

                  return (
                    <div key={msg.id} className="px-4 py-3 hover:bg-gray-50">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-medium text-gray-700">
                          {msg.from}
                        </span>
                        <span className="text-[10px] text-gray-400">-&gt;</span>
                        <span className="text-xs font-medium text-gray-700">
                          {msg.to}
                        </span>
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${badgeClass}`}
                        >
                          {msg.type}
                        </span>
                        <span className="text-[10px] text-gray-400 ml-auto">
                          {new Date(msg.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                      {payloadPreview && (
                        <p className="text-xs text-gray-500 truncate">{payloadPreview}</p>
                      )}
                    </div>
                  )
                })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
