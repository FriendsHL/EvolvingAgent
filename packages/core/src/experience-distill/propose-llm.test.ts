import { describe, it, expect } from 'vitest'

import { parseProposals, createLLMDistiller } from './propose-llm.js'
import type { LLMProvider } from '../llm/provider.js'
import type { Experience } from '../types.js'

function makeExperience(id: string): Experience {
  return {
    id,
    task: `task ${id}`,
    steps: [],
    result: 'success',
    reflection: { whatWorked: [], whatFailed: [], lesson: 'note' },
    tags: ['t'],
    timestamp: new Date().toISOString(),
    health: { referencedCount: 0, contradictionCount: 0 },
    admissionScore: 0.9,
  }
}

describe('parseProposals', () => {
  it('parses a raw JSON array', () => {
    const text = `[{"lesson":"L1","supportingExperienceIds":["a","b"]}]`
    expect(parseProposals(text)).toEqual([
      { lesson: 'L1', rationale: undefined, tags: [], supportingExperienceIds: ['a', 'b'] },
    ])
  })

  it('parses a fenced ```json block', () => {
    const text = '```json\n[{"lesson":"L","supportingExperienceIds":["a","b"]}]\n```'
    expect(parseProposals(text)).toHaveLength(1)
  })

  it('parses a bare ``` fenced block', () => {
    const text = '```\n[{"lesson":"L","supportingExperienceIds":["a","b"]}]\n```'
    expect(parseProposals(text)).toHaveLength(1)
  })

  it('recovers a JSON array embedded in prose', () => {
    const text = `Here you go:\n[{"lesson":"L","supportingExperienceIds":["a","b"]}]\nHope this helps!`
    expect(parseProposals(text)).toHaveLength(1)
  })

  it('returns [] on unparseable text', () => {
    expect(parseProposals('not json at all')).toEqual([])
  })

  it('returns [] when the parsed value is not an array', () => {
    expect(parseProposals('{"lesson":"L"}')).toEqual([])
  })

  it('drops items without a lesson string', () => {
    const text = '[{"supportingExperienceIds":["a","b"]},{"lesson":"ok","supportingExperienceIds":["a","b"]}]'
    const out = parseProposals(text)
    expect(out).toHaveLength(1)
    expect(out[0].lesson).toBe('ok')
  })

  it('preserves rationale and tags when present', () => {
    const text = JSON.stringify([
      { lesson: 'L', rationale: 'why', tags: ['x', 'y'], supportingExperienceIds: ['a'] },
    ])
    const out = parseProposals(text)
    expect(out[0].rationale).toBe('why')
    expect(out[0].tags).toEqual(['x', 'y'])
  })
})

describe('createLLMDistiller', () => {
  /** Build a fake LLMProvider exposing only the surface the distiller touches. */
  function fakeLLM(reply: string, captured?: { messages?: unknown }): LLMProvider {
    return {
      buildMessages: (cfg: { currentInput: string }) => {
        if (captured) captured.messages = cfg.currentInput
        return [{ role: 'user' as const, content: cfg.currentInput }]
      },
      getProviderType: () => 'anthropic',
      generate: async () => ({
        text: reply,
        tokens: { prompt: 0, completion: 0, cacheWrite: 0, cacheRead: 0 },
        cost: 0,
      }),
    } as unknown as LLMProvider
  }

  it('returns [] when fewer than 2 experiences supplied', async () => {
    const distiller = createLLMDistiller({ llm: fakeLLM('[]') })
    const out = await distiller({ experiences: [makeExperience('a')], maxLessons: 5 })
    expect(out).toEqual([])
  })

  it('returns [] when maxLessons is 0', async () => {
    const distiller = createLLMDistiller({ llm: fakeLLM('[]') })
    const out = await distiller({
      experiences: [makeExperience('a'), makeExperience('b')],
      maxLessons: 0,
    })
    expect(out).toEqual([])
  })

  it('parses a successful LLM response', async () => {
    const reply = JSON.stringify([
      { lesson: 'L1', rationale: 'r', tags: ['t'], supportingExperienceIds: ['a', 'b'] },
    ])
    const distiller = createLLMDistiller({ llm: fakeLLM(reply) })
    const out = await distiller({
      experiences: [makeExperience('a'), makeExperience('b')],
      maxLessons: 5,
    })
    expect(out).toHaveLength(1)
    expect(out[0].lesson).toBe('L1')
  })

  it('returns [] when the LLM returns garbage', async () => {
    const distiller = createLLMDistiller({ llm: fakeLLM('completely not json {]') })
    const out = await distiller({
      experiences: [makeExperience('a'), makeExperience('b')],
      maxLessons: 5,
    })
    expect(out).toEqual([])
  })

  it('passes a user prompt that mentions all experience ids', async () => {
    const captured: { messages?: unknown } = {}
    const distiller = createLLMDistiller({ llm: fakeLLM('[]', captured) })
    await distiller({
      experiences: [makeExperience('a'), makeExperience('b')],
      maxLessons: 3,
    })
    const text = String(captured.messages)
    expect(text).toContain('id: a')
    expect(text).toContain('id: b')
    expect(text).toContain('Target max lessons: 3')
  })
})
