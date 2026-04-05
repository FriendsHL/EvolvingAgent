import { nanoid } from 'nanoid'
import type { AgentEvent, ExecutionStep, HookContext, Session } from './types.js'
import { ToolRegistry } from './tools/registry.js'
import { shellTool } from './tools/shell.js'
import { fileReadTool } from './tools/file-read.js'
import { fileWriteTool } from './tools/file-write.js'
import { httpTool } from './tools/http.js'
import { HookRunner } from './hooks/hook-runner.js'
import { contextWindowGuard } from './hooks/core-hooks/context-window-guard.js'
import { costHardLimit } from './hooks/core-hooks/cost-hard-limit.js'
import { safetyCheck } from './hooks/core-hooks/safety-check.js'
import { metricsCollectorHook, getCollectedMetrics } from './hooks/core-hooks/metrics-collector.js'
import { MemoryManager } from './memory/memory-manager.js'
import { Planner } from './planner/planner.js'
import { Executor } from './executor/executor.js'
import { Reflector } from './reflector/reflector.js'
import { LLMProvider, type ProviderConfig, type PresetName } from './llm/provider.js'
import type { PromptConfig, LLMCallMetrics } from './types.js'

export interface AgentConfig {
  dataPath: string // Path to data/ directory
  provider?: ProviderConfig | PresetName // LLM provider config or preset name (default: auto-detect from env)
}

type EventCallback = (event: AgentEvent) => void

const CONVERSATIONAL_SYSTEM_PROMPT = `You are Evolving Agent, an AI assistant that learns and improves over time.
You can use tools to accomplish tasks: shell (run commands), file_read, file_write, http.
When a task requires action, break it into steps and execute them.
For simple questions or conversation, respond directly without tools.
Be concise and helpful.`

export class Agent {
  private session: Session
  private tools: ToolRegistry
  private hooks: HookRunner
  private memory: MemoryManager
  private planner: Planner
  private executor: Executor
  private reflector: Reflector
  private llm: LLMProvider
  private listeners: EventCallback[] = []

  constructor(private config: AgentConfig) {
    this.session = {
      id: nanoid(),
      startedAt: new Date().toISOString(),
      status: 'active',
      totalCost: 0,
      totalTokens: 0,
    }

    // Initialize LLM provider
    if (!config.provider) {
      this.llm = LLMProvider.fromEnv()
    } else if (typeof config.provider === 'string') {
      this.llm = LLMProvider.fromPreset(config.provider)
    } else {
      this.llm = new LLMProvider(config.provider)
    }

    // Initialize tool registry with built-in tools
    this.tools = new ToolRegistry()
    this.tools.register(shellTool)
    this.tools.register(fileReadTool)
    this.tools.register(fileWriteTool)
    this.tools.register(httpTool)

    // Initialize hooks with core hooks
    this.hooks = new HookRunner()
    this.hooks.registerAll([
      contextWindowGuard,
      costHardLimit,
      safetyCheck,
      metricsCollectorHook,
    ])

    // Initialize memory
    this.memory = new MemoryManager(config.dataPath)

    // Initialize components
    this.planner = new Planner(this.llm)
    this.executor = new Executor(this.tools, this.hooks)
    this.reflector = new Reflector(this.llm)
  }

  async init(): Promise<void> {
    await this.memory.init()
    this.emit({ type: 'hook', data: 'Agent initialized', timestamp: new Date().toISOString() })
  }

  onEvent(callback: EventCallback): void {
    this.listeners.push(callback)
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  private getAgentContext(): HookContext['agent'] {
    return {
      sessionId: this.session.id,
      totalCost: this.session.totalCost,
      tokenCount: this.session.totalTokens,
    }
  }

  private trackMetrics(metrics: LLMCallMetrics): void {
    this.session.totalCost += metrics.cost
    this.session.totalTokens += metrics.tokens.prompt + metrics.tokens.completion

    // Fire after:llm-call hook (void mode — metrics collection)
    this.hooks.runVoid('after:llm-call', {
      trigger: 'after:llm-call',
      data: metrics,
      agent: this.getAgentContext(),
    })
  }

  /**
   * Process a user message through the full agent loop:
   * Input → Retrieve → Plan → Execute → Respond → Reflect → Store
   */
  async processMessage(userMessage: string): Promise<string> {
    this.memory.addMessage('user', userMessage)
    this.emit({ type: 'message', data: { role: 'user', content: userMessage }, timestamp: new Date().toISOString() })

    // 1. Retrieve related experiences
    const retrieved = await this.memory.search({ text: userMessage, topK: 3 })
    const relatedExperiences = retrieved
      .filter((r) => r.type === 'experience')
      .map((r) => r.content as import('./types.js').Experience)

    if (relatedExperiences.length > 0) {
      this.emit({
        type: 'hook',
        data: `Found ${relatedExperiences.length} related experience(s)`,
        timestamp: new Date().toISOString(),
      })
    }

    // 2. Run before:llm-call hooks (cost check, context guard)
    const hookContext: HookContext = {
      trigger: 'before:llm-call',
      data: { history: this.memory.getHistory() },
      agent: this.getAgentContext(),
    }
    await this.hooks.run('before:llm-call', hookContext, { history: this.memory.getHistory() })

    // 3. Plan
    this.emit({ type: 'planning', data: 'Analyzing task...', timestamp: new Date().toISOString() })

    const { plan, metrics: planMetrics } = await this.planner.plan(
      userMessage,
      relatedExperiences,
      this.memory.getHistory(),
    )
    this.trackMetrics(planMetrics)

    this.emit({ type: 'planning', data: plan, timestamp: new Date().toISOString() })

    // 4. If no tool steps, this is conversational — generate a direct response
    if (plan.steps.length === 0) {
      const response = await this.generateConversationalResponse(userMessage)
      this.memory.addMessage('assistant', response)
      this.emit({ type: 'message', data: { role: 'assistant', content: response }, timestamp: new Date().toISOString() })
      return response
    }

    // 5. Execute plan steps
    this.emit({ type: 'executing', data: `Executing ${plan.steps.length} step(s)...`, timestamp: new Date().toISOString() })

    const executionSteps = await this.executor.execute(plan, this.getAgentContext())

    for (const step of executionSteps) {
      this.emit({
        type: step.result.success ? 'tool-result' : 'error',
        data: step,
        timestamp: new Date().toISOString(),
      })
    }

    // 6. Generate final response based on execution results
    const response = await this.generateSummaryResponse(userMessage, executionSteps)
    this.memory.addMessage('assistant', response)
    this.emit({ type: 'message', data: { role: 'assistant', content: response }, timestamp: new Date().toISOString() })

    // 7. Reflect on execution
    const overallResult = this.determineResult(executionSteps)
    this.emit({ type: 'reflecting', data: 'Reflecting on execution...', timestamp: new Date().toISOString() })

    const { reflection, tags, metrics: reflectMetrics } = await this.reflector.reflect(
      userMessage,
      executionSteps,
      overallResult,
    )
    this.trackMetrics(reflectMetrics)

    // 8. Store experience if admission score passes
    const storeResult = await this.memory.storeExperience(
      userMessage,
      executionSteps,
      overallResult,
      reflection,
      tags,
    )

    if (storeResult.stored) {
      this.emit({
        type: 'hook',
        data: `Experience stored (score: ${storeResult.score.toFixed(2)}, ${storeResult.decision})`,
        timestamp: new Date().toISOString(),
      })
    }

    return response
  }

  private async generateConversationalResponse(userMessage: string): Promise<string> {
    const config: PromptConfig = {
      systemPrompt: CONVERSATIONAL_SYSTEM_PROMPT,
      skills: [],
      knowledge: [],
      history: this.memory.getHistory().slice(0, -1),
      experiences: [],
      currentInput: userMessage,
      provider: this.llm.getProviderType(),
    }

    const messages = this.llm.buildMessages(config)
    const result = await this.llm.generate('executor', messages)
    this.trackMetrics(result.metrics)
    return result.text
  }

  private async generateSummaryResponse(
    task: string,
    steps: ExecutionStep[],
  ): Promise<string> {
    const stepsDescription = steps
      .map((s, i) => {
        const status = s.result.success ? 'OK' : 'FAIL'
        const output = s.result.output ? s.result.output.slice(0, 500) : '(no output)'
        const error = s.result.error ? `\nError: ${s.result.error}` : ''
        return `Step ${i + 1} [${status}]: ${s.description}\nOutput: ${output}${error}`
      })
      .join('\n\n')

    const summaryPrompt = `Based on the following execution results, provide a clear, concise summary to the user.

Task: ${task}

Results:
${stepsDescription}

Summarize what was accomplished and any important findings. Be direct and helpful.`

    const config: PromptConfig = {
      systemPrompt: CONVERSATIONAL_SYSTEM_PROMPT,
      skills: [],
      knowledge: [],
      history: this.memory.getHistory().slice(0, -1),
      experiences: [],
      currentInput: summaryPrompt,
      provider: this.llm.getProviderType(),
    }

    const messages = this.llm.buildMessages(config)
    const result = await this.llm.generate('executor', messages)
    this.trackMetrics(result.metrics)
    return result.text
  }

  private determineResult(steps: ExecutionStep[]): 'success' | 'partial' | 'failure' {
    if (steps.length === 0) return 'success'
    const successes = steps.filter((s) => s.result.success).length
    if (successes === steps.length) return 'success'
    if (successes === 0) return 'failure'
    return 'partial'
  }

  getSession(): Session {
    return { ...this.session }
  }

  getMetrics(): LLMCallMetrics[] {
    return getCollectedMetrics()
  }

  getExperiences() {
    return this.memory.experienceStore.getAll('all')
  }
}
