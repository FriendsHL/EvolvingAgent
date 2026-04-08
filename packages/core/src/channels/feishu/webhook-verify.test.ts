import { describe, it, expect } from 'vitest'
import { createHash, createCipheriv, randomBytes } from 'node:crypto'

import { verifyFeishuSignature, decryptFeishuPayload } from './webhook-verify.js'

function makeSignature(args: {
  timestamp: string
  nonce: string
  encryptKey: string
  body: string
}): string {
  return createHash('sha256')
    .update(args.timestamp + args.nonce + args.encryptKey + args.body)
    .digest('hex')
}

describe('verifyFeishuSignature', () => {
  const encryptKey = 'test-encrypt-key'
  const rawBody = '{"type":"event_callback"}'
  const timestamp = '1700000000'
  const nonce = 'abc123'
  const goodSig = makeSignature({ timestamp, nonce, encryptKey, body: rawBody })

  it('accepts a correctly signed payload', () => {
    const result = verifyFeishuSignature({
      encryptKey,
      rawBody,
      headers: { timestamp, nonce, signature: goodSig },
    })
    expect(result.ok).toBe(true)
  })

  it('rejects a missing signature header', () => {
    const result = verifyFeishuSignature({
      encryptKey,
      rawBody,
      headers: { timestamp, nonce },
    })
    expect(result).toEqual({ ok: false, reason: 'missing signature headers' })
  })

  it('rejects a missing timestamp header', () => {
    const result = verifyFeishuSignature({
      encryptKey,
      rawBody,
      headers: { nonce, signature: goodSig },
    })
    expect(result.ok).toBe(false)
  })

  it('rejects a tampered body', () => {
    const result = verifyFeishuSignature({
      encryptKey,
      rawBody: rawBody + ' ',
      headers: { timestamp, nonce, signature: goodSig },
    })
    expect(result).toEqual({ ok: false, reason: 'signature mismatch' })
  })

  it('rejects a wrong-length signature', () => {
    const result = verifyFeishuSignature({
      encryptKey,
      rawBody,
      headers: { timestamp, nonce, signature: 'short' },
    })
    expect(result).toEqual({ ok: false, reason: 'signature length mismatch' })
  })

  it('rejects when encryptKey differs', () => {
    const result = verifyFeishuSignature({
      encryptKey: 'different-key',
      rawBody,
      headers: { timestamp, nonce, signature: goodSig },
    })
    expect(result.ok).toBe(false)
  })
})

describe('decryptFeishuPayload', () => {
  const encryptKey = 'test-encrypt-key'

  function encryptForTest(plaintext: string): string {
    const key = createHash('sha256').update(encryptKey).digest()
    const iv = randomBytes(16)
    const cipher = createCipheriv('aes-256-cbc', key, iv)
    const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
    return Buffer.concat([iv, ct]).toString('base64')
  }

  it('round-trips a JSON payload', () => {
    const payload = { type: 'event_callback', token: 'tok' }
    const encrypted = encryptForTest(JSON.stringify(payload))
    const decrypted = decryptFeishuPayload({ encryptKey, encrypted })
    expect(decrypted).toEqual(payload)
  })

  it('throws on too-short ciphertext', () => {
    expect(() =>
      decryptFeishuPayload({ encryptKey, encrypted: Buffer.from('short').toString('base64') }),
    ).toThrow(/too short/)
  })

  it('throws on wrong key', () => {
    const payload = { x: 1 }
    const encrypted = encryptForTest(JSON.stringify(payload))
    expect(() =>
      decryptFeishuPayload({ encryptKey: 'wrong-key', encrypted }),
    ).toThrow()
  })
})
