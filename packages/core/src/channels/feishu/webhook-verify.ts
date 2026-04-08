/**
 * Feishu webhook signature verification + AES payload decryption.
 *
 * Two security layers:
 *
 * 1. **Signature** — Feishu sends `X-Lark-Signature: sha256(timestamp +
 *    nonce + encryptKey + rawBody)`. We recompute and compare in
 *    constant time. The signature is mandatory whenever an encryptKey is
 *    configured; without an encryptKey we accept the verificationToken
 *    challenge handshake but no live message events (because there's
 *    no way to authenticate them).
 *
 * 2. **Encryption** — When encryptKey is configured, the body is an
 *    `{ encrypt: <base64> }` envelope. We AES-256-CBC decrypt with
 *    `key = sha256(encryptKey)` and `iv = first 16 bytes of ciphertext`,
 *    matching the SDK's reference implementation.
 *
 * Both functions are pure: same input → same output, no side effects.
 * They are unit-tested in `webhook-verify.test.ts`.
 *
 * Reference: openclaw `monitor.transport.ts` lines 54-79.
 */

import { createHash, createDecipheriv, timingSafeEqual } from 'node:crypto'

import type { FeishuVerifyResult, FeishuWebhookHeaders } from './types.js'

/**
 * Verify the `X-Lark-Signature` header against `(timestamp + nonce +
 * encryptKey + rawBody)`. Returns `{ ok: true }` on success, or
 * `{ ok: false, reason }` describing the failure mode.
 *
 * Designed to be called BEFORE JSON parsing — pass the raw request body
 * as a string so the hash matches Feishu's exactly.
 */
export function verifyFeishuSignature(args: {
  encryptKey: string
  rawBody: string
  headers: FeishuWebhookHeaders
}): FeishuVerifyResult {
  const { encryptKey, rawBody, headers } = args
  const timestamp = headers.timestamp
  const nonce = headers.nonce
  const signature = headers.signature

  if (!timestamp || !nonce || !signature) {
    return { ok: false, reason: 'missing signature headers' }
  }

  const expected = createHash('sha256')
    .update(timestamp + nonce + encryptKey + rawBody)
    .digest('hex')

  // Constant-time compare. timingSafeEqual requires equal-length buffers.
  const a = Buffer.from(expected, 'utf-8')
  const b = Buffer.from(signature, 'utf-8')
  if (a.length !== b.length) {
    return { ok: false, reason: 'signature length mismatch' }
  }
  if (!timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature mismatch' }
  }
  return { ok: true }
}

/**
 * Decrypt a Feishu webhook payload that was sent with `Encrypt Key`
 * configured. Returns the decoded JSON object.
 *
 * Throws on bad input — we want a hard 400 in the route layer when this
 * happens, not a silent skip.
 */
export function decryptFeishuPayload(args: {
  encryptKey: string
  encrypted: string
}): unknown {
  const { encryptKey, encrypted } = args

  // Key = sha256(encryptKey) raw bytes (32 bytes for AES-256).
  const key = createHash('sha256').update(encryptKey).digest()

  // Ciphertext = first 16 bytes IV + remainder.
  const cipherBuf = Buffer.from(encrypted, 'base64')
  if (cipherBuf.length < 32) {
    throw new Error('encrypted payload too short')
  }
  const iv = cipherBuf.subarray(0, 16)
  const body = cipherBuf.subarray(16)

  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  const decrypted = Buffer.concat([decipher.update(body), decipher.final()])
  const text = decrypted.toString('utf-8')
  return JSON.parse(text)
}
