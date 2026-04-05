import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Session, AgentEvent } from '@evolving-agent/core'

export interface PersistedSession extends Session {
  agentId?: string
  messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }>
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
      try {
        const data = await readFile(join(this.dir, file), 'utf-8')
        const session = JSON.parse(data) as PersistedSession
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
