import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnowledgeStore } from './knowledge-store.js'

let dataPath: string
beforeEach(async () => {
  dataPath = await mkdtemp(join(tmpdir(), 'knowledge-test-'))
})
afterEach(async () => {
  await rm(dataPath, { recursive: true, force: true })
})

describe('KnowledgeStore — CRUD without embedder', () => {
  it('add → get → list', async () => {
    const k = new KnowledgeStore()
    await k.init(dataPath)
    const e = await k.add({ title: 'Hello', content: 'World content here', tags: ['greet'] })
    expect(e.id).toBeTruthy()
    expect(k.get(e.id)?.title).toBe('Hello')
    expect(k.list()).toHaveLength(1)
    expect(k.size()).toBe(1)
  })

  it('persists each entry as <id>.json', async () => {
    const k = new KnowledgeStore()
    await k.init(dataPath)
    await k.add({ title: 'Doc1', content: 'aaa' })
    await k.add({ title: 'Doc2', content: 'bbb' })
    const files = await readdir(join(dataPath, 'knowledge'))
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(2)
  })

  it('reloads existing entries on init', async () => {
    const k1 = new KnowledgeStore()
    await k1.init(dataPath)
    const e = await k1.add({ title: 'Persist', content: 'me' })
    const k2 = new KnowledgeStore()
    await k2.init(dataPath)
    expect(k2.get(e.id)?.title).toBe('Persist')
  })

  it('update mutates fields and bumps updatedAt', async () => {
    const k = new KnowledgeStore()
    await k.init(dataPath)
    const e = await k.add({ title: 'Original', content: 'old' })
    const before = e.updatedAt
    await new Promise((r) => setTimeout(r, 5))
    const updated = await k.update(e.id, { title: 'New' })
    expect(updated?.title).toBe('New')
    expect(updated?.content).toBe('old')
    expect(updated && updated.updatedAt >= before).toBe(true)
  })

  it('update returns undefined for missing id', async () => {
    const k = new KnowledgeStore()
    await k.init(dataPath)
    expect(await k.update('nope', { title: 'x' })).toBeUndefined()
  })

  it('remove deletes the entry and the file', async () => {
    const k = new KnowledgeStore()
    await k.init(dataPath)
    const e = await k.add({ title: 'Bye', content: 'soon' })
    expect(await k.remove(e.id)).toBe(true)
    expect(k.get(e.id)).toBeUndefined()
    const files = await readdir(join(dataPath, 'knowledge'))
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(0)
  })

  it('remove returns false for missing id', async () => {
    const k = new KnowledgeStore()
    await k.init(dataPath)
    expect(await k.remove('nope')).toBe(false)
  })
})

describe('KnowledgeStore — keyword search fallback (no embedder)', () => {
  it('matches title/content tokens', async () => {
    const k = new KnowledgeStore()
    await k.init(dataPath)
    await k.add({ title: 'Vector indexes', content: 'cosine similarity for embeddings' })
    await k.add({ title: 'Cron jobs', content: 'periodic background tasks' })
    const results = await k.search('cosine similarity')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.entry.title).toBe('Vector indexes')
  })

  it('returns empty array for empty query', async () => {
    const k = new KnowledgeStore()
    await k.init(dataPath)
    await k.add({ title: 'foo', content: 'bar' })
    expect(await k.search('   ')).toEqual([])
  })

  it('returns empty array when store is empty', async () => {
    const k = new KnowledgeStore()
    await k.init(dataPath)
    expect(await k.search('anything')).toEqual([])
  })

  it('respects topK', async () => {
    const k = new KnowledgeStore()
    await k.init(dataPath)
    for (let i = 0; i < 5; i++) {
      await k.add({ title: `Doc ${i}`, content: 'shared keyword content' })
    }
    const results = await k.search('shared keyword', 3)
    expect(results.length).toBeLessThanOrEqual(3)
  })
})
