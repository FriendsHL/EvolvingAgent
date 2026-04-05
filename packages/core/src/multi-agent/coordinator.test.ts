import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AgentCoordinator } from './coordinator.js'
import type { AgentProfile } from './coordinator.js'

function makeProfile(overrides?: Partial<AgentProfile>): AgentProfile {
  return {
    id: `agent-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Test Agent',
    role: 'worker',
    description: 'A test agent',
    capabilities: ['coding', 'testing'],
    status: 'idle',
    ...overrides,
  }
}

describe('AgentCoordinator', () => {
  let coordinator: AgentCoordinator

  beforeEach(() => {
    coordinator = new AgentCoordinator()
  })

  it('register() adds agent profile', () => {
    const profile = makeProfile({ id: 'a1' })
    coordinator.register(profile, vi.fn().mockResolvedValue('ok'))
    expect(coordinator.list()).toHaveLength(1)
    expect(coordinator.list()[0].id).toBe('a1')
  })

  it('unregister() removes agent', () => {
    const profile = makeProfile({ id: 'a1' })
    coordinator.register(profile, vi.fn().mockResolvedValue('ok'))
    expect(coordinator.list()).toHaveLength(1)
    coordinator.unregister('a1')
    expect(coordinator.list()).toHaveLength(0)
  })

  it('list() returns all registered agents', () => {
    coordinator.register(makeProfile({ id: 'a1' }), vi.fn().mockResolvedValue('ok'))
    coordinator.register(makeProfile({ id: 'a2' }), vi.fn().mockResolvedValue('ok'))
    coordinator.register(makeProfile({ id: 'a3' }), vi.fn().mockResolvedValue('ok'))
    expect(coordinator.list()).toHaveLength(3)
  })

  it('findByCapability() finds matching agents', () => {
    coordinator.register(
      makeProfile({ id: 'coder', capabilities: ['coding', 'debugging'] }),
      vi.fn().mockResolvedValue('ok'),
    )
    coordinator.register(
      makeProfile({ id: 'writer', capabilities: ['writing', 'editing'] }),
      vi.fn().mockResolvedValue('ok'),
    )

    const coders = coordinator.findByCapability('coding')
    expect(coders).toHaveLength(1)
    expect(coders[0].id).toBe('coder')

    const writers = coordinator.findByCapability('writing')
    expect(writers).toHaveLength(1)
    expect(writers[0].id).toBe('writer')
  })

  it('findByRole() finds matching agents', () => {
    coordinator.register(
      makeProfile({ id: 'w1', role: 'worker' }),
      vi.fn().mockResolvedValue('ok'),
    )
    coordinator.register(
      makeProfile({ id: 'r1', role: 'reviewer' }),
      vi.fn().mockResolvedValue('ok'),
    )

    const workers = coordinator.findByRole('worker')
    expect(workers).toHaveLength(1)
    expect(workers[0].id).toBe('w1')

    const reviewers = coordinator.findByRole('reviewer')
    expect(reviewers).toHaveLength(1)
    expect(reviewers[0].id).toBe('r1')
  })

  it('routeTask() routes to matching agent', async () => {
    const handler = vi.fn().mockResolvedValue('task completed')
    coordinator.register(
      makeProfile({ id: 'coder', capabilities: ['coding', 'debugging'] }),
      handler,
    )

    const result = await coordinator.routeTask('fix the coding bug in the debugger', 'requester')
    expect(result).not.toBeNull()
    expect(result!.agentId).toBe('coder')
    expect(result!.result).toBe('task completed')
    expect(handler).toHaveBeenCalled()
  })

  it('routeTask() returns null when no agents match', async () => {
    coordinator.register(
      makeProfile({ id: 'coder', capabilities: ['coding'] }),
      vi.fn().mockResolvedValue('ok'),
    )

    // Task about cooking - no agent has that capability
    const result = await coordinator.routeTask('bake a chocolate cake', 'requester')
    expect(result).toBeNull()
  })
})
