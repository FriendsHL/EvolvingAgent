import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PresetName, ProviderConfig } from '../llm/provider.js'
import { SubAgentManager, type SubAgentHandle, type SubAgentSpec } from '../sub-agent/index.js'
import type { TaskProgress, TaskResult } from '../sub-agent/index.js'
import { MessageBus } from './message-bus.js'
import { AGENT_TEMPLATES } from './templates.js'

// ============================================================
// Multi-Agent Coordinator
// ============================================================
//
// Phase 3 Batch 3: delegation now routes through SubAgentManager
// instead of inline `await childAgent.processMessage(...)` calls.
//
// Two registration paths are supported:
//   - register(profile, handler) — legacy in-process handler. Kept so the
//     existing web `coordinate` route (and other callers) keep working
//     without changes. Routes execute by calling the handler directly.
//   - registerSpec(profile, spec) — sub-agent backed agent. Routes through
//     SubAgentManager.spawn(), so every delegation hits the new transport
//     and IPC protocol layer.
//
// New code should prefer registerSpec(). The legacy path is preserved for
// back-compat only.

export interface AgentProfile {
  id: string
  name: string
  role: string
  description: string
  capabilities: string[] // What this agent is good at
  status: 'idle' | 'busy' | 'offline'
  provider?: PresetName
}

/**
 * Spec describing how to spawn a sub-agent for a registered profile.
 * Either points at a known template id (resolved via the manager's
 * resolveTemplate callback) or an ad-hoc system prompt.
 */
export type RegisteredSubAgentSpec =
  | { mode: 'template'; templateId: string }
  | { mode: 'adhoc'; systemPrompt?: string; tools?: string[] }

interface RegisteredAgent {
  profile: AgentProfile
  /** Legacy in-process handler. Set when agent registered via register(). */
  processMessage?: (msg: string) => Promise<string>
  /** Sub-agent spec. Set when agent registered via registerSpec(). */
  subAgentSpec?: RegisteredSubAgentSpec
}

export interface CoordinatorOptions {
  /** Shared data directory; required to enable sub-agent spawning. */
  dataPath?: string
  /** Optional LLM provider (preset name or full config) for spawned sub-agents. */
  provider?: ProviderConfig | PresetName
  /** Optional default model name for TaskAssign.config.model. */
  defaultModel?: string
  /** Optional default token budget. Use Infinity for "no limit". */
  defaultTokenBudget?: number
  /** Optional default soft timeout (ms). 0 means none. */
  defaultTimeout?: number
}

export class AgentCoordinator {
  private agents = new Map<string, RegisteredAgent>()
  private bus: MessageBus
  private subAgentManager: SubAgentManager | null = null
  private options: CoordinatorOptions

  constructor(busOrOptions?: MessageBus | CoordinatorOptions, maybeBus?: MessageBus) {
    // Back-compat: original signature was `constructor(bus?: MessageBus)`.
    // New signature: `constructor(options?: CoordinatorOptions, bus?: MessageBus)`.
    // Disambiguate by checking the first arg's shape.
    if (busOrOptions instanceof MessageBus) {
      this.bus = busOrOptions
      this.options = {}
    } else {
      this.options = busOrOptions ?? {}
      this.bus = maybeBus ?? new MessageBus()
    }

    if (this.options.dataPath) {
      this.subAgentManager = new SubAgentManager({
        dataPath: this.options.dataPath,
        provider: this.options.provider,
        defaultModel: this.options.defaultModel,
        // Infinity tokenBudget = "inherit / no limit"; 0 timeout = "none".
        defaultTokenBudget: this.options.defaultTokenBudget ?? Number.POSITIVE_INFINITY,
        defaultTimeout: this.options.defaultTimeout ?? 0,
        resolveTemplate: (templateId) => this.resolveTemplateById(templateId),
      })
    }
  }

  /**
   * Resolve a templateId either from `data/agents/{id}/agent.json` (+
   * `system.md`) on disk, or from the in-memory AGENT_TEMPLATES registry.
   * Disk takes precedence so an agent can evolve its own template files
   * without recompilation.
   */
  private resolveTemplateById(templateId: string): {
    name: string
    systemPrompt?: string
    tools?: string[]
    model?: string
    tokenBudget?: number
  } | undefined {
    const dataPath = this.options.dataPath
    if (dataPath) {
      const agentDir = join(dataPath, 'agents', templateId)
      const jsonPath = join(agentDir, 'agent.json')
      const systemPath = join(agentDir, 'system.md')
      if (existsSync(jsonPath)) {
        try {
          const raw = readFileSync(jsonPath, 'utf-8')
          const parsed = JSON.parse(raw) as {
            name?: string
            systemPrompt?: string
            tools?: string[]
            model?: string
            tokenBudget?: number
          }
          let systemPrompt = parsed.systemPrompt
          if (!systemPrompt && existsSync(systemPath)) {
            systemPrompt = readFileSync(systemPath, 'utf-8')
          }
          return {
            name: parsed.name ?? templateId,
            systemPrompt,
            tools: parsed.tools,
            model: parsed.model,
            tokenBudget: parsed.tokenBudget,
          }
        } catch {
          // Fall through to in-memory registry on parse / IO error.
        }
      }
    }

    const tpl = AGENT_TEMPLATES[templateId]
    if (!tpl) return undefined
    return {
      name: tpl.name,
      systemPrompt: tpl.systemPrompt,
      tools: tpl.capabilities,
    }
  }

  /** Get the underlying SubAgentManager (or null if dataPath was not configured). */
  getSubAgentManager(): SubAgentManager | null {
    return this.subAgentManager
  }

  /**
   * Legacy: register an agent with an in-process message handler.
   * Routes will execute by calling the handler directly (no sub-agent
   * isolation). Kept for back-compat with existing callers; new code
   * should prefer registerSpec().
   */
  register(profile: AgentProfile, handler: (msg: string) => Promise<string>): void {
    this.agents.set(profile.id, { profile, processMessage: handler })

    // Auto-subscribe the agent to the message bus for task-request messages.
    this.bus.subscribe(profile.id, async (message) => {
      if (message.type === 'task-request' && typeof message.payload === 'string') {
        const result = await handler(message.payload)
        await this.bus.send({
          from: profile.id,
          to: message.from,
          type: 'task-result',
          payload: result,
          correlationId: message.correlationId,
        })
      }
    })
  }

  /**
   * Register an agent that should be spawned as a sub-agent on demand.
   * Requires the coordinator to have been constructed with a `dataPath`
   * (otherwise SubAgentManager is unavailable and the registration will
   * be rejected at routing time).
   */
  registerSpec(profile: AgentProfile, spec: RegisteredSubAgentSpec): void {
    this.agents.set(profile.id, { profile, subAgentSpec: spec })
  }

  /** Unregister an agent */
  unregister(agentId: string): void {
    this.agents.delete(agentId)
    this.bus.unsubscribe(agentId)
  }

  /** Find agents matching a capability (case-insensitive substring match) */
  findByCapability(capability: string): AgentProfile[] {
    const needle = capability.toLowerCase()
    return this.list().filter((p) =>
      p.capabilities.some((c) => c.toLowerCase().includes(needle) || needle.includes(c.toLowerCase())),
    )
  }

  /** Find agents matching a role (case-insensitive exact match) */
  findByRole(role: string): AgentProfile[] {
    const needle = role.toLowerCase()
    return this.list().filter((p) => p.role.toLowerCase() === needle)
  }

  /** Get all registered agent profiles */
  list(): AgentProfile[] {
    return Array.from(this.agents.values()).map((a) => ({ ...a.profile }))
  }

  /** Get the message bus */
  getBus(): MessageBus {
    return this.bus
  }

  /**
   * Route a task to the best-matching agent.
   *
   * 1. Parse the task to identify keywords/capabilities needed
   * 2. Find agents with matching capabilities (simple keyword matching)
   * 3. Pick the best idle agent
   * 4. If the agent is sub-agent backed → spawn via SubAgentManager
   *    and await its task:result. Otherwise call the legacy handler.
   * 5. Return the result (or null if no suitable agent found)
   */
  async routeTask(
    task: string,
    fromAgentId: string,
  ): Promise<{ agentId: string; result: string } | null> {
    const keywords = extractKeywords(task)

    // Score each agent by how many capabilities match the task keywords
    const candidates: Array<{ id: string; agent: RegisteredAgent; score: number }> = []
    for (const [id, agent] of this.agents) {
      if (id === fromAgentId) continue // Don't route back to the requester
      if (agent.profile.status !== 'idle') continue

      const score = computeMatchScore(agent.profile.capabilities, keywords)
      if (score > 0) {
        candidates.push({ id, agent, score })
      }
    }

    if (candidates.length === 0) return null

    // Pick the best match (highest score, then first registered)
    candidates.sort((a, b) => b.score - a.score)
    const best = candidates[0]!

    // Execute the task — sub-agent path takes precedence when available.
    best.agent.profile.status = 'busy'
    try {
      const result = await this.executeOnAgent(best.agent, task, fromAgentId)
      return { agentId: best.agent.profile.id, result }
    } finally {
      best.agent.profile.status = 'idle'
    }
  }

  /**
   * Spawn a sub-agent on demand and run a single task on it. Available
   * to callers (e.g. TaskDelegator) that already know which spec they
   * want and don't need keyword routing.
   */
  async spawnAndRun(
    spec: SubAgentSpec,
    fromAgentId = '__coordinator__',
  ): Promise<{ result: string; outcome: TaskResult['outcome'] }> {
    if (!this.subAgentManager) {
      throw new Error(
        'SubAgentManager is not configured: construct AgentCoordinator with { dataPath } to enable sub-agent spawning.',
      )
    }
    const handle = await this.subAgentManager.spawn(spec)
    this.wireProgressToBus(handle, fromAgentId)
    try {
      const tr = await handle.result()
      return { result: tr.result.answer, outcome: tr.outcome }
    } finally {
      await handle.close()
    }
  }

  /** Cancel every active sub-agent. No-op if SubAgentManager isn't configured. */
  async cancelAll(reason = 'coordinator shutdown'): Promise<void> {
    if (!this.subAgentManager) return
    await this.subAgentManager.cancelAll(reason)
  }

  /** Tear down every active sub-agent. */
  async closeAll(): Promise<void> {
    if (!this.subAgentManager) return
    await this.subAgentManager.closeAll()
  }

  // ----------------------------------------------------------
  // Internals
  // ----------------------------------------------------------

  private async executeOnAgent(
    agent: RegisteredAgent,
    task: string,
    fromAgentId: string,
  ): Promise<string> {
    if (agent.subAgentSpec) {
      if (!this.subAgentManager) {
        throw new Error(
          `Agent "${agent.profile.id}" is sub-agent backed but SubAgentManager is not configured. ` +
            `Construct AgentCoordinator with { dataPath } to enable sub-agent spawning.`,
        )
      }
      const spec = this.buildSpawnSpec(agent, task, fromAgentId)
      const handle = await this.subAgentManager.spawn(spec)
      this.wireProgressToBus(handle, fromAgentId)
      try {
        const tr = await handle.result()
        if (tr.outcome === 'failure') {
          // Translate IPC failure into the legacy thrown-error shape so
          // existing TaskDelegator catch blocks classify it as failed.
          const reason = tr.reflection?.whatFailed?.[0] ?? 'sub-agent task failed'
          throw new Error(reason)
        }
        return tr.result.answer
      } finally {
        await handle.close()
      }
    }

    if (agent.processMessage) {
      return agent.processMessage(task)
    }

    throw new Error(`Agent "${agent.profile.id}" has neither a handler nor a sub-agent spec`)
  }

  private buildSpawnSpec(
    agent: RegisteredAgent,
    task: string,
    parentTaskId: string,
  ): SubAgentSpec {
    const spec = agent.subAgentSpec!
    const taskInput = {
      parentTaskId,
      description: task,
      context: {
        background: '',
        constraints: [],
        relatedExperiences: [],
        relevantSkills: [],
      },
      config: {
        // Use sensible defaults — caller can override later by going
        // through spawnAndRun directly with a fully-specified spec.
        tokenBudget: this.options.defaultTokenBudget ?? Number.POSITIVE_INFINITY,
        timeout: this.options.defaultTimeout ?? 0,
        tools: [],
        canRequestMore: false,
      },
    }
    if (spec.mode === 'template') {
      return { mode: 'template', templateId: spec.templateId, task: taskInput }
    }
    return {
      mode: 'adhoc',
      name: agent.profile.name,
      systemPrompt: spec.systemPrompt,
      tools: spec.tools,
      task: taskInput,
    }
  }

  /**
   * Forward sub-agent progress events into the message bus as broadcast
   * notifications, so existing UI consumers can observe them. Falls back
   * to a no-op if the bus is unconfigured.
   *
   * TODO(progress): the v1 message-bus surface only carries opaque
   * payloads; once we add a structured progress message type we can
   * give consumers strongly-typed access. For now we hand the raw
   * TaskProgress through as the payload.
   */
  private wireProgressToBus(handle: SubAgentHandle, fromAgentId: string): void {
    handle.onProgress((p: TaskProgress) => {
      // Best-effort: a failing send must not affect task execution.
      void this.bus
        .send({
          from: handle.id,
          to: fromAgentId,
          type: 'info-reply',
          payload: p,
        })
        .catch(() => undefined)
    })
  }
}

// ============================================================
// Helpers
// ============================================================

/** Extract simple keywords from a task description for capability matching */
function extractKeywords(task: string): string[] {
  return task
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
}

/** Score how well a set of capabilities matches a set of keywords */
function computeMatchScore(capabilities: string[], keywords: string[]): number {
  let score = 0
  for (const cap of capabilities) {
    const capLower = cap.toLowerCase()
    for (const kw of keywords) {
      if (capLower.includes(kw) || kw.includes(capLower)) {
        score += 1
      }
    }
  }
  return score
}
