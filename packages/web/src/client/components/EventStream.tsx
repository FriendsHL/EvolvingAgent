import { useMemo, useState } from 'react'
import { useSSE } from '../hooks/useSSE.js'

// Mirror of core's AgentEventType — kept inline to avoid a cross-package import.
const ALL_EVENT_TYPES = [
  'planning',
  'executing',
  'tool-call',
  'tool-result',
  'reflecting',
  'message',
  'error',
  'hook',
] as const
type EventType = (typeof ALL_EVENT_TYPES)[number]

// Shape mirrored from server: AgentEvent + sessionId injected by broadcast()
interface StreamEvent {
  type: EventType
  data: unknown
  timestamp: string
  sessionId?: string
}

const TYPE_STYLE: Record<EventType, { icon: string; color: string }> = {
  planning:     { icon: '🗺️', color: 'bg-purple-100 text-purple-800 border-purple-200' },
  executing:    { icon: '⚙️', color: 'bg-blue-100 text-blue-800 border-blue-200' },
  'tool-call':  { icon: '🔧', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  'tool-result':{ icon: '📤', color: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
  reflecting:   { icon: '🔍', color: 'bg-indigo-100 text-indigo-800 border-indigo-200' },
  message:      { icon: '💬', color: 'bg-gray-100 text-gray-800 border-gray-200' },
  error:        { icon: '❌', color: 'bg-red-100 text-red-800 border-red-200' },
  hook:         { icon: '🔗', color: 'bg-teal-100 text-teal-800 border-teal-200' },
}

export interface EventStreamProps {
  /** SSE endpoint URL — defaults to /api/events */
  url?: string
  /** If set, only events whose sessionId matches this value will be displayed. */
  sessionId?: string
  /** Show the session id column / show the session filter — default true. */
  showSessionColumn?: boolean
  /** Maximum events to keep in memory. Default 200. */
  capacity?: number
  /** Render at this height — default 600px for full pages, override for embeds. */
  height?: string
}

export default function EventStream({
  url = '/api/events',
  sessionId,
  showSessionColumn = true,
  capacity = 200,
  height = '600px',
}: EventStreamProps) {
  const { events, connected, paused, pause, resume, clear, totalReceived } = useSSE<StreamEvent>(url, { capacity })
  const [enabledTypes, setEnabledTypes] = useState<Set<EventType>>(
    () => new Set(ALL_EVENT_TYPES),
  )
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)

  // When embedded in a session detail page, we silently restrict to that
  // session. Otherwise we show every event.
  const filtered = useMemo(() => {
    return events.filter((e) => {
      if (sessionId && e.sessionId !== sessionId) return false
      if (!enabledTypes.has(e.type)) return false
      return true
    })
  }, [events, enabledTypes, sessionId])

  const toggleType = (t: EventType) => {
    setEnabledTypes((prev) => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t)
      else next.add(t)
      return next
    })
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 flex flex-col" style={{ height }}>
      {/* Header / controls */}
      <div className="border-b border-gray-200 p-3 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className="text-sm font-medium text-gray-700">
            {connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
        <div className="text-xs text-gray-500">
          {filtered.length} shown · {events.length} buffered · {totalReceived} total
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={paused ? resume : pause}
            className={`px-3 py-1 text-xs rounded ${
              paused
                ? 'bg-green-600 text-white hover:bg-green-700'
                : 'bg-yellow-500 text-white hover:bg-yellow-600'
            }`}
          >
            {paused ? '▶ Resume' : '⏸ Pause'}
          </button>
          <button
            onClick={clear}
            className="px-3 py-1 text-xs rounded bg-gray-200 text-gray-700 hover:bg-gray-300"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Type filter chips */}
      <div className="border-b border-gray-200 p-2 flex flex-wrap gap-1">
        {ALL_EVENT_TYPES.map((t) => {
          const enabled = enabledTypes.has(t)
          const style = TYPE_STYLE[t]
          return (
            <button
              key={t}
              onClick={() => toggleType(t)}
              className={`px-2 py-0.5 text-xs rounded border transition-opacity ${style.color} ${
                enabled ? 'opacity-100' : 'opacity-30'
              }`}
            >
              {style.icon} {t}
            </button>
          )
        })}
      </div>

      {/* Event list — newest at bottom, auto-scroll via column-reverse trick */}
      <div className="flex-1 overflow-y-auto p-2 font-mono text-xs space-y-1">
        {filtered.length === 0 ? (
          <div className="text-gray-400 text-center py-12">
            {paused ? 'Paused — events still arriving but not displayed' : 'Waiting for events…'}
          </div>
        ) : (
          filtered.map((e, idx) => {
            const style = TYPE_STYLE[e.type]
            const isExpanded = expandedIdx === idx
            const dataPreview = JSON.stringify(e.data).slice(0, 80)
            const time = new Date(e.timestamp).toLocaleTimeString()
            return (
              <div
                key={`${e.timestamp}-${idx}`}
                className="border border-gray-100 rounded hover:bg-gray-50 cursor-pointer"
                onClick={() => setExpandedIdx(isExpanded ? null : idx)}
              >
                <div className="flex items-center gap-2 px-2 py-1">
                  <span className="text-gray-400 w-20 shrink-0">{time}</span>
                  <span className={`px-1.5 py-0.5 rounded border text-xs shrink-0 ${style.color}`}>
                    {style.icon} {e.type}
                  </span>
                  {showSessionColumn && e.sessionId && (
                    <span className="text-gray-500 w-32 shrink-0 truncate" title={e.sessionId}>
                      {e.sessionId.slice(0, 8)}…
                    </span>
                  )}
                  <span className="text-gray-700 truncate flex-1">{dataPreview}</span>
                </div>
                {isExpanded && (
                  <pre className="px-3 pb-2 text-gray-600 whitespace-pre-wrap break-all">
                    {JSON.stringify(e.data, null, 2)}
                  </pre>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
