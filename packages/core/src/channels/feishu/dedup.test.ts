import { describe, it, expect } from 'vitest'

import { FeishuDedup } from './dedup.js'

describe('FeishuDedup', () => {
  it('returns false on first sight, true on second', () => {
    const d = new FeishuDedup(60_000)
    expect(d.checkAndMark('msg-1')).toBe(false)
    expect(d.checkAndMark('msg-1')).toBe(true)
  })

  it('different ids do not collide', () => {
    const d = new FeishuDedup(60_000)
    expect(d.checkAndMark('msg-1')).toBe(false)
    expect(d.checkAndMark('msg-2')).toBe(false)
    expect(d.checkAndMark('msg-1')).toBe(true)
  })

  it('expires entries after TTL', () => {
    const d = new FeishuDedup(1_000)
    const t0 = 1_000_000
    expect(d.checkAndMark('msg-1', t0)).toBe(false)
    expect(d.checkAndMark('msg-1', t0 + 500)).toBe(true)
    // After TTL the entry should be gone and the id is fresh again.
    expect(d.checkAndMark('msg-1', t0 + 2_000)).toBe(false)
  })

  it('size reflects in-memory count after eviction', () => {
    const d = new FeishuDedup(1_000)
    const t0 = 1_000_000
    d.checkAndMark('a', t0)
    d.checkAndMark('b', t0)
    expect(d.size(t0)).toBe(2)
    expect(d.size(t0 + 2_000)).toBe(0)
  })

  it('clear() drops everything', () => {
    const d = new FeishuDedup()
    d.checkAndMark('a')
    d.checkAndMark('b')
    d.clear()
    expect(d.size()).toBe(0)
  })
})
