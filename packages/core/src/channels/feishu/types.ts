/**
 * Feishu Channel — Phase 4 A.
 *
 * Wraps Feishu (Lark) bot integration as a Channel implementation. Phase 4
 * A1 ships the pure pieces (signature verification, message parsing, dedup,
 * SDK client wrapper, channel skeleton). A2 wires the Hono webhook route,
 * A3 maps inbound messages to SessionManager sessions and dispatches Agent
 * replies, A4 ships docs.
 *
 * Reference: openclaw `extensions/feishu/` (we cherry-pick patterns but use
 * a much smaller surface — single account, in-memory dedup, no streaming).
 */

/** Credentials needed to talk to one Feishu app. */
export interface FeishuCredentials {
  /** App ID from Feishu developer console. */
  appId: string
  /** App Secret. Used to fetch tenant_access_token. */
  appSecret: string
  /** Verification token (HTTP webhook URL verification handshake). */
  verificationToken: string
  /**
   * Encrypt key for inbound webhook payload AES decryption + signature
   * computation. Optional — when omitted, the bot is configured for
   * unencrypted callbacks (Feishu still sends a signature header).
   */
  encryptKey?: string
}

/** Configuration for the FeishuChannel constructor. */
export interface FeishuChannelOptions {
  /** Stable channel id, default `'feishu'`. */
  id?: string
  /** Display name for dashboards/logs. */
  name?: string
  credentials: FeishuCredentials
  /**
   * Whether bot must be @-mentioned in group chats to respond. Default true.
   * P2P chats always respond regardless.
   */
  requireMentionInGroup?: boolean
  /**
   * In-memory dedup TTL in milliseconds. Default 5 * 60 * 1000.
   */
  dedupTtlMs?: number
}

/** Normalized inbound message after parsing the raw Feishu webhook payload. */
export interface FeishuInboundMessage {
  /** Feishu's stable message id (use this as the dedup key). */
  messageId: string
  /** open_id of the sender. */
  senderId: string
  /** chat_id of the conversation. */
  chatId: string
  /** Whether this is a 1:1 chat or a group chat. */
  chatType: 'p2p' | 'group'
  /** Plain text content (mentions stripped). */
  text: string
  /** Whether the bot was @-mentioned in the message. */
  mentionedBot: boolean
  /** Tenant key (used by SDK calls). */
  tenantKey?: string
  /** Receiver of the original event (the bot's open_id), if surfaced. */
  botOpenId?: string
}

/** Headers Feishu sends with each webhook POST. Stripped to what we use. */
export interface FeishuWebhookHeaders {
  timestamp?: string
  nonce?: string
  signature?: string
}

/** Result of verifying an inbound webhook payload. */
export type FeishuVerifyResult =
  | { ok: true }
  | { ok: false; reason: string }
