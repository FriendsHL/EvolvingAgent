import { Agent } from '../agent.js'
import type { ExecutionStep } from '../types.js'
import type { SessionMetadata } from './types.js'

/**
 * One live chat session. Wraps a per-session `Agent` instance whose
 * ShortTermMemory and working state are private to this session, while the
 * heavyweight stores (experiences, skills, knowledge, llm, tools) come from
 * the shared SessionManager-owned singletons that were injected into the
 * Agent at construction time.
 *
 * Phase 3 Batch 3 — see `docs/design/sub-agent.md#multi-session-concurrency`.
 */
export class Session {
  readonly metadata: SessionMetadata
  readonly agent: Agent

  constructor(metadata: SessionMetadata, agent: Agent) {
    this.metadata = metadata
    this.agent = agent
  }

  /** Send a user message and get the final assistant response. */
  async sendMessage(userInput: string): Promise<string> {
    this.touch()
    const response = await this.agent.processMessage(userInput)
    this.metadata.messageCount = this.agent.getMemoryManager().shortTerm.length
    return response
  }

  /**
   * Streaming variant — yields the same event types as
   * `Agent.processMessageStream`, so callers can pipe directly into SSE.
   */
  async *streamMessage(userInput: string): AsyncGenerator<
    | { type: 'status'; message: string }
    | { type: 'text-delta'; text: string }
    | { type: 'tool-call'; step: ExecutionStep }
    | { type: 'delegate-call'; subagent: string; task: string; rationale: string }
    | { type: 'sub-agent-progress'; subagent: string; content: string; timestamp: string }
    | {
        type: 'done'
        response: string
        metrics: { cost: number; tokens: number }
        experienceId?: string
      }
  > {
    this.touch()
    for await (const event of this.agent.processMessageStream(userInput)) {
      yield event
    }
    this.metadata.messageCount = this.agent.getMemoryManager().shortTerm.length
  }

  /** Conversation history as plain {role, content} pairs. */
  getHistory(): Array<{ role: 'user' | 'assistant'; content: string }> {
    return this.agent.getMemoryManager().shortTerm.getHistory()
  }

  /** Conversation history with timestamps (for persistence). */
  getMessages(): Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }> {
    return this.agent.getMemoryManager().shortTerm.getMessages()
  }

  getMetadata(): SessionMetadata {
    return { ...this.metadata }
  }

  /** Update lastActiveAt to now. */
  touch(): void {
    this.metadata.lastActiveAt = Date.now()
  }

  /** Replace conversation history (used when re-hydrating from disk). */
  loadHistory(messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp?: string }>): void {
    this.agent.loadHistory(messages)
    this.metadata.messageCount = this.agent.getMemoryManager().shortTerm.length
  }

  /** Stop background work owned by this session's Agent. */
  async dispose(): Promise<void> {
    await this.agent.shutdown()
  }
}
