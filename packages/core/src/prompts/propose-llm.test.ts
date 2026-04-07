import { describe, it, expect, vi } from 'vitest'
import { createLLMProposer } from './propose-llm.js'
import type { LLMProvider } from '../llm/provider.js'
import type { EvalCase } from '../eval/types.js'

function makeFakeLLM(responses: string[]): LLMProvider {
  let call = 0
  const fake = {
    getProviderType: () => 'openai-compatible' as const,
    buildMessages: vi.fn((cfg: { currentInput: string }) => [
      { role: 'system', content: 'sys' },
      { role: 'user', content: cfg.currentInput },
    ]),
    generate: vi.fn(async () => {
      const text = responses[call % responses.length] ?? '{}'
      call++
      return {
        text,
        metrics: {
          model: 'fake',
          tokens: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
          duration: 0,
          provider: 'openai-compatible' as const,
        },
      }
    }),
  }
  return fake as unknown as LLMProvider
}

const sampleCases: EvalCase[] = [
  {
    id: 'reasoning-arithmetic',
    title: 'Arithmetic',
    tags: ['reasoning'],
    input: 'What is 2+2?',
    criteria: [{ type: 'contains', substring: '4' }],
  },
]

describe('createLLMProposer', () => {
  it('returns parsed candidates from raw JSON responses', async () => {
    const llm = makeFakeLLM([
      JSON.stringify({ rationale: 'fix #1', prompt: 'NEW_PROMPT_A' }),
      JSON.stringify({ rationale: 'fix #2', prompt: 'NEW_PROMPT_B' }),
    ])
    const propose = createLLMProposer({ llm })
    const candidates = await propose({
      targetId: 'planner',
      currentPrompt: 'OLD',
      failingCases: sampleCases,
      count: 2,
    })
    expect(candidates).toHaveLength(2)
    expect(candidates[0].content).toBe('NEW_PROMPT_A')
    expect(candidates[0].source).toBe('llm-selfgen')
    expect(candidates[0].targetId).toBe('planner')
    expect(candidates[1].content).toBe('NEW_PROMPT_B')
  })

  it('parses JSON wrapped in fenced code blocks', async () => {
    const llm = makeFakeLLM([
      '```json\n' + JSON.stringify({ prompt: 'FENCED_PROMPT' }) + '\n```',
    ])
    const propose = createLLMProposer({ llm })
    const candidates = await propose({
      targetId: 'reflector',
      currentPrompt: 'OLD',
      failingCases: [],
      count: 1,
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0].content).toBe('FENCED_PROMPT')
  })

  it('skips malformed responses without aborting the batch', async () => {
    const llm = makeFakeLLM([
      'not json at all',
      JSON.stringify({ prompt: 'GOOD_ONE' }),
      '{"unrelated": "shape"}', // missing prompt field
    ])
    const propose = createLLMProposer({ llm })
    const candidates = await propose({
      targetId: 'planner',
      currentPrompt: 'OLD',
      failingCases: [],
      count: 3,
    })
    // Only the second response is valid; the other two are silently dropped.
    expect(candidates).toHaveLength(1)
    expect(candidates[0].content).toBe('GOOD_ONE')
  })

  it('passes failing case summaries into the user message', async () => {
    const llm = makeFakeLLM(['{"prompt": "OK"}'])
    const propose = createLLMProposer({ llm })
    await propose({
      targetId: 'planner',
      currentPrompt: 'CURRENT_PROMPT',
      failingCases: sampleCases,
      count: 1,
    })
    // The fake's buildMessages spy should have been called with a user
    // input that mentions the failing case id and the current prompt body.
    const call = (llm.buildMessages as ReturnType<typeof vi.fn>).mock.calls[0]
    const cfg = call[0] as { currentInput: string }
    expect(cfg.currentInput).toContain('reasoning-arithmetic')
    expect(cfg.currentInput).toContain('CURRENT_PROMPT')
    expect(cfg.currentInput).toContain('planner')
  })

  it('returns empty array when count is 0', async () => {
    const llm = makeFakeLLM(['{"prompt": "X"}'])
    const propose = createLLMProposer({ llm })
    const candidates = await propose({
      targetId: 'planner',
      currentPrompt: 'OLD',
      failingCases: [],
      count: 0,
    })
    expect(candidates).toHaveLength(0)
    expect(llm.generate).not.toHaveBeenCalled()
  })
})
