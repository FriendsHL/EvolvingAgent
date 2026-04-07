/**
 * ExperienceDistiller — Phase 4 E Stage 1.
 *
 * Pure orchestration class: filters the active Experience pool, hands the
 * shortlisted records to a `DistillFn`, then dedups the resulting candidates
 * against existing lessons via cosine similarity. Storage of accepted
 * lessons is handled by SessionManager so the distiller stays testable
 * without a real ExperienceStore.
 */

import { nanoid } from 'nanoid'

import type { Experience } from '../types.js'
import type { ExperienceStore } from '../memory/experience-store.js'
import type { Embedder } from '../memory/embedder.js'
import { cosineSimilarity } from '../memory/vector-index.js'

import {
  DEFAULT_DISTILLER_OPTIONS,
  LESSON_TAG,
  type DistillCandidate,
  type DistillFn,
  type DistillRun,
  type DistillerOptions,
} from './types.js'

export interface ExperienceDistillerDeps {
  store: ExperienceStore
  /**
   * Optional — when present, candidates will be embedded for dedup against
   * existing lessons. Without it the dedup pass is skipped (`isDuplicate`
   * remains false). The local-bow Embedder is sufficient.
   */
  embedder?: Embedder
  distill: DistillFn
}

export class ExperienceDistiller {
  constructor(private deps: ExperienceDistillerDeps) {}

  /** Run one distillation pass. Pure: returns the run, doesn't persist anything. */
  async run(options: DistillerOptions = {}): Promise<DistillRun> {
    const opts = { ...DEFAULT_DISTILLER_OPTIONS, ...options }
    const id = nanoid(10)
    const startedAt = new Date().toISOString()

    try {
      const inputs = this.pickInputs(opts.minAdmissionScore, opts.maxInputs)
      if (inputs.length < 2) {
        // Need at least 2 supporting experiences for any lesson — short-circuit.
        return {
          id,
          startedAt,
          finishedAt: new Date().toISOString(),
          status: 'completed',
          options: opts,
          inputCount: inputs.length,
          candidates: [],
        }
      }

      const proposals = await this.deps.distill({
        experiences: inputs,
        maxLessons: opts.maxLessons,
      })

      const inputIds = new Set(inputs.map((e) => e.id))
      const candidates: DistillCandidate[] = []

      for (const p of proposals.slice(0, opts.maxLessons)) {
        const lesson = p.lesson?.trim()
        if (!lesson) continue
        const supportingExperienceIds = (p.supportingExperienceIds ?? []).filter((eid) =>
          inputIds.has(eid),
        )
        if (supportingExperienceIds.length < 2) continue

        const cand: DistillCandidate = {
          id: nanoid(10),
          lesson,
          rationale: p.rationale,
          tags: dedupeTags(p.tags ?? []),
          supportingExperienceIds,
          isDuplicate: false,
          status: 'pending',
        }

        await this.scoreDuplication(cand, opts.duplicateThreshold)
        candidates.push(cand)
      }

      return {
        id,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: 'completed',
        options: opts,
        inputCount: inputs.length,
        candidates,
      }
    } catch (err) {
      return {
        id,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: 'failed',
        options: opts,
        inputCount: 0,
        candidates: [],
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /**
   * Promote a candidate into a real Experience and save it to the store.
   * Caller (SessionManager) is responsible for marking the candidate as
   * accepted on the in-memory run record.
   */
  async materializeCandidate(cand: DistillCandidate): Promise<Experience> {
    const exp: Experience = {
      id: nanoid(),
      task: cand.lesson,
      steps: [],
      result: 'success',
      reflection: {
        whatWorked: [],
        whatFailed: [],
        lesson: cand.lesson,
      },
      tags: dedupeTags([LESSON_TAG, ...cand.tags]),
      timestamp: new Date().toISOString(),
      health: {
        referencedCount: 0,
        contradictionCount: 0,
      },
      admissionScore: 1.0,
    }

    if (this.deps.embedder) {
      try {
        exp.embedding = await this.deps.embedder.embed(cand.lesson)
      } catch {
        // Embedding failure is non-fatal — the experience is still useful via
        // tag/keyword retrieval. Same fallback the rest of the codebase uses.
      }
    }

    await this.deps.store.save(exp)
    return exp
  }

  // ----------------------------------------------------------------
  // Internals
  // ----------------------------------------------------------------

  private pickInputs(minAdmissionScore: number, max: number): Experience[] {
    return this.deps.store
      .getAll('active')
      .filter((e) => !e.tags.includes(LESSON_TAG) && e.admissionScore >= minAdmissionScore)
      .sort((a, b) => b.admissionScore - a.admissionScore)
      .slice(0, max)
  }

  /**
   * Compare a candidate against existing lessons in the active pool. Sets
   * `closestExistingLesson*` and `isDuplicate` on the candidate in place.
   * Skipped when no embedder is configured.
   */
  private async scoreDuplication(
    cand: DistillCandidate,
    threshold: number,
  ): Promise<void> {
    const embedder = this.deps.embedder
    if (!embedder) return

    const existingLessons = this.deps.store
      .getAll('active')
      .filter((e) => e.tags.includes(LESSON_TAG))
    if (existingLessons.length === 0) return

    let candidateVec: number[]
    try {
      candidateVec = await embedder.embed(cand.lesson)
    } catch {
      return
    }

    let bestId: string | undefined
    let bestScore = -Infinity
    for (const lesson of existingLessons) {
      const vec = lesson.embedding ?? (await safeEmbed(embedder, lesson.task))
      if (!vec || vec.length === 0) continue
      const score = cosineSimilarity(candidateVec, vec)
      if (score > bestScore) {
        bestScore = score
        bestId = lesson.id
      }
    }

    if (bestId !== undefined && bestScore > -Infinity) {
      cand.closestExistingLessonId = bestId
      cand.closestExistingLessonScore = bestScore
      cand.isDuplicate = bestScore >= threshold
    }
  }
}

async function safeEmbed(embedder: Embedder, text: string): Promise<number[] | null> {
  try {
    return await embedder.embed(text)
  } catch {
    return null
  }
}

function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tags) {
    const v = t.trim()
    if (!v) continue
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}
