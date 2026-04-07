// ============================================================
// Channel event vocabulary
// ============================================================
//
// Discriminated-union of every event that can flow across a Channel — either
// outbound (Agent → external surface) or inbound (external surface → Agent).
// Phase 3 Batch 5 ships only the types + registry; Phase 4 will add concrete
// Channel implementations (Feishu bot, Slack, web UI, …) that consume these
// events.
//
// Design notes:
// - The discriminator is `type`, matching the `Channel.capabilities` set so a
//   registry can route by capability intersection.
// - `target` is an optional routing hint the sender may set to steer the
//   event at a specific session/user/thread. Channels without any notion of
//   multi-target routing may ignore it.
// - `alert.cache-health` is the first concrete system-originated event
//   (Batch 4 C wiring); keep the shape aligned with `CacheHealthAlert` from
//   `hooks/core-hooks/cache-health-alert.ts` so adapters are trivial.

/** Direction & kind discriminator for events flowing across channels. */
export type ChannelEventType =
  | 'agent.message'        // Agent → user (assistant text)
  | 'user.message'         // User → agent (user text input)
  | 'tool.call'            // Agent emits a tool call (mostly inbound display)
  | 'tool.result'          // Agent emits a tool result
  | 'alert.cache-health'   // System cache-health alert (Batch 4 C)
  | 'alert.budget'         // System budget warning/block
  | 'task.completed'       // Sub-agent or main task finished
  | 'task.failed'
  | 'system.notice'        // Generic system notice (used by hooks)

export interface BaseChannelEvent {
  type: ChannelEventType
  ts: number
  /** Routing hint — if absent, channel decides based on its own config. */
  target?: { sessionId?: string; userId?: string; threadId?: string }
}

export interface AgentMessageEvent extends BaseChannelEvent {
  type: 'agent.message'
  text: string
  streaming?: boolean
}

export interface UserMessageEvent extends BaseChannelEvent {
  type: 'user.message'
  text: string
  /** Inbound from a channel; Channel populates this when forwarding to Agent. */
  channelId: string
}

export interface CacheHealthAlertEvent extends BaseChannelEvent {
  type: 'alert.cache-health'
  hitRatio: number
  threshold: number
  totalCalls: number
  reason: string
}

export interface BudgetAlertEvent extends BaseChannelEvent {
  type: 'alert.budget'
  layer: 'global' | 'main' | 'sub-agent'
  ratio: number
  reason: string
}

export interface TaskCompletedEvent extends BaseChannelEvent {
  type: 'task.completed'
  taskId: string
  summary: string
}

export interface TaskFailedEvent extends BaseChannelEvent {
  type: 'task.failed'
  taskId: string
  error: string
}

export interface ToolCallEvent extends BaseChannelEvent {
  type: 'tool.call'
  tool: string
  params: Record<string, unknown>
}

export interface ToolResultEvent extends BaseChannelEvent {
  type: 'tool.result'
  tool: string
  success: boolean
  output: string
}

export interface SystemNoticeEvent extends BaseChannelEvent {
  type: 'system.notice'
  text: string
  level: 'info' | 'warn' | 'error'
}

export type ChannelEvent =
  | AgentMessageEvent
  | UserMessageEvent
  | CacheHealthAlertEvent
  | BudgetAlertEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | ToolCallEvent
  | ToolResultEvent
  | SystemNoticeEvent

export type ChannelEventHandler = (event: ChannelEvent) => void | Promise<void>
