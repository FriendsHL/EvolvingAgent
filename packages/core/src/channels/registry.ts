// ============================================================
// ChannelRegistry
// ============================================================
//
// Fan-out hub for channels. Application code (SessionManager, hooks, the
// Agent itself) talks to the registry; concrete Channel implementations
// register themselves at startup.
//
// Responsibilities:
//  - Register / unregister channels by id.
//  - Broadcast outbound events to every channel whose `capabilities` set
//    contains the event type. Errors from one channel MUST NOT prevent
//    delivery to the others (`Promise.allSettled` + internal logging).
//  - Aggregate inbound events from every channel into a shared handler list,
//    wiring both directions automatically — including retroactively when a
//    handler is added after channels are already registered, and vice
//    versa.
//
// This file is Phase 3 Batch 5 scaffolding. No concrete Channel ships yet.

import type { Channel } from './channel.js'
import type { ChannelEvent, ChannelEventHandler } from './types.js'

export class ChannelRegistry {
  private channels = new Map<string, Channel>()
  private inboundHandlers: ChannelEventHandler[] = []

  /**
   * Register a channel. Idempotent on `id` — re-registering the same id
   * replaces the previous entry (after stopping is the caller's
   * responsibility; we just swap the reference).
   *
   * Newly registered channels are automatically wired to every
   * inbound handler already installed via `onInbound`.
   */
  register(channel: Channel): void {
    this.channels.set(channel.id, channel)
    // Retroactively wire all existing inbound handlers to this channel.
    for (const handler of this.inboundHandlers) {
      channel.onMessage(handler)
    }
  }

  /** Remove a channel by id; calls its `stop()` first. */
  async unregister(id: string): Promise<void> {
    const channel = this.channels.get(id)
    if (!channel) return
    this.channels.delete(id)
    try {
      await channel.stop()
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[channel-registry] stop() failed for '${id}':`, err)
    }
  }

  /** Look up a channel by id. */
  get(id: string): Channel | undefined {
    return this.channels.get(id)
  }

  /** All registered channels (snapshot). */
  list(): Channel[] {
    return [...this.channels.values()]
  }

  /**
   * Broadcast an event to every channel whose capabilities include
   * `event.type`. Returns the number of channels that accepted the event.
   * Used by hooks (e.g. cache-health-alert) and the Agent itself.
   *
   * This method never throws: per-channel failures are caught, logged,
   * and counted as "not accepted".
   */
  async broadcast(event: ChannelEvent): Promise<number> {
    const targets = [...this.channels.values()].filter(ch =>
      ch.capabilities.has(event.type),
    )
    if (targets.length === 0) return 0

    const results = await Promise.allSettled(
      targets.map(ch => ch.send(event)),
    )

    let delivered = 0
    results.forEach((r, i) => {
      const ch = targets[i]!
      if (r.status === 'fulfilled') {
        if (r.value) delivered++
      } else {
        // eslint-disable-next-line no-console
        console.error(
          `[channel-registry] send() failed for '${ch.id}' on '${event.type}':`,
          r.reason,
        )
      }
    })
    return delivered
  }

  /**
   * Subscribe to inbound events from any channel. The registry forwards
   * each channel's `onMessage` callback through these handlers. Use this
   * to wire user messages from Feishu/Slack into the Agent.
   *
   * Handlers added after channels are already registered are retroactively
   * wired into every existing channel, so call order doesn't matter.
   */
  onInbound(handler: ChannelEventHandler): void {
    this.inboundHandlers.push(handler)
    // Retroactively wire into all already-registered channels.
    for (const channel of this.channels.values()) {
      channel.onMessage(handler)
    }
  }

  /** Start every registered channel in parallel. Errors are logged, not thrown. */
  async startAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.channels.values()].map(ch => ch.start()),
    )
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        const ch = [...this.channels.values()][i]!
        // eslint-disable-next-line no-console
        console.error(`[channel-registry] start() failed for '${ch.id}':`, r.reason)
      }
    })
  }

  /** Stop every registered channel in parallel. Errors are logged, not thrown. */
  async stopAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.channels.values()].map(ch => ch.stop()),
    )
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        const ch = [...this.channels.values()][i]!
        // eslint-disable-next-line no-console
        console.error(`[channel-registry] stop() failed for '${ch.id}':`, r.reason)
      }
    })
  }
}
