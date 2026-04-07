/**
 * LLM-backed `DistillFn` factory. Mirrors `prompts/propose-llm.ts` style:
 * one meta system prompt, tolerant JSON parsing, single LLM call per run.
 */

import type { LLMProvider } from '../llm/provider.js'
import type { Experience } from '../types.js'
import type { DistillFn, DistillProposal } from './types.js'

const META_SYSTEM_PROMPT = `You are an experience-distillation assistant for an evolving AI Agent.

You will receive:
1. A list of past experiences the agent has accumulated, each with an id, task description, outcome, and reflection notes.
2. A target maximum number of "lessons" to extract.

Your job: identify cross-cutting RULES OF THUMB the agent should remember beyond any single task. A good lesson:
- Is supported by AT LEAST 2 of the listed experiences (cite their ids).
- Is concrete and actionable, not vague (e.g. "verify the file exists before editing" not "be careful").
- Generalizes — does NOT repeat content already obvious from the existing experience.
- Is short — one to two sentences.

Respond with a JSON array only, no markdown fences:
[
  {
    "lesson": "the rule of thumb",
    "rationale": "1-sentence reason this generalizes",
    "tags": ["topic1", "topic2"],
    "supportingExperienceIds": ["id1", "id2", ...]
  },
  ...
]

Constraints:
- Never invent experience ids — only use ids that appear in the input.
- If you cannot find at least one well-supported lesson, return an empty array [].
- Do NOT exceed the target lesson count.`

export interface ProposeLLMDistillerOptions {
  llm: LLMProvider
}

export function createLLMDistiller(options: ProposeLLMDistillerOptions): DistillFn {
  const { llm } = options

  return async ({ experiences, maxLessons }) => {
    if (experiences.length < 2 || maxLessons <= 0) return []

    const userInput = buildUserMessage(experiences, maxLessons)
    const messages = llm.buildMessages({
      systemPrompt: META_SYSTEM_PROMPT,
      skills: [],
      history: [],
      experiences: [],
      currentInput: userInput,
      provider: llm.getProviderType(),
    })

    try {
      const result = await llm.generate('reflector', messages)
      return parseProposals(result.text)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[propose-llm-distill] generation failed:', err)
      return []
    }
  }
}

function buildUserMessage(experiences: Experience[], maxLessons: number): string {
  const summaries = experiences
    .map((e) => {
      const tags = e.tags.length > 0 ? ` [${e.tags.join(', ')}]` : ''
      const lessonNote = e.reflection?.lesson ? `\n   Lesson note: ${truncate(e.reflection.lesson, 200)}` : ''
      return `- id: ${e.id}${tags}\n   Task: ${truncate(e.task, 200)}\n   Result: ${e.result}${lessonNote}`
    })
    .join('\n')

  return [
    `Target max lessons: ${maxLessons}`,
    '',
    'Experiences:',
    summaries,
    '',
    'Return the JSON array as specified in the system message.',
  ].join('\n')
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…'
}

/**
 * Tolerant JSON-array extractor. Accepts raw JSON, ```json fenced blocks,
 * and partial responses with surrounding prose. Returns [] on failure.
 */
export function parseProposals(text: string): DistillProposal[] {
  let body = text.trim()
  const fenceMatch = body.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (fenceMatch) body = fenceMatch[1].trim()

  // If JSON.parse fails, try to recover the first [...] block in the body.
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    const arrayMatch = body.match(/\[[\s\S]*\]/)
    if (!arrayMatch) return []
    try {
      parsed = JSON.parse(arrayMatch[0])
    } catch {
      return []
    }
  }

  if (!Array.isArray(parsed)) return []

  const out: DistillProposal[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const lesson = typeof obj.lesson === 'string' ? obj.lesson.trim() : ''
    if (!lesson) continue
    const supportingExperienceIds = Array.isArray(obj.supportingExperienceIds)
      ? obj.supportingExperienceIds.filter((x): x is string => typeof x === 'string')
      : []
    const tags = Array.isArray(obj.tags)
      ? obj.tags.filter((x): x is string => typeof x === 'string')
      : []
    out.push({
      lesson,
      rationale: typeof obj.rationale === 'string' ? obj.rationale : undefined,
      tags,
      supportingExperienceIds,
    })
  }
  return out
}
