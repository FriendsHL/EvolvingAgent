import { useNavigate } from 'react-router-dom'
import { useApi } from '../hooks/useApi.js'
import { apiGet } from '../api/client.js'
import DataTable, { type Column } from '../components/shared/DataTable.js'
import { useT } from '../i18n/index.js'

// Mirrors SessionMetadata returned by GET /api/sessions (SessionManager).
// Phase 3 collapsed the legacy PersistedSession shape; the dashboard table
// now shows metadata fields only and clicks deep-link into the chat view.
interface SessionMeta {
  id: string
  title: string
  createdAt: number
  lastActiveAt: number
  messageCount: number
  [key: string]: unknown
}

export default function SessionsPage() {
  const navigate = useNavigate()
  const t = useT()
  const { data } = useApi<{ sessions: SessionMeta[] }>(() => apiGet('/sessions'))
  const sessions = data?.sessions ?? []

  const columns: Column<SessionMeta>[] = [
    {
      key: 'title',
      label: t('sessions.col.title'),
      render: (row) => <span className="font-medium">{row.title || t('sessions.untitled')}</span>,
    },
    {
      key: 'id',
      label: t('sessions.col.id'),
      render: (row) => <span className="font-mono text-xs text-gray-500">{row.id.slice(0, 12)}…</span>,
    },
    {
      key: 'createdAt',
      label: t('sessions.col.created'),
      sortable: true,
      render: (row) => new Date(row.createdAt).toLocaleString(),
    },
    {
      key: 'lastActiveAt',
      label: t('sessions.col.lastActive'),
      sortable: true,
      render: (row) => new Date(row.lastActiveAt).toLocaleString(),
    },
    {
      key: 'messageCount',
      label: t('sessions.col.messages'),
      sortable: true,
    },
  ]

  return (
    <div>
      <h2 className="text-xl font-semibold mb-6">{t('sessions.title')}</h2>
      <div className="bg-white rounded-xl border border-gray-200">
        <DataTable<SessionMeta>
          columns={columns}
          data={sessions}
          keyField="id"
          onRowClick={(row) => navigate(`/chat/${row.id}`)}
          emptyMessage={t('sessions.empty')}
        />
      </div>
    </div>
  )
}
