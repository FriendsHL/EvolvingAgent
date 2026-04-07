/**
 * Adapter that wraps EvalRunner as the optimizer's `EvaluateFn`.
 *
 * The optimizer needs a synchronous-shaped `(cases) => Promise<EvalReport>`
 * but EvalRunner has setup/teardown of an internal SessionManager per call.
 * We give the runner the optimizer-owned PromptRegistry so transient
 * overrides installed by `withTransient()` propagate down to the inner
 * Agents that grade each case.
 */

import { EvalRunner } from '../eval/runner.js'
import type { ProviderConfig, PresetName } from '../llm/provider.js'
import type { EvalCase, EvalReport } from '../eval/types.js'
import type { EvaluateFn } from './optimizer.js'
import type { PromptRegistry } from './registry.js'

export interface EvalAdapterOptions {
  dataPath: string
  promptRegistry: PromptRegistry
  provider?: ProviderConfig | PresetName
}

/**
 * Build an `EvaluateFn` backed by a fresh EvalRunner per call. Each call
 * spins up a throwaway SessionManager bound to the supplied registry, runs
 * the cases, tears down. Heavy but hermetic — no state bleeds between
 * baseline measurement and candidate evaluation.
 */
export function createEvalAdapter(options: EvalAdapterOptions): EvaluateFn {
  return async (cases: EvalCase[]): Promise<EvalReport> => {
    const runner = new EvalRunner({
      dataPath: options.dataPath,
      provider: options.provider,
      promptRegistry: options.promptRegistry,
    })
    return runner.run(cases)
  }
}
