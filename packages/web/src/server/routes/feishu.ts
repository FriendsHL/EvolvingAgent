/**
 * Feishu webhook route — Phase 4 / A2.
 *
 * Mounted at `/api/channels/feishu` (see server/index.ts).
 *
 *   POST /api/channels/feishu/webhook  — inbound event from Feishu
 *   GET  /api/channels/feishu/status   — basic introspection
 *
 * Webhook flow:
 *   1. Read RAW body (NOT c.req.json — signature is over the literal bytes)
 *   2. Pull X-Lark-Request-Timestamp / -Nonce / -Signature headers
 *   3. Hand the (rawBody, headers) tuple to FeishuChannel.handleInboundPayload
 *   4. Map the structured outcome → HTTP response:
 *        challenge   → 200 { challenge }     (URL verification handshake)
 *        dispatched  → 200 { ok: true }
 *        ignored     → 200 { ok: true }      (Feishu only inspects status)
 *        error       → 400 { error, reason }
 *
 * Why ignored maps to 200 instead of 4xx: Feishu retries non-2xx responses,
 * so returning 4xx for "this group message had no @bot mention" would loop
 * forever. Errors that are 4xx are reserved for things we want Feishu to
 * stop retrying (bad signature, decryption failure) — those are real bugs
 * the operator must fix in the Feishu console.
 */

import { Hono } from 'hono'
import type { FeishuChannel } from '@evolving-agent/core'

export function feishuRoutes(args: { channel: FeishuChannel | null }): Hono {
  const app = new Hono()
  const { channel } = args

  app.get('/status', (c) => {
    if (!channel) {
      return c.json({
        enabled: false,
        reason: 'Feishu channel not configured (missing FEISHU_APP_ID/FEISHU_APP_SECRET in secrets.json)',
      })
    }
    return c.json({
      enabled: true,
      id: channel.id,
      name: channel.name,
      capabilities: [...channel.capabilities],
    })
  })

  app.post('/webhook', async (c) => {
    if (!channel) {
      return c.json({ error: 'feishu channel not configured' }, 503)
    }

    // Raw body — must NOT use c.req.json() because the signature is over
    // the exact byte stream Feishu sent.
    const rawBody = await c.req.text()

    const headers = {
      timestamp: c.req.header('X-Lark-Request-Timestamp'),
      nonce: c.req.header('X-Lark-Request-Nonce'),
      signature: c.req.header('X-Lark-Signature'),
    }

    const outcome = await channel.handleInboundPayload({ rawBody, headers })

    switch (outcome.kind) {
      case 'challenge':
        return c.json({ challenge: outcome.challenge })
      case 'dispatched':
        return c.json({ ok: true, conversationId: outcome.conversationId })
      case 'ignored':
        // 200 so Feishu doesn't retry. We surface the reason for debugging
        // via response body even though Feishu ignores it.
        return c.json({ ok: true, ignored: outcome.reason })
      case 'error':
        // eslint-disable-next-line no-console
        console.error('[feishu webhook] error:', outcome.reason)
        return c.json({ error: 'webhook rejected', reason: outcome.reason }, 400)
    }
  })

  return app
}
