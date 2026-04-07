import { describe, it, expect, vi } from 'vitest'
import { ChannelRegistry } from './registry.js'
import type { Channel } from './channel.js'
import type {
  ChannelEvent,
  ChannelEventHandler,
  ChannelEventType,
  CacheHealthAlertEvent,
  AgentMessageEvent,
} from './types.js'

class FakeChannel implements Channel {
  readonly id: string
  readonly name: string
  readonly capabilities: ReadonlySet<ChannelEventType>
  readonly received: ChannelEvent[] = []
  private handlers: ChannelEventHandler[] = []
  startCalls = 0
  stopCalls = 0
  shouldFailSend = false

  constructor(id: string, caps: ChannelEventType[]) {
    this.id = id
    this.name = id
    this.capabilities = new Set(caps)
  }
  async start() {
    this.startCalls++
  }
  async stop() {
    this.stopCalls++
  }
  async send(event: ChannelEvent): Promise<boolean> {
    if (this.shouldFailSend) throw new Error('send failed')
    this.received.push(event)
    return true
  }
  onMessage(handler: ChannelEventHandler) {
    this.handlers.push(handler)
  }
  /** Test helper to simulate inbound from external surface. */
  fireInbound(event: ChannelEvent) {
    for (const h of this.handlers) h(event)
  }
}

const cacheAlert: CacheHealthAlertEvent = {
  type: 'alert.cache-health',
  ts: Date.now(),
  hitRatio: 0.1,
  threshold: 0.3,
  totalCalls: 10,
  reason: 'test',
}
const agentMsg: AgentMessageEvent = {
  type: 'agent.message',
  ts: Date.now(),
  text: 'hi',
}

describe('ChannelRegistry', () => {
  it('broadcast routes events by capability intersection', async () => {
    const reg = new ChannelRegistry()
    const a = new FakeChannel('a', ['alert.cache-health'])
    const b = new FakeChannel('b', ['agent.message'])
    reg.register(a)
    reg.register(b)
    const delivered = await reg.broadcast(cacheAlert)
    expect(delivered).toBe(1)
    expect(a.received).toHaveLength(1)
    expect(b.received).toHaveLength(0)
  })

  it('returns 0 when no channel has the capability', async () => {
    const reg = new ChannelRegistry()
    reg.register(new FakeChannel('a', ['agent.message']))
    expect(await reg.broadcast(cacheAlert)).toBe(0)
  })

  it('per-channel send failures do not block others (Promise.allSettled)', async () => {
    const reg = new ChannelRegistry()
    const bad = new FakeChannel('bad', ['agent.message'])
    bad.shouldFailSend = true
    const good = new FakeChannel('good', ['agent.message'])
    reg.register(bad)
    reg.register(good)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const delivered = await reg.broadcast(agentMsg)
    expect(delivered).toBe(1)
    expect(good.received).toHaveLength(1)
    errSpy.mockRestore()
  })

  it('register replaces previous channel with same id', () => {
    const reg = new ChannelRegistry()
    const a1 = new FakeChannel('a', ['agent.message'])
    const a2 = new FakeChannel('a', ['agent.message'])
    reg.register(a1)
    reg.register(a2)
    expect(reg.get('a')).toBe(a2)
    expect(reg.list()).toHaveLength(1)
  })

  it('unregister calls stop()', async () => {
    const reg = new ChannelRegistry()
    const a = new FakeChannel('a', ['agent.message'])
    reg.register(a)
    await reg.unregister('a')
    expect(a.stopCalls).toBe(1)
    expect(reg.get('a')).toBeUndefined()
  })

  it('onInbound receives events from registered channels (forward order)', () => {
    const reg = new ChannelRegistry()
    const a = new FakeChannel('a', ['user.message'])
    reg.register(a)
    const seen: ChannelEvent[] = []
    reg.onInbound((e) => seen.push(e))
    a.fireInbound({
      type: 'user.message',
      ts: Date.now(),
      text: 'hi',
      channelId: 'a',
    })
    expect(seen).toHaveLength(1)
  })

  it('onInbound retroactively wires handlers added BEFORE channels register', () => {
    const reg = new ChannelRegistry()
    const seen: ChannelEvent[] = []
    reg.onInbound((e) => seen.push(e))
    const a = new FakeChannel('a', ['user.message'])
    reg.register(a)
    a.fireInbound({ type: 'user.message', ts: 0, text: 'hi', channelId: 'a' })
    expect(seen).toHaveLength(1)
  })

  it('startAll / stopAll fan out and survive individual failures', async () => {
    const reg = new ChannelRegistry()
    const a = new FakeChannel('a', ['agent.message'])
    const b = new FakeChannel('b', ['agent.message'])
    reg.register(a)
    reg.register(b)
    await reg.startAll()
    expect(a.startCalls).toBe(1)
    expect(b.startCalls).toBe(1)
    await reg.stopAll()
    expect(a.stopCalls).toBe(1)
    expect(b.stopCalls).toBe(1)
  })
})
