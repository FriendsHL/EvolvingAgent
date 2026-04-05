import type { ExecutableSkill, SkillDraft } from '../types.js'

export interface ValidationResult {
  valid: boolean
  issues: string[]
}

const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/
const MAX_STEPS = 10

/**
 * Validate a compiled skill before it is registered.
 * Catches structural issues, missing metadata, and references to
 * tools that are not available in the current runtime.
 */
export class SkillValidator {
  constructor(private availableTools: string[]) {}

  validate(skill: ExecutableSkill, source: SkillDraft): ValidationResult {
    const issues: string[] = []

    // 1. Name and description must be non-empty
    if (!skill.name || skill.name.trim().length === 0) {
      issues.push('Skill name is empty')
    }
    if (!skill.description || skill.description.trim().length === 0) {
      issues.push('Skill description is empty')
    }

    // 2. At least one trigger
    if (!skill.triggers || skill.triggers.length === 0) {
      issues.push('Skill must have at least one trigger')
    }

    // 3. Source draft step count: 1..MAX_STEPS
    if (!source.steps || source.steps.length === 0) {
      issues.push('Skill draft has no steps')
    } else if (source.steps.length > MAX_STEPS) {
      issues.push(`Skill draft has ${source.steps.length} steps (max ${MAX_STEPS})`)
    }

    // 4. Skill id must be valid kebab-case
    if (!ID_PATTERN.test(skill.id)) {
      issues.push(`Skill id "${skill.id}" is invalid (must be lowercase alphanumeric + hyphens)`)
    }

    // 5. Referenced tools must exist in the available tools list
    for (const step of source.steps) {
      const referencedTool = this.extractToolName(step)
      if (referencedTool && !this.availableTools.includes(referencedTool)) {
        issues.push(`Step references unknown tool "${referencedTool}": ${step}`)
      }
    }

    // 6. No duplicate input parameter names
    const paramNames = new Set<string>()
    for (const input of skill.inputs) {
      if (paramNames.has(input.name)) {
        issues.push(`Duplicate input parameter name: "${input.name}"`)
      }
      paramNames.add(input.name)
    }

    return { valid: issues.length === 0, issues }
  }

  /**
   * Extract a tool name from a step description string.
   * Uses the same heuristic as the compiler: look for known tool name patterns.
   */
  private extractToolName(step: string): string | undefined {
    const lower = step.toLowerCase()
    const knownTools = ['shell', 'file_read', 'file_write', 'http', 'browser']
    for (const tool of knownTools) {
      const pattern = new RegExp(`\\b${tool.replace('_', '[_ ]')}\\b`, 'i')
      if (pattern.test(lower)) return tool
    }
    return undefined
  }
}
