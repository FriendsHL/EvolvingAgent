import { useState } from 'react'

export interface SessionMetadata {
  id: string
  title: string
  createdAt: number
  lastActiveAt: number
  messageCount: number
}

interface SessionListProps {
  sessions: SessionMetadata[]
  activeId: string | null
  loading: boolean
  onSelect: (id: string) => void
  onCreate: () => void | Promise<void>
  onRename: (id: string, title: string) => void | Promise<void>
  onDelete: (id: string) => void | Promise<void>
}

function relativeTime(ts: number): string {
  const diffMs = Date.now() - ts
  const sec = Math.max(1, Math.floor(diffMs / 1000))
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  return new Date(ts).toLocaleDateString()
}

export default function SessionList({
  sessions,
  activeId,
  loading,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: SessionListProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')

  const startRename = (s: SessionMetadata) => {
    setEditingId(s.id)
    setDraftTitle(s.title)
  }

  const commitRename = async (id: string) => {
    const title = draftTitle.trim()
    setEditingId(null)
    if (title.length === 0) return
    await onRename(id, title)
  }

  const handleDelete = async (s: SessionMetadata) => {
    if (!window.confirm(`Delete session "${s.title}"? This cannot be undone.`)) return
    await onDelete(s.id)
  }

  return (
    <div className="w-64 flex flex-col bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="p-3 border-b border-gray-200">
        <button
          type="button"
          onClick={() => onCreate()}
          className="w-full bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 text-sm font-medium"
        >
          + New chat
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading && sessions.length === 0 && (
          <div className="p-4 text-xs text-gray-400">Loading…</div>
        )}
        {!loading && sessions.length === 0 && (
          <div className="p-4 text-xs text-gray-400">No sessions yet.</div>
        )}
        {sessions.map((s) => {
          const isActive = s.id === activeId
          const isEditing = s.id === editingId
          return (
            <div
              key={s.id}
              className={`group px-3 py-2 border-b border-gray-100 cursor-pointer transition-colors ${
                isActive ? 'bg-blue-50' : 'hover:bg-gray-50'
              }`}
              onClick={() => !isEditing && onSelect(s.id)}
            >
              <div className="flex items-center justify-between gap-2">
                {isEditing ? (
                  <input
                    autoFocus
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    onBlur={() => commitRename(s.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(s.id)
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="flex-1 text-sm border border-blue-300 rounded px-1.5 py-0.5 focus:outline-none"
                  />
                ) : (
                  <span
                    className={`flex-1 truncate text-sm ${
                      isActive ? 'font-semibold text-blue-700' : 'text-gray-800'
                    }`}
                    title={s.title}
                  >
                    {s.title}
                  </span>
                )}
                <span className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full">
                  {s.messageCount}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-[11px] text-gray-400">
                  {relativeTime(s.lastActiveAt)}
                </span>
                {!isEditing && (
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        startRename(s)
                      }}
                      className="text-[11px] text-gray-400 hover:text-blue-600"
                      title="Rename"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDelete(s)
                      }}
                      className="text-[11px] text-gray-400 hover:text-red-600"
                      title="Delete"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
