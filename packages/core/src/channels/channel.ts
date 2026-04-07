// ============================================================
// Channel interface
// ============================================================
//
// A Channel is a bidirectional or one-way pipe between the Agent and an
// external surface (Feishu, Slack, web UI, CLI). Channels are pluggable:
// Phase 3 Batch 5 ships only the interface + registry; Phase 4 will add
// concrete implementations (Feishu bot, etc.).
//
// This interface supersedes the stub `Channel` in `../types.ts`. The old
// interface is kept around (with `@deprecated`) so existing callers compile
// until they are migrated.

import type { ChannelEvent, ChannelEventHandler, ChannelEventType } from './types.js'

/**
 * A channel is a bidirectional or one-way pipe between the Agent and an
 * external surface (Feishu, Slack, web UI, CLI). Channels are pluggable:
 * Phase 3 ships only the interface + registry; Phase 4 will add concrete
 * implementations (Feishu bot, etc.).
 */
export interface Channel {
  /** Stable id, e.g. 'feishu:main', 'cli', 'web'. */
  readonly id: string
  /** Human label for dashboards/logs. */
  readonly name: string
  /** What event types this channel will accept via `send()`. */
  readonly capabilities: ReadonlySet<ChannelEventType>

  /** Lifecycle. `start` connects/listens, `stop` releases resources. */
  start(): Promise<void>
  stop(): Promise<void>

  /**
   * Outbound: dispatch an event from the Agent through this channel.
   * Channels MAY filter events outside their `capabilities` set silently.
   * Returns `true` when the event was actually dispatched.
   */
  send(event: ChannelEvent): Promise<boolean>

  /**
   * Inbound: register a handler for events arriving from the channel.
   * The channel calls every registered handler with each inbound event.
   * Channels with no inbound surface (e.g. one-way webhooks) may ignore.
   */
  onMessage(handler: ChannelEventHandler): void
}
