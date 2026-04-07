import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BudgetManager } from '../../metrics/budget.js'
import type { BudgetConfig } from '../../metrics/budget.js'
import { createBudgetGuard, createBudgetRecorder } from './budget-guard.js'
import type { HookContext } from '../../types.js'

let dataPath: string
beforeEach(async () => {
  dataPath = await mkdtemp(join(tmpdir(), 'budget-guard-test-'))
})
afterEach(async () => {
  await rm(dataPath, { recursive: true, force: true })
})

function makeConfig(overrides: Partial<BudgetConfig> = {}): BudgetConfig {
  return {
    global: { perSession: 10_000, perDay: 100_000, ...(overrides.global ?? {}) },
    main: { perTask: 1000, warnRatio: 0.8, overBehavior: 'block', ...(overrides.main ?? {}) },
    subAgent: {
      enabled: true,
      defaultPerTask: 500,
      warnRatio: 0.8,
      overBehavior: 'downgrade',
      downgradeModel: 'haiku',
      ...(overrides.subAgent ?? {}),
    },
  }
}

function makeContext(
  agent: HookContext['agent'],
  data: { history?: Array<{ role: string; content: string }>; estimatedTokens?: number; model?: string } = {},
): HookContext {
  return {
    trigger: 'before:llm-call',
    data,
    agent,
  }
}

describe('budget-guard — Layer 3 (global)', () => {
  it('throws when session ceiling exceeded', async () => {
    const m = new BudgetManager(makeConfig({ global: { perSession: 100, perDay: 1000 } }), dataPath)
    await m.init()
    m.recordUsage({ sessionId: 's1' }, 95)
    const guard = createBudgetGuard(m)
    await expect(
      guard.handler(
        makeContext(
          { sessionId: 's1', totalCost: 0, tokenCount: 0 },
          { estimatedTokens: 50 },
        ),
      ),
    ).rejects.toThrow(/session token ceiling/)
  })
})

describe('budget-guard — Layer 2 (main)', () => {
  it('block policy → throws on over', async () => {
    const m = new BudgetManager(makeConfig(), dataPath)
    await m.init()
    m.recordUsage({ sessionId: 's1', taskId: 't1' }, 950)
    const guard = createBudgetGuard(m)
    await expect(
      guard.handler(
        makeContext(
          { sessionId: 's1', taskId: 't1', totalCost: 0, tokenCount: 0 },
          { estimatedTokens: 100 },
        ),
      ),
    ).rejects.toThrow(/main task budget exceeded/)
  })

  it('warn-only policy → allows but warns', async () => {
    const cfg = makeConfig()
    cfg.main.overBehavior = 'warn-only'
    const m = new BudgetManager(cfg, dataPath)
    await m.init()
    m.recordUsage({ sessionId: 's1', taskId: 't1' }, 950)
    const guard = createBudgetGuard(m)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await guard.handler(
      makeContext(
        { sessionId: 's1', taskId: 't1', totalCost: 0, tokenCount: 0 },
        { estimatedTokens: 100 },
      ),
    )
    expect(result).toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('budget-guard — Layer 1 (sub-agent)', () => {
  it('skipped entirely when subAgent.enabled === false', async () => {
    const cfg = makeConfig()
    cfg.subAgent.enabled = false
    const m = new BudgetManager(cfg, dataPath)
    await m.init()
    // Burn through the per-task budget
    m.recordUsage({ sessionId: 's1', subAgentTaskId: 'sa1' }, 600)
    const guard = createBudgetGuard(m)
    const result = await guard.handler(
      makeContext(
        {
          sessionId: 's1',
          subAgentTaskId: 'sa1',
          subAgentTokenBudget: 500,
          totalCost: 0,
          tokenCount: 0,
        },
        { estimatedTokens: 100 },
      ),
    )
    expect(result).toBeUndefined()
  })

  it('downgrade policy → returns mutated model', async () => {
    const m = new BudgetManager(makeConfig(), dataPath)
    await m.init()
    m.recordUsage({ sessionId: 's1', subAgentTaskId: 'sa1' }, 480)
    const guard = createBudgetGuard(m)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = (await guard.handler(
      makeContext(
        {
          sessionId: 's1',
          subAgentTaskId: 'sa1',
          subAgentTokenBudget: 500,
          totalCost: 0,
          tokenCount: 0,
        },
        { estimatedTokens: 100, history: [{ role: 'user', content: 'x' }] },
      ),
    )) as { model?: string; history?: unknown }
    expect(result?.model).toBe('haiku')
    // Original data preserved
    expect(result?.history).toEqual([{ role: 'user', content: 'x' }])
    warn.mockRestore()
  })

  it('downgrade misconfigured (empty downgradeModel) falls back to block', async () => {
    const cfg = makeConfig()
    cfg.subAgent.downgradeModel = ''
    const m = new BudgetManager(cfg, dataPath)
    await m.init()
    m.recordUsage({ sessionId: 's1', subAgentTaskId: 'sa1' }, 480)
    const guard = createBudgetGuard(m)
    await expect(
      guard.handler(
        makeContext(
          {
            sessionId: 's1',
            subAgentTaskId: 'sa1',
            subAgentTokenBudget: 500,
            totalCost: 0,
            tokenCount: 0,
          },
          { estimatedTokens: 100 },
        ),
      ),
    ).rejects.toThrow(/downgradeModel is empty/)
  })

  it('block policy → throws', async () => {
    const cfg = makeConfig()
    cfg.subAgent.overBehavior = 'block'
    const m = new BudgetManager(cfg, dataPath)
    await m.init()
    m.recordUsage({ sessionId: 's1', subAgentTaskId: 'sa1' }, 480)
    const guard = createBudgetGuard(m)
    await expect(
      guard.handler(
        makeContext(
          {
            sessionId: 's1',
            subAgentTaskId: 'sa1',
            subAgentTokenBudget: 500,
            totalCost: 0,
            tokenCount: 0,
          },
          { estimatedTokens: 100 },
        ),
      ),
    ).rejects.toThrow(/sub-agent task budget exceeded/)
  })

  it('warn-only policy → allows but warns', async () => {
    const cfg = makeConfig()
    cfg.subAgent.overBehavior = 'warn-only'
    const m = new BudgetManager(cfg, dataPath)
    await m.init()
    m.recordUsage({ sessionId: 's1', subAgentTaskId: 'sa1' }, 480)
    const guard = createBudgetGuard(m)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await guard.handler(
      makeContext(
        {
          sessionId: 's1',
          subAgentTaskId: 'sa1',
          subAgentTokenBudget: 500,
          totalCost: 0,
          tokenCount: 0,
        },
        { estimatedTokens: 100 },
      ),
    )
    expect(result).toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('budget-guard — hot reload via updateConfig', () => {
  it('switches policy mid-flight without re-registering hook', async () => {
    const m = new BudgetManager(makeConfig(), dataPath)
    await m.init()
    m.recordUsage({ sessionId: 's1', subAgentTaskId: 'sa1' }, 480)
    const guard = createBudgetGuard(m)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // First call: downgrade
    const ctx = makeContext(
      {
        sessionId: 's1',
        subAgentTaskId: 'sa1',
        subAgentTokenBudget: 500,
        totalCost: 0,
        tokenCount: 0,
      },
      { estimatedTokens: 100 },
    )
    const r1 = (await guard.handler(ctx)) as { model?: string }
    expect(r1?.model).toBe('haiku')

    // Hot-swap to block
    const cfg2 = makeConfig()
    cfg2.subAgent.overBehavior = 'block'
    m.updateConfig(cfg2)

    await expect(guard.handler(ctx)).rejects.toThrow(/sub-agent task budget exceeded/)
    warn.mockRestore()
  })
})

describe('budget-recorder', () => {
  it('feeds prompt+completion tokens back into the BudgetManager', async () => {
    const m = new BudgetManager(makeConfig(), dataPath)
    await m.init()
    const rec = createBudgetRecorder(m)
    const ctx: HookContext = {
      trigger: 'after:llm-call',
      data: {
        model: 'foo',
        provider: 'anthropic',
        latency: 10,
        tokens: { prompt: 30, completion: 70, total: 100 },
        cost: 0,
        timestamp: Date.now(),
      },
      agent: { sessionId: 's1', taskId: 't1', totalCost: 0, tokenCount: 0 },
    }
    await rec.handler(ctx)
    expect(m.getSessionUsage('s1')).toBe(100)
  })

  it('no-ops when tokens missing', async () => {
    const m = new BudgetManager(makeConfig(), dataPath)
    await m.init()
    const rec = createBudgetRecorder(m)
    await rec.handler({
      trigger: 'after:llm-call',
      data: undefined,
      agent: { sessionId: 's1', totalCost: 0, tokenCount: 0 },
    })
    expect(m.getSessionUsage('s1')).toBe(0)
  })
})
