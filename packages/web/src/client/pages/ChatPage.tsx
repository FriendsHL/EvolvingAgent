import { useState, useRef, useEffect, useCallback, lazy, Suspense } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { apiGet, apiPost, apiPatch, apiDelete } from '../api/client.js'
import SessionList, { type SessionMetadata } from '../components/SessionList.js'
import { useT } from '../i18n/index.js'

// Lazy-loaded: react-markdown + remark-gfm are ~180 KB; keep them out of the main bundle.
const MarkdownMessage = lazy(() => import('../components/shared/MarkdownMessage.js'))

interface ToolCallSummary {
  tool: string
  description?: string
  success: boolean
  durationMs?: number
  error?: string
  input?: unknown
  output?: unknown
}

interface DelegateSummary {
  subagent: string
  task: string
  rationale?: string
}

interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  /** For assistant messages: id of the stored experience this turn produced. */
  experienceId?: string
  /** Which feedback (if any) the user has submitted for this message. */
  feedback?: 'positive' | 'negative'
  /** Tool calls the agent issued while producing this message. */
  toolCalls?: ToolCallSummary[]
  /** Phase 5 router delegation info. */
  delegate?: DelegateSummary
}

interface HistoryMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

interface PreviewResponse {
  messages: Array<{ role: string; content: string }>
  totalChars: number
  historyTurns: number
  provider: string
  model: string
  view: string
}

export default function ChatPage() {
  const navigate = useNavigate()
  const t = useT()
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

  // D3a — prompt preview modal
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewData, setPreviewData] = useState<PreviewResponse | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  // D3b — message editing
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')
  // Tracks which tool-call output was most recently copied, keyed as
  // `${messageIndex}-${callIndex}`. Used to flip the "copy" label to
  // "copied!" for ~1.5s after a click. Single cell is fine — only one
  // feedback is shown at a time.
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  // AbortController for the in-flight SSE fetch. Aborted on session
  // switch / new chat so the old stream stops and `sending` resets.
  const abortRef = useRef<AbortController | null>(null)

  const cancelInFlightStream = () => {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    setSending(false)
    setStatusText('')
    setStreamingContent('')
  }

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
    cancelInFlightStream()
    setActiveSessionId(id)
    navigate(`/chat/${id}`)
  }

  const handleCreate = async () => {
    cancelInFlightStream()
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

  // Common SSE event-pump used by both `sendMessage` (POST /api/chat/)
  // and `applyEdit` (POST /api/chat/edit). Both endpoints emit the same
  // event vocabulary, so the parsing loop is identical.
  const pumpStream = async (res: Response) => {
    let streamingStarted = false
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
              // If a delegate-call already pushed an assistant message with
              // the delegate badge, reuse it instead of pushing a second
              // empty one (which would lose the badge).
              setMessages((prev) => {
                const last = prev[prev.length - 1]
                if (last && last.role === 'assistant') {
                  // Already have an assistant placeholder (from delegate-call
                  // or tool-call) — keep it, don't push.
                  return prev
                }
                return [
                  ...prev,
                  { role: 'assistant', content: '', timestamp: new Date().toISOString() },
                ]
              })
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
            const step = event.step ?? {}
            // SSE wire shape from routes/chat.ts is:
            //   { id, description, tool, params, result: {success, output, error}, duration }
            // Previously we read `step.input` (always undefined → no INPUT
            // card rendered) and `step.result.durationMs` (always undefined
            // → no duration label). Both corrected below.
            const call: ToolCallSummary = {
              tool: String(step.tool ?? step.description ?? 'tool'),
              description: step.description,
              success: step?.result?.success !== false,
              durationMs: typeof step?.duration === 'number' ? step.duration : undefined,
              error: step?.result?.error,
              input: step?.params,
              output: step?.result?.output,
            }
            setStatusText(
              `Tool: ${call.tool} [${call.success ? 'OK' : 'FAIL'}]`,
            )
            // Attach to the current streaming assistant message (create a
            // placeholder if text-delta hasn't arrived yet so the bubble
            // still renders as tool-first turns).
            setMessages((prev) => {
              const updated = [...prev]
              let last = updated[updated.length - 1]
              if (!last || last.role !== 'assistant') {
                updated.push({
                  role: 'assistant',
                  content: '',
                  timestamp: new Date().toISOString(),
                  toolCalls: [],
                })
                last = updated[updated.length - 1]
              }
              updated[updated.length - 1] = {
                ...last,
                toolCalls: [...(last.toolCalls ?? []), call],
              }
              return updated
            })
          } else if (event.type === 'delegate-call') {
            // Phase 5 — attach delegation metadata to the current
            // assistant message so the chat UI can render a blue badge.
            const delegateInfo: DelegateSummary = {
              subagent: String(event.subagent ?? 'unknown'),
              task: String(event.task ?? ''),
              rationale: event.rationale ? String(event.rationale) : undefined,
            }
            setStatusText(`Delegating → ${delegateInfo.subagent}`)
            setMessages((prev) => {
              const updated = [...prev]
              let last = updated[updated.length - 1]
              if (!last || last.role !== 'assistant') {
                updated.push({
                  role: 'assistant',
                  content: '',
                  timestamp: new Date().toISOString(),
                  delegate: delegateInfo,
                })
                last = updated[updated.length - 1]
              }
              updated[updated.length - 1] = { ...last, delegate: delegateInfo }
              return updated
            })
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
  }

  const sendMessage = async () => {
    if (!input.trim()) return
    const userMsg = input.trim()
    setInput('')

    setMessages((prev) => [
      ...prev,
      { role: 'user', content: userMsg, timestamp: new Date().toISOString() },
    ])

    try {
      cancelInFlightStream()
      const controller = new AbortController()
      abortRef.current = controller
      setSending(true)
      setStatusText('')
      setStreamingContent('')

      const res = await fetch(`/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMsg,
          sessionId: activeSessionId ?? undefined,
        }),
        signal: controller.signal,
      })
      await pumpStream(res)
    } catch (err) {
      // AbortError is expected when switching sessions mid-stream
      if (err instanceof DOMException && err.name === 'AbortError') {
        return
      }
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
    refreshSessions()
  }

  // ----------------------------------------------------------------
  // D3a — Prompt preview
  // ----------------------------------------------------------------
  const openPreview = async () => {
    if (!input.trim()) return
    setPreviewOpen(true)
    setPreviewLoading(true)
    setPreviewError(null)
    setPreviewData(null)
    try {
      const res = await fetch('/api/chat/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: input.trim(),
          sessionId: activeSessionId ?? undefined,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as PreviewResponse
      setPreviewData(data)
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err))
    } finally {
      setPreviewLoading(false)
    }
  }

  // ----------------------------------------------------------------
  // D3b — Edit a previous user message and re-run from there
  // ----------------------------------------------------------------
  const startEdit = (index: number) => {
    if (sending) return
    const msg = messages[index]
    if (!msg || msg.role !== 'user') return
    setEditingIndex(index)
    setEditDraft(msg.content)
  }

  const cancelEdit = () => {
    setEditingIndex(null)
    setEditDraft('')
  }

  const applyEdit = async () => {
    if (editingIndex === null || !activeSessionId) return
    const newContent = editDraft.trim()
    if (!newContent) return
    const targetIndex = editingIndex

    setSending(true)
    setEditingIndex(null)
    setEditDraft('')
    setStatusText('')
    setStreamingContent('')

    // Locally truncate to before the edited message and append the new
    // user message — matches the server-side truncate-and-replay.
    setMessages((prev) => [
      ...prev.slice(0, targetIndex),
      { role: 'user', content: newContent, timestamp: new Date().toISOString() },
    ])

    try {
      cancelInFlightStream()
      const controller = new AbortController()
      abortRef.current = controller
      setSending(true)

      const res = await fetch('/api/chat/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: activeSessionId,
          messageIndex: targetIndex,
          newContent,
        }),
        signal: controller.signal,
      })
      await pumpStream(res)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setMessages((prev) => [
        ...prev,
        {
          role: 'system',
          content: `Edit failed: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: new Date().toISOString(),
        },
      ])
    }

    setStatusText('')
    setStreamingContent('')
    setSending(false)
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
            <button
              type="button"
              className="text-sm font-medium truncate hover:underline text-left"
              title={t('chat.edit.tooltip', 'Click to rename')}
              onClick={() => {
                if (!activeSession) return
                const next = window.prompt(
                  t('chat.rename.prompt', 'Rename session'),
                  activeSession.title,
                )
                if (next && next.trim() && next.trim() !== activeSession.title) {
                  void handleRename(activeSession.id, next.trim())
                }
              }}
            >
              {activeSession?.title ?? t('chat.title')}
            </button>
            {activeSession && (
              <span className="text-xs text-gray-400">
                {t('chat.messages', undefined, { count: activeSession.messageCount })}
              </span>
            )}
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto bg-white rounded-xl border border-gray-200 p-4 space-y-3">
          {historyLoading && (
            <div className="text-xs text-gray-400">{t('chat.loadingHistory')}</div>
          )}
          {!historyLoading && messages.length === 0 && (
            <div className="text-center text-sm text-gray-400 mt-12">
              {t('chat.empty')}
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} group`}>
              <div className="max-w-[75%] flex flex-col items-start gap-1">
                {/* Phase 5 router — delegation badge */}
                {msg.role === 'assistant' && msg.delegate && (
                  <div className="w-full rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 flex items-start gap-2">
                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-500 text-white text-[10px] font-bold shrink-0 mt-0.5" aria-hidden>
                      →
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold">{msg.delegate.subagent}</span>
                        {msg.delegate.rationale && (
                          <span className="text-blue-500 truncate">— {msg.delegate.rationale}</span>
                        )}
                      </div>
                      {msg.delegate.task && (
                        <div className="text-[11px] text-blue-600/70 mt-0.5 line-clamp-2">
                          {msg.delegate.task}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0 && (
                  <div className="w-full flex flex-col gap-1.5">
                    {msg.toolCalls.map((call, ci) => {
                      const outputStr = call.output === undefined
                        ? ''
                        : typeof call.output === 'string'
                          ? call.output
                          : JSON.stringify(call.output, null, 2)
                      const inputStr = call.input === undefined
                        ? ''
                        : typeof call.input === 'string'
                          ? call.input
                          : JSON.stringify(call.input, null, 2)
                      return (
                        <details
                          key={ci}
                          className={`group/tool text-xs rounded-lg border ${
                            call.success
                              ? 'border-gray-200 bg-gray-50'
                              : 'border-red-200 bg-red-50'
                          }`}
                        >
                          <summary className="cursor-pointer select-none flex items-center gap-2 px-3 py-2 list-none marker:hidden [&::-webkit-details-marker]:hidden">
                            <span
                              className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold ${
                                call.success
                                  ? 'bg-emerald-500 text-white'
                                  : 'bg-red-500 text-white'
                              }`}
                              aria-hidden
                            >
                              {call.success ? '✓' : '✗'}
                            </span>
                            <span className="inline-flex items-center gap-1 font-mono font-semibold text-gray-800">
                              🔧 {call.tool}
                            </span>
                            {call.description && (
                              <span className="text-gray-500 truncate flex-1 min-w-0 font-normal">
                                {call.description}
                              </span>
                            )}
                            {typeof call.durationMs === 'number' && (
                              <span className="text-[10px] text-gray-400 font-mono shrink-0">
                                {call.durationMs}ms
                              </span>
                            )}
                            <span className="text-gray-400 text-[10px] shrink-0 transition-transform group-open/tool:rotate-180">
                              ▾
                            </span>
                          </summary>
                          <div className="px-3 pb-2.5 pt-0 space-y-2 border-t border-gray-200/60 font-mono text-[11px] leading-snug">
                            {inputStr && (
                              <div>
                                <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-gray-400 mb-0.5 mt-2">
                                  <span>input</span>
                                </div>
                                <div className="rounded bg-white border border-gray-200 px-2 py-1.5 whitespace-pre-wrap break-all max-h-32 overflow-auto text-gray-700">
                                  {inputStr}
                                </div>
                              </div>
                            )}
                            {call.error && (
                              <div>
                                <div className="text-[10px] uppercase tracking-wide text-red-600 mb-0.5">
                                  error
                                </div>
                                <div className="rounded bg-white border border-red-200 px-2 py-1.5 whitespace-pre-wrap break-all text-red-700 max-h-32 overflow-auto">
                                  {call.error}
                                </div>
                              </div>
                            )}
                            {outputStr && call.success && (
                              <div>
                                <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-gray-400 mb-0.5">
                                  <span>output</span>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.preventDefault()
                                      const key = `${i}-${ci}`
                                      void navigator.clipboard.writeText(outputStr).then(() => {
                                        setCopiedKey(key)
                                        setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500)
                                      })
                                    }}
                                    className={`normal-case tracking-normal text-[10px] font-sans transition-colors ${
                                      copiedKey === `${i}-${ci}`
                                        ? 'text-emerald-600'
                                        : 'text-gray-400 hover:text-blue-600'
                                    }`}
                                    title="Copy to clipboard"
                                  >
                                    {copiedKey === `${i}-${ci}` ? '✓ copied' : 'copy'}
                                  </button>
                                </div>
                                <div className="rounded bg-white border border-gray-200 px-2 py-1.5 whitespace-pre-wrap break-all max-h-48 overflow-auto text-gray-700">
                                  {outputStr}
                                </div>
                              </div>
                            )}
                          </div>
                        </details>
                      )
                    })}
                  </div>
                )}
                {editingIndex === i ? (
                  <div className="flex flex-col gap-2 w-full">
                    <textarea
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      rows={3}
                      className="border border-blue-400 rounded-xl px-3 py-2 text-sm resize-none focus:outline-none w-[28rem] max-w-full"
                      autoFocus
                    />
                    <div className="flex gap-2 justify-end">
                      <button
                        type="button"
                        onClick={cancelEdit}
                        className="text-xs px-3 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
                      >
                        {t('common.cancel')}
                      </button>
                      <button
                        type="button"
                        onClick={applyEdit}
                        disabled={!editDraft.trim() || sending}
                        className="text-xs px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {t('chat.edit.save')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-1.5 self-end">
                    {msg.role === 'user' && (
                      <button
                        type="button"
                        onClick={() => startEdit(i)}
                        disabled={sending}
                        title={t('chat.edit.tooltip')}
                        className="opacity-0 group-hover:opacity-100 text-xs text-gray-400 hover:text-blue-600 px-1 disabled:opacity-0 transition-opacity self-center"
                      >
                        ✏️
                      </button>
                    )}
                    <div
                      className={`rounded-xl px-4 py-2.5 text-sm ${
                        msg.role === 'user'
                          ? 'bg-blue-600 text-white whitespace-pre-wrap'
                          : msg.role === 'system'
                            ? 'bg-gray-100 text-gray-500 text-xs italic whitespace-pre-wrap'
                            : 'bg-gray-100 text-gray-800'
                      }`}
                    >
                      {msg.role === 'assistant'
                        ? (
                          <Suspense fallback={<div className="whitespace-pre-wrap">{msg.content}</div>}>
                            <MarkdownMessage content={msg.content} />
                          </Suspense>
                        )
                        : msg.content}
                    </div>
                  </div>
                )}
                {msg.role === 'assistant' && msg.experienceId && (
                  <div className="flex items-center gap-1.5 pl-1">
                    <button
                      type="button"
                      disabled={msg.feedback !== undefined}
                      onClick={() => submitFeedback(i, msg.experienceId!, 'positive')}
                      title={t('chat.feedback.helpful')}
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
                      title={t('chat.feedback.notHelpful')}
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
                      <span className="text-[10px] text-gray-400 ml-1">{t('chat.feedback.thanks')}</span>
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
            placeholder={t('chat.input.placeholder')}
            rows={2}
            className="flex-1 border border-gray-300 rounded-xl px-4 py-2.5 text-sm resize-none focus:outline-none focus:border-blue-400"
            disabled={sending}
          />
          <button
            onClick={openPreview}
            disabled={sending || !input.trim()}
            title={t('chat.preview')}
            className="bg-white border border-gray-300 text-gray-700 px-4 rounded-xl hover:bg-gray-50 disabled:opacity-50 text-sm font-medium"
          >
            {t('chat.preview')}
          </button>
          <button
            onClick={sendMessage}
            disabled={sending || !input.trim()}
            className="bg-blue-600 text-white px-6 rounded-xl hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
          >
            {t('common.send')}
          </button>
        </div>
      </div>

      {/* D3a — Prompt preview modal */}
      {previewOpen && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onClick={() => setPreviewOpen(false)}
        >
          <div
            className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
              <div>
                <h2 className="text-base font-semibold text-gray-800">{t('chat.preview.title')}</h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  {t('chat.preview.subtitle', undefined, {
                    provider: previewData?.provider ?? '...',
                    model: previewData?.model ?? '...',
                  })}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPreviewOpen(false)}
                className="text-gray-400 hover:text-gray-600 text-xl leading-none px-2"
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-3">
              {previewLoading && <div className="text-sm text-gray-400">{t('chat.preview.empty')}</div>}
              {previewError && (
                <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-3">
                  {previewError}
                </div>
              )}
              {previewData?.messages.map((m, idx) => (
                <div key={idx} className="border border-gray-200 rounded-lg overflow-hidden">
                  <div className="flex items-center justify-between bg-gray-50 px-3 py-1.5 border-b border-gray-200">
                    <span
                      className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded ${
                        m.role === 'system'
                          ? 'bg-purple-100 text-purple-700'
                          : m.role === 'user'
                            ? 'bg-blue-100 text-blue-700'
                            : 'bg-green-100 text-green-700'
                      }`}
                    >
                      {m.role}
                    </span>
                    <span className="text-[10px] text-gray-400">{m.content.length} chars</span>
                  </div>
                  <pre className="p-3 text-xs text-gray-700 whitespace-pre-wrap break-words font-mono max-h-64 overflow-y-auto">
                    {m.content}
                  </pre>
                </div>
              ))}
            </div>
            {previewData && (
              <div className="border-t border-gray-200 px-5 py-3 flex items-center justify-between text-xs text-gray-500">
                <div>
                  {t('chat.preview.footer', undefined, {
                    count: previewData.messages.length,
                    chars: previewData.totalChars.toLocaleString(),
                    turns: previewData.historyTurns,
                  })}
                </div>
                <div>
                  {previewData.provider} / {previewData.model}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
