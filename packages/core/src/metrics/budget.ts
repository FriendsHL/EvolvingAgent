// ============================================================
// BudgetManager — three-layer token budget enforcement
// ============================================================
//
// Layer 1 (Self):    each Sub-Agent stops itself before its per-task budget
//                    (carried via TaskAssign.config.tokenBudget) is exhausted.
// Layer 2 (Main):    the Main Agent tracks aggregate token usage for the
//                    in-flight user task and rejects further LLM calls when
//                    over budget.
// Layer 3 (Global):  process-wide ceilings per session and per calendar day
//                    (persisted to disk so restarts still honor the day cap).
//
// See `docs/design/sub-agent.md` "Token Budget Control (Three Layers)" for
// the product spec. All checks return a discriminated `BudgetCheck` so the
// caller (the budget-guard hook) can decide whether to allow, warn, downgrade,
// or block the outgoing LLM call.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ModelMessage } from 'ai'

export interface BudgetConfig {
  global: {
    /** Hard ceiling per session — sum of all LLM calls in one Agent session. */
    perSession: number
    /** Hard ceiling per calendar day — sum across every session in the process. */
    perDay: number
  }
  main: {
    /** Soft budget for one user-input "task" in the main agent. */
    perTask: number
    /** Warn ratio (0..1). When current/budget crosses this, emit a warn. */
    warnRatio: number
  }
  subAgent: {
    /** Default per-task budget when TaskAssign.config.tokenBudget is not provided. */
    defaultPerTask: number
    /** Warn ratio (0..1). */
    warnRatio: number
    /** If set, sub-agent calls over warnRatio switch to this cheaper model. */
    downgradeModel?: string
  }
}

export type BudgetCheck =
  | { decision: 'allow' }
  | { decision: 'warn'; ratio: number }
  | { decision: 'downgrade'; toModel: string; reason: string }
  | { decision: 'block'; reason: string; layer: 'global' | 'main' | 'sub-agent' }

export interface BudgetUsageScope {
  sessionId: string
  taskId?: string
  subAgentTaskId?: string
}

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  global: {
    perSession: 2_000_000,
    perDay: 10_000_000,
  },
  main: {
    perTask: 200_000,
    warnRatio: 0.8,
  },
  subAgent: {
    defaultPerTask: 50_000,
    warnRatio: 0.8,
    downgradeModel: 'claude-haiku-4-5-20251001',
  },
}

// Rolling daily map kept to this many days on disk.
const DAILY_RETENTION_DAYS = 30

/** Crude token estimator. Good enough for a pre-call "would this fit?" check. */
export function estimateMessageTokens(messages: ModelMessage[] | undefined): number {
  if (!messages || messages.length === 0) return 0
  let chars = 0
  for (const m of messages) {
    const content = m.content
    if (typeof content === 'string') {
      chars += content.length
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === 'object' && part && 'text' in part && typeof (part as { text?: unknown }).text === 'string') {
          chars += ((part as { text: string }).text).length
        }
      }
    }
  }
  // TODO(tokenizer): replace with a real tokenizer (tiktoken / anthropic-tokenizer)
  // — the 1-token-per-4-chars heuristic biases toward English prose.
  return Math.ceil(chars / 4)
}

/** Estimate tokens from a `{history: [{role, content}]}` payload (hook data shape). */
export function estimateHistoryTokens(history: Array<{ content: string }> | undefined): number {
  if (!history || history.length === 0) return 0
  let chars = 0
  for (const m of history) chars += m.content.length
  return Math.ceil(chars / 4)
}

function todayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

interface DailyFile {
  [date: string]: number
}

export class BudgetManager {
  private config: BudgetConfig
  private dailyPath: string

  // In-memory counters (process lifetime only — NOT persisted).
  private sessionTotals = new Map<string, number>()
  private mainTaskTotals = new Map<string, number>()
  private subAgentTaskTotals = new Map<string, number>()

  // Rolling daily usage (persisted). Keyed by YYYY-MM-DD.
  private daily: DailyFile = {}
  private dirty = false

  constructor(config: BudgetConfig, dataPath: string) {
    this.config = config
    this.dailyPath = join(dataPath, 'metrics', 'budget-daily.json')
  }

  /** Load today's daily counter from disk (and drop anything older than 30 days). */
  async init(): Promise<void> {
    try {
      const raw = await readFile(this.dailyPath, 'utf-8')
      const parsed = JSON.parse(raw) as DailyFile
      this.daily = this.pruneDaily(parsed)
    } catch {
      this.daily = {}
    }
  }

  private pruneDaily(map: DailyFile): DailyFile {
    const keys = Object.keys(map).sort()
    if (keys.length <= DAILY_RETENTION_DAYS) return { ...map }
    const kept: DailyFile = {}
    for (const k of keys.slice(keys.length - DAILY_RETENTION_DAYS)) {
      kept[k] = map[k]
    }
    return kept
  }

  // ----------------------------------------------------------
  // Layer 3: global (session + daily)
  // ----------------------------------------------------------

  checkGlobal(sessionId: string, estimatedTokens: number): BudgetCheck {
    const sessionUsed = this.sessionTotals.get(sessionId) ?? 0
    if (sessionUsed + estimatedTokens > this.config.global.perSession) {
      return {
        decision: 'block',
        reason: `session token ceiling reached (${sessionUsed}/${this.config.global.perSession}, +${estimatedTokens} requested)`,
        layer: 'global',
      }
    }
    const dayUsed = this.daily[todayKey()] ?? 0
    if (dayUsed + estimatedTokens > this.config.global.perDay) {
      return {
        decision: 'block',
        reason: `daily token ceiling reached (${dayUsed}/${this.config.global.perDay}, +${estimatedTokens} requested)`,
        layer: 'global',
      }
    }
    return { decision: 'allow' }
  }

  // ----------------------------------------------------------
  // Layer 2: main-agent per-task
  // ----------------------------------------------------------

  checkMain(taskId: string, estimatedTokens: number): BudgetCheck {
    const used = this.mainTaskTotals.get(taskId) ?? 0
    const budget = this.config.main.perTask
    const projected = used + estimatedTokens
    if (projected > budget) {
      return {
        decision: 'block',
        reason: `main task budget exceeded (${used}/${budget}, +${estimatedTokens} requested)`,
        layer: 'main',
      }
    }
    const ratio = projected / budget
    if (ratio >= this.config.main.warnRatio) {
      return { decision: 'warn', ratio }
    }
    return { decision: 'allow' }
  }

  // ----------------------------------------------------------
  // Layer 1: sub-agent per-task
  // ----------------------------------------------------------

  checkSubAgent(
    subAgentTaskId: string,
    budget: number | undefined,
    estimatedTokens: number,
  ): BudgetCheck {
    const effectiveBudget = budget && budget > 0 ? budget : this.config.subAgent.defaultPerTask
    const used = this.subAgentTaskTotals.get(subAgentTaskId) ?? 0
    const projected = used + estimatedTokens
    if (projected > effectiveBudget) {
      return {
        decision: 'block',
        reason: `sub-agent task budget exceeded (${used}/${effectiveBudget}, +${estimatedTokens} requested)`,
        layer: 'sub-agent',
      }
    }
    const ratio = projected / effectiveBudget
    if (ratio >= this.config.subAgent.warnRatio) {
      if (this.config.subAgent.downgradeModel) {
        return {
          decision: 'downgrade',
          toModel: this.config.subAgent.downgradeModel,
          reason: `sub-agent task over warn ratio (${ratio.toFixed(2)}) — downgrading to cheaper model`,
        }
      }
      return { decision: 'warn', ratio }
    }
    return { decision: 'allow' }
  }

  // ----------------------------------------------------------
  // Recording
  // ----------------------------------------------------------

  recordUsage(scope: BudgetUsageScope, tokens: number): void {
    if (tokens <= 0) return

    // Session (global layer)
    this.sessionTotals.set(
      scope.sessionId,
      (this.sessionTotals.get(scope.sessionId) ?? 0) + tokens,
    )

    // Day (global layer — persisted)
    const key = todayKey()
    this.daily[key] = (this.daily[key] ?? 0) + tokens
    this.dirty = true

    // Main task
    if (scope.taskId) {
      this.mainTaskTotals.set(
        scope.taskId,
        (this.mainTaskTotals.get(scope.taskId) ?? 0) + tokens,
      )
    }

    // Sub-agent task
    if (scope.subAgentTaskId) {
      this.subAgentTaskTotals.set(
        scope.subAgentTaskId,
        (this.subAgentTaskTotals.get(scope.subAgentTaskId) ?? 0) + tokens,
      )
    }
  }

  /** Drop per-task counters once a task terminates (keeps memory bounded). */
  clearMainTask(taskId: string): void {
    this.mainTaskTotals.delete(taskId)
  }

  clearSubAgentTask(subAgentTaskId: string): void {
    this.subAgentTaskTotals.delete(subAgentTaskId)
  }

  // ----------------------------------------------------------
  // Introspection
  // ----------------------------------------------------------

  getSessionUsage(sessionId: string): number {
    return this.sessionTotals.get(sessionId) ?? 0
  }

  getDailyUsage(date = todayKey()): number {
    return this.daily[date] ?? 0
  }

  getConfig(): BudgetConfig {
    return this.config
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  async flush(): Promise<void> {
    if (!this.dirty) return
    try {
      await mkdir(dirname(this.dailyPath), { recursive: true })
      const pruned = this.pruneDaily(this.daily)
      this.daily = pruned
      await writeFile(this.dailyPath, JSON.stringify(pruned, null, 2), 'utf-8')
      this.dirty = false
    } catch (err) {
      // Non-fatal: budget persistence is best-effort.
      console.warn(
        `[BudgetManager] Failed to persist daily counter:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  async shutdown(): Promise<void> {
    await this.flush()
  }
}

// ============================================================
// Config loader
// ============================================================

/**
 * Load budget config from `<dataPath>/config/budget.json`. Missing file or
 * partial config falls back to DEFAULT_BUDGET_CONFIG on a per-field basis.
 */
export async function loadBudgetConfig(dataPath: string): Promise<BudgetConfig> {
  const configPath = join(dataPath, 'config', 'budget.json')
  try {
    const raw = await readFile(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<BudgetConfig>
    return {
      global: { ...DEFAULT_BUDGET_CONFIG.global, ...(parsed.global ?? {}) },
      main: { ...DEFAULT_BUDGET_CONFIG.main, ...(parsed.main ?? {}) },
      subAgent: { ...DEFAULT_BUDGET_CONFIG.subAgent, ...(parsed.subAgent ?? {}) },
    }
  } catch {
    return { ...DEFAULT_BUDGET_CONFIG }
  }
}
