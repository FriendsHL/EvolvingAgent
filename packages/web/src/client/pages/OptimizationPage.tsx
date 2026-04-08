/**
 * Optimization Center — Phase 4 D5.
 *
 * A unified hub for all "optimization-flavored" runs in the system. Today
 * that's two run families:
 *   - Prompt self-optimization runs (Phase 4 C) — backed by `/api/prompts/runs`
 *   - Experience distillation runs   (Phase 4 E) — backed by `/api/memory/distill/runs`
 *
 * The page is intentionally a thin landing surface: it shows status counts,
 * a merged-by-time activity feed, and quick-trigger buttons. The full
 * inspection / accept-reject flows still live in PromptsPage and MemoryPage —
 * timeline rows link out to those existing surfaces with deep-link state.
 *
 * Skill validator + eval runner are not surfaced yet because neither has a
 * standalone runnable process exposed via the API; once they do, drop them
 * into the timeline by extending the merge in `useTimeline` below.
 */

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi.js'
import { apiGet, apiPost } from '../api/client.js'
import SummaryCard from '../components/shared/SummaryCard.js'
import { useT } from '../i18n/index.js'

// ----------------------------------------------------------------
// Wire types — mirror server shapes; intentionally not imported from
// core to keep the client bundle lean.
// ----------------------------------------------------------------

type PromptId = 'planner' | 'reflector' | 'conversational'

interface PromptRunSummary {
  id: string
  targetId: PromptId
  status: 'running' | 'completed' | 'failed'
  startedAt: string
  finishedAt?: string
  candidateCount: number
  acceptedCount: number
  rejectedCount: number
  error?: string
}

interface DistillRun {
  id: string
  startedAt: string
  finishedAt?: string
  status: 'running' | 'completed' | 'failed'
  inputCount: number
  candidates: Array<{ status: 'pending' | 'accepted' | 'rejected' }>
  error?: string
}

type TimelineEntry = {
  kind: 'prompt' | 'distill'
  id: string
  startedAt: string
  finishedAt?: string
  status: 'running' | 'completed' | 'failed'
  title: string
  subtitle: string
  href: string
  error?: string
}

const PROMPT_IDS: PromptId[] = ['planner', 'reflector', 'conversational']

export default function OptimizationPage() {
  const t = useT()
  const { data: promptRunsData, refetch: refetchPrompts } = useApi<{ runs: PromptRunSummary[] }>(
    () => apiGet('/prompts/runs'),
    [],
  )
  const { data: distillRunsData, refetch: refetchDistill } = useApi<{ runs: DistillRun[] }>(
    () => apiGet('/memory/distill/runs'),
    [],
  )

  const promptRuns = promptRunsData?.runs ?? []
  const distillRuns = distillRunsData?.runs ?? []

  const timeline = useMemo<TimelineEntry[]>(() => {
    const fromPrompts: TimelineEntry[] = promptRuns.map((r) => ({
      kind: 'prompt',
      id: r.id,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      status: r.status,
      title: `Prompt: ${r.targetId}`,
      subtitle:
        r.status === 'completed'
          ? `${r.candidateCount} candidates · ${r.acceptedCount} passed gate`
          : r.status === 'failed'
            ? 'failed'
            : 'running…',
      href: `/prompts?run=${r.id}&id=${r.targetId}`,
      error: r.error,
    }))
    const fromDistill: TimelineEntry[] = distillRuns.map((r) => {
      const pending = r.candidates.filter((c) => c.status === 'pending').length
      const accepted = r.candidates.filter((c) => c.status === 'accepted').length
      return {
        kind: 'distill',
        id: r.id,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        status: r.status,
        title: 'Distillation',
        subtitle:
          r.status === 'completed'
            ? `${r.inputCount} inputs → ${r.candidates.length} lessons (${pending} pending, ${accepted} accepted)`
            : r.status === 'failed'
              ? 'failed'
              : 'running…',
        href: `/memory?distillRun=${r.id}`,
        error: r.error,
      }
    })
    return [...fromPrompts, ...fromDistill].sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    )
  }, [promptRuns, distillRuns])

  const promptStats = computeStats(promptRuns)
  const distillStats = computeStats(distillRuns)

  return (
    <div>
      <h2 className="text-xl font-semibold mb-2">{t('optimization.title')}</h2>
      <p className="text-sm text-gray-500 mb-3">
        {t('optimization.subtitle')}
      </p>
      <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-2.5 text-xs text-blue-900 mb-6">
        {t('optimization.help.intro')}
      </div>

      {/* Status summary */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <SummaryCard
          label={t('optimization.promptRuns')}
          value={promptStats.total}
          subtitle={t('optimization.stats.subtitle', undefined, {
            running: promptStats.running,
            completed: promptStats.completed,
            failed: promptStats.failed,
          })}
        />
        <SummaryCard
          label={t('optimization.distillRuns')}
          value={distillStats.total}
          subtitle={t('optimization.stats.subtitle', undefined, {
            running: distillStats.running,
            completed: distillStats.completed,
            failed: distillStats.failed,
          })}
        />
        <SummaryCard
          label={t('optimization.pending')}
          value={countPendingDistill(distillRuns) + countPendingPrompts(promptRuns)}
          subtitle={t('optimization.pending.subtitle')}
        />
        <SummaryCard
          label={t('optimization.total')}
          value={promptStats.total + distillStats.total}
        />
      </div>

      {/* Quick triggers */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <PromptLauncher onLaunched={refetchPrompts} />
        <DistillLauncher onLaunched={refetchDistill} />
      </div>

      {/* Merged timeline */}
      <div className="bg-white rounded-xl border border-gray-200">
        <div className="px-5 py-3 border-b border-gray-200 flex justify-between items-center">
          <h3 className="text-sm font-semibold">{t('optimization.timeline.title')}</h3>
          <button
            onClick={() => {
              refetchPrompts()
              refetchDistill()
            }}
            className="text-xs text-blue-600 hover:text-blue-800"
          >
            {t('common.refresh')}
          </button>
        </div>
        {timeline.length === 0 ? (
          <p className="px-5 py-8 text-sm text-gray-500 text-center">
            {t('optimization.timeline.empty')}
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {timeline.map((entry) => (
              <TimelineRow key={`${entry.kind}-${entry.id}`} entry={entry} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ============================================================
// Prompt launcher
// ============================================================

function PromptLauncher({ onLaunched }: { onLaunched: () => void }) {
  const t = useT()
  const [target, setTarget] = useState<PromptId>('planner')
  const [count, setCount] = useState(3)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function launch() {
    setBusy(true)
    setMsg(null)
    try {
      const res = await apiPost(`/prompts/${target}/optimize`, { count })
      const body = res as { runId?: string; error?: string }
      if (body.error) {
        setMsg(`Failed: ${body.error}`)
      } else {
        setMsg(`Launched run ${body.runId}`)
        onLaunched()
      }
    } catch (e) {
      setMsg(`Failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <h3 className="text-sm font-semibold mb-3">{t('optimization.prompt.title')}</h3>
      <div className="flex flex-col gap-2 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-gray-500 w-16">{t('optimization.prompt.target')}</span>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value as PromptId)}
            className="border rounded-lg px-3 py-1.5 text-sm flex-1"
          >
            {PROMPT_IDS.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-gray-500 w-16">{t('optimization.prompt.count')}</span>
          <input
            type="number"
            min={1}
            max={10}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className="border rounded-lg px-3 py-1.5 text-sm flex-1"
          />
        </label>
        <button
          onClick={launch}
          disabled={busy}
          className="bg-blue-600 text-white text-sm rounded-lg px-4 py-2 mt-1 hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? t('optimization.prompt.launching') : t('optimization.prompt.launch')}
        </button>
        {msg && <p className="text-xs text-gray-500">{msg}</p>}
      </div>
    </div>
  )
}

// ============================================================
// Distill launcher
// ============================================================

function DistillLauncher({ onLaunched }: { onLaunched: () => void }) {
  const t = useT()
  const [maxInputs, setMaxInputs] = useState(50)
  const [maxLessons, setMaxLessons] = useState(5)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function launch() {
    setBusy(true)
    setMsg(null)
    try {
      const res = await apiPost('/memory/distill', { maxInputs, maxLessons })
      const body = res as { id?: string; error?: string }
      if (body.error) {
        setMsg(`Failed: ${body.error}`)
      } else {
        setMsg(`Run ${body.id} completed`)
        onLaunched()
      }
    } catch (e) {
      setMsg(`Failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <h3 className="text-sm font-semibold mb-3">{t('optimization.distill.title')}</h3>
      <div className="flex flex-col gap-2 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-gray-500 w-24">{t('optimization.distill.maxInputs')}</span>
          <input
            type="number"
            min={1}
            max={500}
            value={maxInputs}
            onChange={(e) => setMaxInputs(Number(e.target.value))}
            className="border rounded-lg px-3 py-1.5 text-sm flex-1"
          />
        </label>
        <label className="flex items-center gap-2">
          <span className="text-gray-500 w-24">{t('optimization.distill.maxLessons')}</span>
          <input
            type="number"
            min={1}
            max={20}
            value={maxLessons}
            onChange={(e) => setMaxLessons(Number(e.target.value))}
            className="border rounded-lg px-3 py-1.5 text-sm flex-1"
          />
        </label>
        <button
          onClick={launch}
          disabled={busy}
          className="bg-blue-600 text-white text-sm rounded-lg px-4 py-2 mt-1 hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? t('optimization.distill.launching') : t('optimization.distill.launch')}
        </button>
        {msg && <p className="text-xs text-gray-500">{msg}</p>}
      </div>
    </div>
  )
}

// ============================================================
// Timeline row
// ============================================================

function TimelineRow({ entry }: { entry: TimelineEntry }) {
  const statusBadge = {
    running: 'bg-blue-100 text-blue-700',
    completed: 'bg-green-100 text-green-700',
    failed: 'bg-red-100 text-red-700',
  }[entry.status]

  const kindBadge = {
    prompt: 'bg-purple-50 text-purple-700 border border-purple-200',
    distill: 'bg-amber-50 text-amber-700 border border-amber-200',
  }[entry.kind]

  return (
    <li className="px-5 py-3 hover:bg-gray-50 transition-colors">
      <Link to={entry.href} className="block">
        <div className="flex items-start gap-3">
          <span className={`text-xs px-2 py-0.5 rounded font-medium ${kindBadge}`}>
            {entry.kind}
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{entry.title}</span>
              <span className={`text-xs px-1.5 py-0.5 rounded ${statusBadge}`}>{entry.status}</span>
            </div>
            <p className="text-xs text-gray-500 mt-0.5">{entry.subtitle}</p>
            {entry.error && (
              <p className="text-xs text-red-500 mt-0.5 truncate">{entry.error}</p>
            )}
          </div>
          <div className="text-xs text-gray-400 whitespace-nowrap">
            {new Date(entry.startedAt).toLocaleString()}
          </div>
        </div>
      </Link>
    </li>
  )
}

// ============================================================
// Helpers
// ============================================================

function computeStats<T extends { status: 'running' | 'completed' | 'failed' }>(runs: T[]) {
  return {
    total: runs.length,
    running: runs.filter((r) => r.status === 'running').length,
    completed: runs.filter((r) => r.status === 'completed').length,
    failed: runs.filter((r) => r.status === 'failed').length,
  }
}

function countPendingDistill(runs: DistillRun[]): number {
  return runs.reduce(
    (acc, r) => acc + r.candidates.filter((c) => c.status === 'pending').length,
    0,
  )
}

function countPendingPrompts(runs: PromptRunSummary[]): number {
  // A prompt run with passed candidates that hasn't been accepted yet is "pending review".
  // We can't tell from the runs list alone whether the user accepted it; surface
  // gate-passing runs as a proxy.
  return runs.filter((r) => r.status === 'completed' && r.acceptedCount > 0).length
}
