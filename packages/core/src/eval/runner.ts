import { SessionManager } from '../session/manager.js'
import type { LLMProvider, ProviderConfig, PresetName } from '../llm/provider.js'
import type { AgentEvent, ExecutionStep } from '../types.js'
import type { PromptRegistry } from '../prompts/registry.js'

import { evaluateCriterion } from './judges.js'
import type {
  EvalCase,
  EvalCaseResult,
  EvalCriterion,
  EvalReport,
} from './types.js'

export interface EvalRunnerDeps {
  /** Same `dataPath` the Agent/SessionManager uses. */
  dataPath: string
  /** Optional explicit provider config. */
  provider?: ProviderConfig | PresetName
  /**
   * Optional shared PromptRegistry. When provided, the runner forwards it
   * into its internal SessionManager so the Agents that grade cases see
   * any active overrides — including transient ones installed by the
   * `PromptOptimizer` sandbox loop. Without this, eval would always run
   * against source-code baselines and the optimizer could not measure
   * candidate prompts.
   */
  promptRegistry?: PromptRegistry
}

export interface EvalRunOptions {
  onProgress?: (index: number, total: number, current: EvalCase) => void
}

const DEFAULT_CASE_TIMEOUT_MS = 120_000

/**
 * Runs a set of eval cases through a fresh SessionManager-backed Agent and
 * returns an aggregate `EvalReport`. One throwaway session per case so memory
 * and conversation state never bleed across cases.
 */
export class EvalRunner {
  private deps: EvalRunnerDeps
  private manager: SessionManager | null = null
  private sharedLlm: LLMProvider | null = null

  constructor(deps: EvalRunnerDeps) {
    this.deps = deps
  }

  async run(cases: EvalCase[], options: EvalRunOptions = {}): Promise<EvalReport> {
    const startedAt = Date.now()

    this.manager = new SessionManager({
      dataPath: this.deps.dataPath,
      provider: this.deps.provider,
      // Disable the process-wide cache-health cron hook for eval runs —
      // we don't need background noise during a capability sweep.
      cacheHealthAlert: { enabled: false },
      // Forward the optimizer-owned PromptRegistry so transient overrides
      // installed in the sandbox propagate to the inner Agents.
      shared: this.deps.promptRegistry
        ? { promptRegistry: this.deps.promptRegistry }
        : undefined,
    })
    await this.manager.init()

    const results: EvalCaseResult[] = []
    try {
      for (let i = 0; i < cases.length; i++) {
        const current = cases[i]
        if (!current) continue
        options.onProgress?.(i, cases.length, current)
        const result = await this.runOne(current)
        results.push(result)
      }
    } finally {
      await this.manager.shutdown()
      this.manager = null
    }

    const finishedAt = Date.now()
    return aggregate(results, startedAt, finishedAt)
  }

  private async runOne(evalCase: EvalCase): Promise<EvalCaseResult> {
    if (!this.manager) {
      throw new Error('EvalRunner.runOne called before init')
    }
    const manager = this.manager
    const timeoutMs = evalCase.timeoutMs ?? DEFAULT_CASE_TIMEOUT_MS
    const toolCalls: string[] = []
    const caseStart = Date.now()

    const session = await manager.create({ title: `eval:${evalCase.id}` })
    if (!this.sharedLlm) {
      this.sharedLlm = session.agent.getLLMProvider()
    }

    // Capture tool names by listening on the Agent's event stream. The Agent
    // emits `tool-result` events whose `data` is an ExecutionStep carrying
    // the executed tool name (including `skill:*` steps). We also accept the
    // `error` event emitted for failed steps so the harness still records
    // which tool was attempted even when it failed.
    session.agent.onEvent((event: AgentEvent) => {
      if (event.type !== 'tool-result' && event.type !== 'error') return
      const step = event.data as ExecutionStep | undefined
      if (step && typeof step === 'object' && typeof step.tool === 'string' && step.tool) {
        toolCalls.push(step.tool)
      }
    })

    const tokensBefore = sumTokens(session.agent.getMetrics())
    const cacheReadBefore = sumCacheRead(session.agent.getMetrics())

    let output = ''
    let error: string | undefined
    try {
      output = await withTimeout(
        session.sendMessage(evalCase.input),
        timeoutMs,
        `case "${evalCase.id}" exceeded timeout of ${timeoutMs}ms`,
      )
    } catch (err) {
      error = (err as Error).message
    }

    const tokensAfter = sumTokens(session.agent.getMetrics())
    const cacheReadAfter = sumCacheRead(session.agent.getMetrics())
    const tokensUsed = Math.max(0, tokensAfter - tokensBefore)
    const cacheReadTokens = Math.max(0, cacheReadAfter - cacheReadBefore)

    // Always clean up the throwaway session so eval state stays hermetic.
    try {
      await manager.delete(session.metadata.id)
    } catch {
      // Best-effort cleanup.
    }

    if (error) {
      return {
        caseId: evalCase.id,
        title: evalCase.title,
        outcome: 'error',
        durationMs: Date.now() - caseStart,
        tokensUsed,
        cacheReadTokens,
        output,
        criteriaResults: [],
        error,
      }
    }

    const llm = this.getLlm()
    const criteriaResults: Array<{
      criterion: EvalCriterion
      pass: boolean
      detail?: string
    }> = []
    for (const criterion of evalCase.criteria) {
      const verdict = await evaluateCriterion(criterion, {
        output,
        toolCalls,
        llm,
      })
      criteriaResults.push({ criterion, pass: verdict.pass, detail: verdict.detail })
    }

    const passCount = criteriaResults.filter((r) => r.pass).length
    const total = criteriaResults.length
    let outcome: EvalCaseResult['outcome']
    if (passCount === total) outcome = 'pass'
    else if (passCount === 0) outcome = 'fail'
    else outcome = 'partial'

    return {
      caseId: evalCase.id,
      title: evalCase.title,
      outcome,
      durationMs: Date.now() - caseStart,
      tokensUsed,
      cacheReadTokens,
      output,
      criteriaResults,
    }
  }

  /** The shared LLMProvider used for llm-judge criteria, captured on first case. */
  private getLlm(): LLMProvider {
    if (!this.sharedLlm) {
      throw new Error('EvalRunner: LLMProvider not yet captured — runOne must execute first')
    }
    return this.sharedLlm
  }
}

function sumTokens(metrics: ReadonlyArray<{ tokens: { prompt: number; completion: number; cacheRead: number; cacheWrite: number } }>): number {
  let total = 0
  for (const m of metrics) {
    total += m.tokens.prompt + m.tokens.completion + m.tokens.cacheRead + m.tokens.cacheWrite
  }
  return total
}

function sumCacheRead(metrics: ReadonlyArray<{ tokens: { cacheRead: number } }>): number {
  let total = 0
  for (const m of metrics) total += m.tokens.cacheRead
  return total
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race<T>([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
        if (timer && typeof timer.unref === 'function') timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function aggregate(
  results: EvalCaseResult[],
  startedAt: number,
  finishedAt: number,
): EvalReport {
  let passed = 0
  let partial = 0
  let failed = 0
  let errored = 0
  let totalTokens = 0
  let totalCacheReadTokens = 0
  let totalDurationMs = 0
  for (const r of results) {
    if (r.outcome === 'pass') passed++
    else if (r.outcome === 'partial') partial++
    else if (r.outcome === 'fail') failed++
    else errored++
    totalTokens += r.tokensUsed
    totalCacheReadTokens += r.cacheReadTokens
    totalDurationMs += r.durationMs
  }
  const denom = results.length || 1
  const passRate = passed / denom
  return {
    startedAt,
    finishedAt,
    totalCases: results.length,
    passed,
    partial,
    failed,
    errored,
    passRate,
    totalTokens,
    totalCacheReadTokens,
    totalDurationMs,
    cases: results,
  }
}
