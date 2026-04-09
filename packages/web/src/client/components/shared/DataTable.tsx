import { useState } from 'react'

/**
 * Total ordering over unknown values. Handles the common cases (numbers,
 * strings, dates, booleans, null) and falls back to stringification for
 * everything else so sorting never throws. Null/undefined always sort last.
 */
function compareUnknown(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === null || a === undefined) return 1
  if (b === null || b === undefined) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0)
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  const as = typeof a === 'string' ? a : JSON.stringify(a)
  const bs = typeof b === 'string' ? b : JSON.stringify(b)
  return as < bs ? -1 : as > bs ? 1 : 0
}

export interface Column<T> {
  key: string
  label: string
  render?: (row: T) => React.ReactNode
  sortable?: boolean
}

interface DataTableProps<T> {
  columns: Column<T>[]
  data: T[]
  keyField: string
  onRowClick?: (row: T) => void
  emptyMessage?: string
}

export default function DataTable<T extends Record<string, unknown>>({
  columns,
  data,
  keyField,
  onRowClick,
  emptyMessage = 'No data',
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const sorted = sortKey
    ? [...data].sort((a, b) => {
        // Row values are unknown per the generic constraint. Use a total
        // ordering helper that handles strings / numbers / dates and
        // falls back to string coercion for everything else.
        const cmp = compareUnknown(a[sortKey], b[sortKey])
        return sortDir === 'asc' ? cmp : -cmp
      })
    : data

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  if (data.length === 0) {
    return <div className="text-center text-gray-400 py-12">{emptyMessage}</div>
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200">
            {columns.map((col) => (
              <th
                key={col.key}
                className={`text-left py-3 px-4 text-xs font-medium text-gray-500 uppercase ${
                  col.sortable ? 'cursor-pointer hover:text-gray-700 select-none' : ''
                }`}
                onClick={col.sortable ? () => handleSort(col.key) : undefined}
              >
                {col.label}
                {sortKey === col.key && (sortDir === 'asc' ? ' ↑' : ' ↓')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={String(row[keyField])}
              className={`border-b border-gray-100 ${
                onRowClick ? 'cursor-pointer hover:bg-gray-50' : ''
              }`}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((col) => (
                <td key={col.key} className="py-3 px-4">
                  {col.render ? col.render(row) : String(row[col.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
