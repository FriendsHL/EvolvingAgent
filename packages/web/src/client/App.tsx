import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/layout/Layout.js'
import DashboardPage from './pages/DashboardPage.js'
import MetricsPage from './pages/MetricsPage.js'
import MemoryPage from './pages/MemoryPage.js'
import ExperienceDetailPage from './pages/ExperienceDetailPage.js'
import HooksPage from './pages/HooksPage.js'
import SkillsPage from './pages/SkillsPage.js'
import AgentsPage from './pages/AgentsPage.js'
import SessionsPage from './pages/SessionsPage.js'
import SessionDetailPage from './pages/SessionDetailPage.js'
import ChatPage from './pages/ChatPage.js'
import ToolsPage from './pages/ToolsPage.js'
import CoordinatePage from './pages/CoordinatePage.js'
import KnowledgePage from './pages/KnowledgePage.js'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/sessions/:id" element={<SessionDetailPage />} />
        <Route path="/skills" element={<SkillsPage />} />
        <Route path="/tools" element={<ToolsPage />} />
        <Route path="/coordinate" element={<CoordinatePage />} />
        <Route path="/knowledge" element={<KnowledgePage />} />
        <Route path="/memory" element={<MemoryPage />} />
        <Route path="/memory/:id" element={<ExperienceDetailPage />} />
        <Route path="/hooks" element={<HooksPage />} />
        <Route path="/metrics" element={<MetricsPage />} />
      </Route>
    </Routes>
  )
}
