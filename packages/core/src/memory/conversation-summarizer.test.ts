import { describe, it, expect, vi } from 'vitest'
import { ConversationSummarizer } from './conversation-summarizer.js'
import type { LLMProvider } from '../llm/provider.js'
import type { ChatMessage } from './short-term.js'

function makeMockLLM(text: string): LLMProvider {
  const generate = vi.fn().mockResolvedValue({
    text,
    toolCalls: [],
    metrics: {
      callId: 'test',
      model: 'mock',
      timestamp: new Date().toISOString(),
      tokens: { prompt: 0, completion: 0, cacheWrite: 0, cacheRead: 0 },
      cacheHitRate: 0,
      cost: 0,
      savedCost: 0,
      duration: 0,
    },
  })
  // Cast — we only need `generate` for the summarizer.
  return { generate } as unknown as LLMProvider
}

function makeMsgs(...pairs: Array<[ChatMessage['role'], string]>): ChatMessage[] {
  return pairs.map(([role, content]) => ({ role, content, timestamp: '2024-01-01T00:00:00Z' }))
}

describe('ConversationSummarizer', () => {
  it('summarize returns trimmed LLM text', async () => {
    const llm = makeMockLLM('  The user wants to build a todo app in React.  ')
    const summarizer = new ConversationSummarizer(llm)

    const summary = await summarizer.summarize(
      makeMsgs(
        ['user', 'I want to build a todo app'],
        ['assistant', 'Sure, which framework?'],
        ['user', 'React please'],
      ),
    )

    expect(summary).toBe('The user wants to build a todo app in React.')
    expect((llm.generate as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
    const [role, messages] = (llm.generate as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(role).toBe('reflector')
    // System prompt + user transcript
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('system')
    expect(messages[1].role).toBe('user')
    expect(messages[1].content).toContain('USER: I want to build a todo app')
  })

  it('summarize folds in a prior running summary', async () => {
    const llm = makeMockLLM('Updated summary with new facts.')
    const summarizer = new ConversationSummarizer(llm)

    await summarizer.summarize(
      makeMsgs(['user', 'Also add dark mode'], ['assistant', 'Noted.']),
      'Earlier: user wants a React todo app.',
    )

    const [, messages] = (llm.generate as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(messages[1].content).toContain('Previous running summary:')
    expect(messages[1].content).toContain('React todo app')
    expect(messages[1].content).toContain('Also add dark mode')
  })

  it('summarize returns empty string when no input and no prior summary', async () => {
    const llm = makeMockLLM('should not be called')
    const summarizer = new ConversationSummarizer(llm)
    const summary = await summarizer.summarize([])
    expect(summary).toBe('')
    expect(llm.generate).not.toHaveBeenCalled()
  })

  it('estimateTokens uses chars/4 heuristic', () => {
    const llm = makeMockLLM('x')
    const summarizer = new ConversationSummarizer(llm)

    // 100 chars total -> 25 tokens
    const msgs = makeMsgs(
      ['user', 'a'.repeat(40)],
      ['assistant', 'b'.repeat(60)],
    )
    expect(summarizer.estimateTokens(msgs)).toBe(25)

    expect(summarizer.estimateTokens([])).toBe(0)
  })
})
