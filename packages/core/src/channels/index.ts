// Channel layer public surface (Phase 3 Batch 5).
// Concrete Channel implementations land in Phase 4.

export type { Channel } from './channel.js'
export { ChannelRegistry } from './registry.js'
export type {
  ChannelEventType,
  ChannelEvent,
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
} from './types.js'
