// ============================================================
// Evolving Agent — Core Type Definitions
// ============================================================

// === Agent Events ===

export type AgentEventType =
  | 'planning'
  | 'executing'
  | 'tool-call'
  | 'tool-result'
  | 'reflecting'
  | 'message'
  | 'error'
  | 'hook'

export interface AgentEvent {
  type: AgentEventType
  data: unknown
  timestamp: string
}

// === Tools ===

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  /**
   * Which agent tier this tool is exposed to. Defaults to `'both'` when
   * omitted. Sub-agent spawns derive a filtered registry using this field
   * (plus an optional per-spawn `toolWhitelist`).
   */
  scope?: 'main' | 'sub' | 'both'
}

export interface ToolResult {
  success: boolean
  output: string
  error?: string
}

export interface Tool extends ToolDefinition {
  execute: (params: Record<string, unknown>) => Promise<ToolResult>
}

// === Planning ===

export interface PlanStep {
  id: string
  description: string
  tool?: string
  params?: Record<string, unknown>
  dependsOn?: string[]
}

export interface Plan {
  task: string
  steps: PlanStep[]
  relatedExperiences: Experience[]
}

export interface ExecutionStep extends PlanStep {
  result: ToolResult
  duration: number
}

// === Reflection ===

export interface SkillDraft {
  name: string
  trigger: string
  steps: string[]
}

export interface Reflection {
  whatWorked: string[]
  whatFailed: string[]
  lesson: string
  suggestedSkill?: SkillDraft
}

// === Memory: Experience ===

export interface ExperienceHealth {
  referencedCount: number
  contradictionCount: number
  lastReferenced?: string
}

export interface Experience {
  id: string
  task: string
  steps: ExecutionStep[]
  result: 'success' | 'partial' | 'failure'
  reflection: Reflection
  tags: string[]
  timestamp: string
  embedding?: number[]
  health: ExperienceHealth
  admissionScore: number
  /** Explicit user signal on this experience. Strongly influences admission score. */
  feedback?: 'positive' | 'negative'
}

// === Memory: Retrieval ===

export interface RetrievalQuery {
  text: string
  tags?: string[]
  pool?: 'active' | 'stale' | 'all'
  topK?: number
  minScore?: number
}

export interface RetrievalResult {
  id: string
  type: 'experience' | 'skill' | 'knowledge'
  content: Experience | Skill
  score: number
  matchSource: ('keyword' | 'semantic' | 'tag')[]
}

// === Skills ===

export interface SkillStep {
  description: string
  tool?: string
  params?: Record<string, unknown>
}

export interface Skill {
  id: string
  name: string
  trigger: string
  steps: SkillStep[]
  score: number
  usageCount: number
  lastUsed: string
  createdFrom: string
  version: number
}

/** Input/output schema for executable skills */
export interface SkillParam {
  name: string
  description: string
  type: 'string' | 'number' | 'boolean'
  required?: boolean
}

/** An executable skill — can be a built-in (with handler) or a composed skill (with steps) */
export interface ExecutableSkill {
  id: string
  name: string
  description: string
  category: 'builtin' | 'system' | 'learned'
  /** When should the planner consider this skill (keyword matching) */
  triggers: string[]
  /** Input parameters the skill accepts */
  inputs: SkillParam[]
  /** Execute the skill — receives inputs + tool registry, returns result */
  execute: (
    params: Record<string, unknown>,
    context: SkillContext,
  ) => Promise<SkillResult>
  /** Whether this skill is currently available */
  available?: boolean
  /** Why the skill is unavailable */
  unavailableReason?: string
}

export interface SkillContext {
  /** Execute a tool by name */
  useTool: (toolName: string, params: Record<string, unknown>) => Promise<ToolResult>
  /** Call the LLM for reasoning within the skill */
  think: (prompt: string) => Promise<string>
  /** Emit progress events */
  emit: (message: string) => void
}

export interface SkillResult {
  success: boolean
  output: string
  error?: string
  /** Structured data the skill produces (for downstream use) */
  data?: Record<string, unknown>
}

// === Hooks ===

export type HookTrigger =
  | 'before:plan'
  | 'after:plan'
  | 'before:tool-call'
  | 'after:tool-call'
  | 'before:llm-call'
  | 'after:llm-call'
  | 'before:reflect'
  | 'after:reflect'
  | 'on:error'
  | 'on:startup'
  | 'cron'

export type HookSource = 'core' | 'evolved-verified' | 'evolved-new'

export type HookFallback = 'skip' | 'abort' | 'use-default'

export interface HookHealth {
  consecutiveFailures: number
  lastError?: string
  lastSuccess?: string
  totalRuns: number
  successRate: number
}

export interface HookSafety {
  timeout: number
  maxRetries: number
  fallbackBehavior: HookFallback
  canBeDisabledByAgent: boolean
}

export interface Hook {
  id: string
  name: string
  description: string
  trigger: HookTrigger
  priority: number
  enabled: boolean
  source: HookSource
  handler: (context: HookContext) => Promise<unknown>
  health: HookHealth
  safety: HookSafety
  schedule?: string
}

export interface HookContext {
  trigger: HookTrigger
  data: unknown
  agent: {
    sessionId: string
    totalCost: number
    tokenCount: number
    /** Current main-agent task id (one per user message); used by the budget guard. */
    taskId?: string
    /** Current sub-agent task id when running inside a SubAgent wrapper. */
    subAgentTaskId?: string
    /** Per-task hard token budget carried by sub-agent tasks (from TaskAssign.config.tokenBudget). */
    subAgentTokenBudget?: number
    /** Desired model id for the pending call (mutable — the budget guard can downgrade it). */
    model?: string
  }
}

// === Channel ===

export type AgentMessageType = 'text' | 'tool-call' | 'tool-result' | 'error' | 'event'

export interface AgentMessage {
  type: AgentMessageType
  content: string
  streaming?: boolean
}

export type MessageHandler = (message: AgentMessage) => Promise<void>

/**
 * @deprecated Phase 1 stub. Use the richer `Channel` interface in
 * `./channels/channel.ts` (exported from `./channels/index.js`) together
 * with `ChannelRegistry`. This definition is kept only so legacy callers
 * keep compiling until they are migrated; new code must not use it.
 */
export interface Channel {
  id: string
  send(message: AgentMessage): Promise<void>
  onMessage(handler: MessageHandler): void
  supportsStreaming: boolean
  supportsRichContent: boolean
}

// === Session ===

export interface Session {
  id: string
  startedAt: string
  status: 'active' | 'idle' | 'closed'
  totalCost: number
  totalTokens: number
}

// === LLM ===

export interface LLMCallMetrics {
  callId: string
  model: string
  /** Provider type — e.g. 'anthropic' | 'openai' | 'openai-compatible'. */
  provider?: string
  timestamp: string
  tokens: {
    prompt: number
    completion: number
    cacheWrite: number
    cacheRead: number
  }
  cacheHitRate: number
  cost: number
  savedCost: number
  duration: number
}

export interface PromptConfig {
  systemPrompt: string
  skills: Skill[]
  knowledge: string[]
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  experiences: Experience[]
  currentInput: string
  provider: 'anthropic' | 'openai' | 'openai-compatible'
}

// === Admission Scoring ===

export interface AdmissionScores {
  novelty: number
  lessonValue: number
  reusability: number
  userSignal: number
  complexity: number
}

export interface AdmissionResult {
  score: number
  scores: AdmissionScores
  decision: 'discard' | 'low-confidence' | 'high-confidence'
}
