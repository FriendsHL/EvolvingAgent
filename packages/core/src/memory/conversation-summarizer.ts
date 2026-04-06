/**
 * ConversationSummarizer — uses an LLM to condense old conversation turns
 * into a dense summary while preserving information that matters for future
 * turns: user goals, key facts/decisions, pending items, and context hints.
 *
 * Used by the context-window-guard hook when short-term history exceeds the
 * token budget: instead of dropping old messages outright, we summarize them
 * and store the summary back on ShortTermMemory, so the model still sees a
 * compressed view of earlier context.
 */

import type { ModelMessage } from 'ai'
import { LLMProvider } from '../llm/provider.js'
import type { ChatMessage } from './short-term.js'

const AVG_CHARS_PER_TOKEN = 4

const SUMMARIZER_SYSTEM_PROMPT = `You are a conversation summarizer for a long-running AI agent.

Your job: given a slice of earlier conversation turns (and optionally a prior running summary), produce a dense, factual summary that the agent can rely on in future turns.

Preserve, in this order of priority:
1. User's goals and intent — what are they trying to accomplish?
2. Key facts, data, names, IDs, file paths, URLs, numbers that the user has shared or the agent has discovered.
3. Decisions that have been made (e.g. "user chose option B", "agreed to use PostgreSQL").
4. Pending items / open questions / unfinished work.
5. Important context cues (tone, constraints, preferences, deadlines).

Rules:
- Be concise: aim for under ~500 tokens.
- Write in neutral third person ("the user asked...", "the assistant found...").
- Do not invent facts. If information is unclear, skip it rather than guess.
- Do not include small talk, greetings, or filler.
- Output plain text, no code fences, no markdown headers beyond short bullet lists if useful.`

export class ConversationSummarizer {
  constructor(private llm: LLMProvider) {}

  /**
   * Produce a dense summary of the given messages.
   * If `priorSummary` is provided, it's woven into the input so summaries
   * can compound across multiple truncation rounds without information loss.
   */
  async summarize(messages: ChatMessage[], priorSummary?: string): Promise<string> {
    if (messages.length === 0 && !priorSummary) return ''

    const transcript = messages
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n\n')

    const userBlocks: string[] = []
    if (priorSummary && priorSummary.trim().length > 0) {
      userBlocks.push(`Previous running summary:\n${priorSummary}`)
    }
    if (transcript.length > 0) {
      userBlocks.push(`Earlier conversation turns to fold in:\n${transcript}`)
    }
    userBlocks.push(
      'Produce the updated dense summary now. Under ~500 tokens. Plain text only.',
    )

    const modelMessages: ModelMessage[] = [
      { role: 'system', content: SUMMARIZER_SYSTEM_PROMPT },
      { role: 'user', content: userBlocks.join('\n\n') },
    ]

    // Use the cheapest available model role for summarization.
    const result = await this.llm.generate('reflector', modelMessages)
    return result.text.trim()
  }

  /**
   * Rough token estimate via chars/4 heuristic. Cheap and good enough for
   * budget decisions where exact tokenizer accuracy is not required.
   */
  estimateTokens(messages: ChatMessage[] | Array<{ content: string }>): number {
    let chars = 0
    for (const m of messages) chars += m.content.length
    return Math.ceil(chars / AVG_CHARS_PER_TOKEN)
  }
}
