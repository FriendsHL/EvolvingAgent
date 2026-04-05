import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import type { SkillRegistry, SkillWithMetadata } from '@evolving-agent/core'
import type { ExecutableSkill, SkillStep } from '@evolving-agent/core'

export function skillsRoutes(registry: SkillRegistry) {
  const app = new Hono()

  // GET / — list all skills with metadata
  app.get('/', (c) => {
    const skills = registry.listWithMetadata().map(serializeSkill)
    return c.json({ skills })
  })

  // GET /:id — get single skill with metadata
  app.get('/:id', (c) => {
    const skill = registry.getWithMetadata(c.req.param('id'))
    if (!skill) return c.json({ error: 'Not found' }, 404)
    return c.json(serializeSkill(skill))
  })

  // POST / — create a user-defined skill
  app.post('/', async (c) => {
    const body = await c.req.json<{
      name: string
      description: string
      triggers: string[]
      steps: SkillStep[]
    }>()

    if (!body.name || !body.description) {
      return c.json({ error: 'name and description are required' }, 400)
    }

    const id = nanoid()
    const skillDef: Omit<ExecutableSkill, 'execute'> = {
      id,
      name: body.name,
      description: body.description,
      category: 'system',
      triggers: body.triggers ?? [],
      inputs: [],
    }

    const skill = registry.registerWithSteps(skillDef, body.steps ?? [], {
      createdFrom: 'user',
    })

    const result = registry.getWithMetadata(skill.id)
    return c.json(result ? serializeSkill(result) : { id: skill.id }, 201)
  })

  // PUT /:id — update skill properties
  app.put('/:id', async (c) => {
    const id = c.req.param('id')
    const skill = registry.getWithMetadata(id)
    if (!skill) return c.json({ error: 'Not found' }, 404)

    // Cannot update builtin skills' core properties
    if (skill.category === 'builtin') {
      return c.json({ error: 'Cannot update builtin skill properties' }, 403)
    }

    const body = await c.req.json<{
      name?: string
      description?: string
      triggers?: string[]
      enabled?: boolean
      steps?: SkillStep[]
    }>()

    // Re-register with updated fields + steps
    const steps = body.steps ?? []
    const updatedDef: Omit<ExecutableSkill, 'execute'> = {
      id,
      name: body.name ?? skill.name,
      description: body.description ?? skill.description,
      category: skill.category,
      triggers: body.triggers ?? skill.triggers,
      inputs: skill.inputs,
    }

    registry.registerWithSteps(updatedDef, steps, {
      enabled: body.enabled ?? skill.metadata.enabled,
    })

    const result = registry.getWithMetadata(id)
    return c.json(result ? serializeSkill(result) : { id })
  })

  // DELETE /:id — remove skill (fails for builtin)
  app.delete('/:id', (c) => {
    const id = c.req.param('id')
    const skill = registry.get(id)
    if (!skill) return c.json({ error: 'Not found' }, 404)

    const removed = registry.remove(id)
    if (!removed) {
      return c.json({ error: 'Cannot remove builtin skills' }, 403)
    }
    return c.json({ success: true })
  })

  // PATCH /:id/toggle — toggle enabled/disabled
  app.patch('/:id/toggle', (c) => {
    const id = c.req.param('id')
    const skill = registry.getWithMetadata(id)
    if (!skill) return c.json({ error: 'Not found' }, 404)

    const toggled = skill.metadata.enabled ? registry.disable(id) : registry.enable(id)
    if (!toggled) return c.json({ error: 'Toggle failed' }, 500)

    const result = registry.getWithMetadata(id)
    return c.json(result ? serializeSkill(result) : { id })
  })

  // GET /:id/history — get usage history
  app.get('/:id/history', async (c) => {
    const id = c.req.param('id')
    if (!registry.get(id)) return c.json({ error: 'Not found' }, 404)
    const history = await registry.getHistory(id)
    return c.json({ history })
  })

  return app
}

/** Strip the execute function before serializing */
function serializeSkill(skill: SkillWithMetadata) {
  const { execute, ...rest } = skill
  return rest
}
