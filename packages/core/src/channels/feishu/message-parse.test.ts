import { describe, it, expect } from 'vitest'

import { parseFeishuMessageEvent, buildFeishuConversationId } from './message-parse.js'

const BOT_OPEN_ID = 'ou_bot_self'

function makePayload(overrides: {
  text?: string
  chatType?: 'p2p' | 'group' | 'private'
  messageType?: string
  eventType?: string
  mentionedBot?: boolean
  senderOpenId?: string
  messageId?: string
  chatId?: string
}): unknown {
  const text = overrides.text ?? 'hello'
  return {
    schema: '2.0',
    header: {
      event_id: 'evt_1',
      event_type: overrides.eventType ?? 'im.message.receive_v1',
      tenant_key: 'tenant_xxx',
    },
    event: {
      sender: { sender_id: { open_id: overrides.senderOpenId ?? 'ou_user_a' } },
      message: {
        message_id: overrides.messageId ?? 'om_msg_1',
        chat_id: overrides.chatId ?? 'oc_chat_1',
        chat_type: overrides.chatType ?? 'p2p',
        message_type: overrides.messageType ?? 'text',
        content: JSON.stringify({ text }),
        mentions: overrides.mentionedBot
          ? [{ key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: 'Bot' }]
          : [],
      },
    },
  }
}

describe('parseFeishuMessageEvent', () => {
  it('parses a p2p text message', () => {
    const out = parseFeishuMessageEvent(makePayload({ text: 'hi there' }), { botOpenId: BOT_OPEN_ID })
    expect(out).not.toBeNull()
    expect(out!.text).toBe('hi there')
    expect(out!.chatType).toBe('p2p')
    expect(out!.senderId).toBe('ou_user_a')
    expect(out!.mentionedBot).toBe(false)
    expect(out!.tenantKey).toBe('tenant_xxx')
  })

  it('parses a group text message and detects bot mention', () => {
    const out = parseFeishuMessageEvent(
      makePayload({ chatType: 'group', mentionedBot: true, text: '@_user_1 hello' }),
      { botOpenId: BOT_OPEN_ID },
    )
    expect(out).not.toBeNull()
    expect(out!.chatType).toBe('group')
    expect(out!.mentionedBot).toBe(true)
    // mention marker stripped
    expect(out!.text).toBe('hello')
  })

  it('strips multiple mention markers', () => {
    const payload = makePayload({ text: '@_user_1 @_user_2 do the thing' })
    const out = parseFeishuMessageEvent(payload, { botOpenId: BOT_OPEN_ID })
    expect(out!.text).toBe('do the thing')
  })

  it('treats "private" chat_type as p2p', () => {
    const out = parseFeishuMessageEvent(makePayload({ chatType: 'private' }), { botOpenId: BOT_OPEN_ID })
    expect(out!.chatType).toBe('p2p')
  })

  it('returns null for non-message events', () => {
    expect(
      parseFeishuMessageEvent(makePayload({ eventType: 'im.message.read_v1' }), { botOpenId: BOT_OPEN_ID }),
    ).toBeNull()
  })

  it('returns null for non-text message types', () => {
    expect(
      parseFeishuMessageEvent(makePayload({ messageType: 'image' }), { botOpenId: BOT_OPEN_ID }),
    ).toBeNull()
  })

  it('returns null when content is malformed JSON', () => {
    const payload = makePayload({}) as Record<string, unknown>
    ;((payload.event as Record<string, unknown>).message as Record<string, unknown>).content = '{not json'
    expect(parseFeishuMessageEvent(payload)).toBeNull()
  })

  it('returns null when sender open_id is missing', () => {
    const payload = makePayload({}) as Record<string, unknown>
    ;((payload.event as Record<string, unknown>).sender as Record<string, unknown>).sender_id = {}
    expect(parseFeishuMessageEvent(payload)).toBeNull()
  })

  it('returns null on completely malformed input', () => {
    expect(parseFeishuMessageEvent(null)).toBeNull()
    expect(parseFeishuMessageEvent('not an object')).toBeNull()
    expect(parseFeishuMessageEvent({})).toBeNull()
  })

  it('mentionedBot stays false when no botOpenId provided', () => {
    const out = parseFeishuMessageEvent(makePayload({ mentionedBot: true }))
    expect(out!.mentionedBot).toBe(false)
  })
})

describe('buildFeishuConversationId', () => {
  it('uses sender open_id for p2p', () => {
    const id = buildFeishuConversationId({
      messageId: 'om_1',
      senderId: 'ou_alice',
      chatId: 'oc_p2p',
      chatType: 'p2p',
      text: 'hi',
      mentionedBot: false,
    })
    expect(id).toBe('feishu:p2p:ou_alice')
  })

  it('uses chat id for group', () => {
    const id = buildFeishuConversationId({
      messageId: 'om_1',
      senderId: 'ou_alice',
      chatId: 'oc_group',
      chatType: 'group',
      text: 'hi',
      mentionedBot: true,
    })
    expect(id).toBe('feishu:group:oc_group')
  })
})
