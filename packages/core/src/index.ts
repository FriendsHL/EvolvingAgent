// Evolving Agent Core — Public API

export { Agent } from './agent.js'
export type { AgentConfig } from './agent.js'

export { ToolRegistry } from './tools/registry.js'
export { shellTool } from './tools/shell.js'
export { fileReadTool } from './tools/file-read.js'
export { fileWriteTool } from './tools/file-write.js'
export { httpTool } from './tools/http.js'

export { HookRunner } from './hooks/hook-runner.js'
export { MemoryManager } from './memory/memory-manager.js'
export { MetricsCollector } from './metrics/collector.js'

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
} from './types.js'
