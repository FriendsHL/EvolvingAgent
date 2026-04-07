import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CacheMetricsRecorder } from './cache-metrics.js'
import type { CacheCallRecord } from './cache-metrics.js'

let dataPath: string

beforeEach(async () => {
  dataPath = await mkdtemp(join(tmpdir(), 'cache-metrics-test-'))
})
afterEach(async () => {
  await rm(dataPath, { recursive: true, force: true })
})

function makeCall(overrides: Partial<CacheCallRecord> = {}): CacheCallRecord {
  return {
    ts: Date.now(),
    sessionId: 's1',
    taskId: 't1',
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 0,
    cacheReadTokens: 200,
    latencyMs: 500,
    ...overrides,
  }
}

describe('CacheMetricsRecorder', () => {
  it('records calls into the ring buffer', async () => {
    const r = new CacheMetricsRecorder(dataPath)
    await r.init()
    r.record(makeCall())
    r.record(makeCall({ sessionId: 's2' }))
    expect(r.getRecentCalls(10)).toHaveLength(2)
  })

  it('aggregateBySession filters by sessionId', async () => {
    const r = new CacheMetricsRecorder(dataPath)
    await r.init()
    r.record(makeCall({ sessionId: 's1', inputTokens: 100, cacheReadTokens: 300 }))
    r.record(makeCall({ sessionId: 's2', inputTokens: 50 }))
    const agg = r.aggregateBySession('s1')
    expect(agg.totalCalls).toBe(1)
    expect(agg.totalInputTokens).toBe(100)
  })

  it('hitRatio = cacheRead / (cacheRead + input)', async () => {
    const r = new CacheMetricsRecorder(dataPath)
    await r.init()
    r.record(makeCall({ inputTokens: 100, cacheReadTokens: 300 }))
    const agg = r.aggregateBySession('s1')
    expect(agg.hitRatio).toBeCloseTo(0.75, 5)
  })

  it('aggregateRecent honors time window', async () => {
    const r = new CacheMetricsRecorder(dataPath)
    await r.init()
    const old = Date.now() - 60_000
    r.record(makeCall({ ts: old }))
    r.record(makeCall({ ts: Date.now() }))
    const agg = r.aggregateRecent(10_000)
    expect(agg.totalCalls).toBe(1)
  })

  it('aggregateByTask matches both taskId and subAgentTaskId', async () => {
    const r = new CacheMetricsRecorder(dataPath)
    await r.init()
    r.record(makeCall({ taskId: 'main-1' }))
    r.record(makeCall({ taskId: undefined, subAgentTaskId: 'main-1' }))
    r.record(makeCall({ taskId: 'other' }))
    const agg = r.aggregateByTask('main-1')
    expect(agg.totalCalls).toBe(2)
  })

  it('flush writes JSONL file with one record per line', async () => {
    const r = new CacheMetricsRecorder(dataPath)
    await r.init()
    r.record(makeCall())
    r.record(makeCall({ sessionId: 's2' }))
    await r.flush()
    const today = new Date().toISOString().slice(0, 10)
    const raw = await readFile(join(dataPath, 'metrics', `cache-calls-${today}.jsonl`), 'utf-8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).sessionId).toBe('s1')
  })

  it('flush also persists daily-summary.json', async () => {
    const r = new CacheMetricsRecorder(dataPath)
    await r.init()
    r.record(makeCall({ inputTokens: 50, cacheReadTokens: 150 }))
    await r.flush()
    const raw = await readFile(join(dataPath, 'metrics', 'cache-daily-summary.json'), 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, { totalCalls: number; hitRatio: number }>
    const today = new Date().toISOString().slice(0, 10)
    expect(parsed[today]?.totalCalls).toBe(1)
    expect(parsed[today]?.hitRatio).toBeCloseTo(0.75, 5)
  })

  it('shutdown flushes pending writes', async () => {
    const r = new CacheMetricsRecorder(dataPath)
    await r.init()
    r.record(makeCall())
    await r.shutdown()
    const today = new Date().toISOString().slice(0, 10)
    const raw = await readFile(join(dataPath, 'metrics', `cache-calls-${today}.jsonl`), 'utf-8')
    expect(raw.trim().split('\n')).toHaveLength(1)
  })

  it('ring buffer wraps around and only keeps the most recent N', async () => {
    const r = new CacheMetricsRecorder(dataPath, { ringSize: 3 })
    await r.init()
    for (let i = 0; i < 5; i++) r.record(makeCall({ taskId: `t${i}` }))
    const recent = r.getRecentCalls(10)
    expect(recent).toHaveLength(3)
    // Newest first
    expect(recent[0]?.taskId).toBe('t4')
  })
})
