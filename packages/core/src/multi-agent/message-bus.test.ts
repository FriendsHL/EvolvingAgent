import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MessageBus } from './message-bus.js'

describe('MessageBus', () => {
  let bus: MessageBus

  beforeEach(() => {
    bus = new MessageBus()
  })

  it('subscribe() + send() delivers messages to correct handler', async () => {
    const handler = vi.fn().mockResolvedValue(undefined)
    bus.subscribe('agent-b', handler)

    await bus.send({ from: 'agent-a', to: 'agent-b', type: 'task-request', payload: 'hello' })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'agent-a',
        to: 'agent-b',
        type: 'task-request',
        payload: 'hello',
      }),
    )
  })

  it("broadcast (to: '*') delivers to all except sender", async () => {
    const handlerA = vi.fn().mockResolvedValue(undefined)
    const handlerB = vi.fn().mockResolvedValue(undefined)
    const handlerC = vi.fn().mockResolvedValue(undefined)

    bus.subscribe('agent-a', handlerA) // sender
    bus.subscribe('agent-b', handlerB)
    bus.subscribe('agent-c', handlerC)

    await bus.send({ from: 'agent-a', to: '*', type: 'broadcast', payload: 'hi all' })

    expect(handlerA).not.toHaveBeenCalled()
    expect(handlerB).toHaveBeenCalledTimes(1)
    expect(handlerC).toHaveBeenCalledTimes(1)
  })

  it('sendAndWait() resolves when correlated response arrives', async () => {
    // Set up agent-b to reply with a correlated response
    bus.subscribe('agent-b', async (msg) => {
      await bus.send({
        from: 'agent-b',
        to: msg.from,
        type: 'task-result',
        payload: 'done',
        correlationId: msg.correlationId,
      })
    })

    const reply = await bus.sendAndWait(
      { from: 'agent-a', to: 'agent-b', type: 'task-request', payload: 'do something' },
      5000,
    )

    expect(reply.from).toBe('agent-b')
    expect(reply.payload).toBe('done')
  })

  it('sendAndWait() rejects on timeout', async () => {
    // No handler registered to reply
    await expect(
      bus.sendAndWait(
        { from: 'agent-a', to: 'agent-b', type: 'task-request', payload: 'waiting...' },
        50,
      ),
    ).rejects.toThrow('timed out')
  })

  it('getLog() returns all messages', async () => {
    await bus.send({ from: 'a', to: 'b', type: 'info-query', payload: '1' })
    await bus.send({ from: 'b', to: 'a', type: 'info-reply', payload: '2' })

    const log = bus.getLog()
    expect(log).toHaveLength(2)
  })

  it('getLog() filters by agentId', async () => {
    await bus.send({ from: 'a', to: 'b', type: 'info-query', payload: '1' })
    await bus.send({ from: 'c', to: 'd', type: 'info-query', payload: '2' })

    const log = bus.getLog({ agentId: 'a' })
    expect(log).toHaveLength(1)
    expect(log[0].from).toBe('a')
  })

  it('getLog() filters by type', async () => {
    await bus.send({ from: 'a', to: 'b', type: 'task-request', payload: '1' })
    await bus.send({ from: 'a', to: 'b', type: 'info-query', payload: '2' })

    const log = bus.getLog({ type: 'info-query' })
    expect(log).toHaveLength(1)
    expect(log[0].type).toBe('info-query')
  })

  it('unsubscribe() removes handlers', async () => {
    const handler = vi.fn().mockResolvedValue(undefined)
    bus.subscribe('agent-b', handler)
    bus.unsubscribe('agent-b')

    await bus.send({ from: 'a', to: 'agent-b', type: 'task-request', payload: 'hello' })
    expect(handler).not.toHaveBeenCalled()
  })
})
