/**
 * Parse a raw Feishu webhook event payload into a normalized
 * `FeishuInboundMessage`. Pure function — no side effects, no SDK calls.
 *
 * Feishu's event envelope (v2) looks like:
 *
 *   {
 *     "schema": "2.0",
 *     "header": {
 *       "event_id": "...",
 *       "event_type": "im.message.receive_v1",
 *       "tenant_key": "..."
 *     },
 *     "event": {
 *       "sender": { "sender_id": { "open_id": "..." }, "tenant_key": "..." },
 *       "message": {
 *         "message_id": "om_xxx",
 *         "chat_id": "oc_xxx",
 *         "chat_type": "p2p" | "group",
 *         "message_type": "text" | "post" | ...,
 *         "content": "{\"text\":\"@_user_1 hello\"}",
 *         "mentions": [{ "key": "@_user_1", "id": { "open_id": "ou_bot" }, "name": "Bot" }]
 *       }
 *     }
 *   }
 *
 * We only handle `im.message.receive_v1` + `message_type: 'text'` in A1.
 * Other event types return null and are silently dropped at the route layer.
 *
 * Reference: openclaw `bot.ts:parseFeishuMessageEvent` lines 143-187 +
 * `bot-content.ts:parseMessageContent` lines 127-150.
 */

import type { FeishuInboundMessage } from './types.js'

export interface ParseOptions {
  /** Bot's own open_id, used to detect @-mentions targeted at the bot. */
  botOpenId?: string
}

/**
 * Returns null when the payload is not an `im.message.receive_v1` text
 * event we know how to handle. Returns the parsed message otherwise.
 *
 * Never throws — all unknown shapes degrade to null.
 */
export function parseFeishuMessageEvent(
  payload: unknown,
  opts: ParseOptions = {},
): FeishuInboundMessage | null {
  if (!payload || typeof payload !== 'object') return null
  const root = payload as Record<string, unknown>

  const header = root.header as Record<string, unknown> | undefined
  if (!header) return null
  if (header.event_type !== 'im.message.receive_v1') return null

  const event = root.event as Record<string, unknown> | undefined
  if (!event) return null

  const sender = event.sender as Record<string, unknown> | undefined
  const message = event.message as Record<string, unknown> | undefined
  if (!sender || !message) return null

  if (message.message_type !== 'text') return null

  const senderIdField = sender.sender_id as Record<string, unknown> | undefined
  const senderOpenId = typeof senderIdField?.open_id === 'string' ? senderIdField.open_id : ''
  if (!senderOpenId) return null

  const messageId = typeof message.message_id === 'string' ? message.message_id : ''
  const chatId = typeof message.chat_id === 'string' ? message.chat_id : ''
  const chatTypeRaw = message.chat_type
  if (!messageId || !chatId) return null

  const chatType: 'p2p' | 'group' =
    chatTypeRaw === 'p2p' || chatTypeRaw === 'private' ? 'p2p' : 'group'

  // Parse content JSON to get plain text.
  let text = ''
  if (typeof message.content === 'string') {
    try {
      const parsed = JSON.parse(message.content) as { text?: unknown }
      if (typeof parsed.text === 'string') text = parsed.text
    } catch {
      // Malformed content — drop the message.
      return null
    }
  }

  // Detect bot mention by scanning the mentions array for our open_id.
  let mentionedBot = false
  const mentions = message.mentions
  if (Array.isArray(mentions) && opts.botOpenId) {
    for (const m of mentions) {
      if (!m || typeof m !== 'object') continue
      const id = (m as Record<string, unknown>).id as Record<string, unknown> | undefined
      if (id && id.open_id === opts.botOpenId) {
        mentionedBot = true
        break
      }
    }
  }

  // Strip bot mention markers from the text so commands like "@bot /help"
  // become "/help". Feishu uses tokens like "@_user_1" for each mention; we
  // can't perfectly map without scanning the mentions array, but a simple
  // strip-and-trim covers the common case.
  text = text
    .replace(/@_user_\d+/g, ' ')
    .replace(/@_all/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return {
    messageId,
    senderId: senderOpenId,
    chatId,
    chatType,
    text,
    mentionedBot,
    tenantKey: typeof header.tenant_key === 'string' ? header.tenant_key : undefined,
    botOpenId: opts.botOpenId,
  }
}

/**
 * Build a stable conversation id from a parsed inbound message.
 *
 * Scheme:
 *   p2p:    `feishu:p2p:<senderOpenId>`
 *   group:  `feishu:group:<chatId>`
 *
 * P2P uses the sender open_id (not the chat id) so the same user always
 * lands on the same session even if Feishu rotates p2p chat ids.
 * Group uses chat id so all members of a group share one session.
 *
 * Phase 5 may add `:sender:<openId>` or `:thread:<threadId>` suffixes,
 * matching openclaw's `conversation-id.ts` scheme.
 */
export function buildFeishuConversationId(msg: FeishuInboundMessage): string {
  if (msg.chatType === 'p2p') return `feishu:p2p:${msg.senderId}`
  return `feishu:group:${msg.chatId}`
}
