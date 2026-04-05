import { describe, it, expect } from 'vitest'
import { SkillValidator } from './skill-validator.js'
import { SkillCompiler } from './skill-compiler.js'
import type { ExecutableSkill, SkillDraft } from '../types.js'

const AVAILABLE_TOOLS = ['shell', 'file_read', 'file_write', 'http']

function makeDraft(overrides?: Partial<SkillDraft>): SkillDraft {
  return {
    name: 'Test Skill',
    trigger: 'test, check',
    steps: ['Use shell tool to run "echo hello"'],
    ...overrides,
  }
}

function compileSkill(draft: SkillDraft) {
  const compiler = new SkillCompiler()
  return compiler.compile(draft)
}

describe('SkillValidator', () => {
  const validator = new SkillValidator(AVAILABLE_TOOLS)

  it('valid skill passes validation', () => {
    const draft = makeDraft()
    const { skill } = compileSkill(draft)
    const result = validator.validate(skill, draft)
    expect(result.valid).toBe(true)
    expect(result.issues).toHaveLength(0)
  })

  it('empty name fails validation', () => {
    const draft = makeDraft({ name: '' })
    const { skill } = compileSkill(draft)
    // Force empty name on the compiled skill
    skill.name = ''
    const result = validator.validate(skill, draft)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.includes('name'))).toBe(true)
  })

  it('empty description fails validation', () => {
    const draft = makeDraft()
    const { skill } = compileSkill(draft)
    skill.description = ''
    const result = validator.validate(skill, draft)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.includes('description'))).toBe(true)
  })

  it('no triggers fails validation', () => {
    const draft = makeDraft()
    const { skill } = compileSkill(draft)
    skill.triggers = []
    const result = validator.validate(skill, draft)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.includes('trigger'))).toBe(true)
  })

  it('too many steps (>10) fails validation', () => {
    const steps = Array.from({ length: 12 }, (_, i) => `Step ${i + 1}`)
    const draft = makeDraft({ steps })
    const { skill } = compileSkill(draft)
    const result = validator.validate(skill, draft)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.includes('12 steps'))).toBe(true)
  })

  it('invalid skill id fails validation', () => {
    const draft = makeDraft()
    const { skill } = compileSkill(draft)
    skill.id = 'INVALID ID!'
    const result = validator.validate(skill, draft)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.includes('invalid'))).toBe(true)
  })

  it('references to non-existent tools are flagged', () => {
    const draft = makeDraft({ steps: ['Use browser tool to open page'] })
    // browser is NOT in AVAILABLE_TOOLS
    const { skill } = compileSkill(draft)
    const result = validator.validate(skill, draft)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.includes('browser'))).toBe(true)
  })

  it('duplicate input parameter names are flagged', () => {
    const draft = makeDraft()
    const { skill } = compileSkill(draft)
    // Manually add duplicate params
    skill.inputs = [
      { name: 'path', description: 'first', type: 'string', required: true },
      { name: 'path', description: 'second', type: 'string', required: true },
    ]
    const result = validator.validate(skill, draft)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.includes('Duplicate'))).toBe(true)
  })

  it('returns correct issue messages', () => {
    const draft = makeDraft({ name: '', steps: [] })
    const { skill } = compileSkill(draft)
    skill.name = ''
    const result = validator.validate(skill, draft)
    expect(result.valid).toBe(false)
    expect(result.issues.length).toBeGreaterThan(0)
    // Each issue should be a non-empty string
    for (const issue of result.issues) {
      expect(typeof issue).toBe('string')
      expect(issue.length).toBeGreaterThan(0)
    }
  })
})
