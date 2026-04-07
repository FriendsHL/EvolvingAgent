import { NavLink } from 'react-router-dom'

const NAV_ITEMS = [
  { path: '/chat', label: 'Chat', icon: '💬' },
  { path: '/dashboard', label: 'Dashboard', icon: '📊' },
  { path: '/agents', label: 'Agents', icon: '🤖' },
  { path: '/sessions', label: 'Sessions', icon: '🕐' },
  { path: '/skills', label: 'Skills', icon: '⚡' },
  { path: '/tools', label: 'Tools', icon: '🔧' },
  { path: '/coordinate', label: 'Coordinate', icon: '🔄' },
  { path: '/knowledge', label: 'Knowledge', icon: '📚' },
  { path: '/memory', label: 'Memory', icon: '🧠' },
  { path: '/hooks', label: 'Hooks', icon: '🔗' },
  { path: '/metrics', label: 'Metrics', icon: '📈' },
]

export default function Sidebar() {
  return (
    <aside className="w-56 bg-gray-900 text-gray-300 flex flex-col min-h-screen">
      <div className="p-4 border-b border-gray-700">
        <h1 className="text-lg font-bold text-white">Evolving Agent</h1>
        <p className="text-xs text-gray-500 mt-1">Admin Dashboard</p>
      </div>
      <nav className="flex-1 p-2">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                isActive
                  ? 'bg-blue-600 text-white'
                  : 'hover:bg-gray-800 hover:text-white'
              }`
            }
          >
            <span>{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="mt-auto border-t border-gray-700 p-2">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
              isActive
                ? 'bg-blue-600 text-white'
                : 'hover:bg-gray-800 hover:text-white'
            }`
          }
        >
          <span>⚙️</span>
          <span>Settings</span>
        </NavLink>
      </div>
    </aside>
  )
}
