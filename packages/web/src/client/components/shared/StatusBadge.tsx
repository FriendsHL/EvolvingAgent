const COLORS: Record<string, string> = {
  success: 'bg-green-100 text-green-700',
  active: 'bg-green-100 text-green-700',
  enabled: 'bg-green-100 text-green-700',
  partial: 'bg-yellow-100 text-yellow-700',
  idle: 'bg-yellow-100 text-yellow-700',
  failure: 'bg-red-100 text-red-700',
  closed: 'bg-gray-100 text-gray-600',
  disabled: 'bg-gray-100 text-gray-600',
}

interface StatusBadgeProps {
  status: string
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  const color = COLORS[status] ?? 'bg-gray-100 text-gray-600'
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>
      {status}
    </span>
  )
}
