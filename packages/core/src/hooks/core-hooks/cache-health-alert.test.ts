import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CacheMetricsRecorder } from '../../metrics/cache-metrics.js'
import type { CacheCallRecord } from '../../metrics/cache-metrics.js'
import { createCacheHealthAlert } from './cache-health-alert.js'
import type { HookContext } from '../../types.js'
import type { CacheHealthAlert } from './cache-health-alert.js'

let dataPath: string
beforeEach(async () => {
  dataPath = await mkdtemp(join(tmpdir(), 'cache-health-test-'))
})
afterEach(async () => {
  await rm(dataPath, { recursive: true, force: true })
})

const ctx: HookContext = {
  trigger: 'cron',
  data: undefined,
  agent: { sessionId: 'system', totalCost: 0, tokenCount: 0 },
}

function makeCall(overrides: Partial<CacheCallRecord> = {}): CacheCallRecord {
  return {
    ts: Date.now(),
    sessionId: 's1',
    taskId: 't1',
    model: 'm',
    provider: 'anthropic',
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    latencyMs: 100,
    ...overrides,
  }
}

describe('cache-health-alert hook', () => {
  it('returns undefined under cold-start (too few calls)', async () => {
    const r = new CacheMetricsRecorder(dataPath)
    await r.init()
    r.record(makeCall({ inputTokens: 100, cacheReadTokens: 0 }))
    const hook = createCacheHealthAlert(r, { minCalls: 5, hitRatioFloor: 0.3 })
    const result = await hook.handler(ctx)
    expect(result).toBeUndefined()
  })

  it('returns undefined when hit ratio is healthy', async () => {
    const r = new CacheMetricsRecorder(dataPath)
    await r.init()
    for (let i = 0; i < 10; i++) {
      r.record(makeCall({ inputTokens: 100, cacheReadTokens: 900 }))
    }
    const hook = createCacheHealthAlert(r, { minCalls: 5, hitRatioFloor: 0.3 })
    expect(await hook.handler(ctx)).toBeUndefined()
  })

  it('fires when hit ratio drops below the floor', async () => {
    const r = new CacheMetricsRecorder(dataPath)
    await r.init()
    for (let i = 0; i < 10; i++) {
      r.record(makeCall({ inputTokens: 1000, cacheReadTokens: 50 }))
    }
    const fired: CacheHealthAlert[] = []
    const hook = createCacheHealthAlert(r, {
      minCalls: 5,
      hitRatioFloor: 0.5,
      onAlert: (a) => {
        fired.push(a)
      },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = (await hook.handler(ctx)) as CacheHealthAlert | undefined
    warn.mockRestore()
    expect(result).toBeDefined()
    expect(result?.hitRatio).toBeLessThan(0.5)
    expect(fired).toHaveLength(1)
    expect(fired[0]?.threshold).toBe(0.5)
  })

  it('catches exceptions thrown by onAlert', async () => {
    const r = new CacheMetricsRecorder(dataPath)
    await r.init()
    for (let i = 0; i < 10; i++) {
      r.record(makeCall({ inputTokens: 1000, cacheReadTokens: 0 }))
    }
    const hook = createCacheHealthAlert(r, {
      minCalls: 5,
      hitRatioFloor: 0.5,
      onAlert: () => {
        throw new Error('downstream broke')
      },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Should NOT throw
    const result = await hook.handler(ctx)
    warn.mockRestore()
    err.mockRestore()
    expect(result).toBeDefined()
  })

  it('hook metadata: cron trigger with default schedule', () => {
    const r = new CacheMetricsRecorder(dataPath)
    const hook = createCacheHealthAlert(r)
    expect(hook.trigger).toBe('cron')
    expect(hook.schedule).toBe('*/5 * * * *')
    expect(hook.id).toBe('core:cache-health-alert')
  })
})
