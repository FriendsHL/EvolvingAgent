import { useEffect, useState, useCallback } from 'react'
import { apiGet, apiPost } from '../api/client.js'

// ----------------------------------------------------------------
// Wire types — mirror server shapes; not imported from core to keep
// the client bundle lean.
// ----------------------------------------------------------------
type PromptId = 'planner' | 'reflector' | 'conversational'
type PromptSource = 'baseline' | 'active'
type RunStatus = 'running' | 'completed' | 'failed'

interface PromptListEntry {
  id: PromptId
  source: PromptSource
  contentLength: number
  preview: string
  baselineLength: number
  activeEntry?: {
    acceptedAt: string
    note?: string
    evalPassRate?: number
    baselinePassRate?: number
  }
}

interface PromptDetail {
  id: PromptId
  content: string
  baseline: string
  activeEntry?: PromptListEntry['activeEntry']
}

interface HistoryItem {
  id: PromptId
  timestamp: string
  action: 'accept' | 'rollback' | 'init'
  note?: string
  evalPassRate?: number
  baselinePassRate?: number
  contentLength: number
  preview: string
}

interface RunSummary {
  id: string
  targetId: PromptId
  status: RunStatus
  startedAt: string
  finishedAt?: string
  candidateCount: number
  acceptedCount: number
  rejectedCount: number
  error?: string
}

interface CandidateEvaluation {
  candidate: {
    id: string
    targetId: PromptId
    content: string
    source: string
    generatedAt: string
  }
  passRate: number
  totalCases: number
  passed: number
  improved: string[]
  regressed: string[]
  durationMs: number
  totalTokens: number
}

interface RunDetail {
  id: string
  targetId: PromptId
  status: RunStatus
  startedAt: string
  finishedAt?: string
  candidateCount: number
  error?: string
  gateResult?: {
    baseline: { passRate: number; passed: number; totalCases: number }
    accepted: CandidateEvaluation[]
    rejected: Array<{
      evaluation: CandidateEvaluation
      reason: 'not-better' | 'regression'
    }>
  }
}

const PROMPT_META: Record<PromptId, { icon: string; label: string; desc: string }> = {
  planner: {
    icon: '🗺️',
    label: 'Planner',
    desc: '把任务拆成可执行的 step 列表（结构化 JSON 输出）',
  },
  reflector: {
    icon: '🔍',
    label: 'Reflector',
    desc: '执行后复盘，产出 lesson / suggestedSkill / suggestedHook',
  },
  conversational: {
    icon: '💬',
    label: 'Conversational',
    desc: '直接对话模式，跳过 plan/execute',
  },
}

// ================================================================
// Page
// ================================================================
export default function PromptsPage() {
  const [list, setList] = useState<PromptListEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openDetailId, setOpenDetailId] = useState<PromptId | null>(null)
  const [openRunId, setOpenRunId] = useState<string | null>(null)
  const [runs, setRuns] = useState<RunSummary[]>([])

  const refresh = useCallback(async () => {
    try {
      const [pData, rData] = await Promise.all([
        apiGet<{ prompts: PromptListEntry[] }>('/prompts'),
        apiGet<{ runs: RunSummary[] }>('/prompts/runs'),
      ])
      setList(pData.prompts)
      setRuns(rData.runs)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  useEffect(() => {
    refresh()
    // Light polling so background runs surface without manual refresh.
    const t = setInterval(refresh, 4000)
    return () => clearInterval(t)
  }, [refresh])

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-semibold">✏️ Prompt 自优化</h2>
        <p className="text-xs text-gray-500 mt-1">
          DSPy 风格沙箱闸门：LLM 生成候选 → eval 评分 → 严格优于 baseline 才能进人工审批。
          源码常量是 baseline；
          <code className="bg-gray-100 px-1 rounded">data/prompts/active.json</code>{' '}
          是运行时覆盖层。
        </p>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid gap-4 mb-8">
        {list?.map((entry) => (
          <PromptCard
            key={entry.id}
            entry={entry}
            onView={() => setOpenDetailId(entry.id)}
            onOptimized={refresh}
          />
        ))}
      </div>

      <RunsTable
        runs={runs}
        onOpen={(id) => setOpenRunId(id)}
        onRefresh={refresh}
      />

      {openDetailId && (
        <PromptDetailModal
          promptId={openDetailId}
          onClose={() => {
            setOpenDetailId(null)
            refresh()
          }}
        />
      )}

      {openRunId && (
        <RunDetailModal
          runId={openRunId}
          onClose={() => {
            setOpenRunId(null)
            refresh()
          }}
          onAccepted={refresh}
        />
      )}
    </div>
  )
}

// ================================================================
// PromptCard
// ================================================================
function PromptCard({
  entry,
  onView,
  onOptimized,
}: {
  entry: PromptListEntry
  onView: () => void
  onOptimized: () => void
}) {
  const meta = PROMPT_META[entry.id]
  const [busy, setBusy] = useState(false)
  const [optimizeError, setOptimizeError] = useState<string | null>(null)

  const handleOptimize = async () => {
    setBusy(true)
    setOptimizeError(null)
    try {
      await apiPost<{ runId: string }>(`/prompts/${entry.id}/optimize`, {})
      onOptimized()
    } catch (err) {
      setOptimizeError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-lg">{meta.icon}</span>
            <h3 className="text-base font-semibold">{meta.label}</h3>
            <span
              className={`text-xs px-2 py-0.5 rounded border ${
                entry.source === 'active'
                  ? 'bg-blue-50 text-blue-700 border-blue-200'
                  : 'bg-gray-50 text-gray-600 border-gray-200'
              }`}
            >
              {entry.source === 'active' ? '运行时覆盖' : '源码 baseline'}
            </span>
          </div>
          <p className="text-xs text-gray-500 mt-1">{meta.desc}</p>
          <div className="mt-3 text-xs text-gray-600">
            <span className="font-mono">{entry.contentLength}</span> 字符
            {entry.source === 'active' && entry.activeEntry && (
              <span className="ml-3">
                · 接受于{' '}
                <span className="font-mono">
                  {new Date(entry.activeEntry.acceptedAt).toLocaleString()}
                </span>
                {entry.activeEntry.evalPassRate !== undefined && (
                  <>
                    {' · pass '}
                    <span className="font-mono">
                      {(entry.activeEntry.evalPassRate * 100).toFixed(0)}%
                    </span>
                    {entry.activeEntry.baselinePassRate !== undefined && (
                      <span className="text-gray-400">
                        {' (基线 '}
                        {(entry.activeEntry.baselinePassRate * 100).toFixed(0)}%)
                      </span>
                    )}
                  </>
                )}
              </span>
            )}
          </div>
          <div className="mt-2 text-xs font-mono text-gray-500 bg-gray-50 p-2 rounded border border-gray-100 truncate">
            {entry.preview}
          </div>
          {optimizeError && (
            <div className="mt-2 text-xs text-red-600">{optimizeError}</div>
          )}
        </div>
        <div className="flex flex-col gap-2 shrink-0">
          <button
            onClick={onView}
            className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50"
          >
            查看 / 历史
          </button>
          <button
            onClick={handleOptimize}
            disabled={busy}
            className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-300"
          >
            {busy ? '启动中…' : '触发优化'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ================================================================
// RunsTable
// ================================================================
function RunsTable({
  runs,
  onOpen,
}: {
  runs: RunSummary[]
  onOpen: (id: string) => void
  onRefresh: () => void
}) {
  if (runs.length === 0) {
    return (
      <div className="border border-gray-200 rounded-lg p-6 text-center text-sm text-gray-500 bg-white">
        还没有优化运行记录。点上面的"触发优化"开始一次。
      </div>
    )
  }
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
      <div className="px-4 py-3 border-b bg-gray-50 text-sm font-medium text-gray-700">
        优化运行历史（最近 32 条，进程内存）
      </div>
      <table className="w-full text-xs">
        <thead className="bg-gray-50 text-gray-600">
          <tr>
            <th className="text-left px-4 py-2">Run ID</th>
            <th className="text-left px-4 py-2">目标</th>
            <th className="text-left px-4 py-2">状态</th>
            <th className="text-left px-4 py-2">启动时间</th>
            <th className="text-left px-4 py-2">候选 / 通过 / 拒绝</th>
            <th className="text-right px-4 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="border-t hover:bg-gray-50">
              <td className="px-4 py-2 font-mono text-gray-600">{r.id.slice(0, 12)}</td>
              <td className="px-4 py-2">{PROMPT_META[r.targetId]?.icon} {r.targetId}</td>
              <td className="px-4 py-2">
                <RunStatusBadge status={r.status} />
              </td>
              <td className="px-4 py-2 text-gray-500">
                {new Date(r.startedAt).toLocaleString()}
              </td>
              <td className="px-4 py-2 font-mono">
                {r.candidateCount} /{' '}
                <span className="text-green-700">{r.acceptedCount}</span> /{' '}
                <span className="text-gray-500">{r.rejectedCount}</span>
              </td>
              <td className="px-4 py-2 text-right">
                <button
                  onClick={() => onOpen(r.id)}
                  className="text-blue-600 hover:underline"
                >
                  查看
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RunStatusBadge({ status }: { status: RunStatus }) {
  const color =
    status === 'running'
      ? 'bg-yellow-100 text-yellow-700 border-yellow-300'
      : status === 'completed'
        ? 'bg-green-100 text-green-700 border-green-300'
        : 'bg-red-100 text-red-700 border-red-300'
  const label = status === 'running' ? '运行中' : status === 'completed' ? '完成' : '失败'
  return (
    <span className={`text-xs px-2 py-0.5 rounded border ${color}`}>
      {label}
    </span>
  )
}

// ================================================================
// PromptDetailModal — full content + history + rollback
// ================================================================
function PromptDetailModal({
  promptId,
  onClose,
}: {
  promptId: PromptId
  onClose: () => void
}) {
  const [detail, setDetail] = useState<PromptDetail | null>(null)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [d, h] = await Promise.all([
        apiGet<PromptDetail>(`/prompts/${promptId}`),
        apiGet<{ history: HistoryItem[] }>(`/prompts/${promptId}/history`),
      ])
      setDetail(d)
      setHistory(h.history)
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [promptId])

  useEffect(() => {
    load()
  }, [load])

  const handleRollback = async (timestamp?: string) => {
    if (
      !confirm(
        timestamp
          ? '确认从这个历史快照恢复？当前 active prompt 会被覆盖（但会留下新的 history 条目）'
          : '确认回退到源码 baseline？当前 active prompt 会被清除',
      )
    )
      return
    setBusy(true)
    try {
      await apiPost(`/prompts/${promptId}/rollback`, timestamp ? { timestamp } : {})
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onClose} title={`${PROMPT_META[promptId].icon} ${PROMPT_META[promptId].label}`}>
      {err && <div className="mb-3 p-2 text-xs bg-red-50 text-red-700 rounded">{err}</div>}
      {!detail ? (
        <div className="text-sm text-gray-500">加载中…</div>
      ) : (
        <>
          <div className="mb-4">
            <div className="flex items-center justify-between mb-1">
              <h4 className="text-sm font-semibold">当前生效</h4>
              {detail.activeEntry && (
                <button
                  disabled={busy}
                  onClick={() => handleRollback()}
                  className="text-xs text-orange-600 hover:underline disabled:text-gray-400"
                >
                  回退到源码 baseline
                </button>
              )}
            </div>
            <pre className="text-xs bg-gray-50 border border-gray-200 rounded p-3 max-h-64 overflow-auto whitespace-pre-wrap">
              {detail.content}
            </pre>
          </div>

          {detail.activeEntry && (
            <div className="mb-4">
              <h4 className="text-sm font-semibold mb-1">源码 baseline（fallback）</h4>
              <pre className="text-xs bg-gray-50 border border-gray-200 rounded p-3 max-h-40 overflow-auto whitespace-pre-wrap">
                {detail.baseline}
              </pre>
            </div>
          )}

          <div>
            <h4 className="text-sm font-semibold mb-2">历史快照</h4>
            {history.length === 0 ? (
              <div className="text-xs text-gray-500">没有历史记录</div>
            ) : (
              <ul className="space-y-2">
                {history.map((h) => (
                  <li
                    key={h.timestamp}
                    className="text-xs border border-gray-200 rounded p-2 flex items-start justify-between"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-xs px-1.5 py-0.5 rounded ${
                            h.action === 'accept'
                              ? 'bg-green-100 text-green-700'
                              : h.action === 'rollback'
                                ? 'bg-orange-100 text-orange-700'
                                : 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {h.action}
                        </span>
                        <span className="font-mono text-gray-500">{h.timestamp}</span>
                        {h.evalPassRate !== undefined && (
                          <span className="text-gray-500">
                            pass {(h.evalPassRate * 100).toFixed(0)}%
                          </span>
                        )}
                      </div>
                      {h.note && <div className="text-gray-500 mt-1">{h.note}</div>}
                      <div className="mt-1 font-mono text-gray-400 truncate">{h.preview}</div>
                    </div>
                    <button
                      disabled={busy}
                      onClick={() => handleRollback(h.timestamp)}
                      className="ml-2 shrink-0 text-blue-600 hover:underline disabled:text-gray-400"
                    >
                      还原
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </Modal>
  )
}

// ================================================================
// RunDetailModal — gate result + accept candidate
// ================================================================
function RunDetailModal({
  runId,
  onClose,
  onAccepted,
}: {
  runId: string
  onClose: () => void
  onAccepted: () => void
}) {
  const [run, setRun] = useState<RunDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await apiGet<{ run: RunDetail }>(`/prompts/runs/${runId}`)
      setRun(data.run)
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [runId])

  useEffect(() => {
    load()
    // Poll while the run is in progress so the UI updates without manual reload.
    const t = setInterval(() => {
      if (run?.status === 'running') load()
    }, 2500)
    return () => clearInterval(t)
  }, [load, run?.status])

  const handleAccept = async (idx: number) => {
    if (!run) return
    if (!confirm(`确认采用候选 #${idx + 1} 作为 ${run.targetId} 的新 active prompt？`)) return
    setBusy(true)
    try {
      await apiPost(`/prompts/${run.targetId}/accept`, {
        runId: run.id,
        candidateIndex: idx,
      })
      onAccepted()
      onClose()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onClose} title={`Run · ${runId.slice(0, 12)}`}>
      {err && <div className="mb-3 p-2 text-xs bg-red-50 text-red-700 rounded">{err}</div>}
      {!run ? (
        <div className="text-sm text-gray-500">加载中…</div>
      ) : (
        <>
          <div className="mb-4 text-xs text-gray-600 grid grid-cols-2 gap-2">
            <div>目标: <span className="font-mono">{run.targetId}</span></div>
            <div>状态: <RunStatusBadge status={run.status} /></div>
            <div>启动: <span className="font-mono">{new Date(run.startedAt).toLocaleString()}</span></div>
            <div>候选数: <span className="font-mono">{run.candidateCount}</span></div>
          </div>

          {run.error && (
            <div className="mb-4 p-2 text-xs bg-red-50 border border-red-200 rounded text-red-700">
              {run.error}
            </div>
          )}

          {run.gateResult && (
            <>
              <div className="mb-4 p-3 bg-gray-50 border border-gray-200 rounded text-xs">
                <strong>Baseline:</strong>{' '}
                {(run.gateResult.baseline.passRate * 100).toFixed(0)}% pass{' '}
                ({run.gateResult.baseline.passed}/{run.gateResult.baseline.totalCases})
              </div>

              <h4 className="text-sm font-semibold mb-2 text-green-700">
                ✓ 通过闸门 ({run.gateResult.accepted.length})
              </h4>
              {run.gateResult.accepted.length === 0 ? (
                <div className="text-xs text-gray-500 mb-4">没有候选严格优于 baseline</div>
              ) : (
                <div className="space-y-3 mb-6">
                  {run.gateResult.accepted.map((ev, idx) => (
                    <CandidateCard
                      key={ev.candidate.id}
                      ev={ev}
                      idx={idx}
                      onAccept={() => handleAccept(idx)}
                      busy={busy}
                    />
                  ))}
                </div>
              )}

              <h4 className="text-sm font-semibold mb-2 text-gray-600">
                ✗ 拒绝 ({run.gateResult.rejected.length})
              </h4>
              {run.gateResult.rejected.length === 0 ? (
                <div className="text-xs text-gray-500">无</div>
              ) : (
                <ul className="space-y-1 text-xs">
                  {run.gateResult.rejected.map((r, i) => (
                    <li key={i} className="border border-gray-200 rounded p-2 bg-gray-50">
                      <div className="flex items-center gap-2">
                        <span
                          className={`px-1.5 py-0.5 rounded ${
                            r.reason === 'regression'
                              ? 'bg-red-100 text-red-700'
                              : 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {r.reason === 'regression' ? '有回归' : '不优于'}
                        </span>
                        <span className="font-mono text-gray-500">
                          pass {(r.evaluation.passRate * 100).toFixed(0)}%
                        </span>
                        {r.evaluation.regressed.length > 0 && (
                          <span className="text-red-600">
                            regress: {r.evaluation.regressed.join(', ')}
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </Modal>
  )
}

function CandidateCard({
  ev,
  idx,
  onAccept,
  busy,
}: {
  ev: CandidateEvaluation
  idx: number
  onAccept: () => void
  busy: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="border border-green-300 rounded p-3 bg-green-50/30">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium mb-1">
            候选 #{idx + 1}{' '}
            <span className="font-mono text-gray-500">({ev.candidate.id.slice(0, 8)})</span>
          </div>
          <div className="text-xs text-gray-600 mb-2">
            pass <span className="font-mono">{(ev.passRate * 100).toFixed(0)}%</span>
            {' · '}
            <span className="font-mono">{ev.passed}/{ev.totalCases}</span>
            {ev.improved.length > 0 && (
              <span className="ml-2 text-green-700">
                improved: {ev.improved.join(', ')}
              </span>
            )}
            {' · '}
            <span className="font-mono text-gray-500">{ev.totalTokens} tokens</span>
          </div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-blue-600 hover:underline"
          >
            {expanded ? '收起' : '展开 prompt'}
          </button>
          {expanded && (
            <pre className="mt-2 text-xs bg-white border border-gray-200 rounded p-2 max-h-64 overflow-auto whitespace-pre-wrap">
              {ev.candidate.content}
            </pre>
          )}
        </div>
        <button
          onClick={onAccept}
          disabled={busy}
          className="px-3 py-1.5 text-xs bg-green-600 text-white rounded hover:bg-green-700 disabled:bg-gray-300 shrink-0"
        >
          采用
        </button>
      </div>
    </div>
  )
}

// ================================================================
// Modal — generic
// ================================================================
function Modal({
  onClose,
  title,
  children,
}: {
  onClose: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <h3 className="text-base font-semibold">{title}</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
          >
            ×
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  )
}
