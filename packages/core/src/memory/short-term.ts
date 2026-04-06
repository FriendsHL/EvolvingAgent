/**
 * Short-term memory: in-memory conversation history.
 * Maintains the message list for the current session.
 *
 * Also carries an optional rolling `summary` of older turns produced by
 * the ConversationSummarizer (via the context-window-guard hook). When
 * set, the summary is injected as a synthetic system message in front of
 * the retained recent messages, so the LLM still sees compressed context
 * after old turns are dropped from the raw history.
 */

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

export class ShortTermMemory {
  private messages: ChatMessage[] = []
  private summary?: string

  add(role: 'user' | 'assistant', content: string): void {
    this.messages.push({
      role,
      content,
      timestamp: new Date().toISOString(),
    })
  }

  getHistory(): Array<{ role: 'user' | 'assistant'; content: string }> {
    return this.messages.map(({ role, content }) => ({ role, content }))
  }

  getMessages(): ChatMessage[] {
    return [...this.messages]
  }

  /** Load historical messages (e.g. when resuming a session) */
  load(messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp?: string }>): void {
    for (const msg of messages) {
      this.messages.push({
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp ?? new Date().toISOString(),
      })
    }
  }

  clear(): void {
    this.messages = []
    this.summary = undefined
  }

  get length(): number {
    return this.messages.length
  }

  // ============================================================
  // Rolling summary (populated by context-window-guard + summarizer)
  // ============================================================

  getSummary(): string | undefined {
    return this.summary
  }

  setSummary(summary: string): void {
    this.summary = summary.trim() || undefined
  }

  /**
   * Replace the retained raw message tail with a smaller window.
   * Used by context-window-guard after it summarizes the older portion.
   */
  replaceMessages(messages: ChatMessage[]): void {
    this.messages = [...messages]
  }

  /**
   * Messages as seen by the LLM: if a summary exists, prepend a synthetic
   * assistant-visible context block so the model still sees compressed
   * earlier context. We encode the summary as a `user` turn labeled
   * "Previous conversation summary" because ChatMessage only allows
   * user|assistant roles — the planner/reflector prompt layers already
   * have their own system prompt.
   */
  getEffectiveMessages(): ChatMessage[] {
    if (!this.summary) return this.getMessages()
    const synthetic: ChatMessage = {
      role: 'user',
      content: `Previous conversation summary: ${this.summary}`,
      timestamp: new Date(0).toISOString(),
    }
    return [synthetic, ...this.messages]
  }

  /**
   * {role, content} form of getEffectiveMessages — matches the shape used
   * by the planner, reflector, and LLMProvider.buildMessages history layer.
   */
  getEffectiveHistory(): Array<{ role: 'user' | 'assistant'; content: string }> {
    return this.getEffectiveMessages().map(({ role, content }) => ({ role, content }))
  }
}
