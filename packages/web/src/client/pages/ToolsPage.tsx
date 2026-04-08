import { useState } from 'react'
import { useApi } from '../hooks/useApi.js'
import { apiGet, apiPost } from '../api/client.js'

interface Dependency {
  name: string
  installed: boolean
  version?: string
}

interface SystemTool {
  id: string
  name: string
  description: string
  category: 'builtin' | 'system' | 'plugin'
  status: 'ready' | 'unavailable' | 'checking'
  error?: string
  actions?: string[]
  dependencies?: Dependency[]
  setupCommand?: string
}

export default function ToolsPage() {
  const { data, loading, error, refetch } = useApi<{ tools: SystemTool[] }>(() => apiGet('/tools'))
  const [installing, setInstalling] = useState<string | null>(null)
  const [installResult, setInstallResult] = useState<{ id: string; success: boolean; message: string } | null>(null)

  const tools = data?.tools ?? []

  const handleSetup = async (toolId: string) => {
    setInstalling(toolId)
    setInstallResult(null)
    try {
      const res = await apiPost<{ success: boolean; output?: string; error?: string }>(`/tools/${toolId}/setup`, {})
      setInstallResult({
        id: toolId,
        success: res.success,
        message: res.success ? 'Installation completed successfully' : (res.error ?? 'Unknown error'),
      })
      // Refresh tool list after install
      setTimeout(() => refetch(), 1000)
    } catch (err) {
      setInstallResult({
        id: toolId,
        success: false,
        message: err instanceof Error ? err.message : String(err),
      })
    }
    setInstalling(null)
  }

  const categoryLabel: Record<string, string> = {
    builtin: 'Built-in',
    system: 'System',
    plugin: 'Plugin',
  }

  const categoryColor: Record<string, string> = {
    builtin: 'bg-blue-50 text-blue-700',
    system: 'bg-purple-50 text-purple-700',
    plugin: 'bg-orange-50 text-orange-700',
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold">System Tools</h2>
          <p className="text-sm text-gray-400 mt-1">Tools available to the Agent for task execution</p>
        </div>
        <button
          onClick={() => refetch()}
          className="text-sm text-gray-500 hover:text-gray-700 border border-gray-200 rounded-lg px-3 py-1.5"
        >
          Refresh
        </button>
      </div>

      {/* Summary */}
      <div className="flex gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 px-4 py-3">
          <div className="text-2xl font-semibold">{tools.length}</div>
          <div className="text-xs text-gray-400">Total Tools</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 px-4 py-3">
          <div className="text-2xl font-semibold text-green-600">
            {tools.filter((t) => t.status === 'ready').length}
          </div>
          <div className="text-xs text-gray-400">Ready</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 px-4 py-3">
          <div className="text-2xl font-semibold text-red-500">
            {tools.filter((t) => t.status === 'unavailable').length}
          </div>
          <div className="text-xs text-gray-400">Unavailable</div>
        </div>
      </div>

      {loading && (
        <div className="text-sm text-gray-400 mb-4">Loading tools…</div>
      )}
      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2 rounded">
          Failed to load tools: {error}
        </div>
      )}
      {!loading && !error && tools.length === 0 && (
        <div className="text-sm text-gray-400 mb-4">No tools registered.</div>
      )}

      {/* Tool cards */}
      <div className="space-y-3">
        {tools.map((tool) => (
          <div
            key={tool.id}
            className={`bg-white rounded-xl border px-5 py-4 ${
              tool.status === 'ready' ? 'border-gray-200' : 'border-red-200'
            }`}
          >
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-1">
                  {/* Status dot */}
                  <span className={`w-2.5 h-2.5 rounded-full ${
                    tool.status === 'ready' ? 'bg-green-400' : 'bg-red-400'
                  }`} />
                  <h3 className="font-medium text-gray-800">{tool.name}</h3>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${categoryColor[tool.category]}`}>
                    {categoryLabel[tool.category]}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    tool.status === 'ready'
                      ? 'bg-green-50 text-green-700'
                      : 'bg-red-50 text-red-700'
                  }`}>
                    {tool.status}
                  </span>
                </div>
                <p className="text-sm text-gray-500 ml-5">{tool.description}</p>

                {/* Actions */}
                {tool.actions && tool.actions.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2 ml-5">
                    {tool.actions.map((action) => (
                      <span key={action} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">
                        {action}
                      </span>
                    ))}
                  </div>
                )}

                {/* Dependencies */}
                {tool.dependencies && tool.dependencies.length > 0 && (
                  <div className="mt-3 ml-5">
                    <div className="text-xs text-gray-400 mb-1">Dependencies:</div>
                    <div className="flex flex-wrap gap-2">
                      {tool.dependencies.map((dep) => (
                        <span
                          key={dep.name}
                          className={`text-xs px-2 py-0.5 rounded flex items-center gap-1 ${
                            dep.installed
                              ? 'bg-green-50 text-green-700'
                              : 'bg-red-50 text-red-700'
                          }`}
                        >
                          <span>{dep.installed ? '+' : '!'}</span>
                          {dep.name}
                          {dep.version && <span className="text-gray-400">@{dep.version}</span>}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Error */}
                {tool.error && (
                  <div className="mt-2 ml-5 text-xs text-red-500 bg-red-50 rounded-lg px-3 py-2">
                    {tool.error}
                  </div>
                )}

                {/* Install result */}
                {installResult && installResult.id === tool.id && (
                  <div className={`mt-2 ml-5 text-xs rounded-lg px-3 py-2 ${
                    installResult.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
                  }`}>
                    {installResult.message}
                  </div>
                )}
              </div>

              {/* Setup button for tools that need it */}
              {tool.setupCommand && tool.status === 'unavailable' && (
                <button
                  onClick={() => handleSetup(tool.id)}
                  disabled={installing === tool.id}
                  className="flex-shrink-0 ml-4 bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {installing === tool.id ? 'Installing...' : 'Install'}
                </button>
              )}
            </div>

            {/* Setup command hint */}
            {tool.setupCommand && (
              <div className="mt-3 ml-5">
                <div className="text-xs text-gray-400">Setup command:</div>
                <code className="text-xs bg-gray-50 text-gray-600 px-2 py-1 rounded block mt-0.5">
                  {tool.setupCommand}
                </code>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
