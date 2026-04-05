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

// === Skills (Phase 2 full, stub here) ===

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
  agent: { sessionId: string; totalCost: number; tokenCount: number }
}

// === Channel ===

export type AgentMessageType = 'text' | 'tool-call' | 'tool-result' | 'error' | 'event'

export interface AgentMessage {
  type: AgentMessageType
  content: string
  streaming?: boolean
}

export type MessageHandler = (message: AgentMessage) => Promise<void>

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
  provider: 'anthropic' | 'openai'
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
