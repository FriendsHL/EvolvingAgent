/**
 * Phase 5 S1 prework probe.
 *
 * Asks bailian-coding (or whichever provider env is set) to use a tool with
 * an enum-typed parameter, then prints the resulting toolCalls. The output
 * decides Router implementation strategy:
 *
 *   ✅ toolCalls non-empty AND args.subagent_type ∈ enum
 *      → use function calling. Strongest guarantee.
 *
 *   ⚠️ toolCalls non-empty BUT args.subagent_type ∉ enum
 *      → provider passes the schema but the model doesn't honor it.
 *      Fall back to JSON output mode + zod validation + LLM-as-fixer retry.
 *
 *   ❌ toolCalls empty (only result.text returned)
 *      → provider doesn't support tools at all on this endpoint.
 *      JSON output mode is mandatory.
 *
 * Run via:
 *   pnpm --filter @evolving-agent/core exec tsx src/sub-agents/probe.ts
 *
 * NOT a test. Hand-run before opening any S1 router code. Output is appended
 * to data/phase5-probe.log so the result is durable.
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { tool } from 'ai'
import { z } from 'zod'
import { LLMProvider } from '../llm/provider.js'

async function main() {
  // Load .env from likely locations so the probe matches the dev server's
  // EVOLVING_AGENT_PROVIDER + DASHSCOPE_API_KEY config without needing the
  // user to source it manually. Node 20.6+ ships loadEnvFile.
  for (const candidate of [
    join(process.cwd(), '.env'),
    join(process.cwd(), '..', '..', '.env'),  // packages/core → repo root
    join(process.cwd(), '..', '..', 'packages', 'web', '.env'),
  ]) {
    if (existsSync(candidate)) {
      try {
        ;(process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(candidate)
        console.log(`probe: loaded env from ${candidate}`)
        break
      } catch {
        // try next
      }
    }
  }

  const llm = LLMProvider.fromEnv()
  const provider = llm.getProviderType()
  const plannerModel = llm.getModelId('planner')
  console.log(`probe: provider=${provider} planner=${plannerModel}`)

  const tools = {
    delegate: tool({
      description:
        'Delegate the user task to one specialist sub-agent. Pick the single best target. ' +
        'Do not answer the user yourself in this turn — only call this tool.',
      inputSchema: z.object({
        subagent_type: z.enum(['research', 'code', 'analysis']),
        task: z.string().describe('Self-contained instruction to hand to the chosen specialist'),
        rationale: z.string().describe('One-sentence reason for the choice'),
      }),
      // No execute() — we want the call to come back as a toolCall, not be auto-run.
    }),
  }

  const messages = llm.buildMessages({
    systemPrompt:
      'You are a router. You have ONE tool called delegate that picks a specialist sub-agent. ' +
      'You must call delegate exactly once. Available subagent_type values: research, code, analysis. ' +
      "Don't answer in plain text.",
    skills: [],
    history: [],
    experiences: [],
    currentInput:
      "I'm looking at https://en.wikipedia.org/wiki/Playwright_(software) and want to know what Playwright is.",
    provider,
  })

  const startedAt = Date.now()
  let result
  let error: string | undefined
  try {
    result = await llm.generate('planner', messages, tools)
  } catch (err) {
    error = (err as Error).message
  }
  const durationMs = Date.now() - startedAt

  // Decide verdict
  let verdict: 'function-calling-strict' | 'function-calling-loose' | 'json-only' | 'error'
  let verdictReason: string
  const validEnum = ['research', 'code', 'analysis']

  if (error) {
    verdict = 'error'
    verdictReason = `LLM call threw: ${error}`
  } else if (!result || result.toolCalls.length === 0) {
    verdict = 'json-only'
    verdictReason =
      'No toolCalls in response. Provider/model does not support tool calling on this endpoint, OR ignored the tool entirely. Router must use JSON output mode.'
  } else {
    const call = result.toolCalls[0]
    const target = (call.args as Record<string, unknown>)?.subagent_type
    if (typeof target === 'string' && validEnum.includes(target)) {
      verdict = 'function-calling-strict'
      verdictReason = `Tool call returned subagent_type="${target}", which is in the enum. Function calling honors enum constraints — Router can rely on it.`
    } else {
      verdict = 'function-calling-loose'
      verdictReason = `Tool call returned subagent_type=${JSON.stringify(target)}, which is NOT in the enum [${validEnum.join(', ')}]. Provider passes the schema but the model invents values. Router must validate every tool call result against the enum and retry / fall back to JSON output mode.`
    }
  }

  const log = {
    timestamp: new Date().toISOString(),
    provider,
    plannerModel,
    durationMs,
    error,
    verdict,
    verdictReason,
    rawText: result?.text ?? null,
    toolCalls: result?.toolCalls ?? null,
    metrics: result?.metrics ?? null,
  }

  console.log('\n========== PROBE RESULT ==========')
  console.log(`Verdict: ${verdict}`)
  console.log(`Why: ${verdictReason}`)
  console.log(`Duration: ${durationMs}ms`)
  if (result?.toolCalls?.length) {
    console.log(`toolCalls (${result.toolCalls.length}):`)
    for (const tc of result.toolCalls) {
      console.log(`  - ${tc.toolName}(${JSON.stringify(tc.args)})`)
    }
  }
  if (result?.text) console.log(`text: ${result.text.slice(0, 300)}`)
  if (error) console.log(`error: ${error}`)
  console.log('===================================\n')

  // Persist to data/phase5-probe.log so the verdict survives the session
  const dataDir = join(process.cwd(), 'data')
  await mkdir(dataDir, { recursive: true }).catch(() => {})
  const logPath = join(dataDir, 'phase5-probe.log')
  await writeFile(logPath, JSON.stringify(log, null, 2) + '\n', { flag: 'a' })
  console.log(`Result appended to ${logPath}`)
}

main().catch((err) => {
  console.error('Probe crashed:', err)
  process.exit(1)
})
