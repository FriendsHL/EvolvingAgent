/**
 * Thin wrapper around `@larksuiteoapi/node-sdk`'s Client.
 *
 * Why a wrapper at all: the SDK is a sprawling surface (200+ namespaces).
 * We want a small, named API that the rest of the codebase depends on, so
 * if we ever swap the SDK or stub it in tests we only have to change one
 * file. Token caching, retries, and tenant_access_token refresh are all
 * handled inside the SDK Client — we deliberately do NOT reimplement them.
 *
 * Reference: openclaw `extensions/feishu/bot.ts` does the same kind of
 * narrowing but adds streaming card primitives we don't yet need.
 */

import { Client } from '@larksuiteoapi/node-sdk'

import type { FeishuCredentials } from './types.js'

/** Plain text message content payload (Feishu's `text` message_type). */
export interface FeishuTextContent {
  text: string
}

/** Construct the JSON content string Feishu expects for a text message. */
export function buildTextContent(text: string): string {
  return JSON.stringify({ text } satisfies FeishuTextContent)
}

/**
 * Create an SDK Client. Defaults to the Feishu (cn) domain. Callers can
 * override via the `domain` field on credentials in the future.
 */
export function createFeishuClient(creds: FeishuCredentials): Client {
  return new Client({
    appId: creds.appId,
    appSecret: creds.appSecret,
    // disableTokenCache=false (default) → SDK keeps tenant_access_token
    // cached and refreshes ~30s before expiry. Single-operator bots can
    // rely on this safely; no need to layer our own cache.
  })
}

/**
 * Reply to an inbound message. Threading semantics: Feishu replies show up
 * as a quoted child of the original in group chats. In p2p chats it's just
 * a normal new message.
 */
export async function replyText(
  client: Client,
  args: { messageId: string; text: string },
): Promise<void> {
  await client.im.message.reply({
    path: { message_id: args.messageId },
    data: {
      content: buildTextContent(args.text),
      msg_type: 'text',
    },
  })
}

/**
 * Send a fresh message (not a reply). Used for proactive notifications —
 * e.g. system alerts the Agent surfaces independently of any user prompt.
 */
export async function sendText(
  client: Client,
  args: {
    receiveId: string
    receiveIdType: 'open_id' | 'chat_id' | 'user_id' | 'union_id' | 'email'
    text: string
  },
): Promise<void> {
  await client.im.message.create({
    params: { receive_id_type: args.receiveIdType },
    data: {
      receive_id: args.receiveId,
      content: buildTextContent(args.text),
      msg_type: 'text',
    },
  })
}
