import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Session, AgentEvent } from '@evolving-agent/core'

export interface PersistedSession extends Session {
  agentId?: string
  messages: Array<{
    role: 'user' | 'assistant'
    content: string
    timestamp: string
    /** For assistant messages: id of the experience stored from this turn, if any. */
    experienceId?: string
  }>
  events: AgentEvent[]
  closedAt?: string
}

export class SessionStore {
  private dir: string
  private sessions = new Map<string, PersistedSession>()

  constructor(dataPath: string) {
    this.dir = join(dataPath, 'sessions')
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const files = await readdir(this.dir).catch(() => [])
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      // Skip the SessionManager-owned index.json that lives in the same
      // directory but has a completely different shape.
      if (file === 'index.json') continue
      try {
        const data = await readFile(join(this.dir, file), 'utf-8')
        const parsed = JSON.parse(data) as unknown
        // Defensive: only accept entries that look like a PersistedSession.
        // Without this, a foreign-shape file (e.g. an array, or a
        // SessionManager record) silently poisons the in-memory map and
        // crashes the dashboard reduce loops downstream.
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed) ||
          !Array.isArray((parsed as PersistedSession).messages) ||
          typeof (parsed as PersistedSession).id !== 'string'
        ) {
          continue
        }
        const session = parsed as PersistedSession
        this.sessions.set(session.id, session)
      } catch { /* skip corrupted */ }
    }
  }

  getAll(): PersistedSession[] {
    return [...this.sessions.values()].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    )
  }

  getById(id: string): PersistedSession | undefined {
    return this.sessions.get(id)
  }

  async save(session: PersistedSession): Promise<void> {
    this.sessions.set(session.id, session)
    await writeFile(join(this.dir, `${session.id}.json`), JSON.stringify(session, null, 2), 'utf-8')
  }

  async addMessage(sessionId: string, role: 'user' | 'assistant', content: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.messages.push({ role, content, timestamp: new Date().toISOString() })
    await this.save(session)
  }

  async addEvent(sessionId: string, event: AgentEvent): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.events.push(event)
    // Don't persist every event immediately for performance
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.status = 'closed'
    session.closedAt = new Date().toISOString()
    await this.save(session)
  }
}
