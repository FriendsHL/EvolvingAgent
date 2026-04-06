import { Hono } from 'hono'
import { KnowledgeStore, Embedder } from '@evolving-agent/core'

/**
 * Knowledge Base routes — CRUD + hybrid search over user-curated documents.
 *
 * The server owns its own KnowledgeStore instance (separate from any live
 * Agent sessions). Entries persist under `${dataPath}/knowledge/*.json`, so
 * changes made here are visible to future Agent runs that share the same
 * data directory.
 */
export function knowledgeRoutes(dataPath: string) {
  const app = new Hono()

  // Use a local embedder (no API key needed) for indexing on the server side.
  const store = new KnowledgeStore(new Embedder({ provider: 'local' }))
  let initPromise: Promise<void> | null = null

  const ensureInit = () => {
    if (!initPromise) initPromise = store.init(dataPath)
    return initPromise
  }

  app.get('/', async (c) => {
    await ensureInit()
    return c.json({ entries: store.list() })
  })

  app.get('/:id', async (c) => {
    await ensureInit()
    const entry = store.get(c.req.param('id'))
    if (!entry) return c.json({ error: 'Not found' }, 404)
    return c.json(entry)
  })

  app.post('/', async (c) => {
    await ensureInit()
    const body = await c.req.json<{
      title: string
      content: string
      tags?: string[]
      source?: string
    }>()
    if (!body.title || !body.content) {
      return c.json({ error: 'title and content are required' }, 400)
    }
    const entry = await store.add({
      title: body.title,
      content: body.content,
      tags: body.tags ?? [],
      source: body.source,
    })
    return c.json(entry, 201)
  })

  app.put('/:id', async (c) => {
    await ensureInit()
    const id = c.req.param('id')
    const body = await c.req.json<{
      title?: string
      content?: string
      tags?: string[]
      source?: string
    }>()
    const updated = await store.update(id, body)
    if (!updated) return c.json({ error: 'Not found' }, 404)
    return c.json(updated)
  })

  app.delete('/:id', async (c) => {
    await ensureInit()
    const ok = await store.remove(c.req.param('id'))
    if (!ok) return c.json({ error: 'Not found' }, 404)
    return c.json({ success: true })
  })

  app.post('/search', async (c) => {
    await ensureInit()
    const body = await c.req.json<{ query: string; topK?: number }>()
    if (!body.query) return c.json({ error: 'query is required' }, 400)
    const results = await store.search(body.query, body.topK ?? 5)
    return c.json({ results })
  })

  return app
}
