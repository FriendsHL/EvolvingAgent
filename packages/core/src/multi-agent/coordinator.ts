import type { PresetName } from '../llm/provider.js'
import { MessageBus } from './message-bus.js'

// ============================================================
// Multi-Agent Coordinator
// ============================================================

export interface AgentProfile {
  id: string
  name: string
  role: string
  description: string
  capabilities: string[] // What this agent is good at
  status: 'idle' | 'busy' | 'offline'
  provider?: PresetName
}

interface RegisteredAgent {
  profile: AgentProfile
  processMessage: (msg: string) => Promise<string>
}

export class AgentCoordinator {
  private agents = new Map<string, RegisteredAgent>()
  private bus: MessageBus

  constructor(bus?: MessageBus) {
    this.bus = bus ?? new MessageBus()
  }

  /** Register an agent with its profile and message handler */
  register(profile: AgentProfile, handler: (msg: string) => Promise<string>): void {
    this.agents.set(profile.id, { profile, processMessage: handler })

    // Auto-subscribe the agent to the message bus for task-request messages
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
   * 3. Pick the first idle agent that matches
   * 4. Set its status to 'busy', call its handler, set status back to 'idle'
   * 5. Return the result (or null if no suitable agent found)
   */
  async routeTask(
    task: string,
    fromAgentId: string,
  ): Promise<{ agentId: string; result: string } | null> {
    const keywords = extractKeywords(task)

    // Score each agent by how many capabilities match the task keywords
    const candidates: Array<{ agent: RegisteredAgent; score: number }> = []
    for (const [id, agent] of this.agents) {
      if (id === fromAgentId) continue // Don't route back to the requester
      if (agent.profile.status !== 'idle') continue

      const score = computeMatchScore(agent.profile.capabilities, keywords)
      if (score > 0) {
        candidates.push({ agent, score })
      }
    }

    if (candidates.length === 0) return null

    // Pick the best match (highest score, then first registered)
    candidates.sort((a, b) => b.score - a.score)
    const best = candidates[0]!

    // Execute the task
    best.agent.profile.status = 'busy'
    try {
      const result = await best.agent.processMessage(task)
      return { agentId: best.agent.profile.id, result }
    } finally {
      best.agent.profile.status = 'idle'
    }
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
