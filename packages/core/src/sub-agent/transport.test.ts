import { describe, it, expect } from 'vitest'
import { createInProcessTransportPair } from './transport.js'
import type { SubAgentMessage, TaskAssign, TaskResult } from './protocol.js'

function flushMicrotasks() {
  return new Promise<void>((resolve) => queueMicrotask(resolve))
}

describe('InProcessTransport', () => {
  it('delivers messages from main → sub via paired endpoints', async () => {
    const { mainSide, subSide } = createInProcessTransportPair()
    const received: SubAgentMessage[] = []
    subSide.onMessage((m) => received.push(m))

    const assign: TaskAssign = {
      type: 'task:assign',
      taskId: 't1',
      parentTaskId: 'p1',
      description: 'do thing',
      context: { background: '', constraints: [], relatedExperiences: [], relevantSkills: [] },
      config: { model: 'm', tokenBudget: 100, timeout: 1000, tools: [], canRequestMore: false },
    }
    await mainSide.send(assign)
    await flushMicrotasks()
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(assign)
  })

  it('delivers messages from sub → main', async () => {
    const { mainSide, subSide } = createInProcessTransportPair()
    const received: SubAgentMessage[] = []
    mainSide.onMessage((m) => received.push(m))

    const result: TaskResult = {
      type: 'task:result',
      taskId: 't1',
      outcome: 'success',
      result: { answer: 'ok', artifacts: [], toolCalls: [] },
      metadata: { tokensUsed: 10, duration: 5, stepsTotal: 0, model: 'm' },
    }
    await subSide.send(result)
    await flushMicrotasks()
    expect(received[0]).toEqual(result)
  })

  it('send is asynchronous (microtask scheduled)', async () => {
    const { mainSide, subSide } = createInProcessTransportPair()
    let delivered = false
    subSide.onMessage(() => {
      delivered = true
    })
    void mainSide.send({ type: 'task:cancel', taskId: 't1', reason: 'test' })
    // Synchronously after send: not yet delivered
    expect(delivered).toBe(false)
    await flushMicrotasks()
    expect(delivered).toBe(true)
  })

  it('multiple handlers each receive the message', async () => {
    const { mainSide, subSide } = createInProcessTransportPair()
    const a: SubAgentMessage[] = []
    const b: SubAgentMessage[] = []
    subSide.onMessage((m) => a.push(m))
    subSide.onMessage((m) => b.push(m))
    await mainSide.send({ type: 'task:cancel', taskId: 't1', reason: 'r' })
    await flushMicrotasks()
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })

  it('handler exceptions do not break delivery to siblings', async () => {
    const { mainSide, subSide } = createInProcessTransportPair()
    const reached: number[] = []
    subSide.onMessage(() => {
      throw new Error('boom')
    })
    subSide.onMessage(() => {
      reached.push(2)
    })
    await mainSide.send({ type: 'task:cancel', taskId: 't1', reason: 'r' })
    await flushMicrotasks()
    expect(reached).toEqual([2])
  })

  it('close() makes subsequent sends no-ops', async () => {
    const { mainSide, subSide } = createInProcessTransportPair()
    const received: SubAgentMessage[] = []
    subSide.onMessage((m) => received.push(m))
    await mainSide.close()
    await mainSide.send({ type: 'task:cancel', taskId: 't1', reason: 'r' })
    await flushMicrotasks()
    expect(received).toHaveLength(0)
  })
})
