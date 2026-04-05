import { describe, it, expect, beforeEach } from 'vitest'
import { cosineSimilarity, VectorIndex } from './vector-index.js'

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const v = [1, 2, 3]
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5)
  })

  it('returns 0 for orthogonal vectors', () => {
    const a = [1, 0, 0]
    const b = [0, 1, 0]
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5)
  })

  it('handles different-length vectors', () => {
    const a = [1, 2, 3]
    const b = [1, 2]
    // b is treated as [1, 2, 0]
    const score = cosineSimilarity(a, b)
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThan(1)
  })

  it('returns 0 for zero vectors', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0)
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0)
    expect(cosineSimilarity([], [1, 2, 3])).toBe(0)
    expect(cosineSimilarity([1, 2, 3], [])).toBe(0)
  })
})

describe('VectorIndex', () => {
  let index: VectorIndex

  beforeEach(() => {
    index = new VectorIndex()
  })

  it('add() + size() tracks entries', () => {
    expect(index.size()).toBe(0)
    index.add('a', [1, 0, 0])
    expect(index.size()).toBe(1)
    index.add('b', [0, 1, 0])
    expect(index.size()).toBe(2)
  })

  it('remove() removes entries', () => {
    index.add('a', [1, 0, 0])
    index.add('b', [0, 1, 0])
    expect(index.size()).toBe(2)
    index.remove('a')
    expect(index.size()).toBe(1)
    expect(index.has('a')).toBe(false)
    expect(index.has('b')).toBe(true)
  })

  it('search() returns sorted results by score', () => {
    index.add('exact', [1, 0, 0])
    index.add('partial', [0.7, 0.7, 0])
    index.add('orthogonal', [0, 1, 0])

    const results = index.search([1, 0, 0], 10)
    expect(results.length).toBeGreaterThanOrEqual(2)
    // First result should be the exact match
    expect(results[0].id).toBe('exact')
    expect(results[0].score).toBeCloseTo(1.0, 5)
    // Results should be sorted descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score)
    }
  })

  it('search() respects topK limit', () => {
    index.add('a', [1, 0, 0])
    index.add('b', [0.9, 0.1, 0])
    index.add('c', [0.8, 0.2, 0])

    const results = index.search([1, 0, 0], 2)
    expect(results).toHaveLength(2)
  })

  it('search() respects minScore threshold', () => {
    index.add('high', [1, 0, 0])
    index.add('low', [0, 1, 0]) // orthogonal, score ~0

    const results = index.search([1, 0, 0], 10, 0.5)
    expect(results.every((r) => r.score >= 0.5)).toBe(true)
    expect(results.some((r) => r.id === 'high')).toBe(true)
  })

  it('search() returns empty for no vectors', () => {
    const results = index.search([1, 0, 0], 10)
    expect(results).toHaveLength(0)
  })
})
