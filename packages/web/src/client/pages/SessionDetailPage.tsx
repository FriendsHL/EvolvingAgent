import { useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'

/**
 * Phase 3 collapsed the legacy `PersistedSession` (events / cost / tokens
 * payload) and `/api/sessions/:id` now returns SessionManager metadata only.
 * The old event-timeline / plans / tools / cost / reflection tabs no longer
 * have a backing data source, so this page just redirects into the chat
 * view, which is now the canonical session interface.
 *
 * If we ever want a structured event-timeline back, the right place to
 * surface it is the per-session tab inside ChatPage — not a parallel page.
 */
export default function SessionDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()

  useEffect(() => {
    navigate(id ? `/chat/${id}` : '/chat', { replace: true })
  }, [id, navigate])

  return <div className="text-gray-400 p-6 text-sm">Redirecting…</div>
}
