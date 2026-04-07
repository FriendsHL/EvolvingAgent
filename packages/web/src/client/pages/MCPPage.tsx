import { useEffect, useState, useCallback } from 'react'
import { apiGet, apiPut } from '../api/client.js'

// ----------------------------------------------------------------
// Types — mirror the server's wire shapes; we don't import from
// @evolving-agent/core to keep the client bundle lean.
// ----------------------------------------------------------------
type ServerStatus = 'connecting' | 'running' | 'missing-secret' | 'failed' | 'disabled'

interface MCPServerStatusEntry {
  id: string
  label: string
  status: ServerStatus
  message?: string
  toolNames: string[]
  lastAttemptAt?: string
}

interface MCPServerConfig {
  id: string
  label?: string
  enabled?: boolean
  scope?: 'main' | 'sub' | 'both'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
}

interface SecretKeyEntry {
  key: string
  set: boolean
}

const STATUS_COLORS: Record<ServerStatus, string> = {
  running: 'bg-green-100 text-green-700 border-green-300',
  connecting: 'bg-yellow-100 text-yellow-700 border-yellow-300',
  'missing-secret': 'bg-orange-100 text-orange-700 border-orange-300',
  failed: 'bg-red-100 text-red-700 border-red-300',
  disabled: 'bg-gray-100 text-gray-600 border-gray-300',
}

const STATUS_LABEL: Record<ServerStatus, string> = {
  running: 'Running',
  connecting: 'Connecting…',
  'missing-secret': 'Missing secret',
  failed: 'Failed',
  disabled: 'Disabled',
}

const EXAMPLE_CONFIG = `{
  "servers": [
    {
      "id": "filesystem",
      "label": "Filesystem (read-only)",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "scope": "both"
    }
  ]
}`

// ================================================================
// MCPPage
// ================================================================
export default function MCPPage() {
  const [tab, setTab] = useState<'servers' | 'secrets'>('servers')
  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-semibold">🔌 MCP 集成</h2>
        <p className="text-xs text-gray-500 mt-1">
          配置 MCP server 与 secrets。修改后立即生效，无需重启服务。
          MCP 是兜底通道：能用 skill+CLI 解决的请优先用 skill。
        </p>
      </div>

      <div className="flex gap-2 border-b mb-6">
        {(['servers', 'secrets'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm font-medium border-b-2 ${
              tab === k
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {k === 'servers' ? 'Servers' : 'Secrets'}
          </button>
        ))}
      </div>

      {tab === 'servers' ? <ServersTab /> : <SecretsTab />}
    </div>
  )
}

// ================================================================
// Servers tab
// ================================================================
function ServersTab() {
  const [statusList, setStatusList] = useState<MCPServerStatusEntry[]>([])
  const [enabled, setEnabled] = useState(true)
  const [configText, setConfigText] = useState('{\n  "servers": []\n}')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const [cfg, st] = await Promise.all([
        apiGet<{ servers: MCPServerConfig[] }>('/mcp/config'),
        apiGet<{ enabled: boolean; servers: MCPServerStatusEntry[] }>('/mcp/status'),
      ])
      setConfigText(JSON.stringify({ servers: cfg.servers ?? [] }, null, 2))
      setEnabled(st.enabled)
      setStatusList(st.servers ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleSave = async () => {
    setError(null)
    setSuccess(null)
    let parsed: { servers: MCPServerConfig[] }
    try {
      parsed = JSON.parse(configText)
    } catch (err) {
      setError(`JSON parse failed: ${(err as Error).message}`)
      return
    }
    if (!parsed || !Array.isArray(parsed.servers)) {
      setError('Top-level shape must be { "servers": [...] }')
      return
    }
    setSaving(true)
    try {
      const res = await apiPut<{
        servers: MCPServerConfig[]
        warning?: string
        status?: MCPServerStatusEntry[]
      }>('/mcp/config', { servers: parsed.servers })
      if (res.status) setStatusList(res.status)
      setSuccess(res.warning ?? '已保存并热加载')
      setTimeout(() => setSuccess(null), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="text-gray-400">Loading…</div>

  return (
    <div className="space-y-6">
      {!enabled && (
        <div className="bg-yellow-50 border border-yellow-200 text-yellow-700 text-sm px-4 py-2 rounded">
          MCP 集成已在 SessionManager 配置中关闭。可以编辑配置但不会生效，直到重启后启用。
        </div>
      )}

      {/* Status panel */}
      <section className="bg-white rounded-lg shadow p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">运行状态</h3>
          <button
            onClick={refresh}
            className="text-xs text-blue-600 hover:underline"
          >
            刷新
          </button>
        </div>
        {statusList.length === 0 ? (
          <p className="text-sm text-gray-500">尚未配置任何 MCP server。</p>
        ) : (
          <div className="space-y-3">
            {statusList.map((s) => (
              <ServerStatusCard key={s.id} entry={s} />
            ))}
          </div>
        )}
      </section>

      {/* Config editor */}
      <section className="bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold mb-2">mcp.json</h3>
        <p className="text-xs text-gray-500 mb-3">
          以 JSON 直接编辑。`env` 字段支持 <code className="bg-gray-100 px-1 rounded">${'{VAR}'}</code> 占位符，会从 Secrets tab 解析。
        </p>

        {success && (
          <div className="mb-3 bg-green-50 border border-green-200 text-green-700 text-sm px-3 py-2 rounded">
            {success}
          </div>
        )}
        {error && (
          <div className="mb-3 bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2 rounded whitespace-pre-wrap">
            {error}
          </div>
        )}

        <textarea
          value={configText}
          onChange={(e) => setConfigText(e.target.value)}
          spellCheck={false}
          rows={16}
          className="w-full font-mono text-xs border rounded px-3 py-2 bg-gray-50"
        />

        <details className="mt-2">
          <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
            示例配置
          </summary>
          <pre className="mt-2 bg-gray-50 border rounded p-3 text-xs overflow-x-auto">
            {EXAMPLE_CONFIG}
          </pre>
        </details>

        <div className="flex justify-end mt-4">
          <button
            onClick={handleSave}
            disabled={saving}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50 text-sm"
          >
            {saving ? '保存中…' : '保存并热加载'}
          </button>
        </div>
      </section>
    </div>
  )
}

function ServerStatusCard({ entry }: { entry: MCPServerStatusEntry }) {
  return (
    <div className="border rounded p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="font-medium text-sm">
          {entry.label}{' '}
          <span className="text-gray-400 text-xs font-normal">({entry.id})</span>
        </div>
        <span
          className={`text-xs px-2 py-0.5 rounded border ${STATUS_COLORS[entry.status]}`}
        >
          {STATUS_LABEL[entry.status]}
        </span>
      </div>
      {entry.message && (
        <p className="text-xs text-gray-600 mb-2 font-mono break-all">{entry.message}</p>
      )}
      {entry.toolNames.length > 0 && (
        <div className="text-xs text-gray-600">
          <span className="text-gray-500">Tools ({entry.toolNames.length}): </span>
          {entry.toolNames.map((t) => (
            <span
              key={t}
              className="inline-block bg-gray-100 rounded px-1.5 py-0.5 mr-1 mb-1 font-mono"
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ================================================================
// Secrets tab
// ================================================================
interface SecretRow {
  key: string
  /** Pristine values from disk are loaded as set=true; user-typed values
   *  start blank. We never receive the on-disk value from the server. */
  value: string
  /** True if this row corresponds to an existing on-disk entry. */
  existing: boolean
  /** True if the user has provided a NEW value for this row. */
  changed: boolean
}

function SecretsTab() {
  const [rows, setRows] = useState<SecretRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const data = await apiGet<{ keys: SecretKeyEntry[] }>('/mcp/secrets')
      setRows(
        (data.keys ?? []).map((k) => ({
          key: k.key,
          value: '',
          existing: k.set,
          changed: false,
        })),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const updateRow = (idx: number, patch: Partial<SecretRow>) => {
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }
  const addRow = () => setRows((rs) => [...rs, { key: '', value: '', existing: false, changed: true }])
  const removeRow = (idx: number) => setRows((rs) => rs.filter((_, i) => i !== idx))

  const handleSave = async () => {
    setError(null)
    setSuccess(null)

    // Build the request body. The server overwrites the whole file, so we
    // need to send EVERY key — including existing ones whose value the
    // user did not change. For unchanged existing keys we send an empty
    // string; the server preserves them via the secrets reload contract.
    //
    // Wait — that would clobber the on-disk value with "". Better contract:
    // we only send keys whose value the user explicitly typed (changed=true)
    // OR brand new keys; existing-untouched keys are sent as `null` so the
    // server's coercion drops them, preserving on-disk value.
    //
    // Simplest correct approach: ask the server to do a MERGE on PUT instead
    // of an overwrite. But the server endpoint above is overwrite. So:
    // include every existing key with a sentinel and let the server figure
    // it out — too clever. Instead: switch to the simplest model where the
    // user MUST re-enter unchanged values (rare in practice — secrets edits
    // happen one at a time). Show a warning before save.

    const incompleteExisting = rows.filter((r) => r.existing && !r.changed && !r.value)
    if (incompleteExisting.length > 0) {
      const proceed = window.confirm(
        `保存会覆盖整个 secrets.json。有 ${incompleteExisting.length} 个已有 key 没有重新填写值，将会被清空：\n\n` +
          incompleteExisting.map((r) => `  • ${r.key}`).join('\n') +
          '\n\n继续保存？',
      )
      if (!proceed) return
    }

    const body: Record<string, string> = {}
    for (const r of rows) {
      const key = r.key.trim()
      if (!key) continue
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        setError(`Invalid key "${key}" — must match /^[A-Za-z_][A-Za-z0-9_]*$/`)
        return
      }
      body[key] = r.value
    }

    setSaving(true)
    try {
      const res = await apiPut<{ keys: SecretKeyEntry[]; status?: MCPServerStatusEntry[] }>(
        '/mcp/secrets',
        body,
      )
      setRows(
        (res.keys ?? []).map((k) => ({
          key: k.key,
          value: '',
          existing: k.set,
          changed: false,
        })),
      )
      setSuccess('已保存并触发 MCP 重载')
      setTimeout(() => setSuccess(null), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="text-gray-400">Loading…</div>

  return (
    <section className="bg-white rounded-lg shadow p-6">
      <h3 className="text-lg font-semibold mb-2">Secrets</h3>
      <p className="text-xs text-gray-500 mb-4">
        存储在 <code className="bg-gray-100 px-1 rounded">data/config/secrets.json</code> 中。
        在 mcp.json 中用 <code className="bg-gray-100 px-1 rounded">${'{KEY}'}</code> 引用。
        出于安全考虑，已有 secret 的值不会回显到页面，需重新输入才能更新。
      </p>

      {success && (
        <div className="mb-3 bg-green-50 border border-green-200 text-green-700 text-sm px-3 py-2 rounded">
          {success}
        </div>
      )}
      {error && (
        <div className="mb-3 bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2 rounded">
          {error}
        </div>
      )}

      <table className="w-full text-sm">
        <thead className="text-xs text-gray-500">
          <tr>
            <th className="text-left pb-2">Key</th>
            <th className="text-left pb-2">Value</th>
            <th className="pb-2 w-20"></th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={3} className="text-center text-gray-400 py-4">
                还没有任何 secret。
              </td>
            </tr>
          )}
          {rows.map((r, i) => (
            <tr key={i} className="border-t">
              <td className="py-2 pr-2">
                <input
                  type="text"
                  value={r.key}
                  onChange={(e) => updateRow(i, { key: e.target.value })}
                  placeholder="API_KEY"
                  className="border rounded px-2 py-1 w-full font-mono text-xs"
                />
              </td>
              <td className="py-2 pr-2">
                <input
                  type="password"
                  value={r.value}
                  onChange={(e) => updateRow(i, { value: e.target.value, changed: true })}
                  placeholder={r.existing && !r.changed ? '••••••••（已设置，留空将清除）' : ''}
                  className="border rounded px-2 py-1 w-full font-mono text-xs"
                />
              </td>
              <td className="py-2 text-right">
                <button
                  onClick={() => removeRow(i)}
                  className="text-xs text-red-600 hover:underline"
                >
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex justify-between mt-4">
        <button
          onClick={addRow}
          className="text-sm text-blue-600 hover:underline"
        >
          + 添加 secret
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50 text-sm"
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </section>
  )
}
