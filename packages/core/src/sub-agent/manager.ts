// ============================================================
// SubAgentManager — lifecycle, spawning, and handles
// ============================================================
//
// Main Agent constructs ONE SubAgentManager per session, configured with
// the shared services it wants every spawned sub-agent to see (data path,
// LLM provider preset). Each `spawn()` call:
//   1. Creates an InProcessTransport pair
//   2. Builds a SubAgent with the sub-side endpoint + a fresh Agent
//   3. Initializes the sub-agent (loads memory/skills/knowledge)
//   4. Returns a SubAgentHandle that wraps the main-side endpoint
//
// The manager is also the single place that catches sub-agent spawn
// failures — handles always come back fully constructed or `spawn()`
// rejects with a clean error.

import { nanoid } from 'nanoid'
import type { AgentConfig } from '../agent.js'
import type { PresetName, ProviderConfig } from '../llm/provider.js'
import {
  createInProcessTransportPair,
  type InProcessTransport,
  type SubAgentTransport,
} from './transport.js'
import { SubAgent } from './sub-agent.js'
import type {
  ResourceRequest,
  SubAgentMessage,
  TaskAssign,
  TaskCancel,
  TaskProgress,
  TaskResult,
} from './protocol.js'
import { isResourceRequest, isTaskProgress, isTaskResult } from './protocol.js'

// ------------------------------------------------------------
// Spec / Handle types
// ------------------------------------------------------------

/** What the caller passes to `spawn()` to describe a new sub-agent. */
export type SubAgentSpec =
  | {
      mode: 'template'
      templateId: string
      task: TaskAssignInput
    }
  | {
      mode: 'adhoc'
      name: string
      systemPrompt?: string
      tools?: string[]
      task: TaskAssignInput
    }

/**
 * Caller-friendly task input. The manager fills in `taskId` /
 * `parentTaskId` / defaults so callers don't have to repeat themselves.
 */
export interface TaskAssignInput {
  parentTaskId?: string
  description: string
  context?: Partial<TaskAssign['context']>
  config?: Partial<TaskAssign['config']>
}

export type SubAgentStatus =
  | 'initializing'
  | 'idle'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'closed'

export type ProgressCallback = (progress: TaskProgress) => void
export type ResourceRequestCallback = (req: ResourceRequest) => void

export interface SubAgentHandle {
  readonly id: string
  readonly name: string
  readonly status: SubAgentStatus
  /** Assign a (possibly second) task to this sub-agent. Returns the assigned `taskId`. */
  assign(task: TaskAssignInput): Promise<string>
  /** Cancel the in-flight task. */
  cancel(reason: string): Promise<void>
  /** Subscribe to progress events. Multiple callbacks supported. */
  onProgress(cb: ProgressCallback): void
  /** Subscribe to resource:request events from the sub-agent. */
  onResourceRequest(cb: ResourceRequestCallback): void
  /** Resolve with the next terminal `task:result`. */
  result(): Promise<TaskResult>
  /** Tear down the sub-agent and release its transport. */
  close(): Promise<void>
}

// ------------------------------------------------------------
// SubAgentManagerOptions — shared services injected into every spawn
// ------------------------------------------------------------

export interface SubAgentManagerOptions {
  /** Shared data directory used by all spawned sub-agents (so they read
   *  the SAME experience/skill/knowledge stores as Main). */
  dataPath: string
  /** Optional LLM provider for spawned sub-agents. May be a preset name,
   *  a full provider config, or omitted to let each sub-agent fall back
   *  to env-based detection. */
  provider?: ProviderConfig | PresetName
  /** Optional default model name baked into every TaskAssign.config.model
   *  if the caller doesn't specify one. */
  defaultModel?: string
  /** Optional default token budget per task. */
  defaultTokenBudget?: number
  /** Optional default soft timeout per task (ms). */
  defaultTimeout?: number
  /** Optional resolver from templateId → adhoc-style overrides. The
   *  manager itself doesn't load templates from disk in v1; callers can
   *  pass this to bridge their own template registry. */
  resolveTemplate?: (templateId: string) => {
    name: string
    systemPrompt?: string
    tools?: string[]
    model?: string
    tokenBudget?: number
  } | undefined
}

// ------------------------------------------------------------
// Internal record stored per spawned sub-agent
// ------------------------------------------------------------

interface ManagedSubAgent {
  handle: SubAgentHandle
  subAgent: SubAgent
  mainSide: InProcessTransport
  // Filled in by the handle implementation; kept here so the manager can
  // orchestrate `cancelAll()` etc.
  status: SubAgentStatus
}

// ------------------------------------------------------------
// SubAgentManager
// ------------------------------------------------------------

export class SubAgentManager {
  private agents = new Map<string, ManagedSubAgent>()

  constructor(private options: SubAgentManagerOptions) {}

  /** Spawn a new sub-agent and assign its first task. */
  async spawn(spec: SubAgentSpec): Promise<SubAgentHandle> {
    const id = `sub-${nanoid(8)}`

    let name: string
    let systemPromptOverride: string | undefined
    let tools: string[] | undefined
    let model: string | undefined
    let tokenBudget: number | undefined

    if (spec.mode === 'template') {
      const resolved = this.options.resolveTemplate?.(spec.templateId)
      if (!resolved) {
        // No resolver / unknown template — fall back to a stub so spawn
        // still succeeds. Callers that care should provide a resolver.
        name = spec.templateId
      } else {
        name = resolved.name
        systemPromptOverride = resolved.systemPrompt
        tools = resolved.tools
        model = resolved.model
        tokenBudget = resolved.tokenBudget
      }
    } else {
      name = spec.name
      systemPromptOverride = spec.systemPrompt
      tools = spec.tools
    }

    // Build the agent config — every sub-agent shares the same dataPath,
    // which is how "shared experience/skill/knowledge stores" is realized
    // in v1: they all read the same files.
    const agentConfig: AgentConfig = {
      dataPath: this.options.dataPath,
      provider: this.options.provider,
    }

    const { mainSide, subSide } = createInProcessTransportPair()

    const subAgent = new SubAgent({
      id,
      name,
      agentConfig,
      systemPromptOverride,
      toolWhitelist: tools,
      transport: subSide,
    })

    // Initialize before listening — `init()` may take a moment to load
    // memory/skills/knowledge, and we don't want to race incoming
    // task:assign messages against an uninitialized agent.
    await subAgent.init()
    subAgent.start()

    const handle = this.createHandle({
      id,
      name,
      mainSide,
      defaultModel: model ?? this.options.defaultModel ?? 'default',
      defaultTokenBudget: tokenBudget ?? this.options.defaultTokenBudget ?? 100_000,
      defaultTimeout: this.options.defaultTimeout ?? 300_000,
      defaultTools: tools ?? [],
    })

    const managed: ManagedSubAgent = {
      handle,
      subAgent,
      mainSide,
      status: 'initializing',
    }
    this.agents.set(id, managed)

    // Kick off the first task.
    await handle.assign(spec.task)

    return handle
  }

  list(): SubAgentHandle[] {
    return Array.from(this.agents.values()).map((m) => m.handle)
  }

  get(id: string): SubAgentHandle | undefined {
    return this.agents.get(id)?.handle
  }

  /** Cancel every active sub-agent. Used during session shutdown. */
  async cancelAll(reason = 'manager shutdown'): Promise<void> {
    await Promise.all(
      Array.from(this.agents.values()).map(async (m) => {
        try {
          await m.handle.cancel(reason)
        } catch {
          // Best effort — keep going.
        }
      }),
    )
  }

  /** Cancel and tear down every sub-agent. */
  async closeAll(): Promise<void> {
    await Promise.all(
      Array.from(this.agents.values()).map(async (m) => {
        try {
          await m.handle.close()
        } catch {
          // Best effort.
        }
      }),
    )
    this.agents.clear()
  }

  // ----------------------------------------------------------
  // Handle factory
  // ----------------------------------------------------------

  private createHandle(args: {
    id: string
    name: string
    mainSide: SubAgentTransport
    defaultModel: string
    defaultTokenBudget: number
    defaultTimeout: number
    defaultTools: string[]
  }): SubAgentHandle {
    const { id, name, mainSide, defaultModel, defaultTokenBudget, defaultTimeout, defaultTools } = args
    const progressCbs: ProgressCallback[] = []
    const resourceCbs: ResourceRequestCallback[] = []
    let status: SubAgentStatus = 'initializing'
    let pendingResolvers: Array<(r: TaskResult) => void> = []
    let currentTaskId: string | null = null
    const getManaged = (): ManagedSubAgent | undefined => this.agents.get(id)

    mainSide.onMessage((msg: SubAgentMessage) => {
      if (isTaskProgress(msg)) {
        status = 'running'
        for (const cb of progressCbs) {
          try {
            cb(msg)
          } catch {
            // Subscriber errors must not affect other subscribers.
          }
        }
        return
      }
      if (isTaskResult(msg)) {
        status =
          msg.outcome === 'success'
            ? 'completed'
            : msg.outcome === 'failure'
              ? 'failed'
              : 'cancelled'
        // Update the manager's snapshot of status too.
        const managed = this.agents.get(id)
        if (managed) managed.status = status
        const resolvers = pendingResolvers
        pendingResolvers = []
        currentTaskId = null
        for (const r of resolvers) {
          try {
            r(msg)
          } catch {
            // ignore
          }
        }
        return
      }
      if (isResourceRequest(msg)) {
        for (const cb of resourceCbs) {
          try {
            cb(msg)
          } catch {
            // ignore
          }
        }
        return
      }
      // Other inbound messages (task:assign, task:cancel, resource:grant)
      // are not expected on the main side from a sub. Drop silently.
    })

    const handle: SubAgentHandle = {
      id,
      name,
      get status() {
        return status
      },
      async assign(task: TaskAssignInput): Promise<string> {
        const taskId = `task-${nanoid(8)}`
        currentTaskId = taskId
        status = 'running'
        const managed = getManaged()
        if (managed) managed.status = 'running'

        const assign: TaskAssign = {
          type: 'task:assign',
          taskId,
          parentTaskId: task.parentTaskId ?? 'main',
          description: task.description,
          context: {
            background: task.context?.background ?? '',
            constraints: task.context?.constraints ?? [],
            relatedExperiences: task.context?.relatedExperiences ?? [],
            relevantSkills: task.context?.relevantSkills ?? [],
          },
          config: {
            model: task.config?.model ?? defaultModel,
            tokenBudget: task.config?.tokenBudget ?? defaultTokenBudget,
            timeout: task.config?.timeout ?? defaultTimeout,
            tools: task.config?.tools ?? defaultTools,
            canRequestMore: task.config?.canRequestMore ?? false,
          },
        }
        await mainSide.send(assign)
        return taskId
      },
      async cancel(reason: string): Promise<void> {
        if (!currentTaskId) return
        const cancel: TaskCancel = {
          type: 'task:cancel',
          taskId: currentTaskId,
          reason,
        }
        await mainSide.send(cancel)
      },
      onProgress(cb: ProgressCallback): void {
        progressCbs.push(cb)
      },
      onResourceRequest(cb: ResourceRequestCallback): void {
        resourceCbs.push(cb)
      },
      result(): Promise<TaskResult> {
        return new Promise<TaskResult>((resolve) => {
          pendingResolvers.push(resolve)
        })
      },
      close: async (): Promise<void> => {
        status = 'closed'
        const managed = this.agents.get(id)
        if (managed) {
          managed.status = 'closed'
          try {
            await managed.subAgent.stop()
          } catch {
            // ignore
          }
        }
        try {
          await mainSide.close()
        } catch {
          // ignore
        }
        this.agents.delete(id)
      },
    }

    return handle
  }
}
