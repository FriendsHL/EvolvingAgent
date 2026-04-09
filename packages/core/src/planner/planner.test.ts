import { describe, it, expect, beforeAll } from 'vitest'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Planner } from './planner.js'
import type { LLMProvider, GenerateResult } from '../llm/provider.js'
import { SubAgentRegistry } from '../sub-agents/loader.js'

// ------------------------------------------------------------
// Test fixtures
// ------------------------------------------------------------

const thisFileDir = dirname(fileURLToPath(import.meta.url))
const BUILTIN_DIR = join(thisFileDir, '..', 'sub-agents', 'builtin')

interface StubCall {
  tools?: Record<string, unknown>
  messages: unknown
}

function makeStubLLM(
  scripted: () => Partial<GenerateResult>,
  calls: StubCall[] = [],
): LLMProvider {
  const metrics: GenerateResult['metrics'] = {
    callId: 'stub',
    model: 'stub-model',
    provider: 'openai',
    timestamp: new Date().toISOString(),
    tokens: { prompt: 10, completion: 5, cacheWrite: 0, cacheRead: 0 },
    cacheHitRate: 0,
    cost: 0,
    savedCost: 0,
    duration: 1,
  }
  const fake = {
    getProviderType(): string {
      return 'openai'
    },
    buildMessages(_config: unknown): unknown {
      return [{ role: 'system', content: 'stub' }]
    },
    async generate(
      _role: string,
      messages: unknown,
      tools?: Record<string, unknown>,
    ): Promise<GenerateResult> {
      calls.push({ tools, messages })
      const scriptedOutput = scripted()
      return {
        text: scriptedOutput.text ?? '',
        toolCalls: scriptedOutput.toolCalls ?? [],
        metrics: scriptedOutput.metrics ?? metrics,
      }
    },
  }
  return fake as unknown as LLMProvider
}

let registry: SubAgentRegistry

beforeAll(async () => {
  registry = new SubAgentRegistry()
  await registry.init({ builtinDir: BUILTIN_DIR })
})

// ------------------------------------------------------------
// Solo (non-router) mode regression
// ------------------------------------------------------------

describe('Planner — solo mode (routerMode off)', () => {
  it('parses a JSON plan from llm text as before', async () => {
    const llm = makeStubLLM(() => ({
      text: JSON.stringify({
        task: 'echo hello',
        steps: [{ description: 'run echo', tool: 'shell', params: { command: 'echo hi' } }],
      }),
    }))
    const planner = new Planner(llm)
    const { plan } = await planner.plan('echo hello', [], [])
    expect(plan.task).toBe('echo hello')
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].tool).toBe('shell')
  })

  it('falls back to empty steps on parse failure (legacy catch)', async () => {
    const llm = makeStubLLM(() => ({ text: 'not json at all' }))
    const planner = new Planner(llm)
    const { plan } = await planner.plan('hi', [], [])
    expect(plan.steps).toEqual([])
  })
})

// ------------------------------------------------------------
// Router mode
// ------------------------------------------------------------

describe('Planner — router mode', () => {
  it('returns a single-step delegate plan when the LLM emits a delegate tool call', async () => {
    const calls: StubCall[] = []
    const llm = makeStubLLM(
      () => ({
        text: '',
        toolCalls: [
          {
            toolCallId: 'c1',
            toolName: 'delegate',
            args: {
              subagent_type: 'research',
              task: 'what time is it right now in UTC',
              rationale: 'needs a real clock',
            },
          },
        ],
      }),
      calls,
    )
    const planner = new Planner(llm, undefined, undefined, undefined, {
      routerMode: true,
      subAgentRegistry: registry,
    })
    const { plan } = await planner.plan('what time is it', [], [])
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].tool).toBe('delegate')
    expect(plan.steps[0].params).toEqual({
      subagent_type: 'research',
      task: 'what time is it right now in UTC',
      rationale: 'needs a real clock',
    })
    // The stub was called with the router toolset (delegate tool present).
    expect(calls).toHaveLength(1)
    expect(calls[0].tools && 'delegate' in (calls[0].tools as object)).toBe(true)
  })

  it('returns an empty-steps plan (DIRECT) when the LLM produces text with no tool call', async () => {
    const llm = makeStubLLM(() => ({
      text: 'Hi there! How can I help you today?',
      toolCalls: [],
    }))
    const planner = new Planner(llm, undefined, undefined, undefined, {
      routerMode: true,
      subAgentRegistry: registry,
    })
    const { plan } = await planner.plan('hi', [], [])
    expect(plan.steps).toEqual([])
  })

  it('falls back to delegate research when toolCalls AND text are both empty', async () => {
    const llm = makeStubLLM(() => ({ text: '', toolCalls: [] }))
    const planner = new Planner(llm, undefined, undefined, undefined, {
      routerMode: true,
      subAgentRegistry: registry,
    })
    const { plan } = await planner.plan('do something useful', [], [])
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].tool).toBe('delegate')
    const params = plan.steps[0].params as Record<string, unknown>
    expect(params.subagent_type).toBe('research')
    expect(params.task).toBe('do something useful')
  })

  it('falls back to delegate research when the LLM call throws', async () => {
    const fake = {
      getProviderType(): string {
        return 'openai'
      },
      buildMessages(): unknown {
        return []
      },
      async generate(): Promise<GenerateResult> {
        throw new Error('provider down')
      },
    } as unknown as LLMProvider
    const planner = new Planner(fake, undefined, undefined, undefined, {
      routerMode: true,
      subAgentRegistry: registry,
    })
    const { plan } = await planner.plan('stuff', [], [])
    expect(plan.steps).toHaveLength(1)
    expect((plan.steps[0].params as Record<string, unknown>).subagent_type).toBe('research')
  })

  it('tags fallback metrics with a provider-scoped sentinel model id', async () => {
    const fake = {
      getProviderType(): string {
        return 'openai'
      },
      buildMessages(): unknown {
        return []
      },
      async generate(): Promise<GenerateResult> {
        throw new Error('provider down')
      },
    } as unknown as LLMProvider
    const planner = new Planner(fake, undefined, undefined, undefined, {
      routerMode: true,
      subAgentRegistry: registry,
    })
    const { metrics } = await planner.plan('stuff', [], [])
    // Grep-friendly sentinel so operators can filter these zero-cost rows
    // out of cost dashboards without mistaking them for real model calls.
    expect(metrics.model).toBe('openai:router-fallback-error')
    expect(metrics.cost).toBe(0)
  })
})
