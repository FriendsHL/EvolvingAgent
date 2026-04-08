/**
 * Feishu inbound handler — Phase 4 / A3.
 *
 * Wires `UserMessageEvent`s coming in from FeishuChannel to:
 *   1. SessionManager.getOrLoad(conversationId)  (auto-create if missing)
 *   2. session.sendMessage(text)                 (full Agent run)
 *   3. channel.send({type:'agent.message', target, text}) (reply)
 *
 * Background-execution model:
 *   The Feishu webhook has a 3-second ack budget. A full Agent turn easily
 *   blows past that, so this handler launches the agent run in the
 *   background (`void process()`) and returns immediately. Deduplication
 *   (FeishuChannel.dedup) means a Feishu retry while we're still processing
 *   the original will be silently dropped — at most once per messageId.
 *
 * Error surfacing:
 *   On agent failure we still try to reply with a short error message so
 *   the user isn't left hanging. If even that reply fails, we log loudly
 *   but do not throw — handler exceptions are eaten by the channel layer
 *   and would otherwise be invisible.
 */

import type {
  FeishuChannel,
  SessionManager,
  UserMessageEvent,
} from '@evolving-agent/core'

export function createFeishuHandler(args: {
  channel: FeishuChannel
  sessionManager: SessionManager
}) {
  const { channel, sessionManager } = args

  return async function handleFeishuMessage(event: {
    type: string
  }): Promise<void> {
    if (event.type !== 'user.message') return
    const ev = event as UserMessageEvent
    if (ev.channelId !== channel.id) return

    // Fire-and-forget the heavy work so the webhook acks within Feishu's
    // 3s budget. The promise is intentionally not awaited.
    void process(ev).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[feishu handler] background processing failed:', err)
    })
  }

  async function process(ev: UserMessageEvent): Promise<void> {
    const sessionId = ev.target?.sessionId
    if (!sessionId) {
      // eslint-disable-next-line no-console
      console.warn('[feishu handler] missing target.sessionId, dropping event')
      return
    }

    // Empty messages happen when a user just @-mentions the bot with no
    // body. Reply with a brief usage hint instead of running the agent.
    const text = ev.text.trim()
    if (!text) {
      await safeReply(ev, '收到 ✅ 但是没看到具体问题,请在 @ 之后写下你想问的内容~')
      return
    }

    let session = await sessionManager.getOrLoad(sessionId)
    if (!session) {
      session = await sessionManager.create({
        id: sessionId,
        title: `Feishu ${sessionId}`,
      })
    }

    let response: string
    try {
      response = await session.sendMessage(text)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // eslint-disable-next-line no-console
      console.error(`[feishu handler] agent run failed for ${sessionId}:`, err)
      await safeReply(ev, `处理失败: ${msg.slice(0, 200)}`)
      return
    }

    // Persist conversation state — same hook chat.ts uses on 'done'.
    try {
      await sessionManager.persistSession(session)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[feishu handler] persistSession failed:', err)
    }

    await safeReply(ev, response || '(no response)')
  }

  async function safeReply(ev: UserMessageEvent, text: string): Promise<void> {
    try {
      await channel.send({
        type: 'agent.message',
        text,
        ts: Date.now(),
        target: ev.target,
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[feishu handler] reply failed:', err)
    }
  }
}
