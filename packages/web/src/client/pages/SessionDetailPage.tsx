import { useParams, useNavigate } from 'react-router-dom'
import { useApi } from '../hooks/useApi.js'
import { apiGet } from '../api/client.js'
import StatusBadge from '../components/shared/StatusBadge.js'
import SummaryCard from '../components/shared/SummaryCard.js'

interface SessionDetail {
  id: string
  status: string
  startedAt: string
  closedAt?: string
  totalCost: number
  totalTokens: number
  agentId?: string
  messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }>
  events: Array<{ type: string; data: unknown; timestamp: string }>
}

export default function SessionDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data: session, loading } = useApi<SessionDetail>(() => apiGet(`/sessions/${id}`), [id])

  if (loading) return <div className="text-gray-400">Loading...</div>
  if (!session) return <div className="text-gray-400">Session not found</div>

  return (
    <div>
      <button onClick={() => navigate('/sessions')} className="text-sm text-blue-600 hover:underline mb-4 block">
        &larr; Back to Sessions
      </button>

      {/* Session Info */}
      <div className="flex items-center gap-3 mb-6">
        <h2 className="text-lg font-semibold font-mono">{session.id.slice(0, 12)}...</h2>
        <StatusBadge status={session.status} />
      </div>

      <div className="grid grid-cols-4 gap-4 mb-6">
        <SummaryCard label="Started" value={new Date(session.startedAt).toLocaleString()} />
        <SummaryCard label="Messages" value={session.messages.length} />
        <SummaryCard label="Tokens" value={session.totalTokens.toLocaleString()} />
        <SummaryCard label="Cost" value={`$${session.totalCost.toFixed(4)}`} />
      </div>

      <div className="grid grid-cols-2 gap-6">
        {/* Messages */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-medium text-gray-600 mb-4">Conversation</h3>
          <div className="space-y-3 max-h-[600px] overflow-y-auto">
            {session.messages.length === 0 && (
              <p className="text-gray-400 text-sm">No messages</p>
            )}
            {session.messages.map((msg, i) => (
              <div
                key={i}
                className={`rounded-lg p-3 text-sm ${
                  msg.role === 'user'
                    ? 'bg-blue-50 border border-blue-100'
                    : 'bg-gray-50 border border-gray-100'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-medium text-gray-500">{msg.role}</span>
                  <span className="text-xs text-gray-400">{new Date(msg.timestamp).toLocaleTimeString()}</span>
                </div>
                <p className="whitespace-pre-wrap">{msg.content}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Events */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-medium text-gray-600 mb-4">Events ({session.events.length})</h3>
          <div className="space-y-2 max-h-[600px] overflow-y-auto">
            {session.events.length === 0 && (
              <p className="text-gray-400 text-sm">No events</p>
            )}
            {session.events.map((event, i) => (
              <div key={i} className="border border-gray-100 rounded p-2 text-xs">
                <div className="flex items-center gap-2">
                  <StatusBadge status={event.type} />
                  <span className="text-gray-400">{new Date(event.timestamp).toLocaleTimeString()}</span>
                </div>
                {event.data && (
                  <pre className="mt-1 text-gray-600 overflow-x-auto">
                    {typeof event.data === 'string' ? event.data : JSON.stringify(event.data, null, 2).slice(0, 300)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
