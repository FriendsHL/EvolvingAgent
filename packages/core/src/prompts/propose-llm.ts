/**
 * LLM-backed candidate proposer for the prompt optimizer.
 *
 * Given the current prompt and a list of failing eval cases, asks an LLM to
 * write `count` improved variants. The proposer is intentionally
 * conservative — it instructs the LLM to keep the original prompt's
 * structure and constraints, only revising the parts that plausibly caused
 * the listed failures.
 */

import { nanoid } from 'nanoid'
import type { LLMProvider } from '../llm/provider.js'
import type { EvalCase, EvalCriterion } from '../eval/types.js'
import type { ProposeFn } from './optimizer.js'
import type { PromptCandidate, PromptId } from './types.js'

const META_SYSTEM_PROMPT = `You are a prompt engineer assisting with automated self-optimization of an AI Agent system.

You will be given:
1. The id of an internal prompt slot (planner / reflector / conversational)
2. The current prompt text
3. A list of eval cases the current prompt is failing

Your job: produce ONE revised prompt that is likely to fix the failures while preserving every existing instruction, constraint, and output format. Do NOT introduce new tools, new output schemas, or new placeholder tokens (e.g. {SKILLS_SECTION} must remain literal if present).

Respond with a JSON object only:
{
  "rationale": "1-2 sentence explanation of what you changed and why",
  "prompt": "the full revised prompt text"
}

Constraints:
- The revised prompt must be a complete drop-in replacement, not a diff or instructions
- Preserve all existing placeholder tokens like {SKILLS_SECTION} verbatim
- Do not invent capabilities the agent does not have
- Stay close to the original style and length — aim for surgical fixes, not rewrites`

interface ProposeLLMOptions {
  llm: LLMProvider
  /** How many sequential LLM calls to make per optimize() invocation. */
  // count is provided per-call by the optimizer.
}

export function createLLMProposer(options: ProposeLLMOptions): ProposeFn {
  const { llm } = options

  return async ({ targetId, currentPrompt, failingCases, count }) => {
    const candidates: PromptCandidate[] = []
    // Sequential calls so each candidate gets a fresh LLM context. Parallel
    // would also work but burns budget faster on a hot LLM provider.
    for (let i = 0; i < count; i++) {
      const userInput = buildUserMessage(targetId, currentPrompt, failingCases, i)
      const messages = llm.buildMessages({
        systemPrompt: META_SYSTEM_PROMPT,
        skills: [],
        history: [],
        experiences: [],
        currentInput: userInput,
        provider: llm.getProviderType(),
      })
      try {
        const result = await llm.generate('planner', messages)
        const parsed = parseJsonBlock(result.text)
        if (parsed && typeof parsed.prompt === 'string' && parsed.prompt.length > 0) {
          candidates.push({
            id: nanoid(10),
            targetId,
            content: parsed.prompt,
            source: 'llm-selfgen',
            generatedAt: new Date().toISOString(),
          })
        }
      } catch (err) {
        // One failed proposal call should not abort the whole batch.
        // The optimizer will simply have fewer candidates to grade.
        // eslint-disable-next-line no-console
        console.warn(`[propose-llm] candidate ${i} generation failed:`, err)
      }
    }
    return candidates
  }
}

/**
 * Build the user-side message for one proposal call. The variation index is
 * used to nudge the LLM to produce different rewrites across calls (instead
 * of N copies of the same suggestion).
 */
function buildUserMessage(
  targetId: PromptId,
  currentPrompt: string,
  failingCases: EvalCase[],
  variationIndex: number,
): string {
  const failingSummary = failingCases.length === 0
    ? '(No specific failing cases — improve clarity / specificity / robustness in general.)'
    : failingCases
        .slice(0, 6) // cap to keep token cost predictable
        .map((c, i) => `${i + 1}. [${c.id}] ${c.title}\n   Input: ${truncate(c.input, 200)}\n   Criteria: ${describeCriteria(c.criteria)}`)
        .join('\n\n')

  const variationHint = variationIndex === 0
    ? 'Focus on the smallest possible surgical edit that addresses the failures.'
    : variationIndex === 1
      ? 'Try a more substantial restructuring while still preserving all constraints.'
      : `Take a different angle than your previous attempts (variation #${variationIndex + 1}). Look for less obvious causes of the failures.`

  return [
    `Prompt slot: ${targetId}`,
    '',
    'Current prompt:',
    '"""',
    currentPrompt,
    '"""',
    '',
    'Failing eval cases:',
    failingSummary,
    '',
    `Strategy hint: ${variationHint}`,
    '',
    'Respond with the JSON object as specified.',
  ].join('\n')
}

function describeCriteria(criteria: EvalCriterion[]): string {
  return criteria
    .map((c) => {
      switch (c.type) {
        case 'contains':
          return `output contains "${c.substring}"`
        case 'not-contains':
          return `output does NOT contain "${c.substring}"`
        case 'regex':
          return `output matches /${c.pattern}/`
        case 'tool-called':
          return `tool "${c.tool}" was called`
        case 'tool-not-called':
          return `tool "${c.tool}" was NOT called`
        case 'llm-judge':
          return `judge: ${truncate(c.rubric, 100)}`
        case 'json-shape':
          return `output is JSON with keys ${c.requiredKeys.join(', ')}`
      }
    })
    .join('; ')
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…'
}

/**
 * Tolerant JSON extractor — accepts raw JSON, ```json fenced blocks, and
 * ``` fenced blocks. Returns null on any parse failure.
 */
function parseJsonBlock(text: string): { prompt: string; rationale?: string } | null {
  let body = text.trim()
  const fenceMatch = body.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (fenceMatch) body = fenceMatch[1].trim()
  try {
    const parsed = JSON.parse(body)
    if (parsed && typeof parsed === 'object' && typeof parsed.prompt === 'string') {
      return { prompt: parsed.prompt, rationale: parsed.rationale }
    }
  } catch {
    // fallthrough
  }
  return null
}
