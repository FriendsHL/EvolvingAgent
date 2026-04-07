import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { apiGet, apiPost, apiPatch, apiDelete } from '../api/client.js'
import SessionList, { type SessionMetadata } from '../components/SessionList.js'

interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  /** For assistant messages: id of the stored experience this turn produced. */
  experienceId?: string
  /** Which feedback (if any) the user has submitted for this message. */
  feedback?: 'positive' | 'negative'
}

interface HistoryMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

export default function ChatPage() {
  const navigate = useNavigate()
  const { sessionId: routeSessionId } = useParams<{ sessionId?: string }>()

  const [sessions, setSessions] = useState<SessionMetadata[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(routeSessionId ?? null)

  const [messages, setMessages] = useState<Message[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [statusText, setStatusText] = useState('')
  const [streamingContent, setStreamingContent] = useState('')

  const messagesEndRef = useRef<HTMLDivElement>(null)

  const refreshSessions = useCallback(async (): Promise<SessionMetadata[]> => {
    try {
      const r = await apiGet<{ sessions: SessionMetadata[] }>('/sessions')
      setSessions(r.sessions)
      return r.sessions
    } catch (err) {
      console.error('Failed to load sessions:', err)
      return []
    } finally {
      setSessionsLoading(false)
    }
  }, [])

  const loadHistory = useCallback(async (id: string) => {
    setHistoryLoading(true)
    try {
      const r = await apiGet<{ sessionId: string; messages: HistoryMessage[] }>(
        `/sessions/${id}/history`,
      )
      setMessages(
        r.messages.map((m) => ({
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
        })),
      )
    } catch (err) {
      setMessages([
        {
          role: 'system',
          content: `Failed to load history: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: new Date().toISOString(),
        },
      ])
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  // Initial load: fetch sessions, pick a session
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const list = await refreshSessions()
      if (cancelled) return
      if (routeSessionId && list.some((s) => s.id === routeSessionId)) {
        setActiveSessionId(routeSessionId)
      } else if (list.length > 0) {
        const firstId = list[0].id
        setActiveSessionId(firstId)
        navigate(`/chat/${firstId}`, { replace: true })
      } else {
        // Empty list — fall back to "default"; the server treats unknown
        // sessionId as default and will create it on demand.
        setActiveSessionId(null)
      }
    })()
    return () => {
      cancelled = true
    }
    // Run only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load history whenever the active session changes
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([])
      return
    }
    loadHistory(activeSessionId)
  }, [activeSessionId, loadHistory])

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSelect = (id: string) => {
    if (id === activeSessionId) return
    setActiveSessionId(id)
    navigate(`/chat/${id}`)
  }

  const handleCreate = async () => {
    try {
      const created = await apiPost<SessionMetadata>('/sessions', {})
      await refreshSessions()
      setActiveSessionId(created.id)
      setMessages([])
      navigate(`/chat/${created.id}`)
    } catch (err) {
      alert(`Failed to create session: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleRename = async (id: string, title: string) => {
    try {
      await apiPatch<SessionMetadata>(`/sessions/${id}`, { title })
      await refreshSessions()
    } catch (err) {
      alert(`Failed to rename: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await apiDelete<{ success: boolean }>(`/sessions/${id}`)
      const list = await refreshSessions()
      if (id === activeSessionId) {
        if (list.length > 0) {
          setActiveSessionId(list[0].id)
          navigate(`/chat/${list[0].id}`, { replace: true })
        } else {
          setActiveSessionId(null)
          navigate('/chat', { replace: true })
        }
      }
    } catch (err) {
      alert(`Failed to delete: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const sendMessage = async () => {
    if (!input.trim() || sending) return
    const userMsg = input.trim()
    setInput('')
    setSending(true)

    setMessages((prev) => [
      ...prev,
      { role: 'user', content: userMsg, timestamp: new Date().toISOString() },
    ])

    setStatusText('')
    setStreamingContent('')
    let streamingStarted = false

    try {
      const res = await fetch(`/api/chat/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMsg,
          sessionId: activeSessionId ?? undefined,
        }),
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
            if (event.type === 'status') {
              setStatusText(event.content)
            } else if (event.type === 'text-delta') {
              if (!streamingStarted) {
                streamingStarted = true
                setStatusText('')
                setMessages((prev) => [
                  ...prev,
                  {
                    role: 'assistant',
                    content: '',
                    timestamp: new Date().toISOString(),
                  },
                ])
              }
              setStreamingContent((prev) => prev + event.content)
              setMessages((prev) => {
                const updated = [...prev]
                const last = updated[updated.length - 1]
                if (last && last.role === 'assistant') {
                  updated[updated.length - 1] = { ...last, content: last.content + event.content }
                }
                return updated
              })
            } else if (event.type === 'tool-call') {
              const step = event.step
              const status = step?.result?.success ? 'OK' : 'FAIL'
              setStatusText(`Tool: ${step?.tool ?? step?.description ?? 'tool'} [${status}]`)
            } else if (event.type === 'message') {
              if (streamingStarted) {
                setMessages((prev) => {
                  const updated = [...prev]
                  const last = updated[updated.length - 1]
                  if (last && last.role === 'assistant') {
                    updated[updated.length - 1] = {
                      ...last,
                      content: event.content,
                      experienceId: event.experienceId,
                    }
                  }
                  return updated
                })
              } else {
                setMessages((prev) => [
                  ...prev,
                  {
                    role: 'assistant',
                    content: event.content,
                    timestamp: new Date().toISOString(),
                    experienceId: event.experienceId,
                  },
                ])
              }
            } else if (event.type === 'error') {
              setMessages((prev) => [
                ...prev,
                {
                  role: 'system',
                  content: `Error: ${event.content}`,
                  timestamp: new Date().toISOString(),
                },
              ])
            } else if (event.type === 'done') {
              setStatusText('')
              setStreamingContent('')
            }
          } catch {
            /* skip parse errors */
          }
        }
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'system',
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: new Date().toISOString(),
        },
      ])
    }

    setStatusText('')
    setStreamingContent('')
    setSending(false)
    // Refresh the sessions list so messageCount + lastActiveAt update.
    refreshSessions()
  }

  const submitFeedback = async (
    messageIndex: number,
    experienceId: string,
    feedback: 'positive' | 'negative',
  ) => {
    setMessages((prev) => {
      const updated = [...prev]
      const target = updated[messageIndex]
      if (target && target.role === 'assistant') {
        updated[messageIndex] = { ...target, feedback }
      }
      return updated
    })

    try {
      await apiPost(`/memory/experiences/${experienceId}/feedback`, { feedback })
    } catch (err) {
      setMessages((prev) => {
        const updated = [...prev]
        const target = updated[messageIndex]
        if (target && target.role === 'assistant') {
          updated[messageIndex] = { ...target, feedback: undefined }
        }
        return updated
      })
      alert(`Failed to submit feedback: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const activeSession = sessions.find((s) => s.id === activeSessionId)

  return (
    <div className="flex gap-4 h-[calc(100vh-8rem)]">
      <SessionList
        sessions={sessions}
        activeId={activeSessionId}
        loading={sessionsLoading}
        onSelect={handleSelect}
        onCreate={handleCreate}
        onRename={handleRename}
        onDelete={handleDelete}
      />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <div className="flex items-center justify-between mb-3 bg-white rounded-lg border border-gray-200 px-4 py-2">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-sm font-medium truncate">
              {activeSession?.title ?? 'Chat'}
            </span>
            {activeSession && (
              <span className="text-xs text-gray-400">
                {activeSession.messageCount} messages
              </span>
            )}
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto bg-white rounded-xl border border-gray-200 p-4 space-y-3">
          {historyLoading && (
            <div className="text-xs text-gray-400">Loading history…</div>
          )}
          {!historyLoading && messages.length === 0 && (
            <div className="text-center text-sm text-gray-400 mt-12">
              No messages yet. Start the conversation below.
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className="max-w-[75%] flex flex-col items-start gap-1">
                <div
                  className={`rounded-xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-blue-600 text-white self-end'
                      : msg.role === 'system'
                        ? 'bg-gray-100 text-gray-500 text-xs italic'
                        : 'bg-gray-100 text-gray-800'
                  }`}
                >
                  {msg.content}
                </div>
                {msg.role === 'assistant' && msg.experienceId && (
                  <div className="flex items-center gap-1.5 pl-1">
                    <button
                      type="button"
                      disabled={msg.feedback !== undefined}
                      onClick={() => submitFeedback(i, msg.experienceId!, 'positive')}
                      title="Helpful"
                      className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                        msg.feedback === 'positive'
                          ? 'bg-green-50 border-green-300 text-green-700'
                          : msg.feedback === 'negative'
                            ? 'opacity-30 border-gray-200 text-gray-400'
                            : 'border-gray-200 text-gray-400 hover:border-green-300 hover:text-green-600'
                      }`}
                    >
                      {'\u{1F44D}'}
                    </button>
                    <button
                      type="button"
                      disabled={msg.feedback !== undefined}
                      onClick={() => submitFeedback(i, msg.experienceId!, 'negative')}
                      title="Not helpful"
                      className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                        msg.feedback === 'negative'
                          ? 'bg-red-50 border-red-300 text-red-700'
                          : msg.feedback === 'positive'
                            ? 'opacity-30 border-gray-200 text-gray-400'
                            : 'border-gray-200 text-gray-400 hover:border-red-300 hover:text-red-600'
                      }`}
                    >
                      {'\u{1F44E}'}
                    </button>
                    {msg.feedback && (
                      <span className="text-[10px] text-gray-400 ml-1">Thanks for the feedback</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
          {sending && statusText && !streamingContent && (
            <div className="flex justify-start">
              <div className="bg-blue-50 text-blue-600 rounded-xl px-4 py-2 text-xs font-medium">
                {statusText}
              </div>
            </div>
          )}
          {sending && !streamingContent && !statusText && (
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
    </div>
  )
}
