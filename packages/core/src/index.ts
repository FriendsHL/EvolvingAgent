// Evolving Agent Core — Public API

export { Agent } from './agent.js'
export type { AgentConfig, AgentSharedDeps } from './agent.js'

// Multi-Session (Phase 3 Batch 3)
export * from './session/index.js'

export { LLMProvider, PROVIDER_PRESETS } from './llm/provider.js'
export type { ProviderConfig, ProviderType, PresetName, ModelRole, LLMCallOptions } from './llm/provider.js'

export { ToolRegistry } from './tools/registry.js'
export { shellTool } from './tools/shell.js'
export { fileReadTool } from './tools/file-read.js'
export { fileWriteTool } from './tools/file-write.js'
export { httpTool } from './tools/http.js'
export { browserTool, closeBrowser, checkBrowserHealth, resetBrowserState } from './tools/browser.js'
export {
  createMetricsQueryTool,
  createLogSearchTool,
  createTraceTool,
} from './tools/observability/index.js'

export { HookRunner } from './hooks/hook-runner.js'
export { HookCompiler } from './hooks/hook-compiler.js'
export type { HookDraft, CompiledHook } from './hooks/hook-compiler.js'
export { HookSandbox } from './hooks/hook-sandbox.js'
export type { SandboxConfig, SandboxedHook } from './hooks/hook-sandbox.js'
export { contextWindowGuard } from './hooks/core-hooks/context-window-guard.js'
export { costHardLimit } from './hooks/core-hooks/cost-hard-limit.js'
export { safetyCheck } from './hooks/core-hooks/safety-check.js'
export { metricsCollectorHook } from './hooks/core-hooks/metrics-collector.js'
export { MemoryManager } from './memory/memory-manager.js'
export { ExperienceStore } from './memory/experience-store.js'
export { Embedder } from './memory/embedder.js'
export type { EmbedderConfig } from './memory/embedder.js'
export { VectorIndex, cosineSimilarity } from './memory/vector-index.js'
export type { ScoredResult } from './memory/vector-index.js'
export type { RetrieverConfig } from './memory/retriever.js'
export { MetricsCollector } from './metrics/collector.js'
export {
  BudgetManager,
  loadBudgetConfig,
  cloneBudgetConfig,
  estimateMessageTokens,
  estimateHistoryTokens,
  DEFAULT_BUDGET_CONFIG,
} from './metrics/budget.js'
export type {
  BudgetConfig,
  BudgetCheck,
  BudgetUsageScope,
  OverBehavior,
  SubAgentOverBehavior,
} from './metrics/budget.js'
export { createBudgetGuard, createBudgetRecorder } from './hooks/core-hooks/budget-guard.js'
export { CacheMetricsRecorder } from './metrics/cache-metrics.js'
export type { CacheCallRecord, CacheAggregate } from './metrics/cache-metrics.js'
export { extractCacheTokens } from './metrics/extract-cache-tokens.js'
export type { ExtractedCacheTokens, NormalizedUsageLike } from './metrics/extract-cache-tokens.js'
export { createCacheHealthAlert } from './hooks/core-hooks/cache-health-alert.js'
export type {
  CacheHealthAlert,
  CacheHealthAlertOptions,
} from './hooks/core-hooks/cache-health-alert.js'

export { CapabilityMap } from './agent/capability-map.js'
export type { Capability, FeasibilityResult } from './agent/capability-map.js'

export { SkillRegistry } from './skills/skill-registry.js'
export type { SkillMetadata, SkillWithMetadata, SkillUsageRecord } from './skills/skill-registry.js'
export { SkillCompiler } from './skills/skill-compiler.js'
export type { CompiledSkill } from './skills/skill-compiler.js'
export { SkillValidator } from './skills/skill-validator.js'
export type { ValidationResult } from './skills/skill-validator.js'
export { webSearchSkill } from './skills/builtin/web-search.js'
export { summarizeUrlSkill } from './skills/builtin/summarize-url.js'
export { selfRepairSkill } from './skills/builtin/self-repair.js'
export { githubSkill } from './skills/builtin/github.js'
export { codeAnalysisSkill } from './skills/builtin/code-analysis.js'
export { fileBatchSkill } from './skills/builtin/file-batch.js'
export { scheduleSkill } from './skills/builtin/schedule.js'
export { dataExtractSkill } from './skills/builtin/data-extract.js'

export type {
  AgentEvent,
  AgentMessage,
  Experience,
  ExecutionStep,
  Hook,
  HookContext,
  HookTrigger,
  LLMCallMetrics,
  Plan,
  PlanStep,
  Reflection,
  RetrievalQuery,
  RetrievalResult,
  Session,
  Skill,
  Tool,
  ToolDefinition,
  ToolResult,
  AdmissionResult,
  AdmissionScores,
  PromptConfig,
  ExecutableSkill,
  SkillParam,
  SkillContext,
  SkillDraft,
  SkillResult,
  SkillStep,
} from './types.js'

// Multi-Agent Collaboration
export { MessageBus, AgentCoordinator, TaskDelegator, AGENT_TEMPLATES, profileFromTemplate } from './multi-agent/index.js'
export type { InterAgentMessage, MessageType, AgentProfile, AgentTemplate, DelegationTask, DelegationResult } from './multi-agent/index.js'

// Sub-Agent in-process isolation (Phase 3 Batch 3)
export * from './sub-agent/index.js'

// Channel layer (Phase 3 Batch 5). NOTE: this `Channel` is the Phase-3+
// rich interface in `./channels/channel.ts`; the old `Channel` stub from
// `./types.ts` is kept (marked `@deprecated`) for legacy callers but is
// no longer re-exported from the core barrel to avoid a name collision —
// the new `Channel` wins at the public API surface.
export { ChannelRegistry } from './channels/index.js'
export type {
  Channel,
  ChannelEvent,
  ChannelEventType,
  ChannelEventHandler,
  BaseChannelEvent,
  AgentMessageEvent,
  UserMessageEvent,
  CacheHealthAlertEvent,
  BudgetAlertEvent,
  TaskCompletedEvent,
  TaskFailedEvent,
  ToolCallEvent,
  ToolResultEvent,
  SystemNoticeEvent,
} from './channels/index.js'

// Prompt self-optimization (Phase 4 / C stage)
export { PromptRegistry } from './prompts/registry.js'
export type { PromptRegistryOptions } from './prompts/registry.js'
export { PromptOptimizer } from './prompts/optimizer.js'
export type {
  ProposeFn,
  EvaluateFn,
  PromptOptimizerOptions,
} from './prompts/optimizer.js'
export { createLLMProposer } from './prompts/propose-llm.js'
export { createEvalAdapter } from './prompts/eval-adapter.js'
export type { EvalAdapterOptions } from './prompts/eval-adapter.js'
export type {
  PromptId,
  PromptActiveEntry,
  PromptActiveFile,
  PromptHistoryEntry,
  PromptCandidate,
  PromptCandidateEvaluation,
  GateResult,
  OptimizationRun,
} from './prompts/types.js'
export { PROMPT_IDS } from './prompts/types.js'
export { PLANNER_SYSTEM_PROMPT } from './planner/planner.js'
export { REFLECTOR_SYSTEM_PROMPT } from './reflector/reflector.js'
export { CONVERSATIONAL_SYSTEM_PROMPT } from './agent.js'

// MCP integration (Phase 4 / B stage)
export { MCPManager } from './mcp/manager.js'
export { MCPClient } from './mcp/client.js'
export type {
  MCPServerConfig,
  MCPConfigFile,
  MCPServerStatus,
  MCPServerStatusEntry,
  MCPToolDescriptor,
} from './mcp/types.js'
export { loadSecrets, expandPlaceholders, findMissingPlaceholders } from './secrets/loader.js'

// Eval framework (Phase 3 Batch 5)
export { EvalRunner, loadEvalCases, evaluateCriterion } from './eval/index.js'
export type {
  EvalCase,
  EvalCriterion,
  EvalCaseResult,
  EvalReport,
  EvalRunnerDeps,
  EvalRunOptions,
  CriterionContext,
  CriterionVerdict,
} from './eval/index.js'
