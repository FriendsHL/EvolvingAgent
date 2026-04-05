import { describe, it, expect } from 'vitest'
import { ShortTermMemory } from './short-term.js'

describe('ShortTermMemory', () => {
  it('starts empty', () => {
    const mem = new ShortTermMemory()
    expect(mem.length).toBe(0)
    expect(mem.getHistory()).toEqual([])
  })

  it('adds and retrieves messages', () => {
    const mem = new ShortTermMemory()
    mem.add('user', 'hello')
    mem.add('assistant', 'hi there')

    expect(mem.length).toBe(2)
    const history = mem.getHistory()
    expect(history).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ])
  })

  it('getMessages includes timestamps', () => {
    const mem = new ShortTermMemory()
    mem.add('user', 'test')

    const messages = mem.getMessages()
    expect(messages[0].timestamp).toBeDefined()
    expect(messages[0].role).toBe('user')
    expect(messages[0].content).toBe('test')
  })

  it('clear empties all messages', () => {
    const mem = new ShortTermMemory()
    mem.add('user', 'a')
    mem.add('assistant', 'b')
    mem.clear()

    expect(mem.length).toBe(0)
    expect(mem.getHistory()).toEqual([])
  })

  it('getMessages returns a copy', () => {
    const mem = new ShortTermMemory()
    mem.add('user', 'original')

    const msgs = mem.getMessages()
    msgs.push({ role: 'assistant', content: 'injected', timestamp: '' })

    // Original should be unaffected
    expect(mem.length).toBe(1)
  })
})
