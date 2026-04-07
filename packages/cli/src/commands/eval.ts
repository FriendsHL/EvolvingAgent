import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'

import {
  EvalRunner,
  loadEvalCases,
  type EvalCase,
  type EvalCaseResult,
  type EvalReport,
} from '@evolving-agent/core'

export interface EvalRunOptions {
  filter?: string
  casesDir?: string
  output?: string
}

/**
 * `evolve eval run` — load eval cases, run them through a fresh Agent, print
 * a summary report, and optionally write the full report to a JSON file.
 */
export async function evalRunCommand(options: EvalRunOptions): Promise<void> {
  const cwd = process.cwd()
  const dataPath = resolve(cwd, 'data', 'memory')
  const casesDir = resolve(cwd, options.casesDir ?? 'data/eval/cases')

  const filterTags = options.filter
    ? options.filter
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    : undefined

  let cases: EvalCase[]
  try {
    cases = await loadEvalCases(casesDir, filterTags ? { tags: filterTags } : undefined)
  } catch (err) {
    console.error(`Failed to load eval cases: ${(err as Error).message}`)
    process.exitCode = 1
    return
  }

  if (cases.length === 0) {
    console.log(`No eval cases matched under ${casesDir}` + (filterTags ? ` (filter: ${filterTags.join(',')})` : ''))
    return
  }

  console.log(`Running ${cases.length} eval case${cases.length === 1 ? '' : 's'}...`)
  console.log('')

  const runner = new EvalRunner({ dataPath })

  const report: EvalReport = await runner.run(cases, {
    onProgress: (i, total, current) => {
      process.stdout.write(`[${i + 1}/${total}] ${current.id} ... `)
    },
  })

  // After each case finishes the runner does NOT directly notify us, so we
  // emit the verdict after the whole run by walking the report in order.
  // Progress started each case with `... `, so we complete the line here.
  printCaseVerdicts(report.cases)

  console.log('')
  printSummary(report)

  if (options.output) {
    const outPath = resolve(cwd, options.output)
    await writeFile(outPath, JSON.stringify(report, null, 2), 'utf-8')
    console.log(`\nReport written to ${outPath}`)
  }

  if (report.errored > 0 || report.failed > 0) {
    process.exitCode = 1
  }
}

function printCaseVerdicts(results: EvalCaseResult[]): void {
  // Since we streamed `[i/N] id ... ` from onProgress, we need a newline
  // before printing the results block. In practice the progress line for
  // the LAST case is incomplete, so just start a fresh block.
  if (results.length > 0) console.log('')
  for (const [i, r] of results.entries()) {
    const verdict = verdictLabel(r.outcome)
    console.log(`  [${i + 1}] ${r.caseId}  ${verdict}  (${r.durationMs}ms, ${r.tokensUsed} tokens)`)
    if (r.outcome !== 'pass') {
      for (const c of r.criteriaResults) {
        if (!c.pass) {
          console.log(`      - ${c.criterion.type}: ${c.detail ?? 'failed'}`)
        }
      }
      if (r.error) {
        console.log(`      ! error: ${r.error}`)
      }
    }
  }
}

function verdictLabel(outcome: EvalCaseResult['outcome']): string {
  switch (outcome) {
    case 'pass':
      return 'PASS'
    case 'partial':
      return 'PARTIAL'
    case 'fail':
      return 'FAIL'
    case 'error':
      return 'ERROR'
  }
}

function printSummary(report: EvalReport): void {
  const { totalCases, passed, partial, failed, errored, passRate, totalTokens, totalDurationMs } = report
  const avgLatencyMs = totalCases > 0 ? Math.round(totalDurationMs / totalCases) : 0
  console.log('=== Eval Summary ===')
  console.log(`  Total cases : ${totalCases}`)
  console.log(`  Passed      : ${passed}`)
  console.log(`  Partial     : ${partial}`)
  console.log(`  Failed      : ${failed}`)
  console.log(`  Errored     : ${errored}`)
  console.log(`  Pass rate   : ${(passRate * 100).toFixed(1)}%`)
  console.log(`  Total tokens: ${totalTokens}`)
  console.log(`  Avg latency : ${avgLatencyMs}ms`)
}
