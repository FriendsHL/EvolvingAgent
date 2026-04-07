import type { LLMProvider } from '../llm/provider.js'
import type { EvalCriterion } from './types.js'

export interface CriterionContext {
  output: string
  toolCalls: string[]
  llm: LLMProvider
}

export interface CriterionVerdict {
  pass: boolean
  detail?: string
}

/**
 * Evaluate a single criterion against an agent's output. Never throws —
 * internal failures become `{ pass: false, detail: 'error: ...' }` so a
 * single bad criterion cannot take down the whole case.
 */
export async function evaluateCriterion(
  criterion: EvalCriterion,
  context: CriterionContext,
): Promise<CriterionVerdict> {
  try {
    switch (criterion.type) {
      case 'contains': {
        const sensitive = criterion.caseSensitive ?? false
        const hay = sensitive ? context.output : context.output.toLowerCase()
        const needle = sensitive ? criterion.substring : criterion.substring.toLowerCase()
        const found = hay.includes(needle)
        return {
          pass: found,
          detail: found ? undefined : `missing substring "${criterion.substring}"`,
        }
      }
      case 'not-contains': {
        const found = context.output.toLowerCase().includes(criterion.substring.toLowerCase())
        return {
          pass: !found,
          detail: found ? `unexpected substring "${criterion.substring}"` : undefined,
        }
      }
      case 'regex': {
        const re = new RegExp(criterion.pattern, criterion.flags)
        const match = re.test(context.output)
        return {
          pass: match,
          detail: match ? undefined : `regex /${criterion.pattern}/${criterion.flags ?? ''} did not match`,
        }
      }
      case 'tool-called': {
        const found = context.toolCalls.includes(criterion.tool)
        return {
          pass: found,
          detail: found ? undefined : `tool "${criterion.tool}" was not called (called: [${context.toolCalls.join(', ')}])`,
        }
      }
      case 'tool-not-called': {
        const found = context.toolCalls.includes(criterion.tool)
        return {
          pass: !found,
          detail: found ? `tool "${criterion.tool}" was unexpectedly called` : undefined,
        }
      }
      case 'json-shape': {
        const extracted = extractJsonObject(context.output)
        if (!extracted) {
          return { pass: false, detail: 'no JSON object found in output' }
        }
        const missing = criterion.requiredKeys.filter((k) => !(k in extracted))
        if (missing.length > 0) {
          return { pass: false, detail: `missing keys: ${missing.join(', ')}` }
        }
        return { pass: true }
      }
      case 'llm-judge': {
        const threshold = criterion.passThreshold ?? 0.7
        const judgment = await runLlmJudge(criterion.rubric, context.output, context.llm)
        return {
          pass: judgment.score >= threshold,
          detail: `score=${judgment.score.toFixed(2)} (threshold=${threshold.toFixed(2)}): ${judgment.reason}`,
        }
      }
    }
  } catch (err) {
    return { pass: false, detail: `error: ${(err as Error).message}` }
  }
}

/**
 * Extract the first balanced JSON object from a string. Tolerant of
 * surrounding prose and ```json fences.
 */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\') {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        const candidate = text.slice(start, i + 1)
        try {
          const parsed = JSON.parse(candidate)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>
          }
          return null
        } catch {
          return null
        }
      }
    }
  }
  return null
}

interface LlmJudgment {
  pass: boolean
  score: number
  reason: string
}

async function runLlmJudge(
  rubric: string,
  output: string,
  llm: LLMProvider,
): Promise<LlmJudgment> {
  const prompt = `You are an impartial evaluator. Given the rubric below, judge the provided output.

Rubric:
${rubric}

Output to judge:
${output}

Respond with ONLY a JSON object of the form:
{"pass": boolean, "score": number between 0 and 1, "reason": "short explanation"}`

  const result = await llm.generate('reflector', [
    { role: 'user', content: prompt },
  ])

  const parsed = extractJsonObject(result.text)
  if (!parsed) {
    throw new Error(`llm-judge response was not JSON: ${result.text.slice(0, 200)}`)
  }
  const score = typeof parsed.score === 'number' ? parsed.score : 0
  const pass = typeof parsed.pass === 'boolean' ? parsed.pass : score >= 0.7
  const reason = typeof parsed.reason === 'string' ? parsed.reason : ''
  return { pass, score, reason }
}
