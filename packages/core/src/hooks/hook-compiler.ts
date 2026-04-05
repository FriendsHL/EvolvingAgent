import { nanoid } from 'nanoid'
import type { Hook, HookContext, HookTrigger } from '../types.js'

export interface HookDraft {
  trigger: HookTrigger
  condition: string
  action: string
  reason: string
}

export interface CompiledHook {
  hook: Hook
  source: HookDraft
}

// Keyword patterns for handler selection
const RATE_LIMIT_KEYWORDS = ['too many', 'rate', '频率', 'throttle', 'limit calls', 'flood']
const COST_GUARD_KEYWORDS = ['cost', 'expensive', '费用', 'budget', 'spending', 'price']
const TOOL_BLOCK_KEYWORDS = ['dangerous', 'block', '禁止', 'forbid', 'deny', 'prevent', 'rm -rf', 'drop table']
const LOGGING_KEYWORDS = ['log', '记录', 'track', 'audit', 'monitor', 'observe']

function matchesKeywords(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase()
  return keywords.some((kw) => lower.includes(kw))
}

function buildRateLimitHandler(draft: HookDraft): (context: HookContext) => Promise<unknown> {
  // Extract a numeric threshold from the condition if present, default to 10
  const numMatch = draft.condition.match(/(\d+)/)
  const threshold = numMatch ? parseInt(numMatch[1], 10) : 10
  const windowMs = 60_000 // 1-minute window

  let callTimestamps: number[] = []

  return async (context: HookContext) => {
    const now = Date.now()
    // Prune timestamps outside the window
    callTimestamps = callTimestamps.filter((ts) => now - ts < windowMs)
    callTimestamps.push(now)

    if (callTimestamps.length > threshold) {
      throw new Error(`Hook blocked: rate limit exceeded (${callTimestamps.length}/${threshold} in ${windowMs}ms) — ${draft.reason}`)
    }
    return context.data
  }
}

function buildCostGuardHandler(draft: HookDraft): (context: HookContext) => Promise<unknown> {
  // Extract a numeric threshold from the condition if present, default to 1.0
  const numMatch = draft.condition.match(/([\d.]+)/)
  const threshold = numMatch ? parseFloat(numMatch[1]) : 1.0

  return async (context: HookContext) => {
    if (context.agent.totalCost > threshold) {
      throw new Error(`Hook blocked: cost $${context.agent.totalCost.toFixed(4)} exceeds threshold $${threshold} — ${draft.reason}`)
    }
    return context.data
  }
}

function buildToolBlockHandler(draft: HookDraft): (context: HookContext) => Promise<unknown> {
  // Extract blocked patterns from condition/action
  const blockedPatterns: string[] = []
  const patterns = draft.condition.match(/'([^']+)'|"([^"]+)"|`([^`]+)`/g)
  if (patterns) {
    for (const p of patterns) {
      blockedPatterns.push(p.replace(/['"`]/g, ''))
    }
  }
  // Also check for common dangerous patterns
  if (draft.condition.toLowerCase().includes('rm -rf')) blockedPatterns.push('rm -rf')
  if (draft.condition.toLowerCase().includes('drop table')) blockedPatterns.push('drop table')

  return async (context: HookContext) => {
    const data = context.data as { toolName?: string; params?: Record<string, unknown> } | undefined
    if (!data) return context.data

    const paramsStr = JSON.stringify(data.params ?? {}).toLowerCase()
    const toolName = (data.toolName ?? '').toLowerCase()

    for (const pattern of blockedPatterns) {
      if (paramsStr.includes(pattern.toLowerCase()) || toolName.includes(pattern.toLowerCase())) {
        throw new Error(`Hook blocked: matched dangerous pattern "${pattern}" — ${draft.reason}`)
      }
    }
    return context.data
  }
}

function buildLoggingHandler(draft: HookDraft): (context: HookContext) => Promise<unknown> {
  return async (context: HookContext) => {
    console.log(`[Hook:${draft.trigger}] ${draft.reason}`, context.data)
    return context.data
  }
}

function buildGenericHandler(draft: HookDraft): (context: HookContext) => Promise<unknown> {
  return async (_context: HookContext) => {
    console.warn(`[Evolved Hook] ${draft.condition}: ${draft.action}`)
    return undefined
  }
}

function selectHandler(draft: HookDraft): (context: HookContext) => Promise<unknown> {
  const combined = `${draft.condition} ${draft.action}`

  if (matchesKeywords(combined, RATE_LIMIT_KEYWORDS)) return buildRateLimitHandler(draft)
  if (matchesKeywords(combined, COST_GUARD_KEYWORDS)) return buildCostGuardHandler(draft)
  if (matchesKeywords(combined, TOOL_BLOCK_KEYWORDS)) return buildToolBlockHandler(draft)
  if (matchesKeywords(combined, LOGGING_KEYWORDS)) return buildLoggingHandler(draft)
  return buildGenericHandler(draft)
}

export class HookCompiler {
  /**
   * Compile a HookDraft into a Hook object.
   * The handler function is generated from the condition + action using pattern matching.
   */
  compile(draft: HookDraft): CompiledHook {
    const hook: Hook = {
      id: `hook-evolved-${nanoid(8)}`,
      name: `Evolved: ${draft.reason.slice(0, 60)}`,
      description: `${draft.condition} → ${draft.action}`,
      trigger: draft.trigger,
      priority: 50,
      enabled: true,
      source: 'evolved-new',
      handler: selectHandler(draft),
      health: {
        consecutiveFailures: 0,
        totalRuns: 0,
        successRate: 1.0,
      },
      safety: {
        timeout: 5000,
        maxRetries: 0,
        fallbackBehavior: 'skip',
        canBeDisabledByAgent: true,
      },
    }

    return { hook, source: draft }
  }
}
