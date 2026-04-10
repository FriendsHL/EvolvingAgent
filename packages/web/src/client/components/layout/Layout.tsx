import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar.js'
import Header from './Header.js'

export default function Layout() {
  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar />
      {/* min-w-0 overrides the default `min-width: auto` on flex children,
          allowing this column to shrink below its content's intrinsic width.
          Without it, any page with a long unbroken string (e.g. sub-agent
          identity prompts stored as experience tasks, JSON blobs, long URLs)
          pushes the entire layout wider than the viewport. */}
      <div className="flex-1 flex flex-col min-w-0">
        <Header />
        <main className="flex-1 p-6 overflow-auto break-words">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
