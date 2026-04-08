import { NavLink } from 'react-router-dom'
import { useT } from '../../i18n/index.js'

const NAV_ITEMS: Array<{ path: string; key: string; icon: string }> = [
  { path: '/chat', key: 'sidebar.chat', icon: '💬' },
  { path: '/events', key: 'sidebar.events', icon: '📡' },
  { path: '/dashboard', key: 'sidebar.dashboard', icon: '📊' },
  { path: '/agents', key: 'sidebar.agents', icon: '🤖' },
  { path: '/sessions', key: 'sidebar.sessions', icon: '🕐' },
  { path: '/skills', key: 'sidebar.skills', icon: '⚡' },
  { path: '/tools', key: 'sidebar.tools', icon: '🔧' },
  { path: '/mcp', key: 'sidebar.mcp', icon: '🔌' },
  { path: '/prompts', key: 'sidebar.prompts', icon: '✏️' },
  { path: '/ops', key: 'sidebar.optimization', icon: '🚀' },
  { path: '/coordinate', key: 'sidebar.coordinate', icon: '🔄' },
  { path: '/memory', key: 'sidebar.memory', icon: '🧠' },
  { path: '/hooks', key: 'sidebar.hooks', icon: '🔗' },
  { path: '/metrics', key: 'sidebar.metrics', icon: '📈' },
]

export default function Sidebar() {
  const t = useT()
  return (
    <aside className="w-56 bg-gray-900 text-gray-300 flex flex-col min-h-screen">
      <div className="p-4 border-b border-gray-700">
        <h1 className="text-lg font-bold text-white">{t('sidebar.brand')}</h1>
        <p className="text-xs text-gray-500 mt-1">{t('sidebar.subtitle')}</p>
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
            <span>{t(item.key)}</span>
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
          <span>{t('sidebar.settings')}</span>
        </NavLink>
      </div>
    </aside>
  )
}
