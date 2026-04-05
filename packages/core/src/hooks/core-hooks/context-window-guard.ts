import type { Hook, HookContext } from '../../types.js'

const MAX_HISTORY_TOKENS_ESTIMATE = 100_000 // ~100K token budget for history
const AVG_CHARS_PER_TOKEN = 4

interface HistoryData {
  history: Array<{ role: string; content: string }>
}

/**
 * Core Hook: context-window-guard
 * Trigger: before:llm-call (modifying)
 * Truncates conversation history if it exceeds the token budget.
 * Keeps the first message (system context) and most recent messages.
 */
export const contextWindowGuard: Hook = {
  id: 'core:context-window-guard',
  name: 'context-window-guard',
  description: 'Truncate conversation history when approaching context window limit',
  trigger: 'before:llm-call',
  priority: 100,
  enabled: true,
  source: 'core',

  async handler(context: HookContext): Promise<unknown> {
    const data = context.data as HistoryData
    if (!data?.history) return undefined

    const history = data.history
    const totalChars = history.reduce((sum, m) => sum + m.content.length, 0)
    const estimatedTokens = totalChars / AVG_CHARS_PER_TOKEN

    if (estimatedTokens <= MAX_HISTORY_TOKENS_ESTIMATE) {
      return undefined // No truncation needed
    }

    // Keep first 2 messages (system setup) + most recent messages
    const keepFirst = 2
    const firstMessages = history.slice(0, keepFirst)
    let remaining = history.slice(keepFirst)

    // Trim from the oldest until under budget
    let currentChars = firstMessages.reduce((sum, m) => sum + m.content.length, 0)
    const keptRecent: typeof remaining = []

    for (let i = remaining.length - 1; i >= 0; i--) {
      const msgChars = remaining[i].content.length
      if ((currentChars + msgChars) / AVG_CHARS_PER_TOKEN > MAX_HISTORY_TOKENS_ESTIMATE) {
        break
      }
      currentChars += msgChars
      keptRecent.unshift(remaining[i])
    }

    const truncated = [...firstMessages, ...keptRecent]
    const removed = history.length - truncated.length
    if (removed > 0) {
      console.warn(`[context-window-guard] Truncated ${removed} messages from history`)
    }

    return { ...data, history: truncated }
  },

  health: { consecutiveFailures: 0, totalRuns: 0, successRate: 1 },
  safety: { timeout: 1000, maxRetries: 0, fallbackBehavior: 'skip', canBeDisabledByAgent: false },
}
