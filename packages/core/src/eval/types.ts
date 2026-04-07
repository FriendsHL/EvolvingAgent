/**
 * Eval framework types — Phase 3 Batch 5.
 *
 * Eval cases are NOT unit tests. They are capability assessments: each case
 * describes an input to feed the Agent and one or more criteria to judge the
 * output against. Phase 4 will consume these to drive self-improvement loops.
 */

/**
 * One eval case. Loaded from JSON files under `data/eval/cases/`.
 */
export interface EvalCase {
  /** Stable id, also used as filename. */
  id: string
  /** Short title for the report. */
  title: string
  /** Tags for filtering ('reasoning', 'tool-use', 'memory', etc.) */
  tags: string[]
  /** The user input fed to the agent. */
  input: string
  /**
   * How to judge the agent's output. At least one criterion required.
   */
  criteria: EvalCriterion[]
  /** Optional setup hints — e.g. preload specific experiences. */
  setup?: { experiences?: string[] }
  /** Soft per-case timeout in ms. Default 120_000. */
  timeoutMs?: number
}

export type EvalCriterion =
  | { type: 'contains'; substring: string; caseSensitive?: boolean }
  | { type: 'regex'; pattern: string; flags?: string }
  | { type: 'not-contains'; substring: string }
  | { type: 'tool-called'; tool: string }
  | { type: 'tool-not-called'; tool: string }
  | { type: 'llm-judge'; rubric: string; passThreshold?: number /* 0..1 */ }
  | { type: 'json-shape'; requiredKeys: string[] }

export interface EvalCaseResult {
  caseId: string
  title: string
  outcome: 'pass' | 'partial' | 'fail' | 'error'
  durationMs: number
  tokensUsed: number
  cacheReadTokens: number
  output: string
  criteriaResults: Array<{
    criterion: EvalCriterion
    pass: boolean
    detail?: string
  }>
  error?: string
}

export interface EvalReport {
  startedAt: number
  finishedAt: number
  totalCases: number
  passed: number
  partial: number
  failed: number
  errored: number
  passRate: number
  totalTokens: number
  totalCacheReadTokens: number
  totalDurationMs: number
  cases: EvalCaseResult[]
}
