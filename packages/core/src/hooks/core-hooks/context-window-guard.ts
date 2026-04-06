import type { Hook, HookContext } from '../../types.js'
import type { ShortTermMemory, ChatMessage } from '../../memory/short-term.js'
import type { ConversationSummarizer } from '../../memory/conversation-summarizer.js'

// Lowered from 100K to 50K — with summarization in place we can afford to
// compress earlier, which keeps prompt caches warmer and per-call cost lower.
const MAX_HISTORY_TOKENS_ESTIMATE = 50_000
const AVG_CHARS_PER_TOKEN = 4
// How many most-recent raw turns to keep verbatim after summarizing.
const KEEP_RECENT_MESSAGES = 10

interface HistoryEntry {
  role: 'user' | 'assistant'
  content: string
}

interface HistoryData {
  history: HistoryEntry[]
}

export interface ContextWindowGuardDeps {
  /** Summarizer used to compress dropped history. If omitted, the hook falls back to naive truncation. */
  summarizer?: ConversationSummarizer
  /** Short-term memory to persist the rolling summary back onto. Required for summarization path. */
  memory?: ShortTermMemory
}

function estimateTokens(history: HistoryEntry[]): number {
  let chars = 0
  for (const m of history) chars += m.content.length
  return chars / AVG_CHARS_PER_TOKEN
}

function truncateFallback(history: HistoryEntry[]): HistoryEntry[] {
  // Keep first 2 messages (system setup) + most recent messages within budget.
  const keepFirst = 2
  const firstMessages = history.slice(0, keepFirst)
  const remaining = history.slice(keepFirst)

  let currentChars = firstMessages.reduce((sum, m) => sum + m.content.length, 0)
  const keptRecent: HistoryEntry[] = []
  for (let i = remaining.length - 1; i >= 0; i--) {
    const msgChars = remaining[i].content.length
    if ((currentChars + msgChars) / AVG_CHARS_PER_TOKEN > MAX_HISTORY_TOKENS_ESTIMATE) {
      break
    }
    currentChars += msgChars
    keptRecent.unshift(remaining[i])
  }
  return [...firstMessages, ...keptRecent]
}

/**
 * Build a context-window-guard hook with an optional summarizer.
 *
 * When the history token estimate exceeds the budget:
 *   1. Split history into `older` (to summarize) + `recent` (kept verbatim).
 *   2. Ask the summarizer to fold `older` into any existing rolling summary.
 *   3. Persist the new summary on ShortTermMemory via setSummary().
 *   4. Return the hook's modified data with only the recent turns, plus a
 *      synthetic leading turn containing the summary so the current in-flight
 *      LLM call sees compressed context immediately (even though the caller
 *      passed a snapshot of history).
 *
 * Falls back to naive keep-first-2 truncation if no summarizer/memory is wired
 * in or if the summarizer call throws.
 */
export function createContextWindowGuard(deps: ContextWindowGuardDeps = {}): Hook {
  return {
    id: 'core:context-window-guard',
    name: 'context-window-guard',
    description: 'Summarize or truncate conversation history when approaching context window limit',
    trigger: 'before:llm-call',
    priority: 100,
    enabled: true,
    source: 'core',

    async handler(context: HookContext): Promise<unknown> {
      const data = context.data as HistoryData | undefined
      if (!data?.history) return undefined

      const history = data.history
      const estimatedTokens = estimateTokens(history)
      if (estimatedTokens <= MAX_HISTORY_TOKENS_ESTIMATE) {
        return undefined // No compression needed
      }

      const { summarizer, memory } = deps

      // Fallback path: no summarizer wired in, do the old truncation.
      if (!summarizer || !memory) {
        const truncated = truncateFallback(history)
        const removed = history.length - truncated.length
        if (removed > 0) {
          console.warn(
            `[context-window-guard] Truncated ${removed} messages from history (no summarizer available)`,
          )
        }
        return { ...data, history: truncated }
      }

      // Summarization path.
      const keepRecent = Math.min(KEEP_RECENT_MESSAGES, history.length)
      const older = history.slice(0, history.length - keepRecent)
      const recent = history.slice(history.length - keepRecent)

      if (older.length === 0) {
        // Nothing to summarize (already tiny tail exceeding budget — rare).
        return undefined
      }

      // Coerce {role, content}[] into ChatMessage[] for the summarizer.
      // Timestamps are synthetic; the summarizer only reads role+content.
      const now = new Date().toISOString()
      const olderAsChat: ChatMessage[] = older.map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: now,
      }))

      try {
        const priorSummary = memory.getSummary()
        const newSummary = await summarizer.summarize(olderAsChat, priorSummary)
        if (newSummary) {
          memory.setSummary(newSummary)
          // Also drop the older raw turns from memory so subsequent calls
          // don't re-trigger summarization on the same content.
          const rawMessages = memory.getMessages()
          if (rawMessages.length > keepRecent) {
            memory.replaceMessages(rawMessages.slice(rawMessages.length - keepRecent))
          }
          console.warn(
            `[context-window-guard] Summarized ${older.length} older message(s); keeping last ${keepRecent} verbatim`,
          )
        }

        // Rewrite the in-flight history for this specific LLM call so it sees
        // the summary immediately rather than waiting for the next turn.
        const syntheticSummaryTurn: HistoryEntry = {
          role: 'user',
          content: `Previous conversation summary: ${newSummary || priorSummary || ''}`,
        }
        return { ...data, history: [syntheticSummaryTurn, ...recent] }
      } catch (err) {
        console.warn(
          `[context-window-guard] Summarization failed, falling back to truncation:`,
          err instanceof Error ? err.message : err,
        )
        const truncated = truncateFallback(history)
        return { ...data, history: truncated }
      }
    },

    health: { consecutiveFailures: 0, totalRuns: 0, successRate: 1 },
    safety: { timeout: 30_000, maxRetries: 0, fallbackBehavior: 'skip', canBeDisabledByAgent: false },
  }
}

/**
 * Backward-compatible default instance with no summarizer wired in.
 * Existing call sites (and tests) that import `contextWindowGuard` directly
 * keep working with the naive truncation fallback. The Agent class replaces
 * this with a summarizer-aware instance at construction time.
 */
export const contextWindowGuard: Hook = createContextWindowGuard()
