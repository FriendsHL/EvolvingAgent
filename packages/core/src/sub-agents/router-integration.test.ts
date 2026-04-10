// ============================================================
// Router-mode integration test (Phase 5 S1)
// ============================================================
//
// Exercises the full pipe:
//   1. SubAgentRegistry + SubAgentManager provided → Agent constructs in router mode
//   2. Planner calls a stubbed LLMProvider that returns a
//      delegate tool call targeting 'research'
//   3. Agent intercepts the delegate step and calls
//      subAgentManager.spawn({mode:'adhoc', name:'research', ...})
//   4. We stub spawn() to return a handle that resolves with a
//      canned TaskResult
//   5. The final assistant message equals the canned answer
//
// This is a light end-to-end test — we do NOT start a real
// in-process sub-agent (that would need the real SubAgent loop,
// which pulls in the full Agent constructor for the child and
// cascades into LLM calls). The spawn() stub is the
// intentional seam.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Agent } from '../agent.js'
import type { LLMProvider, GenerateResult } from '../llm/provider.js'
import { SubAgentRegistry } from './loader.js'
import { SubAgentManager, type SubAgentHandle, type SubAgentSpec } from '../sub-agent/manager.js'
import type { TaskResult } from '../sub-agent/protocol.js'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const thisFileDir = dirname(fileURLToPath(import.meta.url))
const BUILTIN_DIR = join(thisFileDir, 'builtin')

// ------------------------------------------------------------
// Stub infrastructure
// ------------------------------------------------------------

function makeStubLLM(scripted: {
  planner?: Partial<GenerateResult>
  default?: Partial<GenerateResult>
}): LLMProvider {
  const metrics: GenerateResult['metrics'] = {
    callId: 'stub',
    model: 'stub-model',
    provider: 'openai',
    timestamp: new Date().toISOString(),
    tokens: { prompt: 0, completion: 0, cacheWrite: 0, cacheRead: 0 },
    cacheHitRate: 0,
    cost: 0,
    savedCost: 0,
    duration: 0,
  }
  const fake = {
    getProviderType(): string {
      return 'openai'
    },
    buildMessages(): unknown {
      return [{ role: 'system', content: 'stub' }]
    },
    async generate(role: string): Promise<GenerateResult> {
      const out =
        role === 'planner' ? scripted.planner : scripted.default
      return {
        text: out?.text ?? '',
        toolCalls: out?.toolCalls ?? [],
        metrics: out?.metrics ?? metrics,
      }
    },
    async *stream(): AsyncGenerator<
      { type: 'text-delta'; text: string } | { type: 'finish'; metrics: typeof metrics }
    > {
      yield { type: 'finish', metrics }
    },
  }
  return fake as unknown as LLMProvider
}

class StubSubAgentManager extends SubAgentManager {
  public lastSpec: SubAgentSpec | null = null
  public cannedAnswer: string
  public cannedOutcome: TaskResult['outcome'] = 'success'

  constructor(dataPath: string, cannedAnswer: string) {
    super({ dataPath })
    this.cannedAnswer = cannedAnswer
  }

  override async spawn(spec: SubAgentSpec): Promise<SubAgentHandle> {
    this.lastSpec = spec
    const answer = this.cannedAnswer
    const outcome = this.cannedOutcome
    const result: TaskResult = {
      type: 'task:result',
      taskId: 'fake-task',
      outcome,
      result: {
        answer,
        artifacts: [],
        toolCalls: [],
      },
      metadata: {
        tokensUsed: 0,
        duration: 0,
        stepsTotal: 0,
        model: 'stub',
      },
      reflection: outcome === 'failure'
        ? { whatWorked: [], whatFailed: ['stubbed failure'], suggestion: '' }
        : undefined,
    }
    const handle: SubAgentHandle = {
      id: 'stub-handle',
      name: spec.mode === 'adhoc' ? spec.name : spec.templateId,
      status: 'completed',
      assign: async () => 'task-stub',
      cancel: async () => {},
      onProgress: () => {},
      onResourceRequest: () => {},
      result: async () => result,
      close: async () => {},
    }
    return handle
  }
}

// ------------------------------------------------------------
// Test body
// ------------------------------------------------------------

describe('Phase 5 router-mode integration (delegate dispatch)', () => {
  let dataPath: string

  beforeEach(async () => {
    dataPath = await mkdtemp(join(tmpdir(), 'router-int-test-'))
  })

  afterEach(async () => {
    await rm(dataPath, { recursive: true, force: true })
  })

  it('routes a real-time-state question through delegate → research and returns the stubbed answer', async () => {
    // 1. Load the real registry so the router tool enum contains 'research'.
    const registry = new SubAgentRegistry()
    await registry.init({ builtinDir: BUILTIN_DIR })

    // 2. Planner LLM returns a single delegate tool call.
    const llm = makeStubLLM({
      planner: {
        text: '',
        toolCalls: [
          {
            toolCallId: 'c1',
            toolName: 'delegate',
            args: {
              subagent_type: 'research',
              task: 'print the current UTC time using shell `date -u`',
              rationale: 'needs a live clock',
            },
          },
        ],
      },
    })

    // 3. SubAgentManager stub with a canned answer.
    const cannedAnswer = 'The current UTC time is 2026-04-08T14:32:07Z.'
    const manager = new StubSubAgentManager(dataPath, cannedAnswer)

    // 4. Build an Agent with the Phase 5 deps wired up.
    const agent = new Agent({
      dataPath,
      shared: {
        llm,
      },
      subAgentManager: manager,
      subAgentRegistry: registry,
    })
    await agent.init()

    // Capture emitted events so we can assert the delegate trace fires.
    const events: Array<{ type: string; data: unknown }> = []
    agent.onEvent((e) => {
      events.push({ type: e.type, data: e.data })
    })

    // 5. Run the message through the full loop.
    const reply = await agent.processMessage('what time is it right now?')

    // 6. The planner called spawn with an adhoc research spec.
    expect(manager.lastSpec).not.toBeNull()
    expect(manager.lastSpec!.mode).toBe('adhoc')
    if (manager.lastSpec!.mode === 'adhoc') {
      expect(manager.lastSpec!.name).toBe('research')
      expect(manager.lastSpec!.systemPrompt?.includes('# Identity')).toBe(true)
      expect(manager.lastSpec!.task.description).toContain('UTC time')
    }

    // 7. The agent returned exactly the canned answer from the sub-agent,
    //    with no conversational hallucination wrapped around it.
    expect(reply).toBe(cannedAnswer)

    // 8. The delegate bypass emitted a visible trace event so operators
    //    and the chat UI can see that executor/reflector/experience are
    //    being skipped on this turn.
    expect(
      events.some(
        (e) =>
          e.type === 'hook' &&
          typeof e.data === 'string' &&
          e.data.includes('router-mode: delegating'),
      ),
    ).toBe(true)

    // S5: delegate turns now run reflector + experience store, so we
    // should also see the reflection event fire (non-fatal if reflector
    // stub doesn't cooperate, but the emit should happen).
    expect(
      events.some(
        (e) => e.type === 'reflecting',
      ),
    ).toBe(true)

    await agent.shutdown()
  })

  it('surfaces a sub-agent failure as an explicit error (no silent fallback)', async () => {
    const registry = new SubAgentRegistry()
    await registry.init({ builtinDir: BUILTIN_DIR })
    const llm = makeStubLLM({
      planner: {
        toolCalls: [
          {
            toolCallId: 'c1',
            toolName: 'delegate',
            args: {
              subagent_type: 'research',
              task: 'something',
              rationale: 'x',
            },
          },
        ],
      },
    })
    const manager = new StubSubAgentManager(dataPath, 'n/a')
    manager.cannedOutcome = 'failure'

    const agent = new Agent({
      dataPath,
      shared: { llm },
      subAgentManager: manager,
      subAgentRegistry: registry,
    })
    await agent.init()

    await expect(agent.processMessage('do the thing')).rejects.toThrow(
      /Sub-agent research failed/,
    )
    await agent.shutdown()
  })
})
