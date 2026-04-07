/**
 * Multi-Session types (Phase 3 Batch 3).
 *
 * A "Session" here is a user-facing chat thread. Each session owns its own
 * Agent instance with its own ShortTermMemory, but all sessions share the
 * heavyweight stores (experiences, skills, knowledge, tools, llm) that the
 * SessionManager constructs once and injects into every Agent it spawns.
 *
 * This is distinct from `Session` in `core/src/types.ts`, which is the
 * lower-level Agent execution session (cost/token counters etc.). To avoid
 * the name collision the public type below is `SessionMetadata`.
 */

export interface SessionMetadata {
  /** Stable session id (nanoid). */
  id: string
  /** Human-readable title. Defaults to "New chat <timestamp>". */
  title: string
  /** Unix milliseconds. */
  createdAt: number
  /** Unix milliseconds. */
  lastActiveAt: number
  /** Number of user+assistant messages persisted in the session history. */
  messageCount: number
}

export interface CreateSessionInput {
  title?: string
  /** Optional explicit id (used for the legacy "default" session). */
  id?: string
}

/**
 * Persisted on-disk shape — metadata plus the raw conversation history so a
 * Session can be re-hydrated across process restarts.
 */
export interface PersistedSessionRecord {
  metadata: SessionMetadata
  messages: Array<{
    role: 'user' | 'assistant'
    content: string
    timestamp: string
  }>
  /** Optional rolling summary written by the context-window-guard hook. */
  summary?: string
}
