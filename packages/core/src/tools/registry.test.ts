import { describe, it, expect } from 'vitest'
import { ToolRegistry } from './registry.js'
import type { Tool } from '../types.js'

const echoTool: Tool = {
  name: 'echo',
  description: 'Echo input',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  execute: async (params) => ({ success: true, output: params.text as string }),
}

const failTool: Tool = {
  name: 'fail',
  description: 'Always fails',
  parameters: {},
  execute: async () => { throw new Error('intentional failure') },
}

describe('ToolRegistry', () => {
  it('registers and retrieves a tool', () => {
    const registry = new ToolRegistry()
    registry.register(echoTool)

    expect(registry.get('echo')).toBe(echoTool)
  })

  it('returns undefined for unregistered tool', () => {
    const registry = new ToolRegistry()
    expect(registry.get('nonexistent')).toBeUndefined()
  })

  it('lists all registered tools', () => {
    const registry = new ToolRegistry()
    registry.register(echoTool)
    registry.register(failTool)

    const list = registry.list()
    expect(list).toHaveLength(2)
    expect(list.map((t) => t.name)).toContain('echo')
    expect(list.map((t) => t.name)).toContain('fail')
  })

  it('executes a tool and returns result', async () => {
    const registry = new ToolRegistry()
    registry.register(echoTool)

    const result = await registry.execute('echo', { text: 'hello' })
    expect(result.success).toBe(true)
    expect(result.output).toBe('hello')
  })

  it('returns error for nonexistent tool', async () => {
    const registry = new ToolRegistry()
    const result = await registry.execute('missing', {})
    expect(result.success).toBe(false)
    expect(result.error).toContain('Tool not found')
  })

  it('catches tool execution errors', async () => {
    const registry = new ToolRegistry()
    registry.register(failTool)

    const result = await registry.execute('fail', {})
    expect(result.success).toBe(false)
    expect(result.error).toContain('intentional failure')
  })
})
