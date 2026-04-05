interface SummaryCardProps {
  label: string
  value: string | number
  subtitle?: string
  trend?: { value: number; label: string }
}

export default function SummaryCard({ label, value, subtitle, trend }: SummaryCardProps) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-2xl font-semibold mt-1">{value}</p>
      {subtitle && <p className="text-xs text-gray-400 mt-1">{subtitle}</p>}
      {trend && (
        <p className={`text-xs mt-2 ${trend.value >= 0 ? 'text-green-600' : 'text-red-500'}`}>
          {trend.value >= 0 ? '+' : ''}{trend.value}% {trend.label}
        </p>
      )}
    </div>
  )
}
