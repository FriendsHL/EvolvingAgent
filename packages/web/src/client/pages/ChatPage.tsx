import { useState, useRef, useEffect } from 'react'
import { apiGet, apiPost, apiPatch } from '../api/client.js'

interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
}

interface Provider {
  name: string
  type: string
  models: { planner: string; executor: string; reflector: string }
}

interface SessionInfo {
  sessionId: string
  provider: string
  model: string
}

interface SessionSummary {
  id: string
  agentId?: string
  status: string
  startedAt: string
  closedAt?: string
  totalCost: number
  totalTokens: number
  messageCount: number
  lastMessage: string
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [providers, setProviders] = useState<Provider[]>([])
  const [selectedProvider, setSelectedProvider] = useState('bailian-coding')
  const [selectedAgent, setSelectedAgent] = useState('')
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([])
  const [historySessions, setHistorySessions] = useState<SessionSummary[]>([])
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Load providers, agents, and session history on mount
  useEffect(() => {
    apiGet<{ presets: Provider[] }>('/chat/providers').then((r) => setProviders(r.presets))
    apiGet<{ agents: Array<{ id: string; name: string }> }>('/agents').then((r) => {
      setAgents(r.agents)
      if (r.agents.length > 0) setSelectedAgent(r.agents[0].id)
    })
    loadSessionHistory()
  }, [])

  const loadSessionHistory = () => {
    apiGet<{ sessions: SessionSummary[] }>('/chat/sessions').then((r) => setHistorySessions(r.sessions))
  }

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const startSession = async () => {
    const res = await apiPost<SessionInfo>('/chat/sessions', {
      agentId: selectedAgent || undefined,
      provider: selectedProvider,
    })
    setSession(res)
    setMessages([{
      role: 'system',
      content: `Session started. Provider: ${res.provider}, Model: ${res.model}`,
      timestamp: new Date().toISOString(),
    }])
  }

  const resumeSession = async (sessionId: string) => {
    try {
      const res = await apiPost<SessionInfo & { messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }> }>(
        `/chat/sessions/${sessionId}/resume`,
        {},
      )
      setSession({ sessionId: res.sessionId, provider: res.provider, model: res.model })

      // Restore messages from history
      const restored: Message[] = [
        {
          role: 'system',
          content: `Session resumed. Provider: ${res.provider}, Model: ${res.model}`,
          timestamp: new Date().toISOString(),
        },
        ...res.messages.map((m) => ({ ...m, role: m.role as Message['role'] })),
      ]
      setMessages(restored)
    } catch (err) {
      alert(`Failed to resume session: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const switchProvider = async (provider: string) => {
    if (!session) return
    setSelectedProvider(provider)
    const res = await apiPatch<SessionInfo>(`/chat/sessions/${session.sessionId}/provider`, { provider })
    setSession(res)
    setMessages((prev) => [...prev, {
      role: 'system',
      content: `Switched to provider: ${res.provider}, Model: ${res.model}`,
      timestamp: new Date().toISOString(),
    }])
  }

  const sendMessage = async () => {
    if (!input.trim() || !session || sending) return
    const userMsg = input.trim()
    setInput('')
    setSending(true)

    setMessages((prev) => [...prev, {
      role: 'user',
      content: userMsg,
      timestamp: new Date().toISOString(),
    }])

    try {
      const res = await fetch(`/api/chat/sessions/${session.sessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMsg }),
      })

      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const event = JSON.parse(line.slice(6))
            if (event.type === 'message') {
              setMessages((prev) => [...prev, {
                role: 'assistant',
                content: event.content,
                timestamp: new Date().toISOString(),
              }])
            } else if (event.type === 'error') {
              setMessages((prev) => [...prev, {
                role: 'system',
                content: `Error: ${event.content}`,
                timestamp: new Date().toISOString(),
              }])
            } else if (event.type === 'metrics') {
              setSession((s) => s ? { ...s, totalCost: event.totalCost, totalTokens: event.totalTokens } : s)
            }
          } catch { /* skip parse errors */ }
        }
      }
    } catch (err) {
      setMessages((prev) => [...prev, {
        role: 'system',
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date().toISOString(),
      }])
    }

    setSending(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const goBack = () => {
    setSession(null)
    setMessages([])
    loadSessionHistory()
  }

  // Pre-session: show setup + history
  if (!session) {
    return (
      <div className="max-w-2xl mx-auto mt-8">
        <h2 className="text-xl font-semibold mb-6">Chat</h2>

        {/* New session */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4 mb-8">
          <h3 className="text-sm font-medium text-gray-700">New Conversation</h3>
          {agents.length > 0 && (
            <div>
              <label className="text-sm text-gray-500 block mb-1">Agent</label>
              <select
                value={selectedAgent}
                onChange={(e) => setSelectedAgent(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm"
              >
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="text-sm text-gray-500 block mb-1">Provider</label>
            <select
              value={selectedProvider}
              onChange={(e) => setSelectedProvider(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm"
            >
              {providers.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} — {p.models.executor}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={startSession}
            className="w-full bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 text-sm font-medium"
          >
            Start Chat
          </button>
        </div>

        {/* Session history */}
        {historySessions.length > 0 && (
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-3">Recent Sessions</h3>
            <div className="space-y-2">
              {historySessions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => resumeSession(s.id)}
                  className="w-full text-left bg-white rounded-xl border border-gray-200 px-4 py-3 hover:border-blue-400 hover:bg-blue-50 transition-colors"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium text-gray-800">
                      {s.lastMessage || 'Empty session'}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      s.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                    }`}>
                      {s.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-gray-400">
                    <span>{new Date(s.startedAt).toLocaleString()}</span>
                    <span>{s.messageCount} messages</span>
                    <span>{s.totalTokens.toLocaleString()} tokens</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      {/* Top bar */}
      <div className="flex items-center justify-between mb-3 bg-white rounded-lg border border-gray-200 px-4 py-2">
        <div className="flex items-center gap-3">
          <button
            onClick={goBack}
            className="text-gray-400 hover:text-gray-600 text-sm"
            title="Back to sessions"
          >
            ← Back
          </button>
          <span className="text-sm font-medium">Chat</span>
          <span className="text-xs text-gray-400">Model: {session.model}</span>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500">Provider:</label>
          <select
            value={selectedProvider}
            onChange={(e) => switchProvider(e.target.value)}
            className="border rounded px-2 py-1 text-xs"
          >
            {providers.map((p) => (
              <option key={p.name} value={p.name}>{p.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto bg-white rounded-xl border border-gray-200 p-4 space-y-3">
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[75%] rounded-xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                msg.role === 'user'
                  ? 'bg-blue-600 text-white'
                  : msg.role === 'system'
                    ? 'bg-gray-100 text-gray-500 text-xs italic'
                    : 'bg-gray-100 text-gray-800'
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="bg-gray-100 text-gray-500 rounded-xl px-4 py-2.5 text-sm">
              <span className="inline-flex gap-1">
                <span className="animate-bounce">.</span>
                <span className="animate-bounce" style={{ animationDelay: '0.1s' }}>.</span>
                <span className="animate-bounce" style={{ animationDelay: '0.2s' }}>.</span>
              </span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="mt-3 flex gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
          rows={2}
          className="flex-1 border border-gray-300 rounded-xl px-4 py-2.5 text-sm resize-none focus:outline-none focus:border-blue-400"
          disabled={sending}
        />
        <button
          onClick={sendMessage}
          disabled={sending || !input.trim()}
          className="bg-blue-600 text-white px-6 rounded-xl hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
        >
          Send
        </button>
      </div>
    </div>
  )
}
