import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BudgetManager,
  DEFAULT_BUDGET_CONFIG,
  cloneBudgetConfig,
  loadBudgetConfig,
  estimateMessageTokens,
  estimateHistoryTokens,
} from './budget.js'
import type { BudgetConfig } from './budget.js'

let dataPath: string

beforeEach(async () => {
  dataPath = await mkdtemp(join(tmpdir(), 'budget-test-'))
})
afterEach(async () => {
  await rm(dataPath, { recursive: true, force: true })
})

function smallConfig(): BudgetConfig {
  return {
    global: { perSession: 1000, perDay: 5000 },
    main: { perTask: 500, warnRatio: 0.8, overBehavior: 'block' },
    subAgent: {
      enabled: true,
      defaultPerTask: 200,
      warnRatio: 0.8,
      overBehavior: 'downgrade',
      downgradeModel: 'haiku',
    },
  }
}

describe('estimateHistoryTokens', () => {
  it('returns 0 for empty/undefined', () => {
    expect(estimateHistoryTokens(undefined)).toBe(0)
    expect(estimateHistoryTokens([])).toBe(0)
  })
  it('computes ceil(chars/4)', () => {
    expect(estimateHistoryTokens([{ content: 'abcd' }, { content: 'ef' }])).toBe(2)
    expect(estimateHistoryTokens([{ content: 'abc' }])).toBe(1)
  })
})

describe('estimateMessageTokens', () => {
  it('handles string content', () => {
    expect(estimateMessageTokens([{ role: 'user', content: 'abcdefgh' } as any])).toBe(2)
  })
  it('handles array content with text parts', () => {
    expect(
      estimateMessageTokens([
        {
          role: 'user',
          content: [{ type: 'text', text: 'abcd' }, { type: 'text', text: 'efgh' }],
        } as any,
      ]),
    ).toBe(2)
  })
})

describe('cloneBudgetConfig', () => {
  it('returns a deep clone — mutating result does not affect source', () => {
    const a = smallConfig()
    const b = cloneBudgetConfig(a)
    b.subAgent.downgradeModel = 'mutated'
    b.global.perDay = 999
    expect(a.subAgent.downgradeModel).toBe('haiku')
    expect(a.global.perDay).toBe(5000)
  })
})

describe('BudgetManager — Layer 3 global', () => {
  it('allows when under both ceilings', async () => {
    const m = new BudgetManager(smallConfig(), dataPath)
    await m.init()
    expect(m.checkGlobal('s1', 100).decision).toBe('allow')
  })

  it('blocks when session ceiling exceeded', async () => {
    const m = new BudgetManager(smallConfig(), dataPath)
    await m.init()
    m.recordUsage({ sessionId: 's1' }, 950)
    const r = m.checkGlobal('s1', 100)
    expect(r.decision).toBe('block')
    if (r.decision === 'block') expect(r.layer).toBe('global')
  })

  it('blocks when daily ceiling exceeded', async () => {
    const m = new BudgetManager(smallConfig(), dataPath)
    await m.init()
    m.recordUsage({ sessionId: 's1' }, 4900)
    const r = m.checkGlobal('s2', 200)
    expect(r.decision).toBe('block')
  })
})

describe('BudgetManager — Layer 2 main', () => {
  it('allow → warn → over progression', async () => {
    const m = new BudgetManager(smallConfig(), dataPath)
    await m.init()
    expect(m.checkMain('t1', 100).decision).toBe('allow')
    m.recordUsage({ sessionId: 's1', taskId: 't1' }, 400)
    const warn = m.checkMain('t1', 10)
    expect(warn.decision).toBe('warn')
    const over = m.checkMain('t1', 200)
    expect(over.decision).toBe('over')
    if (over.decision === 'over') expect(over.layer).toBe('main')
  })

  it('clearMainTask drops counters', async () => {
    const m = new BudgetManager(smallConfig(), dataPath)
    await m.init()
    m.recordUsage({ sessionId: 's1', taskId: 't1' }, 400)
    m.clearMainTask('t1')
    expect(m.checkMain('t1', 100).decision).toBe('allow')
  })
})

describe('BudgetManager — Layer 1 sub-agent', () => {
  it('honors per-task budget override', async () => {
    const m = new BudgetManager(smallConfig(), dataPath)
    await m.init()
    // Custom budget=50 → 60 should immediately be over
    expect(m.checkSubAgent('sa1', 50, 60).decision).toBe('over')
  })

  it('falls back to defaultPerTask when budget is undefined', async () => {
    const m = new BudgetManager(smallConfig(), dataPath)
    await m.init()
    // default=200 → 100 allowed, 250 over
    expect(m.checkSubAgent('sa1', undefined, 100).decision).toBe('allow')
    expect(m.checkSubAgent('sa2', undefined, 250).decision).toBe('over')
  })
})

describe('BudgetManager — updateConfig hot-swap', () => {
  it('subsequent checks use new policy without resetting counters', async () => {
    const m = new BudgetManager(smallConfig(), dataPath)
    await m.init()
    m.recordUsage({ sessionId: 's1', taskId: 't1' }, 400)
    // Tighten the main budget so the recorded usage is now over
    const tightened = smallConfig()
    tightened.main.perTask = 100
    m.updateConfig(tightened)
    const r = m.checkMain('t1', 1)
    expect(r.decision).toBe('over')
    // Counters preserved
    expect(m.getSessionUsage('s1')).toBe(400)
  })

  it('getConfig returns a clone — external mutation does not leak', async () => {
    const m = new BudgetManager(smallConfig(), dataPath)
    await m.init()
    const c = m.getConfig()
    c.subAgent.downgradeModel = 'EVIL'
    expect(m.getConfig().subAgent.downgradeModel).toBe('haiku')
  })
})

describe('BudgetManager — saveConfig + loadBudgetConfig roundtrip', () => {
  it('writes config/budget.json and is reloadable', async () => {
    const m = new BudgetManager(smallConfig(), dataPath)
    await m.init()
    await m.saveConfig()
    const reloaded = await loadBudgetConfig(dataPath)
    expect(reloaded.subAgent.downgradeModel).toBe('haiku')
    expect(reloaded.main.overBehavior).toBe('block')
  })
})

describe('loadBudgetConfig — backward compat', () => {
  it('returns DEFAULT_BUDGET_CONFIG clone when file missing', async () => {
    const cfg = await loadBudgetConfig(dataPath)
    expect(cfg.subAgent.enabled).toBe(DEFAULT_BUDGET_CONFIG.subAgent.enabled)
    expect(cfg.main.overBehavior).toBe(DEFAULT_BUDGET_CONFIG.main.overBehavior)
  })

  it('merges old partial configs with defaults field-by-field', async () => {
    // Simulate an old on-disk config missing the new Phase 3 Batch 4 fields
    await mkdir(join(dataPath, 'config'), { recursive: true })
    await writeFile(
      join(dataPath, 'config', 'budget.json'),
      JSON.stringify({
        global: { perSession: 12345 },
        main: { perTask: 999 },
        subAgent: { defaultPerTask: 77 },
      }),
    )
    const cfg = await loadBudgetConfig(dataPath)
    expect(cfg.global.perSession).toBe(12345)
    // Inherited from defaults
    expect(cfg.global.perDay).toBe(DEFAULT_BUDGET_CONFIG.global.perDay)
    expect(cfg.main.overBehavior).toBe(DEFAULT_BUDGET_CONFIG.main.overBehavior)
    expect(cfg.subAgent.enabled).toBe(DEFAULT_BUDGET_CONFIG.subAgent.enabled)
    expect(cfg.subAgent.overBehavior).toBe(DEFAULT_BUDGET_CONFIG.subAgent.overBehavior)
    expect(cfg.subAgent.defaultPerTask).toBe(77)
  })
})

describe('BudgetManager — daily persistence', () => {
  it('flush writes the daily counter and shutdown is idempotent', async () => {
    const m = new BudgetManager(smallConfig(), dataPath)
    await m.init()
    m.recordUsage({ sessionId: 's1' }, 50)
    await m.flush()
    const raw = await readFile(join(dataPath, 'metrics', 'budget-daily.json'), 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, number>
    const today = new Date().toISOString().slice(0, 10)
    expect(parsed[today]).toBe(50)
    await m.shutdown() // no-op since not dirty
  })
})
