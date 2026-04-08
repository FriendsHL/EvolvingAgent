import { useApi } from '../hooks/useApi.js'
import { apiGet, apiPatch } from '../api/client.js'
import StatusBadge from '../components/shared/StatusBadge.js'

interface HookInfo {
  id: string
  name: string
  description: string
  trigger: string
  priority: number
  enabled: boolean
  source: string
  health: {
    consecutiveFailures: number
    lastError?: string
    lastSuccess?: string
    totalRuns: number
    successRate: number
  }
  safety: {
    timeout: number
    maxRetries: number
    fallbackBehavior: string
    canBeDisabledByAgent: boolean
  }
}

export default function HooksPage() {
  const { data, refetch } = useApi<{ hooks: HookInfo[] }>(() => apiGet('/hooks'))
  const hooks = data?.hooks ?? []

  const toggleHook = async (id: string, enabled: boolean) => {
    await apiPatch(`/hooks/${id}/toggle`, { enabled })
    refetch()
  }

  const updatePriority = async (id: string, priority: number) => {
    await apiPatch(`/hooks/${id}/priority`, { priority })
    refetch()
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-semibold">Hooks</h2>
        <p className="text-xs text-gray-500 mt-1">
          钩子在特定时机运行（如 <code>before-plan</code>、<code>before-tool-call</code>），
          用来注入预算检查、安全校验或指标采集。右侧开关可独立启停每个钩子。
        </p>
        <p className="text-xs text-gray-500 mt-1">
          新增自定义钩子：在 <code>packages/core/src/hooks/core-hooks/</code> 下
          导出符合 <code>Hook</code> 接口的对象，然后在
          <code> packages/web/src/server/routes/hooks.ts </code> 里
          <code> registerAll([...]) </code> 注册后重启即可。上传式自定义钩子在路线图里。
        </p>
      </div>

      <div className="space-y-3">
        {hooks.length === 0 && (
          <div className="text-center text-gray-400 py-12">No hooks registered</div>
        )}
        {hooks.map((hook) => (
          <div key={hook.id} className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium">{hook.name}</h3>
                  <StatusBadge status={hook.enabled ? 'enabled' : 'disabled'} />
                  <span className="bg-gray-100 text-gray-500 text-xs px-2 py-0.5 rounded">{hook.source}</span>
                </div>
                <p className="text-xs text-gray-500 mt-1">{hook.description}</p>
                <div className="flex items-center gap-4 mt-3 text-xs text-gray-400">
                  <span>Trigger: <span className="font-medium text-gray-600">{hook.trigger}</span></span>
                  <span>Timeout: {hook.safety.timeout}ms</span>
                  <span>Fallback: {hook.safety.fallbackBehavior}</span>
                </div>
              </div>

              <div className="flex items-center gap-4">
                {/* Priority */}
                <div className="flex items-center gap-1">
                  <label className="text-xs text-gray-400">Priority:</label>
                  <input
                    type="number"
                    value={hook.priority}
                    onChange={(e) => updatePriority(hook.id, Number(e.target.value))}
                    className="w-16 border rounded px-2 py-1 text-xs text-center"
                  />
                </div>

                {/* Toggle */}
                <button
                  onClick={() => toggleHook(hook.id, !hook.enabled)}
                  className={`relative w-10 h-5 rounded-full transition-colors ${
                    hook.enabled ? 'bg-blue-600' : 'bg-gray-300'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                      hook.enabled ? 'translate-x-5' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
            </div>

            {/* Health */}
            <div className="mt-3 flex items-center gap-4 text-xs">
              <span className="text-gray-400">
                Runs: {hook.health.totalRuns}
              </span>
              <span className={hook.health.successRate >= 0.9 ? 'text-green-600' : 'text-yellow-600'}>
                Success Rate: {(hook.health.successRate * 100).toFixed(0)}%
              </span>
              {hook.health.consecutiveFailures > 0 && (
                <span className="text-red-500">
                  Consecutive Failures: {hook.health.consecutiveFailures}
                </span>
              )}
              {hook.health.lastError && (
                <span className="text-red-400 truncate max-w-xs" title={hook.health.lastError}>
                  Last Error: {hook.health.lastError}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
