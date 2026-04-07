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

/** Over-budget behavior allowed for the main user-task layer. */
export type OverBehavior = 'block' | 'warn-only'

/** Over-budget behavior allowed for the sub-agent layer (downgrade is sub-agent only). */
export type SubAgentOverBehavior = 'block' | 'downgrade' | 'warn-only'

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
    /** Action when the main task budget is exceeded. */
    overBehavior: OverBehavior
  }
  subAgent: {
    /** Master switch — when false, Layer 1 enforcement is skipped entirely. */
    enabled: boolean
    /** Default per-task budget when TaskAssign.config.tokenBudget is not provided. */
    defaultPerTask: number
    /** Warn ratio (0..1). */
    warnRatio: number
    /** Action when the sub-agent task budget is exceeded. */
    overBehavior: SubAgentOverBehavior
    /** Required when overBehavior === 'downgrade'. The model id to switch to. */
    downgradeModel: string
  }
}

/**
 * Discriminated check result. The `BudgetManager.check*` methods only report
 * the raw situation (allow / warn / over / global block); the budget-guard
 * hook owns the policy decision (block vs downgrade vs warn-only).
 */
export type BudgetCheck =
  | { decision: 'allow' }
  | { decision: 'warn'; ratio: number }
  | { decision: 'over'; ratio: number; reason: string; layer: 'main' | 'sub-agent' }
  | { decision: 'block'; reason: string; layer: 'global' }

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
    overBehavior: 'block',
  },
  subAgent: {
    enabled: true,
    defaultPerTask: 50_000,
    warnRatio: 0.8,
    overBehavior: 'downgrade',
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
  private dataPath: string
  private dailyPath: string

  // In-memory counters (process lifetime only — NOT persisted).
  private sessionTotals = new Map<string, number>()
  private mainTaskTotals = new Map<string, number>()
  private subAgentTaskTotals = new Map<string, number>()

  // Rolling daily usage (persisted). Keyed by YYYY-MM-DD.
  private daily: DailyFile = {}
  private dirty = false

  constructor(config: BudgetConfig, dataPath: string) {
    this.config = cloneBudgetConfig(config)
    this.dataPath = dataPath
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
    const ratio = projected / budget
    if (projected > budget) {
      return {
        decision: 'over',
        ratio,
        reason: `main task budget exceeded (${used}/${budget}, +${estimatedTokens} requested)`,
        layer: 'main',
      }
    }
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
    const ratio = projected / effectiveBudget
    if (projected > effectiveBudget) {
      return {
        decision: 'over',
        ratio,
        reason: `sub-agent task budget exceeded (${used}/${effectiveBudget}, +${estimatedTokens} requested)`,
        layer: 'sub-agent',
      }
    }
    if (ratio >= this.config.subAgent.warnRatio) {
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

  /**
   * Returns a deep clone of the current effective config so external callers
   * (REST endpoints, dashboards) cannot mutate the live config in place.
   */
  getConfig(): BudgetConfig {
    return cloneBudgetConfig(this.config)
  }

  /**
   * Hot-swap the live config. In-memory counters (session/main/sub-agent
   * totals + persisted daily) are intentionally preserved — only the config
   * reference is replaced. Any subsequent `check*` calls use the new policy
   * immediately.
   */
  updateConfig(cfg: BudgetConfig): void {
    this.config = cloneBudgetConfig(cfg)
  }

  /** Persist the current config to `<dataPath>/config/budget.json`. */
  async saveConfig(): Promise<void> {
    const configPath = join(this.dataPath, 'config', 'budget.json')
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, JSON.stringify(this.config, null, 2), 'utf-8')
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
 * Deep-clone a BudgetConfig. Used by `getConfig` / `updateConfig` so callers
 * cannot mutate the live policy in place.
 */
export function cloneBudgetConfig(cfg: BudgetConfig): BudgetConfig {
  return {
    global: { ...cfg.global },
    main: { ...cfg.main },
    subAgent: { ...cfg.subAgent },
  }
}

/**
 * Load budget config from `<dataPath>/config/budget.json`. Missing file or
 * partial config falls back to DEFAULT_BUDGET_CONFIG field-by-field, so an
 * older on-disk config without the new Phase 3 Batch 4 fields (overBehavior,
 * subAgent.enabled) keeps working without manual migration.
 */
export async function loadBudgetConfig(dataPath: string): Promise<BudgetConfig> {
  const configPath = join(dataPath, 'config', 'budget.json')
  try {
    const raw = await readFile(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as DeepPartial<BudgetConfig>
    return {
      global: { ...DEFAULT_BUDGET_CONFIG.global, ...(parsed.global ?? {}) },
      main: { ...DEFAULT_BUDGET_CONFIG.main, ...(parsed.main ?? {}) },
      subAgent: { ...DEFAULT_BUDGET_CONFIG.subAgent, ...(parsed.subAgent ?? {}) },
    }
  } catch {
    return cloneBudgetConfig(DEFAULT_BUDGET_CONFIG)
  }
}

type DeepPartial<T> = { [K in keyof T]?: Partial<T[K]> }
