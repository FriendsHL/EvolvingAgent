import { nanoid } from 'nanoid'

// ============================================================
// Multi-Agent Message Bus
// ============================================================

export type MessageType = 'task-request' | 'task-result' | 'info-query' | 'info-reply' | 'broadcast'

export interface InterAgentMessage {
  id: string
  from: string // Agent ID
  to: string | '*' // Agent ID or '*' for broadcast
  type: MessageType
  payload: unknown
  correlationId?: string // Links request/response pairs
  timestamp: string
}

export type InterAgentMessageHandler = (message: InterAgentMessage) => Promise<void>

export class MessageBus {
  private handlers = new Map<string, InterAgentMessageHandler[]>()
  private messageLog: InterAgentMessage[] = []

  /** Register a handler for messages to a specific agent */
  subscribe(agentId: string, handler: InterAgentMessageHandler): void {
    const existing = this.handlers.get(agentId) ?? []
    existing.push(handler)
    this.handlers.set(agentId, existing)
  }

  /** Unsubscribe all handlers for an agent */
  unsubscribe(agentId: string): void {
    this.handlers.delete(agentId)
  }

  /** Send a message (point-to-point or broadcast). Returns the generated message id. */
  async send(message: Omit<InterAgentMessage, 'id' | 'timestamp'>): Promise<string> {
    const full: InterAgentMessage = {
      ...message,
      id: nanoid(),
      timestamp: new Date().toISOString(),
    }
    this.messageLog.push(full)

    if (full.to === '*') {
      // Broadcast: deliver to all handlers except the sender
      const dispatches: Promise<void>[] = []
      for (const [agentId, handlers] of this.handlers) {
        if (agentId === full.from) continue
        for (const handler of handlers) {
          dispatches.push(handler(full))
        }
      }
      await Promise.all(dispatches)
    } else {
      // Point-to-point
      const handlers = this.handlers.get(full.to)
      if (handlers) {
        await Promise.all(handlers.map((h) => h(full)))
      }
    }

    return full.id
  }

  /**
   * Send a message and wait for a correlated response.
   * Creates a correlationId, sends the message, then resolves when
   * a response with matching correlationId arrives (or rejects on timeout).
   */
  async sendAndWait(
    message: Omit<InterAgentMessage, 'id' | 'timestamp' | 'correlationId'>,
    timeoutMs = 30_000,
  ): Promise<InterAgentMessage> {
    const correlationId = nanoid()

    return new Promise<InterAgentMessage>((resolve, reject) => {
      let settled = false

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          // Clean up the temporary handler
          this.removeCorrelationHandler(message.from, handler)
          reject(new Error(`sendAndWait timed out after ${timeoutMs}ms (correlationId=${correlationId})`))
        }
      }, timeoutMs)

      const handler: InterAgentMessageHandler = async (incoming) => {
        if (incoming.correlationId === correlationId && !settled) {
          settled = true
          clearTimeout(timer)
          this.removeCorrelationHandler(message.from, handler)
          resolve(incoming)
        }
      }

      // Listen on the sender's channel for the correlated reply
      this.subscribe(message.from, handler)

      // Send the message with the correlationId
      this.send({ ...message, correlationId }).catch((err) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          this.removeCorrelationHandler(message.from, handler)
          reject(err)
        }
      })
    })
  }

  /** Get message history with optional filtering */
  getLog(filter?: { agentId?: string; type?: MessageType }): InterAgentMessage[] {
    if (!filter) return [...this.messageLog]

    return this.messageLog.filter((msg) => {
      if (filter.agentId && msg.from !== filter.agentId && msg.to !== filter.agentId) {
        return false
      }
      if (filter.type && msg.type !== filter.type) {
        return false
      }
      return true
    })
  }

  /** Remove a specific handler from an agent's handler list */
  private removeCorrelationHandler(agentId: string, handler: InterAgentMessageHandler): void {
    const handlers = this.handlers.get(agentId)
    if (!handlers) return
    const idx = handlers.indexOf(handler)
    if (idx !== -1) {
      handlers.splice(idx, 1)
    }
  }
}
