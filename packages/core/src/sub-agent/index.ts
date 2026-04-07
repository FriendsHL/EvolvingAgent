// Sub-Agent module — public API
//
// Provides in-process isolation for sub-agents spawned by Main Agent.
// See docs/design/sub-agent.md for the architectural overview.

export { SubAgent } from './sub-agent.js'
export type { SubAgentOptions } from './sub-agent.js'

export { SubAgentManager } from './manager.js'
export type {
  SubAgentSpec,
  SubAgentHandle,
  SubAgentStatus,
  SubAgentManagerOptions,
  TaskAssignInput,
  ProgressCallback,
  ResourceRequestCallback,
} from './manager.js'

export {
  InProcessTransport,
  createInProcessTransportPair,
} from './transport.js'
export type { SubAgentTransport, SubAgentMessageHandler } from './transport.js'

export {
  isTaskAssign,
  isTaskProgress,
  isTaskResult,
  isTaskCancel,
  isResourceRequest,
  isResourceGrant,
} from './protocol.js'
export type {
  SubAgentMessage,
  TaskAssign,
  TaskProgress,
  TaskResult,
  TaskCancel,
  ResourceRequest,
  ResourceGrant,
  ResourceRequestPayload,
  Artifact,
  ToolCallRecord,
} from './protocol.js'
