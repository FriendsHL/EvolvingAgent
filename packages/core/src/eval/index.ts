// Eval framework — Phase 3 Batch 5.
// Capability assessments (NOT unit tests): load cases, run them through the
// Agent, judge outputs, aggregate a pass-rate report. Phase 4 will consume
// this for self-improvement loops.

export { EvalRunner } from './runner.js'
export type { EvalRunnerDeps, EvalRunOptions } from './runner.js'

export { loadEvalCases } from './loader.js'

export { evaluateCriterion } from './judges.js'
export type { CriterionContext, CriterionVerdict } from './judges.js'

export type {
  EvalCase,
  EvalCriterion,
  EvalCaseResult,
  EvalReport,
} from './types.js'
