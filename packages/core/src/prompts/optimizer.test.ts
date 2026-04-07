import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { PromptRegistry } from './registry.js'
import { PromptOptimizer } from './optimizer.js'
import type { EvalCase, EvalReport, EvalCaseResult } from '../eval/types.js'
import type { PromptCandidate, PromptId } from './types.js'

const DEFAULTS: Record<PromptId, string> = {
  planner: 'BASE_PLANNER',
  reflector: 'BASE_REFLECTOR',
  conversational: 'BASE_CONVO',
}

function makeCase(id: string): EvalCase {
  return {
    id,
    title: id,
    tags: [],
    input: 'noop',
    criteria: [{ type: 'contains', substring: 'ok' }],
  }
}

function makeResult(caseId: string, outcome: EvalCaseResult['outcome']): EvalCaseResult {
  return {
    caseId,
    title: caseId,
    outcome,
    durationMs: 1,
    tokensUsed: 10,
    cacheReadTokens: 0,
    output: 'out',
    criteriaResults: [],
  }
}

function makeReport(cases: EvalCaseResult[]): EvalReport {
  const passed = cases.filter((c) => c.outcome === 'pass').length
  const partial = cases.filter((c) => c.outcome === 'partial').length
  const failed = cases.filter((c) => c.outcome === 'fail').length
  const errored = cases.filter((c) => c.outcome === 'error').length
  return {
    startedAt: 0,
    finishedAt: 1,
    totalCases: cases.length,
    passed,
    partial,
    failed,
    errored,
    passRate: passed / Math.max(1, cases.length),
    totalTokens: 0,
    totalCacheReadTokens: 0,
    totalDurationMs: 0,
    cases,
  }
}

function makeCandidate(content: string, targetId: PromptId = 'planner'): PromptCandidate {
  return {
    id: `cand-${content}`,
    targetId,
    content,
    source: 'test',
    generatedAt: '2026-04-07T00:00:00.000Z',
  }
}

describe('PromptOptimizer', () => {
  let dataPath: string
  let registry: PromptRegistry

  beforeEach(async () => {
    dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-optimizer-'))
    registry = new PromptRegistry({ dataPath, defaults: DEFAULTS })
    await registry.init()
  })

  afterEach(async () => {
    await fs.rm(dataPath, { recursive: true, force: true })
  })

  describe('gate logic', () => {
    it('accepts candidates strictly better than baseline and with no regression', async () => {
      const cases = [makeCase('a'), makeCase('b'), makeCase('c')]
      const baseline = makeReport([
        makeResult('a', 'pass'),
        makeResult('b', 'fail'),
        makeResult('c', 'fail'),
      ])

      const optimizer = new PromptOptimizer({
        registry,
        propose: async () => [],
        evaluate: async () => baseline,
        cases,
      })

      const ev = {
        candidate: makeCandidate('X'),
        passRate: 2 / 3,
        totalCases: 3,
        passed: 2,
        improved: ['b'],
        regressed: [],
        durationMs: 0,
        totalTokens: 0,
      }
      const result = optimizer.gate(baseline, [ev])
      expect(result.accepted).toHaveLength(1)
      expect(result.rejected).toHaveLength(0)
    })

    it('rejects ties', async () => {
      const cases = [makeCase('a'), makeCase('b')]
      const baseline = makeReport([
        makeResult('a', 'pass'),
        makeResult('b', 'fail'),
      ])
      const optimizer = new PromptOptimizer({
        registry,
        propose: async () => [],
        evaluate: async () => baseline,
        cases,
      })
      const ev = {
        candidate: makeCandidate('X'),
        passRate: 0.5,
        totalCases: 2,
        passed: 1,
        improved: [],
        regressed: [],
        durationMs: 0,
        totalTokens: 0,
      }
      const result = optimizer.gate(baseline, [ev])
      expect(result.accepted).toHaveLength(0)
      expect(result.rejected[0].reason).toBe('not-better')
    })

    it('rejects candidates that regress any baseline-passing case', async () => {
      const cases = [makeCase('a'), makeCase('b'), makeCase('c')]
      const baseline = makeReport([
        makeResult('a', 'pass'),
        makeResult('b', 'pass'),
        makeResult('c', 'fail'),
      ])
      const optimizer = new PromptOptimizer({
        registry,
        propose: async () => [],
        evaluate: async () => baseline,
        cases,
      })
      // Candidate fixed 'c' but broke 'b' — regressed count > 0.
      const ev = {
        candidate: makeCandidate('X'),
        passRate: 2 / 3,
        totalCases: 3,
        passed: 2,
        improved: ['c'],
        regressed: ['b'],
        durationMs: 0,
        totalTokens: 0,
      }
      const result = optimizer.gate(baseline, [ev])
      expect(result.accepted).toHaveLength(0)
      expect(result.rejected[0].reason).toBe('regression')
    })

    it('sorts accepted candidates best-first', async () => {
      const cases = [makeCase('a')]
      const baseline = makeReport([makeResult('a', 'fail')])
      const optimizer = new PromptOptimizer({
        registry,
        propose: async () => [],
        evaluate: async () => baseline,
        cases,
      })
      const worse = {
        candidate: makeCandidate('WORSE'),
        passRate: 0.5,
        totalCases: 1,
        passed: 0,
        improved: [],
        regressed: [],
        durationMs: 0,
        totalTokens: 0,
      }
      const better = {
        candidate: makeCandidate('BETTER'),
        passRate: 1.0,
        totalCases: 1,
        passed: 1,
        improved: ['a'],
        regressed: [],
        durationMs: 0,
        totalTokens: 0,
      }
      const result = optimizer.gate(baseline, [worse, better])
      expect(result.accepted).toHaveLength(2)
      expect(result.accepted[0].candidate.content).toBe('BETTER')
      expect(result.accepted[1].candidate.content).toBe('WORSE')
    })
  })

  describe('evaluateCandidate', () => {
    it('installs the candidate as a transient override while the evaluator runs', async () => {
      const cases = [makeCase('a')]
      let seenPrompt = ''
      const evaluate = vi.fn(async () => {
        // Inside the eval we should see the candidate.
        seenPrompt = registry.get('planner')
        return makeReport([makeResult('a', 'pass')])
      })
      const optimizer = new PromptOptimizer({
        registry,
        propose: async () => [],
        evaluate,
        cases,
      })

      const candidate = makeCandidate('SANDBOX_PROMPT')
      await optimizer.evaluateCandidate(candidate, new Set())

      expect(seenPrompt).toBe('SANDBOX_PROMPT')
      // After eval, the transient should be cleared.
      expect(registry.get('planner')).toBe('BASE_PLANNER')
    })

    it('computes improved / regressed against the baseline pass set', async () => {
      const cases = [makeCase('a'), makeCase('b')]
      const evaluate = vi.fn(async () =>
        makeReport([
          makeResult('a', 'fail'), // was pass in baseline — regression
          makeResult('b', 'pass'), // was fail in baseline — improvement
        ]),
      )
      const optimizer = new PromptOptimizer({
        registry,
        propose: async () => [],
        evaluate,
        cases,
      })

      const baselinePass = new Set(['a']) // baseline passed a, failed b
      const candidate = makeCandidate('SANDBOX')
      const result = await optimizer.evaluateCandidate(candidate, baselinePass)

      expect(result.improved).toEqual(['b'])
      expect(result.regressed).toEqual(['a'])
      expect(result.passed).toBe(1)
    })
  })

  describe('optimize (end to end with mocks)', () => {
    it('runs baseline → propose → evaluate candidates → gate', async () => {
      const cases = [makeCase('a'), makeCase('b')]
      const baselineReport = makeReport([
        makeResult('a', 'pass'),
        makeResult('b', 'fail'),
      ])
      const candidateReport = makeReport([
        makeResult('a', 'pass'),
        makeResult('b', 'pass'),
      ])
      let evalCall = 0
      const evaluate = vi.fn(async () => {
        evalCall++
        // First call is baseline, subsequent are candidates.
        return evalCall === 1 ? baselineReport : candidateReport
      })
      const propose = vi.fn(async () => [makeCandidate('BETTER_PROMPT')])

      const optimizer = new PromptOptimizer({
        registry,
        propose,
        evaluate,
        cases,
        defaultCandidateCount: 1,
      })

      const run = await optimizer.optimize('planner')

      expect(run.status).toBe('completed')
      expect(run.gateResult).toBeDefined()
      expect(run.gateResult!.baseline.passRate).toBe(0.5)
      expect(run.gateResult!.accepted).toHaveLength(1)
      expect(run.gateResult!.accepted[0].candidate.content).toBe('BETTER_PROMPT')

      // propose must have been called with the failing cases.
      expect(propose).toHaveBeenCalledTimes(1)
      const proposeArg = propose.mock.calls[0][0]
      expect(proposeArg.failingCases.map((c) => c.id)).toEqual(['b'])
      expect(proposeArg.targetId).toBe('planner')
    })

    it('marks run as failed when propose throws', async () => {
      const cases = [makeCase('a')]
      const optimizer = new PromptOptimizer({
        registry,
        propose: async () => {
          throw new Error('llm went boom')
        },
        evaluate: async () => makeReport([makeResult('a', 'pass')]),
        cases,
      })
      const run = await optimizer.optimize('planner')
      expect(run.status).toBe('failed')
      expect(run.error).toContain('llm went boom')
    })
  })
})
