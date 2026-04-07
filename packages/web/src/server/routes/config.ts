import { Hono } from 'hono'
import type { SessionManager, BudgetConfig, OverBehavior, SubAgentOverBehavior } from '@evolving-agent/core'

/**
 * Phase 3 Batch 4 — user-configurable token budget policy.
 *
 * GET  /api/config/budget  → returns the live BudgetManager config
 * PUT  /api/config/budget  → full-replace + hot-reload (no restart)
 *
 * Validation rejects nonsensical values (negative tokens, out-of-range warn
 * ratios, downgrade configured without a target model, downgrade attempted on
 * the main layer, etc.) with HTTP 400 and a clear error message listing every
 * invalid field.
 */
export function configRoutes(manager: SessionManager) {
  const app = new Hono()

  app.get('/budget', (c) => {
    const config = manager.getBudgetManager().getConfig()
    return c.json({ config })
  })

  app.put('/budget', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Body must be JSON' }, 400)
    }

    const result = validateBudgetConfig(body)
    if (!result.ok) {
      return c.json({ error: 'Invalid budget config', details: result.errors }, 400)
    }

    const budgetManager = manager.getBudgetManager()
    budgetManager.updateConfig(result.value)
    try {
      await budgetManager.saveConfig()
    } catch (err) {
      return c.json(
        {
          error: 'Failed to persist budget config',
          message: err instanceof Error ? err.message : String(err),
        },
        500,
      )
    }
    return c.json({ config: budgetManager.getConfig() })
  })

  return app
}

// ============================================================
// Validation
// ============================================================

const MAIN_OVER_BEHAVIORS: ReadonlyArray<OverBehavior> = ['block', 'warn-only']
const SUB_OVER_BEHAVIORS: ReadonlyArray<SubAgentOverBehavior> = ['block', 'downgrade', 'warn-only']

interface ValidationOk {
  ok: true
  value: BudgetConfig
}
interface ValidationFail {
  ok: false
  errors: string[]
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function checkPositiveInt(errs: string[], path: string, v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v <= 0) {
    errs.push(`${path} must be a positive integer`)
    return null
  }
  return v
}

function checkRatio(errs: string[], path: string, v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
    errs.push(`${path} must be a number in [0, 1]`)
    return null
  }
  return v
}

function validateBudgetConfig(body: unknown): ValidationOk | ValidationFail {
  const errors: string[] = []
  if (!isObj(body)) {
    return { ok: false, errors: ['body must be an object'] }
  }

  const global = isObj(body.global) ? body.global : null
  const main = isObj(body.main) ? body.main : null
  const subAgent = isObj(body.subAgent) ? body.subAgent : null

  if (!global) errors.push('global is required')
  if (!main) errors.push('main is required')
  if (!subAgent) errors.push('subAgent is required')

  if (errors.length > 0) return { ok: false, errors }

  // global
  const perSession = checkPositiveInt(errors, 'global.perSession', global!.perSession)
  const perDay = checkPositiveInt(errors, 'global.perDay', global!.perDay)

  // main
  const mainPerTask = checkPositiveInt(errors, 'main.perTask', main!.perTask)
  const mainWarnRatio = checkRatio(errors, 'main.warnRatio', main!.warnRatio)
  const mainOverBehavior = main!.overBehavior
  if (
    typeof mainOverBehavior !== 'string' ||
    !MAIN_OVER_BEHAVIORS.includes(mainOverBehavior as OverBehavior)
  ) {
    errors.push(
      `main.overBehavior must be one of ${MAIN_OVER_BEHAVIORS.join(' | ')} (downgrade is not allowed for the main layer)`,
    )
  }

  // subAgent
  if (typeof subAgent!.enabled !== 'boolean') {
    errors.push('subAgent.enabled must be a boolean')
  }
  const subDefault = checkPositiveInt(errors, 'subAgent.defaultPerTask', subAgent!.defaultPerTask)
  const subWarnRatio = checkRatio(errors, 'subAgent.warnRatio', subAgent!.warnRatio)
  const subOverBehavior = subAgent!.overBehavior
  if (
    typeof subOverBehavior !== 'string' ||
    !SUB_OVER_BEHAVIORS.includes(subOverBehavior as SubAgentOverBehavior)
  ) {
    errors.push(`subAgent.overBehavior must be one of ${SUB_OVER_BEHAVIORS.join(' | ')}`)
  }
  const downgradeModel = subAgent!.downgradeModel
  if (typeof downgradeModel !== 'string') {
    errors.push('subAgent.downgradeModel must be a string')
  }
  if (
    subOverBehavior === 'downgrade' &&
    (typeof downgradeModel !== 'string' || downgradeModel.trim().length === 0)
  ) {
    errors.push('subAgent.downgradeModel must be a non-empty string when overBehavior is "downgrade"')
  }

  if (errors.length > 0) return { ok: false, errors }

  const value: BudgetConfig = {
    global: {
      perSession: perSession!,
      perDay: perDay!,
    },
    main: {
      perTask: mainPerTask!,
      warnRatio: mainWarnRatio!,
      overBehavior: mainOverBehavior as OverBehavior,
    },
    subAgent: {
      enabled: subAgent!.enabled as boolean,
      defaultPerTask: subDefault!,
      warnRatio: subWarnRatio!,
      overBehavior: subOverBehavior as SubAgentOverBehavior,
      downgradeModel: (downgradeModel as string) ?? '',
    },
  }
  return { ok: true, value }
}
