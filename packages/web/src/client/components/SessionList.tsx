import { useState, useMemo } from 'react'

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

const PAGE_SIZE = 20

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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(0)
  const [batchDeleting, setBatchDeleting] = useState(false)

  // Pagination
  const totalPages = Math.max(1, Math.ceil(sessions.length / PAGE_SIZE))
  const pagedSessions = useMemo(
    () => sessions.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [sessions, page],
  )

  // Reset page if sessions shrink
  if (page >= totalPages && page > 0) setPage(totalPages - 1)

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

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    const pageIds = pagedSessions.map((s) => s.id)
    const allSelected = pageIds.every((id) => selectedIds.has(id))
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allSelected) {
        pageIds.forEach((id) => next.delete(id))
      } else {
        pageIds.forEach((id) => next.add(id))
      }
      return next
    })
  }

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return
    if (!window.confirm(`Delete ${selectedIds.size} sessions? This cannot be undone.`)) return
    setBatchDeleting(true)
    try {
      for (const id of selectedIds) {
        await onDelete(id)
      }
      setSelectedIds(new Set())
    } finally {
      setBatchDeleting(false)
    }
  }

  const selectMode = selectedIds.size > 0

  return (
    <div className="w-64 flex flex-col bg-white border border-gray-200 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="p-3 border-b border-gray-200 space-y-2">
        <button
          type="button"
          onClick={() => onCreate()}
          className="w-full bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 text-sm font-medium"
        >
          + New chat
        </button>
        {/* Batch controls */}
        <div className="flex items-center justify-between text-[11px]">
          <button
            type="button"
            onClick={toggleSelectAll}
            className="text-gray-400 hover:text-blue-600"
          >
            {pagedSessions.length > 0 && pagedSessions.every((s) => selectedIds.has(s.id))
              ? '取消全选'
              : '全选'}
          </button>
          {selectMode && (
            <button
              type="button"
              onClick={handleBatchDelete}
              disabled={batchDeleting}
              className="text-red-500 hover:text-red-700 disabled:opacity-50"
            >
              {batchDeleting ? '删除中...' : `删除 (${selectedIds.size})`}
            </button>
          )}
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {loading && sessions.length === 0 && (
          <div className="p-4 text-xs text-gray-400">Loading…</div>
        )}
        {!loading && sessions.length === 0 && (
          <div className="p-4 text-xs text-gray-400">No sessions yet.</div>
        )}
        {pagedSessions.map((s) => {
          const isActive = s.id === activeId
          const isEditing = s.id === editingId
          const isSelected = selectedIds.has(s.id)
          return (
            <div
              key={s.id}
              className={`group px-3 py-2 border-b border-gray-100 cursor-pointer transition-colors ${
                isActive ? 'bg-blue-50' : isSelected ? 'bg-red-50/30' : 'hover:bg-gray-50'
              }`}
              onClick={() => !isEditing && onSelect(s.id)}
            >
              <div className="flex items-center gap-2">
                {/* Checkbox for batch select */}
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={(e) => {
                    e.stopPropagation()
                    toggleSelect(s.id)
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="w-3 h-3 rounded border-gray-300 text-blue-600 focus:ring-0 shrink-0"
                />
                <div className="flex-1 min-w-0">
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
                    <span className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full shrink-0">
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
              </div>
            </div>
          )
        })}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="border-t border-gray-200 px-3 py-2 flex items-center justify-between text-[11px] text-gray-500">
          <button
            type="button"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="hover:text-blue-600 disabled:opacity-30 disabled:cursor-default"
          >
            ← 上一页
          </button>
          <span>{page + 1} / {totalPages}</span>
          <button
            type="button"
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            className="hover:text-blue-600 disabled:opacity-30 disabled:cursor-default"
          >
            下一页 →
          </button>
        </div>
      )}
    </div>
  )
}
