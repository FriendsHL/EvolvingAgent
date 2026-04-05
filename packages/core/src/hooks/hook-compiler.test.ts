import { describe, it, expect } from 'vitest'
import { HookCompiler } from './hook-compiler.js'
import type { HookDraft } from './hook-compiler.js'

function makeDraft(overrides?: Partial<HookDraft>): HookDraft {
  return {
    trigger: 'before:tool-call',
    condition: 'rate limit exceeded',
    action: 'block the call',
    reason: 'Prevent excessive tool usage',
    ...overrides,
  }
}

describe('HookCompiler', () => {
  const compiler = new HookCompiler()

  it('compiles a rate-limiting HookDraft', () => {
    const draft = makeDraft({ condition: 'too many rate calls' })
    const { hook } = compiler.compile(draft)
    expect(hook).toBeDefined()
    expect(typeof hook.handler).toBe('function')
    expect(hook.trigger).toBe('before:tool-call')
  })

  it('compiles a cost-guard HookDraft', () => {
    const draft = makeDraft({ condition: 'cost exceeds 5.0' })
    const { hook } = compiler.compile(draft)
    expect(hook).toBeDefined()
    expect(typeof hook.handler).toBe('function')
  })

  it('compiles a tool-blocking HookDraft', () => {
    const draft = makeDraft({ condition: "block dangerous 'rm -rf' commands" })
    const { hook } = compiler.compile(draft)
    expect(hook).toBeDefined()
    expect(typeof hook.handler).toBe('function')
  })

  it('compiles a logging HookDraft', () => {
    const draft = makeDraft({ action: 'log all tool calls for audit' })
    const { hook } = compiler.compile(draft)
    expect(hook).toBeDefined()
    expect(typeof hook.handler).toBe('function')
  })

  it("compiled hook has correct source ('evolved-new')", () => {
    const { hook } = compiler.compile(makeDraft())
    expect(hook.source).toBe('evolved-new')
  })

  it('compiled hook has correct safety defaults (canBeDisabledByAgent: true)', () => {
    const { hook } = compiler.compile(makeDraft())
    expect(hook.safety.canBeDisabledByAgent).toBe(true)
    expect(hook.safety.timeout).toBe(5000)
    expect(hook.safety.maxRetries).toBe(0)
    expect(hook.safety.fallbackBehavior).toBe('skip')
  })

  it('compiled hook handler is a function', () => {
    const { hook } = compiler.compile(makeDraft())
    expect(typeof hook.handler).toBe('function')
  })

  it('returns CompiledHook with source draft', () => {
    const draft = makeDraft()
    const compiled = compiler.compile(draft)
    expect(compiled.source).toBe(draft)
    expect(compiled.hook).toBeDefined()
    expect(compiled.hook.id).toMatch(/^hook-evolved-/)
  })
})
