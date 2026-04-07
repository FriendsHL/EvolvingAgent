// ============================================================
// SubAgent — wraps the existing Agent class behind the IPC protocol
// ============================================================
//
// A SubAgent owns a single underlying `Agent` instance plus its sub-side
// transport endpoint. It listens for `task:assign`, drives the agent, and
// emits `task:progress` / `task:result` back to Main.
//
// Cancellation is cooperative: a `task:cancel` flips the `cancelled` flag,
// which is checked at every `await` boundary the SubAgent itself controls.
// We CANNOT preempt code running inside `Agent.processMessage()` — that
// would require invasive changes to the agent loop. See the TODO below.

import { Agent, type AgentConfig } from '../agent.js'
import type {
  SubAgentMessage,
  TaskAssign,
  TaskProgress,
  TaskResult,
  TaskCancel,
  ToolCallRecord,
  Artifact,
} from './protocol.js'
import { isTaskAssign, isTaskCancel } from './protocol.js'
import type { SubAgentTransport } from './transport.js'

export interface SubAgentOptions {
  /** Stable identifier for this sub-agent (also surfaced via SubAgentHandle.id) */
  id: string
  /** Human-readable name (template id, ad-hoc tag, etc.) */
  name: string
  /** Underlying agent configuration. The dataPath here points at the SAME
   *  shared data directory as Main, so experience/skill/knowledge stores
   *  are read from a common source. Writes are still gated by Main. */
  agentConfig: AgentConfig
  /** Optional system prompt override (ad-hoc mode). The current `Agent`
   *  class hard-codes its conversational system prompt; we record the
   *  override here so future iterations can wire it in. */
  systemPromptOverride?: string
  /** Optional tool whitelist (currently informational — see TODO). */
  toolWhitelist?: string[]
  /** Sub side of the IPC transport pair. */
  transport: SubAgentTransport
}

export class SubAgent {
  readonly id: string
  readonly name: string
  private agent: Agent
  private transport: SubAgentTransport
  private started = false
  private cancelled = false
  private cancelReason: string | null = null
  private currentTaskId: string | null = null
  private systemPromptOverride?: string
  private toolWhitelist?: string[]

  constructor(opts: SubAgentOptions) {
    this.id = opts.id
    this.name = opts.name
    this.agent = new Agent(opts.agentConfig)
    this.transport = opts.transport
    this.systemPromptOverride = opts.systemPromptOverride
    this.toolWhitelist = opts.toolWhitelist
  }

  /** Initialize the underlying agent (loads memory/skills/knowledge from disk). */
  async init(): Promise<void> {
    await this.agent.init()
  }

  /** Begin listening for incoming task:assign / task:cancel messages. */
  start(): void {
    if (this.started) return
    this.started = true
    this.transport.onMessage((msg) => {
      this.handleMessage(msg)
    })
  }

  /** Stop listening and shut down the underlying agent. */
  async stop(): Promise<void> {
    this.started = false
    this.cancelled = true
    try {
      await this.agent.shutdown()
    } catch {
      // Shutdown errors are non-fatal; we're tearing down anyway.
    }
    await this.transport.close()
  }

  /** Expose the wrapped Agent for advanced consumers (read-only inspection). */
  getAgent(): Agent {
    return this.agent
  }

  // ----------------------------------------------------------
  // Message handling
  // ----------------------------------------------------------

  private handleMessage(msg: SubAgentMessage): void {
    if (isTaskAssign(msg)) {
      // Fire-and-forget: the run loop emits its own messages. We catch all
      // exceptions inside `runTask` so this never throws.
      void this.runTask(msg)
      return
    }
    if (isTaskCancel(msg)) {
      this.handleCancel(msg)
      return
    }
    // resource:grant and other inbound messages are not consumed by the
    // v1 sub-agent loop yet (the agent doesn't issue resource:request).
    // Drop silently — Main can decide to retry or ignore.
  }

  private handleCancel(msg: TaskCancel): void {
    if (this.currentTaskId !== msg.taskId) return
    this.cancelled = true
    this.cancelReason = msg.reason
  }

  private async runTask(assign: TaskAssign): Promise<void> {
    const startedAt = Date.now()
    this.currentTaskId = assign.taskId
    this.cancelled = false
    this.cancelReason = null

    // Snapshot pre-run session metrics so we can report deltas.
    const sessionBefore = this.agent.getSession()
    const tokensBefore = sessionBefore.totalTokens

    // Emit an initial progress event. v1 only emits this single progress
    // marker plus the final task:result — see the TODO at end of file for
    // why progress is currently coarse-grained.
    await this.emitProgress({
      type: 'task:progress',
      taskId: assign.taskId,
      status: 'thinking',
      summary: `Starting: ${assign.description.slice(0, 200)}`,
      tokensUsed: 0,
      stepsCompleted: 0,
    })

    if (this.cancelled) {
      await this.emitCancelledResult(assign, startedAt, tokensBefore)
      return
    }

    try {
      // Compose the user-facing message we hand to the underlying Agent.
      // We fold context.background + constraints into the message rather
      // than mutating Agent's system prompt — keeps this wrapper isolated
      // from Agent internals.
      const composed = composeSubAgentInput(assign, this.systemPromptOverride)

      // === Cancellation checkpoint #1: just before the long await ===
      if (this.cancelled) {
        await this.emitCancelledResult(assign, startedAt, tokensBefore)
        return
      }

      const answer = await this.agent.processMessage(composed)

      // === Cancellation checkpoint #2: result post-processing ===
      if (this.cancelled) {
        await this.emitCancelledResult(assign, startedAt, tokensBefore)
        return
      }

      const sessionAfter = this.agent.getSession()
      const tokensUsed = sessionAfter.totalTokens - tokensBefore
      const result: TaskResult = {
        type: 'task:result',
        taskId: assign.taskId,
        outcome: 'success',
        result: {
          answer,
          artifacts: [] as Artifact[],
          toolCalls: [] as ToolCallRecord[],
        },
        metadata: {
          tokensUsed,
          duration: Date.now() - startedAt,
          stepsTotal: 0,
          model: assign.config.model,
        },
      }
      await this.transport.send(result)
    } catch (err) {
      // Top-level catch: NEVER let an exception escape the sub-agent loop.
      const message = err instanceof Error ? err.message : String(err)
      const sessionAfter = this.agent.getSession()
      const tokensUsed = sessionAfter.totalTokens - tokensBefore
      const failure: TaskResult = {
        type: 'task:result',
        taskId: assign.taskId,
        outcome: 'failure',
        result: {
          answer: '',
          artifacts: [],
          toolCalls: [],
        },
        metadata: {
          tokensUsed,
          duration: Date.now() - startedAt,
          stepsTotal: 0,
          model: assign.config.model,
        },
        reflection: {
          whatWorked: [],
          whatFailed: [message],
          suggestion: 'Review the underlying error and retry with adjusted inputs.',
        },
      }
      await this.transport.send(failure)
    } finally {
      this.currentTaskId = null
    }
  }

  private async emitProgress(p: TaskProgress): Promise<void> {
    await this.transport.send(p)
  }

  private async emitCancelledResult(
    assign: TaskAssign,
    startedAt: number,
    tokensBefore: number,
  ): Promise<void> {
    const sessionAfter = this.agent.getSession()
    const tokensUsed = sessionAfter.totalTokens - tokensBefore
    const result: TaskResult = {
      type: 'task:result',
      taskId: assign.taskId,
      outcome: 'partial',
      result: {
        answer: '',
        artifacts: [],
        toolCalls: [],
      },
      metadata: {
        tokensUsed,
        duration: Date.now() - startedAt,
        stepsTotal: 0,
        model: assign.config.model,
      },
      reflection: {
        whatWorked: [],
        whatFailed: [`Cancelled: ${this.cancelReason ?? 'unspecified'}`],
        suggestion: 'Task was cancelled by Main; retry with a larger budget or different scope.',
      },
    }
    await this.transport.send(result)
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function composeSubAgentInput(assign: TaskAssign, systemPromptOverride?: string): string {
  const parts: string[] = []
  if (systemPromptOverride) {
    parts.push(`[Sub-agent role]\n${systemPromptOverride}`)
  }
  if (assign.context.background) {
    parts.push(`[Background]\n${assign.context.background}`)
  }
  if (assign.context.constraints.length > 0) {
    parts.push(`[Constraints]\n- ${assign.context.constraints.join('\n- ')}`)
  }
  parts.push(`[Task]\n${assign.description}`)
  return parts.join('\n\n')
}

// TODO(progress): v1 only emits one `task:progress` (start) and one
// terminal `task:result`. Finer-grained progress (per-plan-step or per
// LLM call) requires the underlying `Agent` to expose hooks or an event
// stream we can subscribe to from the wrapper. The Agent already emits
// AgentEvents via `onEvent()`; the next iteration should bridge those
// events into TaskProgress messages — see Agent.onEvent in agent.ts.
//
// TODO(tools): the `toolWhitelist` field is recorded but not yet enforced.
// Enforcement requires either filtering the tool registry per-sub-agent
// or adding a permission hook. The Agent currently always exposes its
// full builtin tool/skill set.
//
// TODO(artifacts/toolCalls): the v1 result.artifacts and result.toolCalls
// arrays are empty. We can populate them by subscribing to Agent's
// `tool-result` events and translating ExecutionStep → ToolCallRecord.
