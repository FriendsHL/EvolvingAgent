/**
 * Short-term memory: in-memory conversation history.
 * Maintains the message list for the current session.
 */

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

export class ShortTermMemory {
  private messages: ChatMessage[] = []

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

  clear(): void {
    this.messages = []
  }

  get length(): number {
    return this.messages.length
  }
}
