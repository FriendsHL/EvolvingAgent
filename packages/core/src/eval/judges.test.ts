import { describe, it, expect } from 'vitest'
import { evaluateCriterion } from './judges.js'
import type { CriterionContext } from './judges.js'

const baseCtx = (output: string, toolCalls: string[] = []): CriterionContext => ({
  output,
  toolCalls,
  // We never invoke llm-judge in these tests, so a stub is fine.
  llm: {} as any,
})

describe('evaluateCriterion — contains', () => {
  it('passes when substring present (case-insensitive default)', async () => {
    const r = await evaluateCriterion(
      { type: 'contains', substring: 'Hello' },
      baseCtx('hello world'),
    )
    expect(r.pass).toBe(true)
  })

  it('fails when substring missing', async () => {
    const r = await evaluateCriterion(
      { type: 'contains', substring: 'goodbye' },
      baseCtx('hello world'),
    )
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/missing substring/)
  })

  it('caseSensitive=true respects case', async () => {
    const r = await evaluateCriterion(
      { type: 'contains', substring: 'Hello', caseSensitive: true },
      baseCtx('hello world'),
    )
    expect(r.pass).toBe(false)
  })
})

describe('evaluateCriterion — not-contains', () => {
  it('passes when substring absent', async () => {
    const r = await evaluateCriterion(
      { type: 'not-contains', substring: 'evil' },
      baseCtx('safe content'),
    )
    expect(r.pass).toBe(true)
  })

  it('fails when substring present', async () => {
    const r = await evaluateCriterion(
      { type: 'not-contains', substring: 'evil' },
      baseCtx('contains evil thing'),
    )
    expect(r.pass).toBe(false)
  })
})

describe('evaluateCriterion — regex', () => {
  it('passes on match', async () => {
    const r = await evaluateCriterion(
      { type: 'regex', pattern: '^foo\\d+$' },
      baseCtx('foo123'),
    )
    expect(r.pass).toBe(true)
  })

  it('fails on no match', async () => {
    const r = await evaluateCriterion(
      { type: 'regex', pattern: '^foo\\d+$' },
      baseCtx('bar'),
    )
    expect(r.pass).toBe(false)
  })

  it('honors flags', async () => {
    const r = await evaluateCriterion(
      { type: 'regex', pattern: 'HELLO', flags: 'i' },
      baseCtx('hello world'),
    )
    expect(r.pass).toBe(true)
  })

  it('catches invalid regex without throwing', async () => {
    const r = await evaluateCriterion(
      { type: 'regex', pattern: '(' },
      baseCtx('anything'),
    )
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/error:/)
  })
})

describe('evaluateCriterion — tool-called / tool-not-called', () => {
  it('tool-called passes when tool was invoked', async () => {
    const r = await evaluateCriterion(
      { type: 'tool-called', tool: 'shell' },
      baseCtx('out', ['shell', 'http']),
    )
    expect(r.pass).toBe(true)
  })

  it('tool-called fails with helpful detail', async () => {
    const r = await evaluateCriterion(
      { type: 'tool-called', tool: 'browser' },
      baseCtx('out', ['shell']),
    )
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/was not called/)
  })

  it('tool-not-called passes when absent', async () => {
    const r = await evaluateCriterion(
      { type: 'tool-not-called', tool: 'shell' },
      baseCtx('out', ['http']),
    )
    expect(r.pass).toBe(true)
  })

  it('tool-not-called fails when invoked', async () => {
    const r = await evaluateCriterion(
      { type: 'tool-not-called', tool: 'shell' },
      baseCtx('out', ['shell']),
    )
    expect(r.pass).toBe(false)
  })
})

describe('evaluateCriterion — json-shape', () => {
  it('passes when all required keys present', async () => {
    const r = await evaluateCriterion(
      { type: 'json-shape', requiredKeys: ['name', 'value'] },
      baseCtx('result: {"name": "x", "value": 1, "extra": true}'),
    )
    expect(r.pass).toBe(true)
  })

  it('fails when keys missing', async () => {
    const r = await evaluateCriterion(
      { type: 'json-shape', requiredKeys: ['name', 'value'] },
      baseCtx('{"name": "x"}'),
    )
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/missing keys: value/)
  })

  it('fails when no JSON object found', async () => {
    const r = await evaluateCriterion(
      { type: 'json-shape', requiredKeys: ['x'] },
      baseCtx('plain text'),
    )
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/no JSON object/)
  })

  it('extracts JSON embedded in surrounding prose', async () => {
    const r = await evaluateCriterion(
      { type: 'json-shape', requiredKeys: ['ok'] },
      baseCtx('Here is the answer: {"ok": true} — done.'),
    )
    expect(r.pass).toBe(true)
  })

  it('handles nested braces correctly (balanced extraction)', async () => {
    const r = await evaluateCriterion(
      { type: 'json-shape', requiredKeys: ['inner'] },
      baseCtx('{"inner": {"a": 1, "b": {"c": 2}}}'),
    )
    expect(r.pass).toBe(true)
  })

  it('ignores braces inside string literals', async () => {
    const r = await evaluateCriterion(
      { type: 'json-shape', requiredKeys: ['s'] },
      baseCtx('{"s": "has } brace inside"}'),
    )
    expect(r.pass).toBe(true)
  })
})
