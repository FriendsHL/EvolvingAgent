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

  describe('rolling summary', () => {
    it('starts with no summary', () => {
      const mem = new ShortTermMemory()
      expect(mem.getSummary()).toBeUndefined()
    })

    it('setSummary / getSummary round-trip', () => {
      const mem = new ShortTermMemory()
      mem.setSummary('User is building a React app.')
      expect(mem.getSummary()).toBe('User is building a React app.')
    })

    it('setSummary with blank string clears the summary', () => {
      const mem = new ShortTermMemory()
      mem.setSummary('something')
      mem.setSummary('   ')
      expect(mem.getSummary()).toBeUndefined()
    })

    it('getEffectiveMessages returns raw messages when no summary is set', () => {
      const mem = new ShortTermMemory()
      mem.add('user', 'hello')
      mem.add('assistant', 'hi')
      expect(mem.getEffectiveMessages()).toEqual(mem.getMessages())
    })

    it('getEffectiveMessages prepends a synthetic summary turn when summary is set', () => {
      const mem = new ShortTermMemory()
      mem.add('user', 'latest question')
      mem.setSummary('Earlier: user wants a todo app.')

      const effective = mem.getEffectiveMessages()
      expect(effective).toHaveLength(2)
      expect(effective[0].role).toBe('user')
      expect(effective[0].content).toContain('Previous conversation summary')
      expect(effective[0].content).toContain('todo app')
      expect(effective[1].content).toBe('latest question')
    })

    it('getEffectiveHistory returns role+content form with summary prepended', () => {
      const mem = new ShortTermMemory()
      mem.add('user', 'q1')
      mem.setSummary('prior context')

      const history = mem.getEffectiveHistory()
      expect(history).toHaveLength(2)
      expect(history[0]).toEqual({
        role: 'user',
        content: 'Previous conversation summary: prior context',
      })
      expect(history[1]).toEqual({ role: 'user', content: 'q1' })
    })

    it('replaceMessages swaps the retained tail', () => {
      const mem = new ShortTermMemory()
      mem.add('user', 'a')
      mem.add('assistant', 'b')
      mem.add('user', 'c')

      const tail = mem.getMessages().slice(-1)
      mem.replaceMessages(tail)
      expect(mem.length).toBe(1)
      expect(mem.getHistory()).toEqual([{ role: 'user', content: 'c' }])
    })

    it('clear also drops the summary', () => {
      const mem = new ShortTermMemory()
      mem.add('user', 'x')
      mem.setSummary('something')
      mem.clear()
      expect(mem.getSummary()).toBeUndefined()
      expect(mem.length).toBe(0)
    })
  })
})
