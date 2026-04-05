import { describe, it, expect, beforeEach } from 'vitest'
import { CapabilityMap } from './capability-map.js'
import type { ToolDefinition, ExecutableSkill } from '../types.js'

function makeTool(name: string): ToolDefinition {
  return { name, description: `Tool: ${name}`, parameters: {} }
}

function makeSkill(id: string, triggers: string[] = []): ExecutableSkill {
  return {
    id,
    name: id,
    description: `Skill: ${id}`,
    category: 'learned',
    triggers,
    inputs: [],
    available: true,
    execute: async () => ({ success: true, output: 'ok' }),
  }
}

describe('CapabilityMap', () => {
  let capMap: CapabilityMap

  beforeEach(() => {
    capMap = new CapabilityMap()
  })

  it('initBuiltinCapabilities creates default capabilities', () => {
    const caps = capMap.list()
    expect(caps.length).toBeGreaterThan(0)
    // All start at confidence 0 before refresh
    for (const cap of caps) {
      expect(cap.confidence).toBe(0)
    }
  })

  it('refresh() sets confidence=1.0 when tools are available', () => {
    capMap.refresh(
      [makeTool('shell')],
      [],
    )
    const shellCap = capMap.list().find((c) => c.name === 'shell-execution')
    expect(shellCap).toBeDefined()
    expect(shellCap!.confidence).toBe(1.0)
  })

  it('refresh() sets confidence=0 when tools are missing', () => {
    capMap.refresh([], [])
    const shellCap = capMap.list().find((c) => c.name === 'shell-execution')
    expect(shellCap).toBeDefined()
    expect(shellCap!.confidence).toBe(0)
  })

  it('assess() marks task as feasible when capabilities match', () => {
    // Provide all tools so every matching capability has confidence > 0
    capMap.refresh(
      [makeTool('shell'), makeTool('file_read'), makeTool('file_write'), makeTool('browser'), makeTool('http')],
      [makeSkill('web-search'), makeSkill('data-extract'), makeSkill('code-analysis'), makeSkill('github'), makeSkill('schedule'), makeSkill('file-batch'), makeSkill('summarize-url')],
    )
    const result = capMap.assess('terminal bash')
    expect(result.feasible).toBe(true)
    expect(result.matchedCapabilities).toContain('shell-execution')
  })

  it('assess() marks task as infeasible when capabilities are missing', () => {
    capMap.refresh([], []) // No tools available
    const result = capMap.assess('发邮件')
    expect(result.feasible).toBe(false)
    expect(result.missingCapabilities.length).toBeGreaterThan(0)
  })

  it('assess() handles Chinese keywords', () => {
    capMap.refresh([], []) // No tools
    const result = capMap.assess('发邮件')
    expect(result.feasible).toBe(false)
    expect(result.missingCapabilities).toContain('email')
  })

  it('assess() returns generic feasible for conversational tasks', () => {
    capMap.refresh([], [])
    // Use a phrase that does not match any capability keyword
    const result = capMap.assess('hello')
    expect(result.feasible).toBe(true)
    expect(result.confidence).toBe(0.5)
    expect(result.matchedCapabilities).toHaveLength(0)
    expect(result.missingCapabilities).toHaveLength(0)
  })

  it('describeForPlanner() includes available/unavailable sections', () => {
    capMap.refresh([makeTool('shell'), makeTool('file_read'), makeTool('file_write')], [])
    const desc = capMap.describeForPlanner()
    expect(desc).toContain('Available:')
    expect(desc).toContain('Not available:')
    expect(desc).toContain('Run shell/terminal commands')
  })

  it('list() returns all capabilities', () => {
    const caps = capMap.list()
    expect(Array.isArray(caps)).toBe(true)
    expect(caps.length).toBeGreaterThan(5)
    // Each capability has the expected shape
    for (const cap of caps) {
      expect(cap).toHaveProperty('name')
      expect(cap).toHaveProperty('confidence')
      expect(cap).toHaveProperty('keywords')
    }
  })
})
