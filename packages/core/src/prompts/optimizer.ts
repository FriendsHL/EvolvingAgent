/**
 * Phase 4 C — PromptOptimizer.
 *
 * DSPy-style sandbox gate for prompt self-optimization:
 *   propose → evaluate → gate → (human accepts) → registry.set()
 *
 * Stage 1 scope: the core logic is isolated from the real EvalRunner / LLM
 * through injectable dependencies (`evaluateFn`, `proposeFn`). This keeps
 * the unit tests fast and deterministic. Stage 2 wires the real eval runner
 * and real LLM candidate generation.
 */

import { nanoid } from 'nanoid'
import type { EvalCase, EvalReport } from '../eval/types.js'
import type { PromptRegistry } from './registry.js'
import type {
  GateResult,
  OptimizationRun,
  PromptCandidate,
  PromptCandidateEvaluation,
  PromptId,
} from './types.js'

/**
 * Produces candidate prompt variants for a target id. The production impl
 * uses an LLM; tests inject a fake that returns pre-baked strings.
 */
export type ProposeFn = (input: {
  targetId: PromptId
  currentPrompt: string
  failingCases: EvalCase[]
  count: number
}) => Promise<PromptCandidate[]>

/**
 * Runs the eval sweep against the currently-active prompt set. The
 * optimizer calls this inside `registry.withTransient()` so the candidate
 * is the one in effect during the call. Production impl is backed by
 * `EvalRunner`; tests inject a fake that returns synthetic reports.
 */
export type EvaluateFn = (cases: EvalCase[]) => Promise<EvalReport>

export interface PromptOptimizerOptions {
  registry: PromptRegistry
  propose: ProposeFn
  evaluate: EvaluateFn
  /**
   * Eval cases to use for scoring. A subset of the full eval suite is
   * recommended for fast iteration.
   */
  cases: EvalCase[]
  /** Default candidate count when `optimize` is called without one. */
  defaultCandidateCount?: number
}

export class PromptOptimizer {
  private registry: PromptRegistry
  private proposeFn: ProposeFn
  private evaluateFn: EvaluateFn
  private cases: EvalCase[]
  private defaultCandidateCount: number

  constructor(options: PromptOptimizerOptions) {
    this.registry = options.registry
    this.proposeFn = options.propose
    this.evaluateFn = options.evaluate
    this.cases = options.cases
    this.defaultCandidateCount = options.defaultCandidateCount ?? 3
  }

  /**
   * Full optimization run: baseline measurement → candidate generation →
   * per-candidate evaluation under transient override → gate filtering →
   * return the run with its gate result.
   *
   * Does NOT accept any candidate — that's a separate explicit call the UI
   * makes after the human approves.
   */
  async optimize(targetId: PromptId, count?: number): Promise<OptimizationRun> {
    const run: OptimizationRun = {
      id: nanoid(10),
      targetId,
      startedAt: new Date().toISOString(),
      status: 'running',
      candidateCount: count ?? this.defaultCandidateCount,
    }

    try {
      // 1. Measure baseline. Current registry state (with any pre-existing
      // active override) is the baseline the candidate must beat.
      const baselineReport = await this.evaluateFn(this.cases)
      const baselinePassIds = new Set(
        baselineReport.cases.filter((c) => c.outcome === 'pass').map((c) => c.caseId),
      )

      // 2. Collect failing cases for the propose step — LLM uses these as
      // hints about what the current prompt is missing.
      const failingCases = this.cases.filter((c) => {
        const r = baselineReport.cases.find((x) => x.caseId === c.id)
        return r && r.outcome !== 'pass'
      })

      // 3. Ask the proposer for candidates.
      const currentPrompt = this.registry.get(targetId)
      const candidates = await this.proposeFn({
        targetId,
        currentPrompt,
        failingCases,
        count: run.candidateCount,
      })

      // 4. Evaluate each candidate under a transient override so concurrent
      // traffic would see the *current* prompt, not the candidate. (Stage 1
      // runs these sequentially — parallelism would race the transient slot.)
      const evaluations: PromptCandidateEvaluation[] = []
      for (const candidate of candidates) {
        const evaluation = await this.evaluateCandidate(candidate, baselinePassIds)
        evaluations.push(evaluation)
      }

      // 5. Gate: strictly-better-than-baseline AND no regression on cases
      // that baseline passed.
      run.gateResult = this.gate(baselineReport, evaluations)
      run.status = 'completed'
      run.finishedAt = new Date().toISOString()
      return run
    } catch (err) {
      run.status = 'failed'
      run.error = (err as Error).message
      run.finishedAt = new Date().toISOString()
      return run
    }
  }

  /**
   * Evaluate a single candidate under a transient override. Exposed so
   * tests can drive one candidate at a time.
   */
  async evaluateCandidate(
    candidate: PromptCandidate,
    baselinePassIds: Set<string>,
  ): Promise<PromptCandidateEvaluation> {
    return this.registry.withTransient(candidate.targetId, candidate.content, async () => {
      const report = await this.evaluateFn(this.cases)
      const improved: string[] = []
      const regressed: string[] = []
      for (const r of report.cases) {
        const baselinePassed = baselinePassIds.has(r.caseId)
        const candidatePassed = r.outcome === 'pass'
        if (candidatePassed && !baselinePassed) improved.push(r.caseId)
        if (!candidatePassed && baselinePassed) regressed.push(r.caseId)
      }
      return {
        candidate,
        passRate: report.passRate,
        totalCases: report.totalCases,
        passed: report.passed,
        improved,
        regressed,
        durationMs: report.totalDurationMs,
        totalTokens: report.totalTokens,
      }
    })
  }

  /**
   * Gate logic: a candidate is accepted iff
   *   1) its pass rate is STRICTLY greater than baseline (no ties), AND
   *   2) it does not regress any case that baseline passed
   *
   * Ties are rejected on purpose — same score = no reason to switch, and
   * the eval set is noisy enough that a tie-break would amplify noise.
   */
  gate(
    baselineReport: EvalReport,
    evaluations: PromptCandidateEvaluation[],
  ): GateResult {
    const baseline = {
      passRate: baselineReport.passRate,
      passed: baselineReport.passed,
      totalCases: baselineReport.totalCases,
    }
    const accepted: PromptCandidateEvaluation[] = []
    const rejected: GateResult['rejected'] = []
    for (const ev of evaluations) {
      if (ev.regressed.length > 0) {
        rejected.push({ evaluation: ev, reason: 'regression' })
        continue
      }
      if (ev.passRate > baseline.passRate) {
        accepted.push(ev)
      } else {
        rejected.push({ evaluation: ev, reason: 'not-better' })
      }
    }
    // Sort accepted best-first.
    accepted.sort((a, b) => b.passRate - a.passRate)
    return { baseline, accepted, rejected }
  }
}
