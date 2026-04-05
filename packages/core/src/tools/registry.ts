import type { Tool, ToolResult } from '../types.js'

export class ToolRegistry {
  private tools = new Map<string, Tool>()

  register(tool: Tool): void {
    this.tools.set(tool.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  list(): Tool[] {
    return [...this.tools.values()]
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
