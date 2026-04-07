// ============================================================
// Sub-Agent IPC Protocol — pure JSON, no function references
// ============================================================
//
// All messages here MUST be JSON-serializable. The current transport runs
// in-process (see ./transport.ts) but the protocol is designed so that a
// future ChildProcessTransport or WorkerThreadTransport can be swapped in
// without touching sub-agent business logic.
//
// See docs/design/sub-agent.md "IPC Message Protocol" for the full spec —
// the field names below are kept in lock-step with that document.

import type { Experience, Skill } from '../types.js'

// ------------------------------------------------------------
// Local types not yet defined in core/src/types.ts
// TODO(types): once Artifact + ToolCallRecord land in types.ts, replace
// these local definitions with re-exports so the project has one canonical
// shape. Keeping them local for now to avoid touching shared types from
// the sub-agent workstream.
// ------------------------------------------------------------

export interface Artifact {
  /** Stable identifier (e.g. "report.md", "diff-1") */
  id: string
  /** Content kind — drives how Main renders / persists it */
  kind: 'text' | 'markdown' | 'json' | 'binary' | 'file-ref'
  /** Inline content; for `file-ref` use `path` instead */
  content?: string
  /** Filesystem path when `kind === 'file-ref'` */
  path?: string
  /** Optional MIME type for richer rendering */
  mimeType?: string
}

export interface ToolCallRecord {
  /** Tool or skill name (skills use the `skill:<id>` convention) */
  tool: string
  /** Plain-JSON parameters passed to the tool */
  params: Record<string, unknown>
  /** Truncated string form of the tool output */
  output: string
  /** Whether the call succeeded */
  success: boolean
  /** Error message if the call failed */
  error?: string
  /** Wall-clock duration in ms */
  duration: number
}

// ------------------------------------------------------------
// Discriminated union: SubAgentMessage
// ------------------------------------------------------------

export type SubAgentMessage =
  | TaskAssign
  | TaskProgress
  | TaskResult
  | TaskCancel
  | ResourceRequest
  | ResourceGrant

// === Main → Sub: assign a task ===

export interface TaskAssign {
  type: 'task:assign'
  taskId: string
  parentTaskId: string
  description: string
  context: {
    /** Shared task background — kept stable across sibling sub-agents for prompt-cache reuse */
    background: string
    constraints: string[]
    relatedExperiences: Experience[]
    relevantSkills: Skill[]
  }
  config: {
    model: string
    tokenBudget: number
    /** Soft timeout in ms; enforced cooperatively via task:cancel */
    timeout: number
    /** Allowed tool whitelist (tool/skill names) */
    tools: string[]
    /** Whether the sub-agent may issue resource:request messages */
    canRequestMore: boolean
  }
}

// === Sub → Main: progress update ===

export interface TaskProgress {
  type: 'task:progress'
  taskId: string
  status: 'thinking' | 'executing' | 'tool-calling' | 'waiting-resource'
  summary: string
  tokensUsed: number
  stepsCompleted: number
}

// === Sub → Main: terminal result ===

export interface TaskResult {
  type: 'task:result'
  taskId: string
  outcome: 'success' | 'partial' | 'failure'
  result: {
    answer: string
    artifacts: Artifact[]
    toolCalls: ToolCallRecord[]
  }
  metadata: {
    tokensUsed: number
    duration: number
    stepsTotal: number
    model: string
  }
  reflection?: {
    whatWorked: string[]
    whatFailed: string[]
    suggestion: string
  }
}

// === Main → Sub: cancel ===

export interface TaskCancel {
  type: 'task:cancel'
  taskId: string
  reason: string
}

// === Sub → Main: ask for more resources / permissions ===

export type ResourceRequestPayload =
  | { kind: 'more-tokens'; amount: number }
  | { kind: 'more-tools'; tools: string[] }
  | { kind: 'more-context'; query: string }
  | { kind: 'user-input'; question: string }

export interface ResourceRequest {
  type: 'resource:request'
  taskId: string
  request: ResourceRequestPayload
}

// === Main → Sub: grant (or deny) a resource request ===

export interface ResourceGrant {
  type: 'resource:grant'
  taskId: string
  granted: boolean
  /** Optional payload — shape depends on the original request kind */
  payload?: Record<string, unknown>
}

// ------------------------------------------------------------
// Type guards (handy for transport handlers + tests)
// ------------------------------------------------------------

export function isTaskAssign(m: SubAgentMessage): m is TaskAssign {
  return m.type === 'task:assign'
}
export function isTaskProgress(m: SubAgentMessage): m is TaskProgress {
  return m.type === 'task:progress'
}
export function isTaskResult(m: SubAgentMessage): m is TaskResult {
  return m.type === 'task:result'
}
export function isTaskCancel(m: SubAgentMessage): m is TaskCancel {
  return m.type === 'task:cancel'
}
export function isResourceRequest(m: SubAgentMessage): m is ResourceRequest {
  return m.type === 'resource:request'
}
export function isResourceGrant(m: SubAgentMessage): m is ResourceGrant {
  return m.type === 'resource:grant'
}
