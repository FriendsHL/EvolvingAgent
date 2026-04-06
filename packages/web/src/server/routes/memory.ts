import { Hono } from 'hono'
import { ExperienceStore, MemoryManager, SkillRegistry } from '@evolving-agent/core'

export function memoryRoutes(dataPath: string) {
  const app = new Hono()
  const store = new ExperienceStore(dataPath)
  const memory = new MemoryManager(dataPath)
  // Dedicated skill registry used purely for feedback-driven score updates.
  // We don't register builtin skill executables here — recordUsage only needs
  // persisted metadata, which is loaded from disk via init().
  const skillRegistry = new SkillRegistry(dataPath)
  memory.setSkillRegistry(skillRegistry)
  let initialized = false

  async function ensureInit() {
    if (!initialized) {
      await store.init()
      await memory.init()
      await skillRegistry.init()
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

  // Record user feedback on an experience (positive / negative).
  // Recomputes the experience's admission score and nudges scores of any
  // skills the experience used.
  app.post('/experiences/:id/feedback', async (c) => {
    await ensureInit()
    const id = c.req.param('id')
    let body: { feedback?: unknown }
    try {
      body = await c.req.json<{ feedback?: unknown }>()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    const feedback = body.feedback
    if (feedback !== 'positive' && feedback !== 'negative') {
      return c.json({ error: "feedback must be 'positive' or 'negative'" }, 400)
    }

    const ok = await memory.recordFeedback(id, feedback)
    if (!ok) return c.json({ error: 'Experience not found' }, 404)

    const updated = (await memory.experienceStore.getAnyPool(id)) ?? null
    return c.json({ success: true, experience: updated })
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
