/**
 * Experience distillation routes — Phase 4 E Stage 2.
 *
 * Mounted at `/api/memory/distill`. Wraps `SessionManager`'s in-memory
 * distill run map. Runs are NOT persisted across process restarts; LRU 32
 * cap matches the prompt optimizer pattern.
 */

import { Hono } from 'hono'
import type { SessionManager } from '@evolving-agent/core'
import type { DistillerOptions } from '@evolving-agent/core'

interface DistillRequestBody {
  maxInputs?: number
  maxLessons?: number
  minAdmissionScore?: number
  duplicateThreshold?: number
}

function pickOptions(body: DistillRequestBody): DistillerOptions {
  const out: DistillerOptions = {}
  if (typeof body.maxInputs === 'number' && body.maxInputs > 0) out.maxInputs = body.maxInputs
  if (typeof body.maxLessons === 'number' && body.maxLessons > 0) out.maxLessons = body.maxLessons
  if (typeof body.minAdmissionScore === 'number') out.minAdmissionScore = body.minAdmissionScore
  if (typeof body.duplicateThreshold === 'number') out.duplicateThreshold = body.duplicateThreshold
  return out
}

export function distillRoutes(sessionManager: SessionManager) {
  const app = new Hono()

  // Trigger a new distillation run. Synchronous: returns the completed run.
  app.post('/', async (c) => {
    let body: DistillRequestBody = {}
    try {
      body = (await c.req.json<DistillRequestBody>()) ?? {}
    } catch {
      // Empty / non-JSON body is fine — fall through with defaults.
      body = {}
    }
    const options = pickOptions(body)

    try {
      const run = await sessionManager.startDistillRun(options)
      return c.json(run)
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      )
    }
  })

  // List all in-memory runs (newest first).
  app.get('/runs', (c) => {
    return c.json({ runs: sessionManager.listDistillRuns() })
  })

  // Fetch one run.
  app.get('/runs/:id', (c) => {
    const run = sessionManager.getDistillRun(c.req.param('id'))
    if (!run) return c.json({ error: 'Run not found' }, 404)
    return c.json(run)
  })

  // Accept a candidate → materialize as Experience.
  app.post('/runs/:runId/candidates/:id/accept', async (c) => {
    const runId = c.req.param('runId')
    const candidateId = c.req.param('id')
    try {
      const experienceId = await sessionManager.acceptDistillCandidate(runId, candidateId)
      if (!experienceId) {
        return c.json(
          { error: 'Run or candidate not found, or candidate is not pending' },
          404,
        )
      }
      const run = sessionManager.getDistillRun(runId)
      return c.json({ success: true, experienceId, run })
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      )
    }
  })

  // Reject a candidate.
  app.post('/runs/:runId/candidates/:id/reject', (c) => {
    const runId = c.req.param('runId')
    const candidateId = c.req.param('id')
    const ok = sessionManager.rejectDistillCandidate(runId, candidateId)
    if (!ok) {
      return c.json(
        { error: 'Run or candidate not found, or candidate is not pending' },
        404,
      )
    }
    const run = sessionManager.getDistillRun(runId)
    return c.json({ success: true, run })
  })

  return app
}
