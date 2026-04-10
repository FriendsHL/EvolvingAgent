import { useState } from 'react'
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

type HookFilter = 'all' | 'system' | 'user' | 'evolved'

export default function HooksPage() {
  const { data, refetch } = useApi<{ hooks: HookInfo[] }>(() => apiGet('/hooks'))
  const hooks = data?.hooks ?? []
  const [filter, setFilter] = useState<HookFilter>('all')

  const toggleHook = async (id: string, enabled: boolean) => {
    await apiPatch(`/hooks/${id}/toggle`, { enabled })
    refetch()
  }

  const updatePriority = async (id: string, priority: number) => {
    await apiPatch(`/hooks/${id}/priority`, { priority })
    refetch()
  }

  // Categorize hooks by source
  const systemHooks = hooks.filter((h) => h.source === 'core' || h.source === 'system' || h.source === 'builtin')
  const userHooks = hooks.filter((h) => h.source === 'user')
  const evolvedHooks = hooks.filter((h) => h.source === 'evolved' || h.source === 'agent')
  const filteredHooks = filter === 'all' ? hooks
    : filter === 'system' ? systemHooks
    : filter === 'user' ? userHooks
    : evolvedHooks

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-xl font-semibold mb-1">钩子管理</h2>
        <p className="text-sm text-gray-500 mb-3">
          钩子在 Agent 处理流程的关键节点运行（规划前、工具调用前后、反思后等），可注入预算检查、安全校验、缓存监控或自定义逻辑。
        </p>
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-2.5 text-xs text-blue-900 space-y-1">
          <div><strong>系统钩子（System）</strong>：内置在 <code>packages/core/src/hooks/core-hooks/</code> 中，如缓存健康告警、预算守卫。可以开关但不能删除。</div>
          <div><strong>用户钩子（User）</strong>：在 <code>routes/hooks.ts</code> 中注册的自定义钩子。可以调整优先级和开关。</div>
          <div><strong>自进化钩子（Evolved）</strong>：Agent 从反思中自动创建的钩子，经过沙箱验证。可以审查并开关。</div>
          <div className="mt-1.5 text-blue-700">想添加自定义钩子？在 core-hooks 目录下实现 <code>Hook</code> 接口并注册，或等待后续的上传式自定义钩子功能。</div>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 mb-4 bg-gray-100 rounded-lg p-1 w-fit">
        {([
          { key: 'all' as const, label: `全部 (${hooks.length})` },
          { key: 'system' as const, label: `系统 (${systemHooks.length})` },
          { key: 'user' as const, label: `用户 (${userHooks.length})` },
          { key: 'evolved' as const, label: `自进化 (${evolvedHooks.length})` },
        ]).map((t) => (
          <button
            key={t.key}
            onClick={() => setFilter(t.key)}
            className={`text-xs px-3 py-1.5 rounded-md transition-colors ${
              filter === t.key
                ? 'bg-white text-gray-900 shadow-sm font-medium'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        {filteredHooks.length === 0 && (
          <div className="text-center text-gray-400 py-12">
            {filter === 'all' ? '暂无注册的钩子' : `暂无${filter === 'system' ? '系统' : filter === 'user' ? '用户' : '自进化'}钩子`}
          </div>
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
