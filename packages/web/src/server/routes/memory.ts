import { Hono } from 'hono'
import { ExperienceStore, MemoryManager } from '@evolving-agent/core'

export function memoryRoutes(dataPath: string) {
  const app = new Hono()
  const store = new ExperienceStore(dataPath)
  const memory = new MemoryManager(dataPath)
  let initialized = false

  async function ensureInit() {
    if (!initialized) {
      await store.init()
      await memory.init()
      initialized = true
    }
  }

  // Filtered experience list
  app.get('/experiences', async (c) => {
    await ensureInit()
    const pool = (c.req.query('pool') ?? 'all') as 'active' | 'stale' | 'all'
    const result = c.req.query('result')
    const tag = c.req.query('tag')

    let experiences = pool === 'all'
      ? [...store.getAll('active'), ...store.getAll('stale')]
      : store.getAll(pool)

    if (result) {
      experiences = experiences.filter((e) => e.result === result)
    }
    if (tag) {
      experiences = experiences.filter((e) => e.tags.includes(tag))
    }

    // Sort by timestamp descending
    experiences.sort((a, b) => b.timestamp.localeCompare(a.timestamp))

    return c.json({ experiences, total: experiences.length })
  })

  // Single experience detail
  app.get('/experiences/:id', async (c) => {
    await ensureInit()
    const exp = store.get(c.req.param('id'))
    if (!exp) return c.json({ error: 'Not found' }, 404)
    return c.json(exp)
  })

  // Search
  app.get('/search', async (c) => {
    await ensureInit()
    const q = c.req.query('q') ?? ''
    const tags = c.req.query('tags')?.split(',').filter(Boolean)
    const results = await memory.search({ text: q, tags, topK: 20 })
    return c.json({ results })
  })

  // Pool stats
  app.get('/stats', async (c) => {
    await ensureInit()
    const stats = await store.getPoolStats()
    return c.json(stats)
  })

  // Trigger maintenance
  app.post('/maintain', async (c) => {
    await ensureInit()
    const result = await store.maintain()
    return c.json(result)
  })

  return app
}
