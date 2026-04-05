import { readFile, writeFile, readdir, mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import type { Skill } from '@evolving-agent/core'

export class SkillStore {
  private dir: string
  private skills = new Map<string, Skill>()

  constructor(dataPath: string) {
    this.dir = join(dataPath, 'skills')
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const files = await readdir(this.dir).catch(() => [])
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const data = await readFile(join(this.dir, file), 'utf-8')
        const skill = JSON.parse(data) as Skill
        this.skills.set(skill.id, skill)
      } catch { /* skip corrupted */ }
    }
  }

  getAll(): Skill[] {
    return [...this.skills.values()]
  }

  getById(id: string): Skill | undefined {
    return this.skills.get(id)
  }

  async create(input: Omit<Skill, 'id' | 'score' | 'usageCount' | 'lastUsed' | 'createdFrom' | 'version'>): Promise<Skill> {
    const skill: Skill = {
      id: nanoid(),
      score: 0.5,
      usageCount: 0,
      lastUsed: new Date().toISOString(),
      createdFrom: 'dashboard',
      version: 1,
      ...input,
    }
    this.skills.set(skill.id, skill)
    await writeFile(join(this.dir, `${skill.id}.json`), JSON.stringify(skill, null, 2), 'utf-8')
    return skill
  }

  async update(id: string, updates: Partial<Skill>): Promise<Skill | null> {
    const skill = this.skills.get(id)
    if (!skill) return null
    Object.assign(skill, updates, { id }) // Prevent id overwrite
    await writeFile(join(this.dir, `${id}.json`), JSON.stringify(skill, null, 2), 'utf-8')
    return skill
  }

  async delete(id: string): Promise<boolean> {
    if (!this.skills.has(id)) return false
    this.skills.delete(id)
    try { await unlink(join(this.dir, `${id}.json`)) } catch { /* ok */ }
    return true
  }
}
