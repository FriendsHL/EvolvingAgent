import type { Tool, ToolResult } from '../types.js'

export class ToolRegistry {
  private tools = new Map<string, Tool>()

  register(tool: Tool): void {
    this.tools.set(tool.name, tool)
  }

  /** Remove a tool by name. Returns true if it existed. */
  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  list(): Tool[] {
    return [...this.tools.values()]
  }

  /**
   * Build a NEW registry containing only the tools matching `filter`.
   * The returned registry is a snapshot — later mutations to the parent
   * (register/unregister) do NOT propagate. Tool instances themselves are
   * shared by reference, so execute() still routes through the same handler.
   */
  derive(filter: (tool: Tool) => boolean): ToolRegistry {
    const child = new ToolRegistry()
    for (const tool of this.tools.values()) {
      if (filter(tool)) child.register(tool)
    }
    return child
  }

  async execute(name: string, params: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return { success: false, output: '', error: `Tool not found: ${name}` }
    }
    try {
      return await tool.execute(params)
    } catch (err) {
      return { success: false, output: '', error: String(err) }
    }
  }
}

export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry()

  // Lazy import to avoid circular deps — tools are registered at startup
  return registry
}
