import { useNavigate } from 'react-router-dom'
import { useApi } from '../hooks/useApi.js'
import { apiGet } from '../api/client.js'
import DataTable, { type Column } from '../components/shared/DataTable.js'
import StatusBadge from '../components/shared/StatusBadge.js'

interface SessionSummary {
  id: string
  status: string
  startedAt: string
  closedAt?: string
  totalCost: number
  totalTokens: number
  agentId?: string
  messageCount: number
  [key: string]: unknown
}

export default function SessionsPage() {
  const navigate = useNavigate()
  const { data } = useApi<{ sessions: SessionSummary[] }>(() => apiGet('/sessions'))
  const sessions = data?.sessions ?? []

  const columns: Column<SessionSummary>[] = [
    {
      key: 'id',
      label: 'Session',
      render: (row) => <span className="font-mono text-xs">{row.id.slice(0, 12)}...</span>,
    },
    {
      key: 'status',
      label: 'Status',
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: 'startedAt',
      label: 'Started',
      sortable: true,
      render: (row) => new Date(row.startedAt).toLocaleString(),
    },
    {
      key: 'messageCount',
      label: 'Messages',
      sortable: true,
    },
    {
      key: 'totalTokens',
      label: 'Tokens',
      sortable: true,
      render: (row) => row.totalTokens.toLocaleString(),
    },
    {
      key: 'totalCost',
      label: 'Cost',
      sortable: true,
      render: (row) => `$${row.totalCost.toFixed(4)}`,
    },
  ]

  return (
    <div>
      <h2 className="text-xl font-semibold mb-6">Sessions</h2>
      <div className="bg-white rounded-xl border border-gray-200">
        <DataTable<SessionSummary>
          columns={columns}
          data={sessions}
          keyField="id"
          onRowClick={(row) => navigate(`/sessions/${row.id}`)}
          emptyMessage="No sessions recorded yet"
        />
      </div>
    </div>
  )
}
