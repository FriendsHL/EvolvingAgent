import { useEffect, useRef, useState } from 'react'

interface BudgetConfig {
  global: {
    perSession: number
    perDay: number
  }
  main: {
    perTask: number
    warnRatio: number
    overBehavior: 'block' | 'warn-only'
  }
  subAgent: {
    enabled: boolean
    defaultPerTask: number
    warnRatio: number
    overBehavior: 'block' | 'downgrade' | 'warn-only'
    downgradeModel?: string
  }
}

const PRESET_MODELS = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
  'gpt-4o-mini',
  'deepseek-chat',
]

const DEFAULT_CONFIG: BudgetConfig = {
  global: { perSession: 0, perDay: 0 },
  main: { perTask: 0, warnRatio: 0.8, overBehavior: 'warn-only' },
  subAgent: {
    enabled: false,
    defaultPerTask: 0,
    warnRatio: 0.8,
    overBehavior: 'warn-only',
  },
}

export default function SettingsPage() {
  const [config, setConfig] = useState<BudgetConfig>(DEFAULT_CONFIG)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Track whether the downgrade model is a custom (non-preset) value
  const [customModel, setCustomModel] = useState(false)
  const [customModelValue, setCustomModelValue] = useState('')
  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/config/budget')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as BudgetConfig
        if (cancelled) return
        setConfig(data)
        const dm = data.subAgent.downgradeModel
        if (dm && !PRESET_MODELS.includes(dm)) {
          setCustomModel(true)
          setCustomModelValue(dm)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load config')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      if (successTimer.current) clearTimeout(successTimer.current)
    }
  }, [])

  const updateGlobal = <K extends keyof BudgetConfig['global']>(
    key: K,
    value: BudgetConfig['global'][K]
  ) => {
    setConfig((c) => ({ ...c, global: { ...c.global, [key]: value } }))
  }

  const updateMain = <K extends keyof BudgetConfig['main']>(
    key: K,
    value: BudgetConfig['main'][K]
  ) => {
    setConfig((c) => ({ ...c, main: { ...c.main, [key]: value } }))
  }

  const updateSub = <K extends keyof BudgetConfig['subAgent']>(
    key: K,
    value: BudgetConfig['subAgent'][K]
  ) => {
    setConfig((c) => ({ ...c, subAgent: { ...c.subAgent, [key]: value } }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)

    // Validation: downgrade requires a model id
    if (config.subAgent.enabled && config.subAgent.overBehavior === 'downgrade') {
      const model = customModel ? customModelValue.trim() : config.subAgent.downgradeModel
      if (!model) {
        setError('请选择或填写降级模型')
        return
      }
    }

    const payload: BudgetConfig = {
      ...config,
      subAgent: {
        ...config.subAgent,
        downgradeModel:
          config.subAgent.overBehavior === 'downgrade'
            ? customModel
              ? customModelValue.trim()
              : config.subAgent.downgradeModel
            : undefined,
      },
    }

    setSaving(true)
    try {
      const res = await fetch('/api/config/budget', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(text || `HTTP ${res.status}`)
      }
      setSuccess('已生效，无需重启')
      if (successTimer.current) clearTimeout(successTimer.current)
      successTimer.current = setTimeout(() => setSuccess(null), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div>
        <h2 className="text-xl font-semibold mb-6">⚙️ Settings — Budget Policy</h2>
        <div className="text-gray-400">Loading…</div>
      </div>
    )
  }

  const subDisabled = !config.subAgent.enabled
  const showDowngradeModel = config.subAgent.overBehavior === 'downgrade'

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-semibold">⚙️ Settings — Budget Policy</h2>
        <p className="text-xs text-gray-500 mt-1">
          配置全局、主 Agent 与子 Agent 的 token 预算策略。修改后立即生效。
        </p>
      </div>

      {success && (
        <div className="mb-4 bg-green-50 border border-green-200 text-green-700 text-sm px-4 py-2 rounded">
          {success}
        </div>
      )}
      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2 rounded">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Global */}
        <section className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold mb-4">全局预算</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                单会话 token 上限
              </label>
              <input
                type="number"
                min={0}
                value={config.global.perSession}
                onChange={(e) => updateGlobal('perSession', Number(e.target.value))}
                className="border rounded px-3 py-2 w-full"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                每日 token 上限
              </label>
              <input
                type="number"
                min={0}
                value={config.global.perDay}
                onChange={(e) => updateGlobal('perDay', Number(e.target.value))}
                className="border rounded px-3 py-2 w-full"
              />
            </div>
          </div>
        </section>

        {/* Main Agent */}
        <section className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold mb-4">主 Agent</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                单任务 token 上限
              </label>
              <input
                type="number"
                min={0}
                value={config.main.perTask}
                onChange={(e) => updateMain('perTask', Number(e.target.value))}
                className="border rounded px-3 py-2 w-full"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                告警阈值（warnRatio）：{config.main.warnRatio.toFixed(2)}
              </label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={config.main.warnRatio}
                onChange={(e) => updateMain('warnRatio', Number(e.target.value))}
                className="w-full"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">超限行为</label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="main-over"
                    checked={config.main.overBehavior === 'block'}
                    onChange={() => updateMain('overBehavior', 'block')}
                  />
                  block（拒绝执行）
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="main-over"
                    checked={config.main.overBehavior === 'warn-only'}
                    onChange={() => updateMain('overBehavior', 'warn-only')}
                  />
                  warn-only（仅告警）
                </label>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                主 Agent 不支持自动降级；如需降级请在请求失败时手动切换模型。
              </p>
            </div>
          </div>
        </section>

        {/* Sub-Agent */}
        <section className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">子 Agent</h3>
            <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
              <input
                type="checkbox"
                checked={config.subAgent.enabled}
                onChange={(e) => updateSub('enabled', e.target.checked)}
              />
              启用子 Agent 预算控制
            </label>
          </div>
          <div className={`space-y-4 ${subDisabled ? 'opacity-50 pointer-events-none' : ''}`}>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                默认单任务 token 上限
              </label>
              <input
                type="number"
                min={0}
                value={config.subAgent.defaultPerTask}
                onChange={(e) => updateSub('defaultPerTask', Number(e.target.value))}
                className="border rounded px-3 py-2 w-full"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                告警阈值（warnRatio）：{config.subAgent.warnRatio.toFixed(2)}
              </label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={config.subAgent.warnRatio}
                onChange={(e) => updateSub('warnRatio', Number(e.target.value))}
                className="w-full"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">超限行为</label>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="sub-over"
                    checked={config.subAgent.overBehavior === 'block'}
                    onChange={() => updateSub('overBehavior', 'block')}
                  />
                  block（拒绝执行）
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="sub-over"
                    checked={config.subAgent.overBehavior === 'downgrade'}
                    onChange={() => updateSub('overBehavior', 'downgrade')}
                  />
                  downgrade（自动降级）
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="sub-over"
                    checked={config.subAgent.overBehavior === 'warn-only'}
                    onChange={() => updateSub('overBehavior', 'warn-only')}
                  />
                  warn-only（仅告警）
                </label>
              </div>
            </div>
            {showDowngradeModel && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  降级目标模型
                </label>
                <select
                  value={customModel ? '__custom__' : config.subAgent.downgradeModel ?? ''}
                  onChange={(e) => {
                    const v = e.target.value
                    if (v === '__custom__') {
                      setCustomModel(true)
                    } else {
                      setCustomModel(false)
                      updateSub('downgradeModel', v || undefined)
                    }
                  }}
                  className="border rounded px-3 py-2 w-full"
                >
                  <option value="">— 请选择 —</option>
                  {PRESET_MODELS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                  <option value="__custom__">自定义…</option>
                </select>
                {customModel && (
                  <input
                    type="text"
                    placeholder="输入模型 ID"
                    value={customModelValue}
                    onChange={(e) => setCustomModelValue(e.target.value)}
                    className="border rounded px-3 py-2 w-full mt-2"
                  />
                )}
              </div>
            )}
          </div>
        </section>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </div>
  )
}
