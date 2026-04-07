/**
 * Phase 4 C — Prompt self-optimization types.
 *
 * Three prompts are registered under stable ids. Source-code constants are
 * the *baseline*; active.json overrides are the self-optimization layer.
 */

export type PromptId = 'planner' | 'reflector' | 'conversational'

export const PROMPT_IDS: readonly PromptId[] = ['planner', 'reflector', 'conversational']

/**
 * One entry in `data/prompts/active.json`. When present, overrides the
 * source-code baseline for that prompt id.
 */
export interface PromptActiveEntry {
  /** The prompt text currently in effect. */
  content: string
  /** ISO timestamp when this became active. */
  acceptedAt: string
  /** Human-readable note (e.g. "accepted from run X", "rolled back to T"). */
  note?: string
  /** Eval pass rate at the time of acceptance, if known. */
  evalPassRate?: number
  /** Baseline pass rate the candidate was measured against, if known. */
  baselinePassRate?: number
}

/**
 * The full shape of `data/prompts/active.json`.
 */
export interface PromptActiveFile {
  prompts: Partial<Record<PromptId, PromptActiveEntry>>
}

/**
 * One history snapshot file. Each accept/rollback writes one of these under
 * `data/prompts/history/<iso>-<id>.md` (markdown body) with yaml frontmatter.
 */
export interface PromptHistoryEntry {
  id: PromptId
  timestamp: string
  action: 'accept' | 'rollback' | 'init'
  content: string
  note?: string
  evalPassRate?: number
  baselinePassRate?: number
}

/**
 * A prompt candidate produced by the optimizer. Not yet accepted.
 */
export interface PromptCandidate {
  id: string
  targetId: PromptId
  content: string
  /** Which source strategy produced this ('llm-selfgen' / 'reflection-distill' / ...) */
  source: string
  generatedAt: string
}

/**
 * Result of evaluating a candidate in the sandbox.
 */
export interface PromptCandidateEvaluation {
  candidate: PromptCandidate
  passRate: number
  totalCases: number
  passed: number
  regressed: string[] // case ids that baseline passed but candidate failed
  improved: string[] // case ids that baseline failed but candidate passed
  durationMs: number
  totalTokens: number
}

/**
 * Result of `PromptOptimizer.gate()` — which candidates cleared the bar.
 */
export interface GateResult {
  baseline: {
    passRate: number
    passed: number
    totalCases: number
  }
  accepted: PromptCandidateEvaluation[]
  rejected: Array<{
    evaluation: PromptCandidateEvaluation
    reason: 'not-better' | 'regression'
  }>
}

/**
 * A full optimization run (propose → evaluate → gate). Persisted so the UI
 * can display historical runs and let the user pick which candidate to accept.
 */
export interface OptimizationRun {
  id: string
  targetId: PromptId
  startedAt: string
  finishedAt?: string
  status: 'running' | 'completed' | 'failed'
  candidateCount: number
  gateResult?: GateResult
  error?: string
}
