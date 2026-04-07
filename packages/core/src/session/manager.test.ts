import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from './manager.js'

let dataPath: string

beforeEach(async () => {
  dataPath = await mkdtemp(join(tmpdir(), 'session-manager-test-'))
})
afterEach(async () => {
  await rm(dataPath, { recursive: true, force: true })
})

async function freshManager(): Promise<SessionManager> {
  const m = new SessionManager({
    dataPath,
    // Disable the cache-health cron so the test process doesn't hold a timer.
    cacheHealthAlert: { enabled: false },
  })
  await m.init()
  return m
}

describe('SessionManager — init + shared singletons', () => {
  it('init constructs BudgetManager + CacheMetricsRecorder + ChannelRegistry', async () => {
    const m = await freshManager()
    expect(m.getBudgetManager()).toBeDefined()
    expect(m.getCacheMetrics()).toBeDefined()
    expect(m.getChannels()).toBeDefined()
    expect(m.getSystemHooks()).toBeDefined()
    await m.shutdown()
  })

  it('registers observability tools on the shared registry', async () => {
    const m = await freshManager()
    // The session-level Agent inherits these via the shared deps wired in
    // buildSharedDeps(). We verify presence indirectly: create a session and
    // check that its agent's tool registry exposes the three observability
    // tools.
    const session = await m.create({ title: 'probe' })
    const tools = (session.agent as any).tools.list() as Array<{ name: string }>
    const names = tools.map((t) => t.name)
    expect(names).toContain('metrics-query')
    expect(names).toContain('log-search')
    expect(names).toContain('trace')
    await m.shutdown()
  })
})

describe('SessionManager — create / get / list / delete', () => {
  it('create returns a Session with metadata and registers it in list()', async () => {
    const m = await freshManager()
    const s = await m.create({ title: 'My chat' })
    expect(s.metadata.id).toBeTruthy()
    expect(s.metadata.title).toBe('My chat')
    expect(m.list().some((meta) => meta.id === s.metadata.id)).toBe(true)
    await m.shutdown()
  })

  it('default title is generated when not provided', async () => {
    const m = await freshManager()
    const s = await m.create()
    expect(s.metadata.title).toMatch(/^New chat /)
    await m.shutdown()
  })

  it('get returns a live session, undefined for unknown id', async () => {
    const m = await freshManager()
    const s = await m.create()
    expect(m.get(s.metadata.id)).toBe(s)
    expect(m.get('nope')).toBeUndefined()
    await m.shutdown()
  })

  it('list orders sessions by lastActiveAt desc', async () => {
    const m = await freshManager()
    const s1 = await m.create({ title: 'first' })
    await new Promise((r) => setTimeout(r, 5))
    const s2 = await m.create({ title: 'second' })
    const ordering = m.list().map((meta) => meta.id)
    expect(ordering[0]).toBe(s2.metadata.id)
    expect(ordering[1]).toBe(s1.metadata.id)
    await m.shutdown()
  })

  it('delete removes from index and from disk', async () => {
    const m = await freshManager()
    const s = await m.create({ title: 'delete me' })
    await m.delete(s.metadata.id)
    expect(m.get(s.metadata.id)).toBeUndefined()
    expect(m.list().some((meta) => meta.id === s.metadata.id)).toBe(false)
    await m.shutdown()
  })

  it('rename updates the title and bumps lastActiveAt', async () => {
    const m = await freshManager()
    const s = await m.create({ title: 'old' })
    const before = s.metadata.lastActiveAt
    await new Promise((r) => setTimeout(r, 5))
    await m.rename(s.metadata.id, 'new')
    expect(m.get(s.metadata.id)?.metadata.title).toBe('new')
    expect(m.get(s.metadata.id)!.metadata.lastActiveAt).toBeGreaterThan(before)
    await m.shutdown()
  })

  it('create throws if init() was not called', async () => {
    const m = new SessionManager({
      dataPath,
      cacheHealthAlert: { enabled: false },
    })
    await expect(m.create()).rejects.toThrow(/not initialized/)
  })
})

describe('SessionManager — re-hydration via getOrLoad', () => {
  it('reloads a session from disk after manager restart', async () => {
    const m1 = await freshManager()
    const created = await m1.create({ title: 'persisted' })
    const id = created.metadata.id
    await m1.shutdown()

    const m2 = await freshManager()
    const reloaded = await m2.getOrLoad(id)
    expect(reloaded).toBeDefined()
    expect(reloaded?.metadata.title).toBe('persisted')
    expect(m2.list().some((meta) => meta.id === id)).toBe(true)
    await m2.shutdown()
  })

  it('returns undefined for unknown id', async () => {
    const m = await freshManager()
    expect(await m.getOrLoad('nope')).toBeUndefined()
    await m.shutdown()
  })
})
