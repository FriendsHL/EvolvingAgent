import { Hono } from 'hono'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionManager } from '@evolving-agent/core'
import type { SessionStore } from '../services/session-store.js'

/**
 * Multi-session REST endpoints (Phase 3 Batch 3).
 *
 * The new SessionManager owns the canonical view of sessions and is the
 * source of truth for new clients. The legacy `SessionStore` is still
 * passed in so the dashboard's pre-existing session list keeps working,
 * but new code paths should prefer SessionManager.
 */
export function sessionsRoutes(
  manager: SessionManager,
  legacyStore?: SessionStore,
  dataPath?: string,
) {
  const app = new Hono()

  // List all sessions (SessionManager-owned), sorted lastActive desc.
  app.get('/', (c) => {
    const sessions = manager.list()
    return c.json({ sessions })
  })

  // Create a new session.
  app.post('/', async (c) => {
    let body: { title?: string } = {}
    try {
      body = await c.req.json<{ title?: string }>()
    } catch {
      // Empty body is fine.
    }
    const session = await manager.create({ title: body.title })
    return c.json(session.getMetadata())
  })

  // Fetch a single session's metadata.
  app.get('/:id', async (c) => {
    const id = c.req.param('id')
    // Prefer SessionManager.
    const meta = manager.list().find((m) => m.id === id)
    if (meta) return c.json(meta)

    // Legacy fallback (read-only) so dashboard URLs that point at the old
    // session-store records still resolve.
    if (legacyStore) {
      const persisted = legacyStore.getById(id)
      if (persisted) return c.json(persisted)
    }
    return c.json({ error: 'Not found' }, 404)
  })

  // Conversation history for a session.
  app.get('/:id/history', async (c) => {
    const id = c.req.param('id')
    const session = await manager.getOrLoad(id)
    if (!session) return c.json({ error: 'Not found' }, 404)
    return c.json({
      sessionId: id,
      messages: session.getMessages(),
    })
  })

  // Rename a session.
  app.patch('/:id', async (c) => {
    const id = c.req.param('id')
    const { title } = await c.req.json<{ title: string }>()
    if (!title || typeof title !== 'string') {
      return c.json({ error: 'title is required' }, 400)
    }
    await manager.rename(id, title)
    const meta = manager.list().find((m) => m.id === id)
    if (!meta) return c.json({ error: 'Not found' }, 404)
    return c.json(meta)
  })

  // Delete a session.
  app.delete('/:id', async (c) => {
    const id = c.req.param('id')
    await manager.delete(id)
    return c.json({ success: true })
  })

  // Get persisted event history for a session (JSONL → JSON array).
  // Events are written to `<dataPath>/events/<sessionId>.jsonl` by the
  // chat route's onEvent broadcast hook.
  app.get('/:id/events', async (c) => {
    if (!dataPath) return c.json({ events: [] })
    const id = c.req.param('id')
    const filePath = join(dataPath, 'events', `${id}.jsonl`)
    try {
      const raw = await readFile(filePath, 'utf-8')
      const events = raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line) } catch { return null }
        })
        .filter(Boolean)
      return c.json({ events })
    } catch {
      return c.json({ events: [] })
    }
  })

  return app
}
