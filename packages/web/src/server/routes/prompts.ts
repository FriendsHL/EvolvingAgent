import { Hono } from 'hono'
import type { SessionManager, PromptId } from '@evolving-agent/core'
import { PROMPT_IDS } from '@evolving-agent/core'

/**
 * Prompt self-optimization — Phase 4 C Stage 2 routes.
 *
 * Mounted at `/api/prompts` (see server/index.ts).
 *
 *   GET    /api/prompts                  — list current state of every slot
 *   GET    /api/prompts/runs             — list recent optimization runs
 *   GET    /api/prompts/runs/:runId      — fetch one run (poll for status)
 *   POST   /api/prompts/:id/optimize     — kick off a background run
 *   POST   /api/prompts/:id/accept       — accept a candidate from a run
 *   POST   /api/prompts/:id/rollback     — revert to source baseline OR a
 *                                          history snapshot timestamp
 *   GET    /api/prompts/:id/history      — list history snapshot entries
 *
 * The route layer never serializes prompt content over the wire by default
 * (some prompts are long); it returns truncated previews + content lengths
 * and only ships the full body when explicitly requested via `?full=1` or
 * for the run / accept flows where the candidate text is the whole point.
 */
export function promptsRoutes(manager: SessionManager) {
  const app = new Hono()

  // ============================================================
  // GET / — list current state
  // ============================================================
  app.get('/', (c) => {
    const registry = manager.getPromptRegistry()
    const list = registry.list().map((entry) => ({
      id: entry.id,
      source: entry.source, // 'baseline' | 'active'
      contentLength: entry.content.length,
      preview: preview(entry.content),
      activeEntry: entry.activeEntry
        ? {
            acceptedAt: entry.activeEntry.acceptedAt,
            note: entry.activeEntry.note,
            evalPassRate: entry.activeEntry.evalPassRate,
            baselinePassRate: entry.activeEntry.baselinePassRate,
          }
        : undefined,
      baselineLength: registry.getBaseline(entry.id).length,
    }))
    return c.json({ prompts: list })
  })

  // ============================================================
  // GET /runs — list recent runs
  //
  // IMPORTANT: this must be registered BEFORE `/:id`, otherwise Hono's
  // first-match wins routing treats `runs` as a prompt id and the request
  // hits the 400-on-unknown-id branch below.
  // ============================================================
  app.get('/runs', (c) => {
    const runs = manager.listOptimizationRuns().map((r) => ({
      id: r.id,
      targetId: r.targetId,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      candidateCount: r.candidateCount,
      acceptedCount: r.gateResult?.accepted.length ?? 0,
      rejectedCount: r.gateResult?.rejected.length ?? 0,
      error: r.error,
    }))
    return c.json({ runs })
  })

  // GET /runs/:runId — full run with candidate text. Same ordering reason
  // as `/runs` above.
  app.get('/runs/:runId', (c) => {
    const runId = c.req.param('runId')
    const run = manager.getOptimizationRun(runId)
    if (!run) return c.json({ error: 'Run not found' }, 404)
    return c.json({ run })
  })

  // ============================================================
  // GET /:id — fetch one prompt with full content
  // ============================================================
  app.get('/:id', (c) => {
    const id = parsePromptId(c.req.param('id'))
    if (!id) return c.json({ error: 'Unknown prompt id' }, 400)
    const registry = manager.getPromptRegistry()
    return c.json({
      id,
      content: registry.get(id),
      baseline: registry.getBaseline(id),
      activeEntry: registry.getActiveEntry(id),
    })
  })

  // ============================================================
  // GET /:id/history — list history snapshots
  // ============================================================
  app.get('/:id/history', async (c) => {
    const id = parsePromptId(c.req.param('id'))
    if (!id) return c.json({ error: 'Unknown prompt id' }, 400)
    const registry = manager.getPromptRegistry()
    const history = await registry.history(id)
    // Strip full content from the list view to keep it light.
    return c.json({
      history: history.map((h) => ({
        id: h.id,
        timestamp: h.timestamp,
        action: h.action,
        note: h.note,
        evalPassRate: h.evalPassRate,
        baselinePassRate: h.baselinePassRate,
        contentLength: h.content.length,
        preview: preview(h.content),
      })),
    })
  })

  // ============================================================
  // POST /:id/optimize — kick off background optimization
  // ============================================================
  app.post('/:id/optimize', async (c) => {
    const id = parsePromptId(c.req.param('id'))
    if (!id) return c.json({ error: 'Unknown prompt id' }, 400)

    let body: { count?: number } = {}
    try {
      body = (await c.req.json()) as { count?: number }
    } catch {
      // Body is optional — empty body is fine.
    }

    const count = typeof body.count === 'number' && body.count > 0 && body.count <= 10
      ? body.count
      : undefined

    try {
      const run = await manager.startOptimizationRun(id, count)
      return c.json({ runId: run.id, status: run.status, targetId: run.targetId })
    } catch (err) {
      return c.json(
        { error: 'Failed to start optimization run', message: (err as Error).message },
        500,
      )
    }
  })

  // ============================================================
  // POST /:id/accept — accept a candidate from a run
  // ============================================================
  app.post('/:id/accept', async (c) => {
    const id = parsePromptId(c.req.param('id'))
    if (!id) return c.json({ error: 'Unknown prompt id' }, 400)

    let body: { runId?: string; candidateIndex?: number; note?: string }
    try {
      body = (await c.req.json()) as typeof body
    } catch {
      return c.json({ error: 'Body must be JSON' }, 400)
    }

    if (!body.runId) {
      return c.json({ error: 'runId is required' }, 400)
    }
    const run = manager.getOptimizationRun(body.runId)
    if (!run) return c.json({ error: 'Run not found' }, 404)
    if (run.status !== 'completed' || !run.gateResult) {
      return c.json({ error: 'Run is not yet completed' }, 400)
    }
    if (run.targetId !== id) {
      return c.json({ error: 'Run target does not match prompt id' }, 400)
    }

    const accepted = run.gateResult.accepted
    if (accepted.length === 0) {
      return c.json({ error: 'No candidates passed the gate in this run' }, 400)
    }
    const idx = body.candidateIndex ?? 0
    if (idx < 0 || idx >= accepted.length) {
      return c.json({ error: `candidateIndex out of range (0..${accepted.length - 1})` }, 400)
    }
    const winner = accepted[idx]

    try {
      const registry = manager.getPromptRegistry()
      await registry.set(id, winner.candidate.content, {
        note: body.note ?? `accepted from run ${run.id}`,
        evalPassRate: winner.passRate,
        baselinePassRate: run.gateResult.baseline.passRate,
      })
      return c.json({
        ok: true,
        accepted: {
          candidateId: winner.candidate.id,
          passRate: winner.passRate,
          improved: winner.improved,
        },
      })
    } catch (err) {
      return c.json(
        { error: 'Failed to write active prompt', message: (err as Error).message },
        500,
      )
    }
  })

  // ============================================================
  // POST /:id/rollback — revert to baseline or restore from history
  // ============================================================
  app.post('/:id/rollback', async (c) => {
    const id = parsePromptId(c.req.param('id'))
    if (!id) return c.json({ error: 'Unknown prompt id' }, 400)

    let body: { timestamp?: string; note?: string } = {}
    try {
      body = (await c.req.json()) as typeof body
    } catch {
      // Empty body = revert to source baseline.
    }

    const registry = manager.getPromptRegistry()
    try {
      if (body.timestamp) {
        await registry.restoreFromHistory(id, body.timestamp)
        return c.json({ ok: true, restoredFrom: body.timestamp })
      }
      await registry.revertToBaseline(id, body.note)
      return c.json({ ok: true, revertedToBaseline: true })
    } catch (err) {
      return c.json(
        { error: 'Rollback failed', message: (err as Error).message },
        500,
      )
    }
  })

  return app
}

function parsePromptId(s: string | undefined): PromptId | null {
  if (!s) return null
  return (PROMPT_IDS as readonly string[]).includes(s) ? (s as PromptId) : null
}

function preview(content: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim()
  return oneLine.length <= 120 ? oneLine : oneLine.slice(0, 120) + '…'
}
