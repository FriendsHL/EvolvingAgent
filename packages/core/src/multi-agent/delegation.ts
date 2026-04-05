import { nanoid } from 'nanoid'
import type { LLMProvider } from '../llm/provider.js'
import type { AgentCoordinator } from './coordinator.js'

// ============================================================
// Task Delegation — decompose and distribute work
// ============================================================

export interface DelegationTask {
  id: string
  parentTaskId?: string
  description: string
  assignedTo?: string // Agent ID
  status: 'pending' | 'in-progress' | 'completed' | 'failed'
  result?: string
  error?: string
  startedAt?: string
  completedAt?: string
}

export interface DelegationResult {
  taskId: string
  subtasks: DelegationTask[]
  aggregatedResult: string
  success: boolean
}

interface DecomposedSubtask {
  description: string
  requiredCapabilities: string[]
}

export class TaskDelegator {
  constructor(
    private coordinator: AgentCoordinator,
    private llm: LLMProvider,
  ) {}

  /**
   * Decompose a complex task into subtasks and delegate to appropriate agents.
   * Falls back to the requesting agent if no suitable agent is found.
   */
  async delegate(
    task: string,
    fromAgentId: string,
    fallbackHandler: (subtask: string) => Promise<string>,
  ): Promise<DelegationResult> {
    const taskId = nanoid()

    // Step 1: Use LLM to decompose the task into subtasks
    const subtaskSpecs = await this.decompose(task)

    // Step 2: Create DelegationTask objects
    const subtasks: DelegationTask[] = subtaskSpecs.map((spec) => ({
      id: nanoid(),
      parentTaskId: taskId,
      description: spec.description,
      status: 'pending' as const,
    }))

    // Step 3: For each subtask, find a matching agent or use fallback
    const results: string[] = []
    let allSuccess = true

    for (let i = 0; i < subtasks.length; i++) {
      const subtask = subtasks[i]!
      const spec = subtaskSpecs[i]!
      subtask.status = 'in-progress'
      subtask.startedAt = new Date().toISOString()

      try {
        // Try to route via coordinator
        const routed = await this.coordinator.routeTask(spec.description, fromAgentId)

        if (routed) {
          subtask.assignedTo = routed.agentId
          subtask.result = routed.result
        } else {
          // No suitable agent found — use fallback
          subtask.assignedTo = fromAgentId
          subtask.result = await fallbackHandler(spec.description)
        }

        subtask.status = 'completed'
        subtask.completedAt = new Date().toISOString()
        results.push(subtask.result)
      } catch (err) {
        subtask.status = 'failed'
        subtask.error = err instanceof Error ? err.message : String(err)
        subtask.completedAt = new Date().toISOString()
        allSuccess = false
        results.push(`[FAILED] ${subtask.error}`)
      }
    }

    // Step 4: Aggregate results into a final summary
    const aggregatedResult = await this.aggregate(task, subtasks, results)

    return {
      taskId,
      subtasks,
      aggregatedResult,
      success: allSuccess,
    }
  }

  /** Use LLM to decompose a task into subtasks with required capabilities */
  private async decompose(task: string): Promise<DecomposedSubtask[]> {
    const prompt = `Decompose this task into 2-5 independent subtasks. Return a JSON array.

Task: ${task}

Each element must have:
- "description": a concise subtask description
- "requiredCapabilities": array of capability keywords (e.g. "search", "code-write", "summarize")

Return ONLY the JSON array, no markdown fences or extra text.`

    const messages = this.llm.buildMessages({
      systemPrompt: 'You are a task decomposition assistant. Return only valid JSON.',
      skills: [],
      knowledge: [],
      history: [],
      experiences: [],
      currentInput: prompt,
      provider: this.llm.getProviderType(),
    })

    const result = await this.llm.generate('planner', messages)
    return parseSubtasks(result.text)
  }

  /** Use LLM to aggregate subtask results into a cohesive summary */
  private async aggregate(
    originalTask: string,
    subtasks: DelegationTask[],
    results: string[],
  ): Promise<string> {
    const subtaskSummary = subtasks
      .map((st, i) => {
        const status = st.status === 'completed' ? 'OK' : 'FAILED'
        const agent = st.assignedTo ?? 'unknown'
        return `Subtask ${i + 1} [${status}] (agent: ${agent}): ${st.description}\nResult: ${results[i]?.slice(0, 500) ?? '(no result)'}`
      })
      .join('\n\n')

    const prompt = `Summarize the results of this delegated task.

Original task: ${originalTask}

Subtask results:
${subtaskSummary}

Provide a clear, concise summary of what was accomplished.`

    const messages = this.llm.buildMessages({
      systemPrompt: 'You are a task summarization assistant. Be concise and direct.',
      skills: [],
      knowledge: [],
      history: [],
      experiences: [],
      currentInput: prompt,
      provider: this.llm.getProviderType(),
    })

    const result = await this.llm.generate('reflector', messages)
    return result.text
  }
}

// ============================================================
// Helpers
// ============================================================

/** Parse the LLM's JSON response into subtask specs, with fallback */
function parseSubtasks(text: string): DecomposedSubtask[] {
  try {
    // Strip markdown code fences if present
    const cleaned = text.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim()
    const parsed = JSON.parse(cleaned)

    if (!Array.isArray(parsed) || parsed.length === 0) {
      return [{ description: text.trim(), requiredCapabilities: [] }]
    }

    return parsed.map((item: Record<string, unknown>) => ({
      description: typeof item.description === 'string' ? item.description : String(item.description ?? ''),
      requiredCapabilities: Array.isArray(item.requiredCapabilities)
        ? item.requiredCapabilities.filter((c): c is string => typeof c === 'string')
        : [],
    }))
  } catch {
    // If JSON parsing fails, treat the whole task as a single subtask
    return [{ description: text.trim(), requiredCapabilities: [] }]
  }
}
