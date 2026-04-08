/**
 * DistillationPanel — Phase 4 E Stage 3.
 *
 * Drives the /api/memory/distill HTTP routes:
 *   - Configure + trigger a run
 *   - Browse run history (in-memory, LRU 32 server-side)
 *   - Review candidates of a selected run, accept/reject each
 */

import { useEffect, useState, useCallback } from 'react'
import { apiGet, apiPost } from '../../api/client.js'

interface DistillCandidate {
  id: string
  lesson: string
  rationale?: string
  tags: string[]
  supportingExperienceIds: string[]
  closestExistingLessonId?: string
  closestExistingLessonScore?: number
  isDuplicate: boolean
  status: 'pending' | 'accepted' | 'rejected'
  acceptedExperienceId?: string
}

interface DistillRun {
  id: string
  startedAt: string
  finishedAt?: string
  status: 'running' | 'completed' | 'failed'
  options: {
    maxInputs: number
    maxLessons: number
    minAdmissionScore: number
    duplicateThreshold: number
  }
  inputCount: number
  candidates: DistillCandidate[]
  error?: string
}

export default function DistillationPanel() {
  const [runs, setRuns] = useState<DistillRun[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)

  // Form state
  const [maxInputs, setMaxInputs] = useState(50)
  const [maxLessons, setMaxLessons] = useState(5)
  const [minAdmissionScore, setMinAdmissionScore] = useState(0.6)
  const [duplicateThreshold, setDuplicateThreshold] = useState(0.85)

  const refreshRuns = useCallback(async () => {
    try {
      const res = await apiGet<{ runs: DistillRun[] }>('/memory/distill/runs')
      setRuns(res.runs)
      if (!selectedId && res.runs.length > 0) {
        setSelectedId(res.runs[0].id)
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to load distill runs:', err)
    }
  }, [selectedId])

  useEffect(() => {
    void refreshRuns()
  }, [refreshRuns])

  const handleRun = async () => {
    setRunning(true)
    setRunError(null)
    try {
      const run = await apiPost<DistillRun>('/memory/distill', {
        maxInputs,
        maxLessons,
        minAdmissionScore,
        duplicateThreshold,
      })
      setSelectedId(run.id)
      await refreshRuns()
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const handleAccept = async (runId: string, candidateId: string) => {
    try {
      const res = await apiPost<{ run: DistillRun }>(
        `/memory/distill/runs/${runId}/candidates/${candidateId}/accept`,
      )
      setRuns((prev) => prev.map((r) => (r.id === runId ? res.run : r)))
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleReject = async (runId: string, candidateId: string) => {
    try {
      const res = await apiPost<{ run: DistillRun }>(
        `/memory/distill/runs/${runId}/candidates/${candidateId}/reject`,
      )
      setRuns((prev) => prev.map((r) => (r.id === runId ? res.run : r)))
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err))
    }
  }

  const selected = runs.find((r) => r.id === selectedId) ?? null

  return (
    <div className="space-y-6">
      {/* Trigger form */}
      <section className="bg-white rounded-xl border border-gray-200 p-4">
        <h3 className="text-sm font-semibold mb-3">Run distillation</h3>
        <p className="text-xs text-gray-500 mb-4">
          Distillation reads high-quality experiences from the active pool and asks the LLM to
          surface cross-cutting "lessons". Lessons are stored as Experiences tagged{' '}
          <code className="bg-gray-100 px-1 rounded">lesson</code> after you accept them.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <NumberField label="Max inputs" value={maxInputs} onChange={setMaxInputs} step={5} min={2} />
          <NumberField label="Max lessons" value={maxLessons} onChange={setMaxLessons} step={1} min={1} />
          <NumberField
            label="Min admission score"
            value={minAdmissionScore}
            onChange={setMinAdmissionScore}
            step={0.05}
            min={0}
            max={1}
          />
          <NumberField
            label="Dup threshold"
            value={duplicateThreshold}
            onChange={setDuplicateThreshold}
            step={0.05}
            min={0}
            max={1}
          />
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={handleRun}
            disabled={running}
            className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            {running ? 'Running…' : 'Distill now'}
          </button>
          {runError && <span className="text-xs text-red-600">{runError}</span>}
        </div>
      </section>

      {/* Run list + detail */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* History */}
        <div className="md:col-span-1">
          <h3 className="text-sm font-semibold mb-2">History ({runs.length})</h3>
          <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
            {runs.length === 0 && (
              <div className="text-xs text-gray-400 border border-dashed border-gray-200 rounded-lg p-3 text-center">
                No runs yet
              </div>
            )}
            {runs.map((run) => (
              <button
                key={run.id}
                onClick={() => setSelectedId(run.id)}
                className={`block w-full text-left rounded-lg border p-3 transition-colors ${
                  run.id === selectedId
                    ? 'border-blue-400 bg-blue-50'
                    : 'border-gray-200 hover:border-gray-300 bg-white'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-mono text-gray-500">{run.id}</span>
                  <RunStatusBadge status={run.status} />
                </div>
                <div className="text-xs text-gray-600">
                  {new Date(run.startedAt).toLocaleString()}
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  {run.inputCount} inputs → {run.candidates.length} candidates
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Detail */}
        <div className="md:col-span-2">
          <h3 className="text-sm font-semibold mb-2">Candidates</h3>
          {!selected && (
            <div className="text-xs text-gray-400 border border-dashed border-gray-200 rounded-lg p-6 text-center">
              Select a run to review candidates
            </div>
          )}
          {selected && selected.error && (
            <div className="text-xs text-red-600 border border-red-200 bg-red-50 rounded-lg p-3 mb-3">
              {selected.error}
            </div>
          )}
          {selected && selected.candidates.length === 0 && !selected.error && (
            <div className="text-xs text-gray-400 border border-dashed border-gray-200 rounded-lg p-6 text-center">
              No lessons proposed for this run
            </div>
          )}
          {selected && selected.candidates.length > 0 && (
            <div className="space-y-3">
              {selected.candidates.map((cand) => (
                <CandidateCard
                  key={cand.id}
                  cand={cand}
                  onAccept={() => handleAccept(selected.id, cand.id)}
                  onReject={() => handleReject(selected.id, cand.id)}
                />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function NumberField({
  label,
  value,
  onChange,
  step,
  min,
  max,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  step: number
  min?: number
  max?: number
}) {
  return (
    <label className="block">
      <span className="text-xs text-gray-500 block mb-1">{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (!Number.isNaN(n)) onChange(n)
        }}
        className="w-full border rounded-lg px-3 py-1.5 text-sm"
      />
    </label>
  )
}

function RunStatusBadge({ status }: { status: DistillRun['status'] }) {
  const styles: Record<DistillRun['status'], string> = {
    running: 'bg-yellow-100 text-yellow-800',
    completed: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-800',
  }
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded font-medium ${styles[status]}`}>
      {status}
    </span>
  )
}

function CandidateCard({
  cand,
  onAccept,
  onReject,
}: {
  cand: DistillCandidate
  onAccept: () => void
  onReject: () => void
}) {
  const statusStyles: Record<DistillCandidate['status'], string> = {
    pending: 'bg-gray-100 text-gray-700',
    accepted: 'bg-green-100 text-green-700',
    rejected: 'bg-red-100 text-red-700',
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium flex-1">{cand.lesson}</p>
        <span className={`text-[10px] px-2 py-0.5 rounded font-medium ${statusStyles[cand.status]}`}>
          {cand.status}
        </span>
      </div>

      {cand.rationale && (
        <p className="text-xs text-gray-500 mt-2 italic">{cand.rationale}</p>
      )}

      <div className="flex flex-wrap gap-1 mt-2">
        {cand.tags.map((t) => (
          <span key={t} className="bg-gray-100 text-gray-600 text-xs px-2 py-0.5 rounded">
            {t}
          </span>
        ))}
      </div>

      <div className="text-xs text-gray-500 mt-2">
        Supported by{' '}
        <span className="font-mono">{cand.supportingExperienceIds.length}</span> experiences:{' '}
        {cand.supportingExperienceIds.slice(0, 6).map((id, i) => (
          <span key={id}>
            {i > 0 && ', '}
            <code className="bg-gray-50 px-1 rounded">{id.slice(0, 8)}</code>
          </span>
        ))}
        {cand.supportingExperienceIds.length > 6 && ' …'}
      </div>

      {cand.isDuplicate && (
        <div className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          ⚠ Looks similar to existing lesson{' '}
          <code className="bg-white px-1 rounded">
            {cand.closestExistingLessonId?.slice(0, 8)}
          </code>{' '}
          (cosine {cand.closestExistingLessonScore?.toFixed(2)})
        </div>
      )}

      {cand.acceptedExperienceId && (
        <div className="mt-2 text-xs text-green-700">
          Saved as Experience{' '}
          <code className="bg-green-50 px-1 rounded">
            {cand.acceptedExperienceId.slice(0, 8)}
          </code>
        </div>
      )}

      {cand.status === 'pending' && (
        <div className="mt-3 flex gap-2">
          <button
            onClick={onAccept}
            className="bg-green-600 hover:bg-green-700 text-white text-xs font-medium px-3 py-1.5 rounded-lg"
          >
            Accept
          </button>
          <button
            onClick={onReject}
            className="bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-medium px-3 py-1.5 rounded-lg"
          >
            Reject
          </button>
        </div>
      )}
    </div>
  )
}
