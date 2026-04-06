// Evolving Agent Core — Public API

export { Agent } from './agent.js'
export type { AgentConfig } from './agent.js'

export { LLMProvider, PROVIDER_PRESETS } from './llm/provider.js'
export type { ProviderConfig, ProviderType, PresetName, ModelRole } from './llm/provider.js'

export { ToolRegistry } from './tools/registry.js'
export { shellTool } from './tools/shell.js'
export { fileReadTool } from './tools/file-read.js'
export { fileWriteTool } from './tools/file-write.js'
export { httpTool } from './tools/http.js'
export { browserTool, closeBrowser, checkBrowserHealth, resetBrowserState } from './tools/browser.js'

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

export { KnowledgeStore } from './knowledge/knowledge-store.js'
export type { KnowledgeEntry, KnowledgeSearchResult } from './knowledge/types.js'

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
  Channel,
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
