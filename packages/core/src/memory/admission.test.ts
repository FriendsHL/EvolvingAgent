import { describe, it, expect } from 'vitest'
import {
  scoreNovelty,
  scoreLessonValue,
  scoreReusability,
  scoreComplexity,
  scoreUserSignal,
  computeAdmission,
} from './admission.js'
import type { ExecutionStep, Reflection } from '../types.js'

describe('admission scoring', () => {
  describe('scoreNovelty', () => {
    it('returns 1.0 when no existing tasks', () => {
      expect(scoreNovelty('debug the server', [])).toBe(1.0)
    })

    it('returns low score for near-duplicate task', () => {
      const existing = ['debug the server']
      const score = scoreNovelty('debug the server', existing)
      expect(score).toBeLessThan(0.2)
    })

    it('returns high score for completely different task', () => {
      const existing = ['deploy to production']
      const score = scoreNovelty('analyze database performance', existing)
      expect(score).toBeGreaterThan(0.7)
    })

    it('returns medium score for partially overlapping task', () => {
      const existing = ['debug the server latency']
      const score = scoreNovelty('debug the database latency', existing)
      expect(score).toBeGreaterThan(0.2)
      expect(score).toBeLessThan(0.8)
    })
  })

  describe('scoreLessonValue', () => {
    it('returns 1.0 for failure with clear lessons', () => {
      const reflection: Reflection = {
        whatWorked: [],
        whatFailed: ['timeout on API call'],
        lesson: 'Need to increase timeout for external API calls to at least 30 seconds',
        suggestedSkill: undefined,
      }
      expect(scoreLessonValue(reflection, 'failure')).toBe(1.0)
    })

    it('returns 0.7 for success with multiple strategies', () => {
      const reflection: Reflection = {
        whatWorked: ['used grep to find the file', 'applied regex replacement'],
        whatFailed: [],
        lesson: 'Worked well',
      }
      expect(scoreLessonValue(reflection, 'success')).toBe(0.7)
    })

    it('returns 0.3 for simple success', () => {
      const reflection: Reflection = {
        whatWorked: ['ran the command'],
        whatFailed: [],
        lesson: 'Done',
      }
      expect(scoreLessonValue(reflection, 'success')).toBe(0.3)
    })

    it('returns 0.5 for partial result', () => {
      const reflection: Reflection = {
        whatWorked: [],
        whatFailed: [],
        lesson: 'Partial',
      }
      expect(scoreLessonValue(reflection, 'partial')).toBe(0.5)
    })
  })

  describe('scoreReusability', () => {
    it('returns high score for common patterns', () => {
      expect(scoreReusability(['shell', 'git'], 'debug the deployment issue')).toBeGreaterThanOrEqual(0.6)
    })

    it('returns low score for no tags and uncommon task', () => {
      expect(scoreReusability([], 'do something unique')).toBe(0)
    })

    it('returns higher score with more tags', () => {
      const few = scoreReusability(['a'], 'random task')
      const many = scoreReusability(['a', 'b', 'c', 'd', 'e'], 'random task')
      expect(many).toBeGreaterThan(few)
    })
  })

  describe('scoreComplexity', () => {
    const makeSteps = (n: number): ExecutionStep[] =>
      Array.from({ length: n }, (_, i) => ({
        id: `s${i}`,
        description: `step ${i}`,
        result: { success: true, output: '' },
        duration: 100,
      }))

    it('returns 1.0 for 5+ steps', () => {
      expect(scoreComplexity(makeSteps(5))).toBe(1.0)
      expect(scoreComplexity(makeSteps(10))).toBe(1.0)
    })

    it('returns 0.7 for 3-4 steps', () => {
      expect(scoreComplexity(makeSteps(3))).toBe(0.7)
      expect(scoreComplexity(makeSteps(4))).toBe(0.7)
    })

    it('returns 0.5 for 2 steps', () => {
      expect(scoreComplexity(makeSteps(2))).toBe(0.5)
    })

    it('returns 0.2 for 1 step', () => {
      expect(scoreComplexity(makeSteps(1))).toBe(0.2)
    })
  })

  describe('scoreUserSignal', () => {
    it('returns 0.5 (neutral in Phase 1)', () => {
      expect(scoreUserSignal()).toBe(0.5)
    })
  })

  describe('computeAdmission', () => {
    const reflection: Reflection = {
      whatWorked: ['found the bug', 'fixed it'],
      whatFailed: [],
      lesson: 'Check logs first when debugging server issues',
    }
    const steps: ExecutionStep[] = [
      { id: 's1', description: 'check logs', tool: 'shell', result: { success: true, output: 'error found' }, duration: 200 },
      { id: 's2', description: 'fix code', tool: 'file_write', result: { success: true, output: 'done' }, duration: 300 },
      { id: 's3', description: 'test', tool: 'shell', result: { success: true, output: 'pass' }, duration: 150 },
    ]

    it('returns high-confidence for novel complex task with lessons', () => {
      const result = computeAdmission('debug server crash', steps, 'success', reflection, ['debug', 'server'], [])
      expect(result.decision).toBe('high-confidence')
      expect(result.score).toBeGreaterThan(0.6)
    })

    it('returns discard for near-duplicate simple task', () => {
      const simpleReflection: Reflection = { whatWorked: ['done'], whatFailed: [], lesson: 'ok' }
      const simpleSteps: ExecutionStep[] = [
        { id: 's1', description: 'run', result: { success: true, output: '' }, duration: 50 },
      ]
      const existing = ['list files in directory']
      const result = computeAdmission('list files in directory', simpleSteps, 'success', simpleReflection, [], existing)
      expect(result.decision).toBe('discard')
      expect(result.score).toBeLessThan(0.4)
    })

    it('scores object contains all 5 dimensions', () => {
      const result = computeAdmission('test task', steps, 'success', reflection, ['test'], [])
      expect(result.scores).toHaveProperty('novelty')
      expect(result.scores).toHaveProperty('lessonValue')
      expect(result.scores).toHaveProperty('reusability')
      expect(result.scores).toHaveProperty('userSignal')
      expect(result.scores).toHaveProperty('complexity')
    })
  })
})
