import { nanoid } from 'nanoid'
import type { AgentEvent, ExecutionStep, HookContext, Session, SkillContext, SkillResult } from './types.js'
import { ToolRegistry } from './tools/registry.js'
import { shellTool } from './tools/shell.js'
import { fileReadTool } from './tools/file-read.js'
import { fileWriteTool } from './tools/file-write.js'
import { httpTool } from './tools/http.js'
import { browserTool } from './tools/browser.js'
import { HookRunner } from './hooks/hook-runner.js'
import { HookCompiler } from './hooks/hook-compiler.js'
import { HookSandbox } from './hooks/hook-sandbox.js'
import { createContextWindowGuard } from './hooks/core-hooks/context-window-guard.js'
import { ConversationSummarizer } from './memory/conversation-summarizer.js'
import { costHardLimit } from './hooks/core-hooks/cost-hard-limit.js'
import { safetyCheck } from './hooks/core-hooks/safety-check.js'
import { metricsCollectorHook, getCollectedMetrics } from './hooks/core-hooks/metrics-collector.js'
import { createBudgetGuard, createBudgetRecorder } from './hooks/core-hooks/budget-guard.js'
import { BudgetManager, loadBudgetConfig } from './metrics/budget.js'
import { MemoryManager } from './memory/memory-manager.js'
import { Embedder } from './memory/embedder.js'
import { Planner } from './planner/planner.js'
import { Executor } from './executor/executor.js'
import { Reflector } from './reflector/reflector.js'
import { LLMProvider, type ProviderConfig, type PresetName } from './llm/provider.js'
import { SkillRegistry } from './skills/skill-registry.js'
import { SkillCompiler } from './skills/skill-compiler.js'
import { SkillValidator } from './skills/skill-validator.js'
import { webSearchSkill } from './skills/builtin/web-search.js'
import { summarizeUrlSkill } from './skills/builtin/summarize-url.js'
import { selfRepairSkill } from './skills/builtin/self-repair.js'
import { githubSkill } from './skills/builtin/github.js'
import { codeAnalysisSkill } from './skills/builtin/code-analysis.js'
import { fileBatchSkill } from './skills/builtin/file-batch.js'
import { scheduleSkill } from './skills/builtin/schedule.js'
import { dataExtractSkill } from './skills/builtin/data-extract.js'
import { CapabilityMap } from './agent/capability-map.js'
import { KnowledgeStore } from './knowledge/knowledge-store.js'
import { CacheMetricsRecorder, type CacheCallRecord } from './metrics/cache-metrics.js'
import type { AgentCoordinator } from './multi-agent/coordinator.js'
import type { PromptConfig, LLMCallMetrics } from './types.js'

/**
 * Shared singletons that can be injected into an Agent so multiple Agent
 * instances (e.g. one per Session) reuse the same underlying registries and
 * stores. When a field is omitted, the Agent constructs its own private copy
 * (legacy behavior). When provided, the Agent skips its own construction and
 * uses the shared instance instead.
 *
 * ShortTermMemory and the per-message currentKnowledge are NEVER shared —
 * each Agent always has its own conversation state.
 */
export interface AgentSharedDeps {
  llm?: LLMProvider
  tools?: ToolRegistry
  skills?: SkillRegistry
  knowledgeStore?: KnowledgeStore
  experienceStore?: import('./memory/experience-store.js').ExperienceStore
  embedder?: Embedder
  /** Shared three-layer token budget manager (process-wide). Phase 3 Batch 4. */
  budgetManager?: BudgetManager
  /** Shared token cache observability recorder (process-wide). Phase 3 Batch 4. */
  cacheMetrics?: CacheMetricsRecorder
}

export interface AgentConfig {
  dataPath: string // Path to data/ directory
  provider?: ProviderConfig | PresetName // LLM provider config or preset name (default: auto-detect from env)
  /** Optional shared singletons (Phase 3 Batch 3 — multi-session). */
  shared?: AgentSharedDeps
}

type EventCallback = (event: AgentEvent) => void

const CONVERSATIONAL_SYSTEM_PROMPT = `You are Evolving Agent, an AI assistant that learns and improves over time.

You have access to the following tools and skills:

Tools (low-level):
- shell: Run shell commands
- file_read: Read files
- file_write: Write files
- http: Make HTTP requests
- browser: Control a headless browser (goto, click, type, text, screenshot, evaluate)

Skills (high-level, use "skill:<id>" as the tool name):
- skill:web-search(query, engine?, maxResults?) — Search the web and summarize results
- skill:summarize-url(url, focus?) — Visit a URL and produce a structured summary
- skill:self-repair(error, toolName) — Diagnose and fix tool failures
- skill:github(action, repo?, query?, title?, body?) — Interact with GitHub (issues, PRs, repos)
- skill:code-analysis(path, question?) — Analyze code structure and explain code
- skill:file-batch(action, pattern, replacement?, path?) — Batch file operations
- skill:schedule(action, interval?, command?, taskId?) — Schedule tasks at intervals
- skill:data-extract(source, schema?, format?) — Extract structured data from URLs or files

When a task requires action, break it into steps and execute them.
Prefer using skills over raw tools when appropriate — skills handle multi-step workflows automatically.
For simple questions or conversation, respond directly without tools.
If a task is beyond your capabilities, say so honestly.
Be concise and helpful.`

export class Agent {
  private session: Session
  private tools: ToolRegistry
  private hooks: HookRunner
  private hookSandbox: HookSandbox
  private hookCompiler: HookCompiler
  private memory: MemoryManager
  private planner: Planner
  private executor: Executor
  private reflector: Reflector
  private llm: LLMProvider
  private skills: SkillRegistry
  private skillCompiler: SkillCompiler
  private skillValidator: SkillValidator
  private capabilityMap: CapabilityMap
  private knowledgeStore: KnowledgeStore
  private summarizer: ConversationSummarizer
  private budgetManager: BudgetManager
  private ownsBudgetManager: boolean
  private cacheMetrics: CacheMetricsRecorder
  private ownsCacheMetrics: boolean
  /** Task id for the in-flight processMessage call; used by the budget guard. */
  private currentTaskId: string | null = null
  /** Knowledge snippets retrieved for the in-flight message; reset per process call. */
  private currentKnowledge: string[] = []
  private listeners: EventCallback[] = []

  constructor(private config: AgentConfig) {
    this.session = {
      id: nanoid(),
      startedAt: new Date().toISOString(),
      status: 'active',
      totalCost: 0,
      totalTokens: 0,
    }

    const shared = config.shared ?? {}

    // Initialize LLM provider
    if (shared.llm) {
      this.llm = shared.llm
    } else if (!config.provider) {
      this.llm = LLMProvider.fromEnv()
    } else if (typeof config.provider === 'string') {
      this.llm = LLMProvider.fromPreset(config.provider)
    } else {
      this.llm = new LLMProvider(config.provider)
    }

    // Initialize tool registry with built-in tools
    if (shared.tools) {
      this.tools = shared.tools
    } else {
      this.tools = new ToolRegistry()
      this.tools.register(shellTool)
      this.tools.register(fileReadTool)
      this.tools.register(fileWriteTool)
      this.tools.register(httpTool)
      this.tools.register(browserTool)
    }

    // Initialize skill registry with built-in skills (8 total)
    if (shared.skills) {
      this.skills = shared.skills
    } else {
      this.skills = new SkillRegistry(config.dataPath)
      this.skills.register(webSearchSkill)
      this.skills.register(summarizeUrlSkill)
      this.skills.register(selfRepairSkill)
      this.skills.register(githubSkill)
      this.skills.register(codeAnalysisSkill)
      this.skills.register(fileBatchSkill)
      this.skills.register(scheduleSkill)
      this.skills.register(dataExtractSkill)
    }

    // Skill auto-creation from reflection
    this.skillCompiler = new SkillCompiler()
    this.skillValidator = new SkillValidator(this.tools.list().map((t) => t.name))

    // Initialize memory with embedder for RAG (must come before hooks so
    // the context-window-guard can reference ShortTermMemory directly).
    const embedder = shared.embedder ?? Embedder.fromProviderConfig(
      this.llm.getProviderType(),
      undefined, // apiKey from env
    )
    this.memory = new MemoryManager(
      config.dataPath,
      embedder,
      undefined,
      shared.experienceStore,
    )
    // Wire the skill registry so experience feedback can influence skill scores.
    this.memory.setSkillRegistry(this.skills)

    // Conversation summarizer for long-context management (P8).
    this.summarizer = new ConversationSummarizer(this.llm)

    // Budget manager: shared across sessions when provided, otherwise each
    // standalone Agent gets its own (legacy callers). The shared instance is
    // initialized by SessionManager via loadBudgetConfig().
    if (shared.budgetManager) {
      this.budgetManager = shared.budgetManager
      this.ownsBudgetManager = false
    } else {
      // Synchronous fallback — use defaults. Agent.init() will attempt to
      // reload from disk asynchronously (best-effort, non-fatal on miss).
      this.budgetManager = new BudgetManager(
        {
          global: { perSession: 2_000_000, perDay: 10_000_000 },
          main: { perTask: 200_000, warnRatio: 0.8 },
          subAgent: { defaultPerTask: 50_000, warnRatio: 0.8, downgradeModel: 'claude-haiku-4-5-20251001' },
        },
        config.dataPath,
      )
      this.ownsBudgetManager = true
    }

    // Cache metrics recorder: shared across sessions when provided, otherwise
    // each standalone Agent gets its own fallback so legacy callers keep
    // working. Records per-call stats to data/metrics/cache-*.jsonl.
    if (shared.cacheMetrics) {
      this.cacheMetrics = shared.cacheMetrics
      this.ownsCacheMetrics = false
    } else {
      this.cacheMetrics = new CacheMetricsRecorder(config.dataPath)
      this.ownsCacheMetrics = true
    }

    // Initialize hooks with core hooks + sandbox for evolved hooks.
    // The context-window-guard gets a summarizer + memory ref so it can
    // compress old turns instead of dropping them.
    this.hooks = new HookRunner()
    this.hooks.registerAll([
      createBudgetGuard(this.budgetManager),
      createBudgetRecorder(this.budgetManager),
      createContextWindowGuard({
        summarizer: this.summarizer,
        memory: this.memory.shortTerm,
      }),
      costHardLimit,
      safetyCheck,
      metricsCollectorHook,
    ])
    this.hookSandbox = new HookSandbox()
    this.hooks.setSandbox(this.hookSandbox)
    this.hookCompiler = new HookCompiler()

    // Knowledge base — user-curated documents/notes/facts
    this.knowledgeStore = shared.knowledgeStore ?? new KnowledgeStore(embedder)

    // Capability awareness
    this.capabilityMap = new CapabilityMap()
    this.capabilityMap.refresh(
      this.tools.list(),
      this.skills.list(),
    )

    // Initialize components — pass skill registry + capability map to planner
    this.planner = new Planner(this.llm, this.skills, this.capabilityMap)
    this.executor = new Executor(this.tools, this.hooks, this.skills, this.createSkillContext())
    this.reflector = new Reflector(this.llm)
  }

  async init(): Promise<void> {
    await this.memory.init()
    if (!this.config.shared?.skills) {
      await this.skills.init()
    }
    if (!this.config.shared?.knowledgeStore) {
      await this.knowledgeStore.init(this.config.dataPath)
    }
    // Only load daily counter for a privately-owned budget manager; a shared
    // manager is initialized once by SessionManager.init(). Note: owned
    // instances use the default config (sync-constructed in the ctor) — full
    // on-disk config loading is available via the shared path.
    if (this.ownsBudgetManager) {
      await this.budgetManager.init()
    }
    if (this.ownsCacheMetrics) {
      await this.cacheMetrics.init()
    }

    // Refresh capability map after skills are loaded from disk
    this.capabilityMap.refresh(
      this.tools.list(),
      this.skills.list(),
    )

    // Start cron scheduler for time-based hooks (P7)
    this.hooks.startScheduler()

    // Graduate any sandboxed hooks that have proven themselves
    const graduated = this.hooks.graduateSandboxedHooks()
    if (graduated.length > 0) {
      this.emit({ type: 'hook', data: `Graduated ${graduated.length} evolved hook(s)`, timestamp: new Date().toISOString() })
    }

    this.emit({ type: 'hook', data: 'Agent initialized', timestamp: new Date().toISOString() })
  }

  /** Shutdown agent background tasks (cron scheduler, etc.). */
  async shutdown(): Promise<void> {
    this.hooks.stopScheduler()
    if (this.ownsBudgetManager) {
      await this.budgetManager.shutdown()
    }
    if (this.ownsCacheMetrics) {
      await this.cacheMetrics.shutdown()
    }
  }

  onEvent(callback: EventCallback): void {
    this.listeners.push(callback)
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  /** Create a SkillContext that skills use to interact with tools and LLM */
  private createSkillContext(): SkillContext {
    return {
      useTool: async (toolName, params) => {
        return this.tools.execute(toolName, params)
      },
      think: async (prompt) => {
        const config: PromptConfig = {
          systemPrompt: 'You are a helpful AI assistant. Respond concisely.',
          skills: [],
          knowledge: [],
          history: [],
          experiences: [],
          currentInput: prompt,
          provider: this.llm.getProviderType(),
        }
        const messages = this.llm.buildMessages(config)
        const result = await this.llm.generate('executor', messages)
        this.trackMetrics(result.metrics)
        return result.text
      },
      emit: (message) => {
        this.emit({ type: 'executing', data: message, timestamp: new Date().toISOString() })
      },
    }
  }

  /** Optional sub-agent scope set by the SubAgent wrapper. Null for main Agent. */
  private subAgentTaskId: string | null = null
  private subAgentTokenBudget: number | undefined

  /** Called by SubAgent wrapper before dispatching a task. */
  setSubAgentScope(taskId: string | null, tokenBudget?: number): void {
    this.subAgentTaskId = taskId
    this.subAgentTokenBudget = tokenBudget
  }

  private getAgentContext(): HookContext['agent'] {
    return {
      sessionId: this.session.id,
      totalCost: this.session.totalCost,
      tokenCount: this.session.totalTokens,
      taskId: this.currentTaskId ?? undefined,
      subAgentTaskId: this.subAgentTaskId ?? undefined,
      subAgentTokenBudget: this.subAgentTokenBudget,
    }
  }

  private trackMetrics(metrics: LLMCallMetrics): void {
    this.session.totalCost += metrics.cost
    this.session.totalTokens += metrics.tokens.prompt + metrics.tokens.completion

    // Phase 3 Batch 4 — cache observability. Record the per-call row here
    // (after every LLM call, regardless of whether it came from planner,
    // executor, reflector, summarizer, or skill context) because this is the
    // single funnel where we already have sessionId / taskId / subAgentTaskId
    // in scope. This keeps LLMProvider itself stateless/shared and avoids
    // threading context through every call site.
    const record: CacheCallRecord = {
      ts: Date.parse(metrics.timestamp) || Date.now(),
      sessionId: this.session.id,
      taskId: this.currentTaskId ?? undefined,
      subAgentTaskId: this.subAgentTaskId ?? undefined,
      model: metrics.model,
      provider: metrics.provider ?? this.llm.getProviderType(),
      inputTokens: metrics.tokens.prompt,
      outputTokens: metrics.tokens.completion,
      cacheCreationTokens: metrics.tokens.cacheWrite,
      cacheReadTokens: metrics.tokens.cacheRead,
      latencyMs: metrics.duration,
    }
    this.cacheMetrics.record(record)

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
    this.currentTaskId = nanoid()
    try {
      return await this.processMessageInner(userMessage)
    } finally {
      if (this.currentTaskId) {
        this.budgetManager.clearMainTask(this.currentTaskId)
      }
      this.currentTaskId = null
    }
  }

  private async processMessageInner(userMessage: string): Promise<string> {
    this.memory.addMessage('user', userMessage)
    this.emit({ type: 'message', data: { role: 'user', content: userMessage }, timestamp: new Date().toISOString() })

    // 0. Retrieve relevant knowledge snippets for this turn
    this.currentKnowledge = await this.retrieveKnowledge(userMessage)

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

    // 5. Execute plan steps (executor now handles both tools and skills)
    this.emit({ type: 'executing', data: `Executing ${plan.steps.length} step(s)...`, timestamp: new Date().toISOString() })

    const executionSteps = await this.executor.execute(plan, this.getAgentContext())

    for (const step of executionSteps) {
      this.emit({
        type: step.result.success ? 'tool-result' : 'error',
        data: step,
        timestamp: new Date().toISOString(),
      })
    }

    // 5b. Auto-repair: if a tool step failed, try self-repair skill
    const failedToolStep = executionSteps.find((s) => !s.result.success && s.tool && !s.tool.startsWith('skill:'))
    if (failedToolStep && failedToolStep.result.error) {
      this.emit({ type: 'executing', data: 'Attempting auto-repair...', timestamp: new Date().toISOString() })
      const repairResult = await this.skills.get('self-repair')?.execute(
        { error: failedToolStep.result.error, toolName: failedToolStep.tool! },
        this.createSkillContext(),
      )
      if (repairResult?.success) {
        this.emit({ type: 'hook', data: `Auto-repair succeeded: ${repairResult.output.slice(0, 200)}`, timestamp: new Date().toISOString() })
      }
    }

    // 6. Generate final response based on execution results
    const response = await this.generateSummaryResponse(userMessage, executionSteps)
    this.memory.addMessage('assistant', response)
    this.emit({ type: 'message', data: { role: 'assistant', content: response }, timestamp: new Date().toISOString() })

    // 7. Reflect on execution
    const overallResult = this.determineResult(executionSteps)
    this.emit({ type: 'reflecting', data: 'Reflecting on execution...', timestamp: new Date().toISOString() })

    const { reflection, tags, suggestedHook, metrics: reflectMetrics } = await this.reflector.reflect(
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

    // 9. Auto-create skill from reflection if suggested
    if (reflection.suggestedSkill) {
      try {
        const compiled = this.skillCompiler.compile(reflection.suggestedSkill)
        const validation = this.skillValidator.validate(compiled.skill, reflection.suggestedSkill)
        if (validation.valid) {
          // Check for duplicates
          const existing = this.skills.get(compiled.skill.id)
          if (!existing) {
            this.skills.register(compiled.skill)
            this.emit({
              type: 'hook',
              data: `Skill auto-created: ${compiled.skill.name} (${compiled.skill.id})`,
              timestamp: new Date().toISOString(),
            })
            // Refresh capability map
            this.capabilityMap.refresh(this.tools.list(), this.skills.list())
          }
        }
      } catch {
        // Skill creation failed — non-fatal, continue
      }
    }

    // 10. Auto-create hook from reflection if suggested
    if (suggestedHook) {
      try {
        const compiled = this.hookCompiler.compile(suggestedHook)
        this.hooks.registerEvolved(compiled.hook)
        this.emit({
          type: 'hook',
          data: `Hook evolved (sandbox): ${compiled.hook.name}`,
          timestamp: new Date().toISOString(),
        })
      } catch {
        // Hook creation failed — non-fatal, continue
      }
    }

    return response
  }

  /**
   * Streaming variant of processMessage — yields incremental events for real-time UI.
   * The final response text is streamed token-by-token via text-delta events.
   */
  async *processMessageStream(userMessage: string): AsyncGenerator<
    | { type: 'status'; message: string }
    | { type: 'text-delta'; text: string }
    | { type: 'tool-call'; step: ExecutionStep }
    | {
        type: 'done'
        response: string
        metrics: { cost: number; tokens: number }
        experienceId?: string
      }
  > {
    this.currentTaskId = nanoid()
    try {
      yield* this.processMessageStreamInner(userMessage)
    } finally {
      if (this.currentTaskId) {
        this.budgetManager.clearMainTask(this.currentTaskId)
      }
      this.currentTaskId = null
    }
  }

  private async *processMessageStreamInner(userMessage: string): AsyncGenerator<
    | { type: 'status'; message: string }
    | { type: 'text-delta'; text: string }
    | { type: 'tool-call'; step: ExecutionStep }
    | {
        type: 'done'
        response: string
        metrics: { cost: number; tokens: number }
        experienceId?: string
      }
  > {
    this.memory.addMessage('user', userMessage)
    this.emit({ type: 'message', data: { role: 'user', content: userMessage }, timestamp: new Date().toISOString() })

    // 0. Retrieve relevant knowledge snippets for this turn
    this.currentKnowledge = await this.retrieveKnowledge(userMessage)

    // 1. Retrieve related experiences
    yield { type: 'status', message: 'Retrieving experiences...' }
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

    // 2. Run before:llm-call hooks
    const hookContext: HookContext = {
      trigger: 'before:llm-call',
      data: { history: this.memory.getHistory() },
      agent: this.getAgentContext(),
    }
    await this.hooks.run('before:llm-call', hookContext, { history: this.memory.getHistory() })

    // 3. Plan
    yield { type: 'status', message: 'Planning...' }
    this.emit({ type: 'planning', data: 'Analyzing task...', timestamp: new Date().toISOString() })

    const { plan, metrics: planMetrics } = await this.planner.plan(
      userMessage,
      relatedExperiences,
      this.memory.getHistory(),
    )
    this.trackMetrics(planMetrics)
    this.emit({ type: 'planning', data: plan, timestamp: new Date().toISOString() })

    // 4. If no tool steps — conversational, stream the response
    if (plan.steps.length === 0) {
      const fullText = yield* this.streamConversationalResponse(userMessage)
      this.memory.addMessage('assistant', fullText)
      this.emit({ type: 'message', data: { role: 'assistant', content: fullText }, timestamp: new Date().toISOString() })
      yield { type: 'done', response: fullText, metrics: { cost: this.session.totalCost, tokens: this.session.totalTokens } }
      return
    }

    // 5. Execute plan steps
    yield { type: 'status', message: `Executing ${plan.steps.length} step(s)...` }
    this.emit({ type: 'executing', data: `Executing ${plan.steps.length} step(s)...`, timestamp: new Date().toISOString() })

    const executionSteps = await this.executor.execute(plan, this.getAgentContext())

    for (const step of executionSteps) {
      yield { type: 'tool-call', step }
      this.emit({
        type: step.result.success ? 'tool-result' : 'error',
        data: step,
        timestamp: new Date().toISOString(),
      })
    }

    // 5b. Auto-repair
    const failedToolStep = executionSteps.find((s) => !s.result.success && s.tool && !s.tool.startsWith('skill:'))
    if (failedToolStep && failedToolStep.result.error) {
      yield { type: 'status', message: 'Attempting auto-repair...' }
      this.emit({ type: 'executing', data: 'Attempting auto-repair...', timestamp: new Date().toISOString() })
      const repairResult = await this.skills.get('self-repair')?.execute(
        { error: failedToolStep.result.error, toolName: failedToolStep.tool! },
        this.createSkillContext(),
      )
      if (repairResult?.success) {
        this.emit({ type: 'hook', data: `Auto-repair succeeded: ${repairResult.output.slice(0, 200)}`, timestamp: new Date().toISOString() })
      }
    }

    // 6. Generate summary response (streaming)
    yield { type: 'status', message: 'Generating response...' }
    const fullText = yield* this.streamSummaryResponse(userMessage, executionSteps)
    this.memory.addMessage('assistant', fullText)
    this.emit({ type: 'message', data: { role: 'assistant', content: fullText }, timestamp: new Date().toISOString() })

    // 7. Reflect
    const overallResult = this.determineResult(executionSteps)
    yield { type: 'status', message: 'Reflecting...' }
    this.emit({ type: 'reflecting', data: 'Reflecting on execution...', timestamp: new Date().toISOString() })

    const { reflection, tags, suggestedHook, metrics: reflectMetrics } = await this.reflector.reflect(
      userMessage,
      executionSteps,
      overallResult,
    )
    this.trackMetrics(reflectMetrics)

    // 8. Store experience
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

    // 9. Auto-create skill
    if (reflection.suggestedSkill) {
      try {
        const compiled = this.skillCompiler.compile(reflection.suggestedSkill)
        const validation = this.skillValidator.validate(compiled.skill, reflection.suggestedSkill)
        if (validation.valid) {
          const existing = this.skills.get(compiled.skill.id)
          if (!existing) {
            this.skills.register(compiled.skill)
            this.emit({
              type: 'hook',
              data: `Skill auto-created: ${compiled.skill.name} (${compiled.skill.id})`,
              timestamp: new Date().toISOString(),
            })
            this.capabilityMap.refresh(this.tools.list(), this.skills.list())
          }
        }
      } catch {
        // Skill creation failed — non-fatal
      }
    }

    // 10. Auto-create hook
    if (suggestedHook) {
      try {
        const compiled = this.hookCompiler.compile(suggestedHook)
        this.hooks.registerEvolved(compiled.hook)
        this.emit({
          type: 'hook',
          data: `Hook evolved (sandbox): ${compiled.hook.name}`,
          timestamp: new Date().toISOString(),
        })
      } catch {
        // Hook creation failed — non-fatal
      }
    }

    yield {
      type: 'done',
      response: fullText,
      metrics: { cost: this.session.totalCost, tokens: this.session.totalTokens },
      experienceId: storeResult.stored ? storeResult.experience?.id : undefined,
    }
  }

  /**
   * Stream a conversational response (no tool steps), yielding text-delta events.
   * Returns the full accumulated text.
   */
  private async *streamConversationalResponse(userMessage: string): AsyncGenerator<
    { type: 'text-delta'; text: string },
    string
  > {
    const config: PromptConfig = {
      systemPrompt: CONVERSATIONAL_SYSTEM_PROMPT,
      skills: [],
      knowledge: this.currentKnowledge,
      history: this.memory.getHistory().slice(0, -1),
      experiences: [],
      currentInput: userMessage,
      provider: this.llm.getProviderType(),
    }

    const messages = this.llm.buildMessages(config)
    let fullText = ''

    for await (const chunk of this.llm.stream('executor', messages)) {
      if (chunk.type === 'text-delta') {
        fullText += chunk.text
        yield { type: 'text-delta', text: chunk.text }
      } else if (chunk.type === 'finish') {
        this.trackMetrics(chunk.metrics)
      }
    }

    return fullText
  }

  /**
   * Stream a summary response after tool execution, yielding text-delta events.
   * Returns the full accumulated text.
   */
  private async *streamSummaryResponse(
    task: string,
    steps: ExecutionStep[],
  ): AsyncGenerator<{ type: 'text-delta'; text: string }, string> {
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
      knowledge: this.currentKnowledge,
      history: this.memory.getHistory().slice(0, -1),
      experiences: [],
      currentInput: summaryPrompt,
      provider: this.llm.getProviderType(),
    }

    const messages = this.llm.buildMessages(config)
    let fullText = ''

    for await (const chunk of this.llm.stream('executor', messages)) {
      if (chunk.type === 'text-delta') {
        fullText += chunk.text
        yield { type: 'text-delta', text: chunk.text }
      } else if (chunk.type === 'finish') {
        this.trackMetrics(chunk.metrics)
      }
    }

    return fullText
  }

  private async generateConversationalResponse(userMessage: string): Promise<string> {
    const config: PromptConfig = {
      systemPrompt: CONVERSATIONAL_SYSTEM_PROMPT,
      skills: [],
      knowledge: this.currentKnowledge,
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
      knowledge: this.currentKnowledge,
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

  /**
   * Record explicit user feedback on an experience. Delegates to the memory
   * manager, which updates the experience's admission score and also nudges
   * any referenced skills' usage scores via the wired skill registry.
   */
  async recordFeedback(
    experienceId: string,
    feedback: 'positive' | 'negative',
  ): Promise<boolean> {
    return this.memory.recordFeedback(experienceId, feedback)
  }

  // === Introspection API (for web dashboard) ===

  getHookRunner(): HookRunner {
    return this.hooks
  }

  getMemoryManager(): MemoryManager {
    return this.memory
  }

  getToolRegistry(): ToolRegistry {
    return this.tools
  }

  getLLMProvider(): LLMProvider {
    return this.llm
  }

  getSkillRegistry(): SkillRegistry {
    return this.skills
  }

  getCapabilityMap(): CapabilityMap {
    return this.capabilityMap
  }

  getKnowledgeStore(): KnowledgeStore {
    return this.knowledgeStore
  }

  /** Retrieve top-3 knowledge snippets matching the user message. */
  private async retrieveKnowledge(userMessage: string): Promise<string[]> {
    try {
      if (!this.knowledgeStore.isInitialized() || this.knowledgeStore.size() === 0) {
        return []
      }
      const results = await this.knowledgeStore.search(userMessage, 3)
      return results.map((r) => r.entry.content)
    } catch {
      return []
    }
  }

  getCacheMetrics(): CacheMetricsRecorder {
    return this.cacheMetrics
  }

  getBudgetManager(): BudgetManager {
    return this.budgetManager
  }

  getHookSandbox(): HookSandbox {
    return this.hookSandbox
  }

  /** Load historical messages into short-term memory (for session resume) */
  loadHistory(messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp?: string }>): void {
    this.memory.shortTerm.load(messages)
  }

  // === Multi-Agent Delegation ===

  /** Get the agent's session ID (used as agent ID in coordination) */
  getAgentId(): string {
    return this.session.id
  }

  /** Delegate a subtask to another agent via the coordinator */
  async delegate(
    task: string,
    coordinator: AgentCoordinator,
  ): Promise<{ agentId: string; result: string } | null> {
    const result = await coordinator.routeTask(task, this.session.id)
    if (result) {
      this.emit({
        type: 'hook',
        data: `Delegated to ${result.agentId}: ${task.slice(0, 100)}`,
        timestamp: new Date().toISOString(),
      })
    }
    return result
  }
}
