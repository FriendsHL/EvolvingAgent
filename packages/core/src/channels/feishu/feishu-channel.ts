/**
 * FeishuChannel — Phase 4 A.
 *
 * Implements the `Channel` interface for Feishu (Lark) bots. The channel is
 * deliberately "fed" by the Hono webhook route (A2) rather than running its
 * own HTTP listener; that keeps deployment surface to a single port and
 * lets us share the existing TLS / auth middleware on the web server.
 *
 * Lifecycle:
 *   start() / stop()  → no-ops (the SDK Client is created eagerly in
 *                        the constructor and has no persistent connection)
 *   send(event)        → outbound: AgentMessageEvent → Feishu reply
 *   onMessage(handler) → inbound: webhook route calls handleInboundPayload,
 *                        which fans out to registered handlers
 *
 * Inbound flow (driven from the webhook route):
 *   raw body + headers
 *     → verifyFeishuSignature      (drop on bad sig)
 *     → decryptFeishuPayload?      (only if encryptKey is set)
 *     → URL-verification challenge (handled by route, not us)
 *     → parseFeishuMessageEvent    (drop unknown event shapes)
 *     → mention gating             (group requires @bot if configured)
 *     → FeishuDedup.checkAndMark   (drop retransmits)
 *     → emit UserMessageEvent to handlers
 *
 * What lives elsewhere:
 *   - Mapping conversationId → SessionManager session: A3
 *   - Markdown→Card auto-conversion: A3
 *   - URL challenge response: A2 (route layer)
 */

import type { Client } from '@larksuiteoapi/node-sdk'

import type {
  AgentMessageEvent,
  Channel,
  ChannelEvent,
  ChannelEventHandler,
  ChannelEventType,
  UserMessageEvent,
} from '../index.js'

import { FeishuDedup } from './dedup.js'
import { createFeishuClient, replyText, sendText } from './feishu-client.js'
import { buildFeishuConversationId, parseFeishuMessageEvent } from './message-parse.js'
import type {
  FeishuChannelOptions,
  FeishuCredentials,
  FeishuInboundMessage,
  FeishuWebhookHeaders,
} from './types.js'
import { decryptFeishuPayload, verifyFeishuSignature } from './webhook-verify.js'

/**
 * Outcome of `handleInboundPayload` — exposed so the webhook route can log
 * a structured summary and return appropriate HTTP status codes.
 */
export type FeishuInboundOutcome =
  | { kind: 'challenge'; challenge: string }
  | { kind: 'ignored'; reason: string }
  | { kind: 'dispatched'; conversationId: string; message: FeishuInboundMessage }
  | { kind: 'error'; reason: string }

export class FeishuChannel implements Channel {
  readonly id: string
  readonly name: string
  readonly capabilities: ReadonlySet<ChannelEventType> = new Set<ChannelEventType>([
    'agent.message',
    'system.notice',
    'alert.cache-health',
    'alert.budget',
  ])

  private readonly creds: FeishuCredentials
  private readonly client: Client
  private readonly dedup: FeishuDedup
  private readonly handlers: ChannelEventHandler[] = []
  private readonly requireMentionInGroup: boolean
  /** Resolved bot open_id for mention detection. Set externally if known. */
  private botOpenId: string | undefined

  constructor(opts: FeishuChannelOptions) {
    this.id = opts.id ?? 'feishu'
    this.name = opts.name ?? 'Feishu'
    this.creds = opts.credentials
    this.requireMentionInGroup = opts.requireMentionInGroup ?? true
    this.dedup = new FeishuDedup(opts.dedupTtlMs)
    this.client = createFeishuClient(this.creds)
  }

  /**
   * Optionally configure the bot's own open_id so mention detection works.
   * The route layer can call this once after fetching the bot info, or it
   * can be supplied via env. Without it, `mentionedBot` is always false and
   * group chats fall back to text-only heuristics.
   */
  setBotOpenId(openId: string): void {
    this.botOpenId = openId
  }

  async start(): Promise<void> {
    // Webhook is hosted by the web server (A2). Nothing to do here.
  }

  async stop(): Promise<void> {
    this.dedup.clear()
  }

  /**
   * Outbound event dispatch. Currently only `agent.message` is mapped to a
   * Feishu reply. Other capabilities are accepted but converted to plain
   * text — A3/A4 may upgrade to interactive cards.
   *
   * Routing: `event.target.threadId` is interpreted as the inbound message
   * id to reply to. If absent, falls back to `target.userId` (open_id) and
   * sends a fresh message instead of a reply.
   */
  async send(event: ChannelEvent): Promise<boolean> {
    if (!this.capabilities.has(event.type)) return false

    const text = this.eventToText(event)
    if (!text) return false

    const replyToMessageId = event.target?.threadId
    if (replyToMessageId) {
      await replyText(this.client, { messageId: replyToMessageId, text })
      return true
    }

    const openId = event.target?.userId
    if (openId) {
      await sendText(this.client, {
        receiveId: openId,
        receiveIdType: 'open_id',
        text,
      })
      return true
    }

    // No routing target — drop silently. Channel cannot guess where to send.
    return false
  }

  onMessage(handler: ChannelEventHandler): void {
    this.handlers.push(handler)
  }

  /**
   * Public entry point used by the Hono webhook route (A2).
   *
   * Verifies signature → handles URL challenge → decrypts (if applicable)
   * → parses → dedupes → fans out to handlers. Never throws — all errors
   * are returned as a structured outcome the route can convert to HTTP.
   */
  async handleInboundPayload(args: {
    rawBody: string
    headers: FeishuWebhookHeaders
  }): Promise<FeishuInboundOutcome> {
    // 1. Signature verification (only if encryptKey is configured — Feishu
    //    callbacks without encryption omit the signature pipeline entirely).
    if (this.creds.encryptKey) {
      const verified = verifyFeishuSignature({
        encryptKey: this.creds.encryptKey,
        rawBody: args.rawBody,
        headers: args.headers,
      })
      if (!verified.ok) return { kind: 'error', reason: verified.reason }
    }

    // 2. Parse the body as JSON. May be encrypted (`{encrypt:'...'}`) or
    //    plaintext (the event envelope directly).
    let payload: unknown
    try {
      const outer = JSON.parse(args.rawBody) as Record<string, unknown>
      if (typeof outer.encrypt === 'string') {
        if (!this.creds.encryptKey) {
          return { kind: 'error', reason: 'encrypted payload but no encryptKey configured' }
        }
        payload = decryptFeishuPayload({
          encryptKey: this.creds.encryptKey,
          encrypted: outer.encrypt,
        })
      } else {
        payload = outer
      }
    } catch (err) {
      return { kind: 'error', reason: `payload parse failed: ${(err as Error).message}` }
    }

    // 3. URL-verification handshake (one-time setup ping from Feishu).
    if (
      payload &&
      typeof payload === 'object' &&
      (payload as Record<string, unknown>).type === 'url_verification'
    ) {
      const challenge = (payload as Record<string, unknown>).challenge
      if (typeof challenge === 'string') {
        return { kind: 'challenge', challenge }
      }
      return { kind: 'error', reason: 'url_verification missing challenge' }
    }

    // 4. Parse as a message event.
    const parsed = parseFeishuMessageEvent(payload, { botOpenId: this.botOpenId })
    if (!parsed) return { kind: 'ignored', reason: 'not a text message event' }

    // 5. Mention gating for group chats.
    if (parsed.chatType === 'group' && this.requireMentionInGroup && !parsed.mentionedBot) {
      return { kind: 'ignored', reason: 'group message without bot mention' }
    }

    // 6. Dedup retransmits.
    if (this.dedup.checkAndMark(parsed.messageId)) {
      return { kind: 'ignored', reason: 'duplicate message id' }
    }

    // 7. Fan out to handlers as a UserMessageEvent. The session-mapping
    //    layer (A3) is what actually drives the Agent.
    const conversationId = buildFeishuConversationId(parsed)
    const event: UserMessageEvent = {
      type: 'user.message',
      ts: Date.now(),
      text: parsed.text,
      channelId: this.id,
      target: {
        sessionId: conversationId,
        userId: parsed.senderId,
        threadId: parsed.messageId,
      },
    }

    for (const h of this.handlers) {
      try {
        await h(event)
      } catch {
        // Handler errors must not stop other handlers or fail the webhook.
      }
    }

    return { kind: 'dispatched', conversationId, message: parsed }
  }

  /** Flatten any supported channel event into a plain-text body. */
  private eventToText(event: ChannelEvent): string | null {
    switch (event.type) {
      case 'agent.message':
        return (event as AgentMessageEvent).text
      case 'system.notice':
        return event.text
      case 'alert.cache-health':
        return `[cache-health] hit ratio ${(event.hitRatio * 100).toFixed(1)}% < ${(event.threshold * 100).toFixed(0)}% (${event.reason})`
      case 'alert.budget':
        return `[budget] ${event.layer} at ${(event.ratio * 100).toFixed(0)}% — ${event.reason}`
      default:
        return null
    }
  }
}
