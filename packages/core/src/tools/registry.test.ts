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

  it('unregister removes a tool and returns true', () => {
    const registry = new ToolRegistry()
    registry.register(echoTool)
    expect(registry.unregister('echo')).toBe(true)
    expect(registry.get('echo')).toBeUndefined()
    expect(registry.list()).toHaveLength(0)
  })

  it('unregister returns false for unknown tool', () => {
    const registry = new ToolRegistry()
    expect(registry.unregister('nonexistent')).toBe(false)
  })

  it('derive returns a filtered snapshot', () => {
    const registry = new ToolRegistry()
    registry.register(echoTool)
    registry.register(failTool)

    const child = registry.derive((t) => t.name === 'echo')
    expect(child.list().map((t) => t.name)).toEqual(['echo'])
    expect(child.get('fail')).toBeUndefined()
  })

  it('derive snapshot is isolated from later parent mutations', () => {
    const registry = new ToolRegistry()
    registry.register(echoTool)

    const child = registry.derive(() => true)
    registry.register(failTool)
    registry.unregister('echo')

    // Child kept its snapshot from before the mutations.
    expect(child.list().map((t) => t.name)).toEqual(['echo'])
  })

  it('derive supports scope-based filtering', () => {
    const registry = new ToolRegistry()
    const mainOnly: Tool = {
      name: 'main-only',
      description: '',
      parameters: {},
      scope: 'main',
      execute: async () => ({ success: true, output: '' }),
    }
    const subOnly: Tool = {
      name: 'sub-only',
      description: '',
      parameters: {},
      scope: 'sub',
      execute: async () => ({ success: true, output: '' }),
    }
    const both: Tool = {
      name: 'both',
      description: '',
      parameters: {},
      scope: 'both',
      execute: async () => ({ success: true, output: '' }),
    }
    registry.register(mainOnly)
    registry.register(subOnly)
    registry.register(both)

    const subView = registry.derive((t) => t.scope !== 'main')
    expect(subView.list().map((t) => t.name).sort()).toEqual(['both', 'sub-only'])
  })
})
