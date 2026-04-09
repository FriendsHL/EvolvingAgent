import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import AdmZip from 'adm-zip'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SkillRegistry, SkillWithMetadata } from '@evolving-agent/core'
import type { ExecutableSkill, SkillStep } from '@evolving-agent/core'

export function skillsRoutes(registry: SkillRegistry, dataPath: string) {
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

  // POST /upload — install a skill from a zip bundle (Claude-Code-style)
  //
  // Expected zip layout (either flat at root OR under a single top-level dir):
  //   SKILL.md              <-- required, frontmatter + body
  //   scripts/*             <-- optional, executable helpers
  //   references/*          <-- optional, reference docs the agent can read
  //
  // SKILL.md frontmatter (minimum):
  //   ---
  //   name: my-skill
  //   description: What this skill does.
  //   when_to_use: (optional) One-line trigger hint
  //   triggers: [keyword1, keyword2]   (optional)
  //   ---
  //   # Identity / instructions
  //   (markdown body — becomes the skill's prompt body)
  //
  // Unpacked to data/skills/<skill-name>/ and registered with the SkillRegistry.
  app.post('/upload', async (c) => {
    try {
      const form = await c.req.formData()
      const file = form.get('file')
      if (!(file instanceof File)) {
        return c.json({ error: 'missing "file" field (multipart/form-data)' }, 400)
      }
      const buf = Buffer.from(await file.arrayBuffer())
      let zip: AdmZip
      try {
        zip = new AdmZip(buf)
      } catch (err) {
        return c.json({ error: `zip parse failed: ${(err as Error).message}` }, 400)
      }

      const entries = zip.getEntries()
      if (entries.length === 0) {
        return c.json({ error: 'zip is empty' }, 400)
      }

      // Locate SKILL.md — allow either at the zip root OR under a single
      // wrapper directory (CC ships skills as `skill-name/SKILL.md`).
      const skillMdEntry = entries.find((e) => /^(?:[^/]+\/)?SKILL\.md$/i.test(e.entryName))
      if (!skillMdEntry) {
        return c.json({ error: 'SKILL.md not found in zip (expected at root or in a single top-level directory)' }, 400)
      }
      const wrapperPrefix = skillMdEntry.entryName.includes('/')
        ? skillMdEntry.entryName.slice(0, skillMdEntry.entryName.lastIndexOf('/') + 1)
        : ''

      const skillMdText = skillMdEntry.getData().toString('utf-8')
      const parsed = parseSkillFrontmatter(skillMdText)
      if (!parsed.name) {
        return c.json({ error: 'SKILL.md frontmatter missing "name"' }, 400)
      }
      if (!parsed.description) {
        return c.json({ error: 'SKILL.md frontmatter missing "description"' }, 400)
      }

      // Sanitize name for use as a directory
      const skillDirName = parsed.name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
      const skillRoot = join(dataPath, 'skills', skillDirName)
      await mkdir(skillRoot, { recursive: true })

      // Extract everything under the wrapper (or root) into the skill directory.
      let extractedFiles = 0
      for (const entry of entries) {
        if (entry.isDirectory) continue
        if (wrapperPrefix && !entry.entryName.startsWith(wrapperPrefix)) continue
        const relPath = wrapperPrefix
          ? entry.entryName.slice(wrapperPrefix.length)
          : entry.entryName
        if (!relPath) continue
        // Defend against path traversal — reject any ".." or absolute paths
        if (relPath.includes('..') || relPath.startsWith('/')) {
          return c.json({ error: `unsafe path in zip: ${entry.entryName}` }, 400)
        }
        const destPath = join(skillRoot, relPath)
        await mkdir(join(destPath, '..'), { recursive: true })
        await writeFile(destPath, entry.getData())
        extractedFiles++
      }

      // Register with the runtime SkillRegistry. Zip-based skills don't yet
      // express executable steps the way the in-code skills do — the SKILL.md
      // body is stored on disk as the skill's instructions, and the agent
      // surfaces it through file_read when the skill fires. This is the MVP
      // shim; full "LLM reads SKILL.md as a sub-prompt" support is a Phase 5
      // item (ties into the sub-agents markdown loader).
      const id = nanoid()
      const skillDef: Omit<ExecutableSkill, 'execute'> = {
        id,
        name: parsed.name,
        description: parsed.description,
        category: 'system',
        triggers: parsed.triggers ?? [],
        inputs: [],
      }
      const steps: SkillStep[] = [
        {
          description: `Read skill instructions: data/skills/${skillDirName}/SKILL.md`,
          tool: 'file_read',
          params: { path: `data/skills/${skillDirName}/SKILL.md` },
        },
      ]
      registry.registerWithSteps(skillDef, steps, { createdFrom: 'user' })
      const result = registry.getWithMetadata(id)

      return c.json(
        {
          id,
          name: parsed.name,
          description: parsed.description,
          skillDir: skillRoot,
          extractedFiles,
          triggers: parsed.triggers ?? [],
          whenToUse: parsed.whenToUse ?? null,
          skill: result ? serializeSkill(result) : null,
        },
        201,
      )
    } catch (err) {
      return c.json({ error: `upload failed: ${(err as Error).message}` }, 500)
    }
  })

  return app
}

/** Parse a subset of YAML frontmatter from a SKILL.md file. */
function parseSkillFrontmatter(text: string): {
  name?: string
  description?: string
  whenToUse?: string
  triggers?: string[]
} {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  const fm: Record<string, string | string[]> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/)
    if (!kv) continue
    const key = kv[1]
    let value: string | string[] = kv[2].trim()
    // Strip optional surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    // Inline YAML array: [a, b, c]
    if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
    }
    fm[key] = value
  }
  return {
    name: typeof fm.name === 'string' ? fm.name : undefined,
    description: typeof fm.description === 'string' ? fm.description : undefined,
    whenToUse:
      typeof fm.when_to_use === 'string'
        ? fm.when_to_use
        : typeof fm.whenToUse === 'string'
          ? fm.whenToUse
          : undefined,
    triggers: Array.isArray(fm.triggers) ? fm.triggers : undefined,
  }
}

/** Strip the execute function before serializing */
function serializeSkill(skill: SkillWithMetadata) {
  const { execute, ...rest } = skill
  return rest
}
