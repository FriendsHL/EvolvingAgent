// ============================================================
// SubAgentTransport — abstraction over the Main↔Sub channel
// ============================================================
//
// Today we ship `InProcessTransport`: paired endpoints that hand JSON
// messages back and forth via microtask scheduling. Tomorrow we may add
// `ChildProcessTransport` (JSON-line over fork stdio) or
// `WorkerThreadTransport` (postMessage). Sub-agent business logic only
// touches this interface, so the swap is transparent.

import type { SubAgentMessage } from './protocol.js'

export type SubAgentMessageHandler = (msg: SubAgentMessage) => void

export interface SubAgentTransport {
  /** Send a message to the peer endpoint. Resolves once the message has been queued for delivery. */
  send(msg: SubAgentMessage): Promise<void>
  /** Subscribe to inbound messages. Multiple handlers are supported. */
  onMessage(handler: SubAgentMessageHandler): void
  /** Tear down the transport; subsequent sends become no-ops. */
  close(): Promise<void>
}

// ------------------------------------------------------------
// InProcessTransport
// ------------------------------------------------------------

/**
 * One end of an in-process transport pair. Holds its own list of inbound
 * handlers and a reference to the peer's list. `send()` schedules delivery
 * onto the microtask queue so that callers always observe asynchronous
 * semantics — this matches what a real IPC transport would look like and
 * keeps tests deterministic.
 */
export class InProcessTransport implements SubAgentTransport {
  private handlers: SubAgentMessageHandler[] = []
  private peerHandlers: SubAgentMessageHandler[] | null = null
  private closed = false

  /** Wire this endpoint to its peer. Called by the factory. */
  _bind(peerHandlers: SubAgentMessageHandler[]): void {
    this.peerHandlers = peerHandlers
  }

  /** Internal: the list of handlers other endpoints deliver into. */
  _getHandlers(): SubAgentMessageHandler[] {
    return this.handlers
  }

  async send(msg: SubAgentMessage): Promise<void> {
    if (this.closed) return
    const targets = this.peerHandlers
    if (!targets || targets.length === 0) return
    // Snapshot to insulate delivery from concurrent subscribe/unsubscribe.
    const snapshot = [...targets]
    queueMicrotask(() => {
      for (const h of snapshot) {
        try {
          h(msg)
        } catch {
          // Handler errors must not break the transport. Sub-agent code
          // catches its own errors at the manager boundary; if a handler
          // throws here we silently drop it rather than poisoning delivery
          // to other handlers.
        }
      }
    })
  }

  onMessage(handler: SubAgentMessageHandler): void {
    if (this.closed) return
    this.handlers.push(handler)
  }

  async close(): Promise<void> {
    this.closed = true
    this.handlers = []
    this.peerHandlers = null
  }
}

/**
 * Create a paired in-process transport. The two endpoints' inbound queues
 * are cross-wired so a `send()` on one delivers into the other's handlers.
 */
export function createInProcessTransportPair(): {
  mainSide: InProcessTransport
  subSide: InProcessTransport
} {
  const mainSide = new InProcessTransport()
  const subSide = new InProcessTransport()
  mainSide._bind(subSide._getHandlers())
  subSide._bind(mainSide._getHandlers())
  return { mainSide, subSide }
}
