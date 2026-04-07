import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMetricsQueryTool } from './metrics-query.js'
import { createLogSearchTool } from './log-search.js'
import { createTraceTool } from './trace.js'
import { CacheMetricsRecorder } from '../../metrics/cache-metrics.js'
import { BudgetManager, DEFAULT_BUDGET_CONFIG } from '../../metrics/budget.js'
import { ExperienceStore } from '../../memory/experience-store.js'
import type { Experience } from '../../types.js'

let dataPath: string
beforeEach(async () => {
  dataPath = await mkdtemp(join(tmpdir(), 'observability-test-'))
})
afterEach(async () => {
  await rm(dataPath, { recursive: true, force: true })
})

function makeExperience(overrides: Partial<Experience> = {}): Experience {
  return {
    id: 'exp-1',
    task: 'analyze logs and find the error',
    steps: [
      {
        description: 'list log files',
        tool: 'shell',
        params: { command: 'ls /var/log' },
        result: { success: true, output: 'foo.log' },
        duration: 50,
      } as any,
    ],
    result: 'success',
    reflection: {
      whatWorked: ['shell tool worked'],
      whatFailed: [],
      lesson: 'logs are useful',
    } as any,
    tags: ['debug', 'logs'],
    timestamp: new Date().toISOString(),
    health: { consecutiveFailures: 0, totalUses: 1, successRate: 1 } as any,
    admissionScore: 1,
    ...overrides,
  }
}

// ================================================================
// metrics-query
// ================================================================
describe('metrics-query tool', () => {
  it('returns error when scope missing', async () => {
    const recorder = new CacheMetricsRecorder(dataPath)
    await recorder.init()
    const bm = new BudgetManager(DEFAULT_BUDGET_CONFIG, dataPath)
    await bm.init()
    const tool = createMetricsQueryTool(recorder, bm)
    const r = await tool.execute({})
    expect(r.success).toBe(false)
  })

  it('scope=session aggregates by sessionId', async () => {
    const recorder = new CacheMetricsRecorder(dataPath)
    await recorder.init()
    recorder.record({
      ts: Date.now(),
      sessionId: 's1',
      taskId: 't1',
      model: 'm',
      provider: 'anthropic',
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 300,
      latencyMs: 100,
    })
    const bm = new BudgetManager(DEFAULT_BUDGET_CONFIG, dataPath)
    await bm.init()
    const tool = createMetricsQueryTool(recorder, bm)
    const r = await tool.execute({ scope: 'session', sessionId: 's1' })
    expect(r.success).toBe(true)
    expect(r.output).toMatch(/Session s1/)
    expect(r.output).toMatch(/total calls/)
  })

  it("scope=session requires sessionId", async () => {
    const recorder = new CacheMetricsRecorder(dataPath)
    await recorder.init()
    const bm = new BudgetManager(DEFAULT_BUDGET_CONFIG, dataPath)
    await bm.init()
    const tool = createMetricsQueryTool(recorder, bm)
    const r = await tool.execute({ scope: 'session' })
    expect(r.success).toBe(false)
  })

  it('scope=recent honors window', async () => {
    const recorder = new CacheMetricsRecorder(dataPath)
    await recorder.init()
    const bm = new BudgetManager(DEFAULT_BUDGET_CONFIG, dataPath)
    await bm.init()
    const tool = createMetricsQueryTool(recorder, bm)
    const r = await tool.execute({ scope: 'recent', windowMinutes: 5 })
    expect(r.success).toBe(true)
  })

  it('scope=budget renders the live config snapshot', async () => {
    const recorder = new CacheMetricsRecorder(dataPath)
    await recorder.init()
    const bm = new BudgetManager(DEFAULT_BUDGET_CONFIG, dataPath)
    await bm.init()
    const tool = createMetricsQueryTool(recorder, bm)
    const r = await tool.execute({ scope: 'budget' })
    expect(r.success).toBe(true)
    expect(r.output).toMatch(/Token budget snapshot/)
    expect(r.output).toMatch(/Sub-agent/)
  })

  it('rejects unknown scope', async () => {
    const recorder = new CacheMetricsRecorder(dataPath)
    await recorder.init()
    const bm = new BudgetManager(DEFAULT_BUDGET_CONFIG, dataPath)
    await bm.init()
    const tool = createMetricsQueryTool(recorder, bm)
    const r = await tool.execute({ scope: 'mystery' })
    expect(r.success).toBe(false)
  })
})

// ================================================================
// log-search
// ================================================================
describe('log-search tool', () => {
  it('requires at least one filter', async () => {
    const store = new ExperienceStore(dataPath)
    await store.init()
    const tool = createLogSearchTool(store)
    const r = await tool.execute({})
    expect(r.success).toBe(false)
  })

  it('keyword search across task + reflection text', async () => {
    const store = new ExperienceStore(dataPath)
    await store.init()
    await store.save(makeExperience({ id: 'a', task: 'fix database connection bug' }))
    await store.save(makeExperience({ id: 'b', task: 'render homepage' }))
    const tool = createLogSearchTool(store)
    const r = await tool.execute({ query: 'database' })
    expect(r.success).toBe(true)
    expect(r.output).toMatch(/Found 1/)
    expect(r.output).toMatch(/a/)
  })

  it('filters by outcome', async () => {
    const store = new ExperienceStore(dataPath)
    await store.init()
    await store.save(makeExperience({ id: 'a', result: 'success' }))
    await store.save(makeExperience({ id: 'b', result: 'failure' }))
    const tool = createLogSearchTool(store)
    const r = await tool.execute({ outcome: 'failure' })
    expect(r.success).toBe(true)
    expect(r.output).toMatch(/Found 1/)
  })

  it('filters by tag', async () => {
    const store = new ExperienceStore(dataPath)
    await store.init()
    await store.save(makeExperience({ id: 'a', tags: ['urgent'] }))
    await store.save(makeExperience({ id: 'b', tags: ['routine'] }))
    const tool = createLogSearchTool(store)
    const r = await tool.execute({ tag: 'urgent' })
    expect(r.output).toMatch(/Found 1/)
  })

  it('returns "no experiences matched" when nothing matches', async () => {
    const store = new ExperienceStore(dataPath)
    await store.init()
    await store.save(makeExperience({ id: 'a' }))
    const tool = createLogSearchTool(store)
    const r = await tool.execute({ query: 'nonexistent' })
    expect(r.success).toBe(true)
    expect(r.output).toMatch(/No experiences matched/)
  })
})

// ================================================================
// trace
// ================================================================
describe('trace tool', () => {
  it('requires experienceId', async () => {
    const store = new ExperienceStore(dataPath)
    await store.init()
    const tool = createTraceTool(store)
    const r = await tool.execute({})
    expect(r.success).toBe(false)
  })

  it('returns error for unknown id', async () => {
    const store = new ExperienceStore(dataPath)
    await store.init()
    const tool = createTraceTool(store)
    const r = await tool.execute({ experienceId: 'nope' })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/No experience found/)
  })

  it('renders the full trace for an existing experience', async () => {
    const store = new ExperienceStore(dataPath)
    await store.init()
    await store.save(makeExperience({ id: 'exp-7' }))
    const tool = createTraceTool(store)
    const r = await tool.execute({ experienceId: 'exp-7' })
    expect(r.success).toBe(true)
    expect(r.output).toMatch(/Experience: exp-7/)
    expect(r.output).toMatch(/Steps \(1\)/)
    expect(r.output).toMatch(/Reflection:/)
  })
})
