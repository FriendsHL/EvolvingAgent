/**
 * Experience Distillation — Phase 4 E Stage 1.
 *
 * Distillation reads a batch of high-quality Experiences and asks an LLM to
 * surface a small number of cross-cutting "lessons" — generalized rules of
 * thumb that the agent should remember beyond any single task. Lessons are
 * stored back into the same ExperienceStore using a `tags: ['lesson', ...]`
 * convention, which lets the existing retriever / health / pool machinery
 * apply unchanged. See `docs/experience-distillation.md` for the rationale.
 */

import type { Experience } from '../types.js'

/** Tag every distilled lesson carries. Used as the storage marker. */
export const LESSON_TAG = 'lesson'

/** Configuration for one distillation run. */
export interface DistillerOptions {
  /** Cap the number of input experiences sampled per run. Default 50. */
  maxInputs?: number
  /** Hard cap on lessons proposed per run. Default 5. */
  maxLessons?: number
  /** Minimum admissionScore an Experience needs to be considered. Default 0.6. */
  minAdmissionScore?: number
  /** Cosine similarity at/above which a candidate is flagged as a duplicate of an existing lesson. Default 0.85. */
  duplicateThreshold?: number
}

export const DEFAULT_DISTILLER_OPTIONS: Required<DistillerOptions> = {
  maxInputs: 50,
  maxLessons: 5,
  minAdmissionScore: 0.6,
  duplicateThreshold: 0.85,
}

/**
 * One distilled lesson candidate, before user review. The candidate is NOT
 * persisted to ExperienceStore until the user accepts it via the dashboard.
 */
export interface DistillCandidate {
  /** Stable id within a run. */
  id: string
  /** The lesson statement itself — becomes `Experience.task` on accept. */
  lesson: string
  /** Optional one-line rationale from the LLM. */
  rationale?: string
  /** Topic tags suggested by the LLM (will be merged with `['lesson']` on accept). */
  tags: string[]
  /** Ids of input Experiences that supported this lesson. >=2 required. */
  supportingExperienceIds: string[]
  /**
   * Cosine similarity vs the closest existing lesson, if any. When
   * `>= duplicateThreshold` the UI flags this candidate as a duplicate but
   * the user may still accept it.
   */
  closestExistingLessonId?: string
  closestExistingLessonScore?: number
  /** Convenience flag: `closestExistingLessonScore >= duplicateThreshold`. */
  isDuplicate: boolean
  /** Status managed by the run lifecycle. */
  status: 'pending' | 'accepted' | 'rejected'
  /** When accepted, the id of the resulting Experience. */
  acceptedExperienceId?: string
}

/** A single distillation run, kept in-memory by the SessionManager. */
export interface DistillRun {
  id: string
  startedAt: string
  finishedAt?: string
  status: 'running' | 'completed' | 'failed'
  options: Required<DistillerOptions>
  inputCount: number
  candidates: DistillCandidate[]
  error?: string
}

/**
 * Pluggable LLM-side hook. Receives the input experiences plus the cap and
 * returns raw lesson proposals. The distiller wraps the result with dedup
 * scoring and supporting-id validation.
 *
 * Mirrors C 阶段's `ProposeFn` shape — keeps the test surface tiny.
 */
export type DistillFn = (input: {
  experiences: Experience[]
  maxLessons: number
}) => Promise<DistillProposal[]>

/** Raw proposal returned by a `DistillFn` before dedup checks. */
export interface DistillProposal {
  lesson: string
  rationale?: string
  tags?: string[]
  supportingExperienceIds: string[]
}
