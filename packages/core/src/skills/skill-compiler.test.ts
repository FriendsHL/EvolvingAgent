import { describe, it, expect, vi } from 'vitest'
import { SkillCompiler } from './skill-compiler.js'
import type { SkillContext, SkillDraft } from '../types.js'

function makeDraft(overrides?: Partial<SkillDraft>): SkillDraft {
  return {
    name: 'Git Status Check',
    trigger: 'git status, check repo',
    steps: ['Use shell tool to run "git status"', 'Summarize the output'],
    ...overrides,
  }
}

function makeContext(): SkillContext {
  return {
    useTool: vi.fn().mockResolvedValue({ success: true, output: 'ok' }),
    think: vi.fn().mockResolvedValue('thought result'),
    emit: vi.fn(),
  }
}

describe('SkillCompiler', () => {
  const compiler = new SkillCompiler()

  it('compiles a simple SkillDraft into ExecutableSkill', () => {
    const { skill } = compiler.compile(makeDraft())
    expect(skill).toBeDefined()
    expect(skill.name).toBe('Git Status Check')
    expect(typeof skill.execute).toBe('function')
  })

  it('generated skill has correct id (kebab-case from name)', () => {
    const { skill } = compiler.compile(makeDraft({ name: 'My Cool Skill' }))
    expect(skill.id).toBe('my-cool-skill')
  })

  it("generated skill has 'learned' category", () => {
    const { skill } = compiler.compile(makeDraft())
    expect(skill.category).toBe('learned')
  })

  it('triggers are extracted from draft trigger string', () => {
    const { skill } = compiler.compile(makeDraft({ trigger: 'foo, bar; baz' }))
    expect(skill.triggers).toEqual(['foo', 'bar', 'baz'])
  })

  it('input params are inferred from step descriptions containing {placeholder}', () => {
    const { skill } = compiler.compile(
      makeDraft({
        steps: ['Read the file at {path}', 'Search for {query} in it'],
      }),
    )
    const paramNames = skill.inputs.map((p) => p.name)
    expect(paramNames).toContain('path')
    expect(paramNames).toContain('query')
  })

  it('steps referencing known tools (shell, file_read) are detected', async () => {
    const ctx = makeContext()
    const { skill } = compiler.compile(
      makeDraft({
        steps: ['Use shell tool to run "ls"'],
      }),
    )
    await skill.execute({}, ctx)
    expect(ctx.useTool).toHaveBeenCalledWith('shell', expect.objectContaining({ command: 'ls' }))
  })

  it('execute function calls ctx.think for non-tool steps', async () => {
    const ctx = makeContext()
    const { skill } = compiler.compile(
      makeDraft({
        steps: ['Think about the meaning of life'],
      }),
    )
    await skill.execute({}, ctx)
    expect(ctx.think).toHaveBeenCalled()
  })

  it('execute function calls ctx.useTool for tool steps', async () => {
    const ctx = makeContext()
    const { skill } = compiler.compile(
      makeDraft({
        steps: ['Use shell tool to run "echo hello"'],
      }),
    )
    await skill.execute({}, ctx)
    expect(ctx.useTool).toHaveBeenCalledWith('shell', expect.any(Object))
  })

  it('returns CompiledSkill with source attached', () => {
    const draft = makeDraft()
    const compiled = compiler.compile(draft)
    expect(compiled.source).toBe(draft)
    expect(compiled.skill).toBeDefined()
  })
})
