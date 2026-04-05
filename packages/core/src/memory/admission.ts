import type { AdmissionResult, AdmissionScores, Experience, ExecutionStep, Reflection } from '../types.js'

/**
 * 5-dimension admission scoring for experience storage.
 *
 * score = 0.25 * novelty + 0.25 * lesson_value + 0.20 * reusability
 *       + 0.15 * user_signal + 0.15 * complexity
 *
 * Thresholds:
 *   < 0.4 → discard
 *   0.4-0.6 → low-confidence
 *   > 0.6 → high-confidence
 */

const WEIGHTS = {
  novelty: 0.25,
  lessonValue: 0.25,
  reusability: 0.20,
  userSignal: 0.15,
  complexity: 0.15,
} as const

export function scoreNovelty(task: string, existingTasks: string[]): number {
  if (existingTasks.length === 0) return 1.0

  // Simple keyword overlap scoring
  const taskWords = new Set(task.toLowerCase().split(/\s+/))
  let maxOverlap = 0

  for (const existing of existingTasks) {
    const existingWords = new Set(existing.toLowerCase().split(/\s+/))
    let overlap = 0
    for (const word of taskWords) {
      if (existingWords.has(word)) overlap++
    }
    const overlapRatio = overlap / Math.max(taskWords.size, 1)
    if (overlapRatio > maxOverlap) maxOverlap = overlapRatio
  }

  return 1.0 - maxOverlap
}

export function scoreLessonValue(reflection: Reflection, result: string): number {
  // Failure with clear lesson = high value
  if (result === 'failure' && reflection.whatFailed.length > 0 && reflection.lesson.length > 20) {
    return 1.0
  }
  // Success with non-obvious strategy
  if (result === 'success' && reflection.whatWorked.length > 1) {
    return 0.7
  }
  // Partial with lessons learned
  if (result === 'partial') return 0.5
  // Simple success, little learning
  if (result === 'success' && reflection.whatWorked.length <= 1) return 0.3
  return 0.2
}

export function scoreReusability(tags: string[], task: string): number {
  // More tags = more reusable (it applies to multiple domains)
  const tagScore = Math.min(1.0, tags.length / 5)
  // Longer task descriptions with common patterns suggest reusability
  const hasCommonPatterns = /\b(debug|fix|deploy|test|build|setup|config|create|migrate)\b/i.test(task)
  return hasCommonPatterns ? Math.max(tagScore, 0.6) : tagScore
}

export function scoreUserSignal(): number {
  // Phase 1: no user signal mechanism yet → neutral 0.5
  return 0.5
}

export function scoreComplexity(steps: ExecutionStep[]): number {
  if (steps.length >= 5) return 1.0
  if (steps.length >= 3) return 0.7
  if (steps.length >= 2) return 0.5
  return 0.2
}

export function computeAdmission(
  task: string,
  steps: ExecutionStep[],
  result: 'success' | 'partial' | 'failure',
  reflection: Reflection,
  tags: string[],
  existingTasks: string[],
): AdmissionResult {
  const scores: AdmissionScores = {
    novelty: scoreNovelty(task, existingTasks),
    lessonValue: scoreLessonValue(reflection, result),
    reusability: scoreReusability(tags, task),
    userSignal: scoreUserSignal(),
    complexity: scoreComplexity(steps),
  }

  const score =
    WEIGHTS.novelty * scores.novelty +
    WEIGHTS.lessonValue * scores.lessonValue +
    WEIGHTS.reusability * scores.reusability +
    WEIGHTS.userSignal * scores.userSignal +
    WEIGHTS.complexity * scores.complexity

  let decision: AdmissionResult['decision']
  if (score < 0.4) decision = 'discard'
  else if (score <= 0.6) decision = 'low-confidence'
  else decision = 'high-confidence'

  return { score, scores, decision }
}
