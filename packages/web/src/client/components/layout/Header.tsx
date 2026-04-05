export default function Header() {
  return (
    <header className="h-14 bg-white border-b border-gray-200 flex items-center justify-between px-6">
      <div className="text-sm text-gray-500">
        Evolving Agent Control Panel
      </div>
      <div className="flex items-center gap-4">
        <span className="inline-flex items-center gap-1.5 text-xs">
          <span className="w-2 h-2 rounded-full bg-green-500" />
          Connected
        </span>
      </div>
    </header>
  )
}
