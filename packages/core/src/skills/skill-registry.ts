import { readFile, writeFile, readdir, mkdir, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExecutableSkill, SkillContext, SkillStep, ToolResult } from '../types.js'

// === Public types ===

export interface SkillMetadata {
  score: number
  usageCount: number
  lastUsed?: string
  enabled: boolean
  status: 'active' | 'disabled' | 'archived'
  createdAt: string
  createdFrom: 'builtin' | 'user' | 'agent'
}

export interface SkillWithMetadata extends ExecutableSkill {
  metadata: SkillMetadata
}

export interface SkillUsageRecord {
  timestamp: string
  success: boolean
  duration?: number
}

/** Serializable skill definition (persisted to disk — no execute function) */
interface PersistedSkill {
  id: string
  name: string
  description: string
  category: 'builtin' | 'system' | 'learned'
  triggers: string[]
  inputs: ExecutableSkill['inputs']
  steps?: SkillStep[]
  metadata: SkillMetadata
}

// === Default metadata ===

function defaultMetadata(overrides?: Partial<SkillMetadata>): SkillMetadata {
  return {
    score: 0.5,
    usageCount: 0,
    enabled: true,
    status: 'active',
    createdAt: new Date().toISOString(),
    createdFrom: 'builtin',
    ...overrides,
  }
}

// === Build an execute function from steps ===

function buildStepExecutor(steps: SkillStep[]): ExecutableSkill['execute'] {
  return async (params: Record<string, unknown>, ctx: SkillContext) => {
    const outputs: string[] = []
    for (const step of steps) {
      if (step.tool) {
        const result: ToolResult = await ctx.useTool(step.tool, { ...step.params, ...params })
        outputs.push(result.output)
        if (!result.success) {
          return { success: false, output: outputs.join('\n'), error: result.error }
        }
      } else {
        const reasoning = await ctx.think(step.description)
        outputs.push(reasoning)
      }
    }
    return { success: true, output: outputs.join('\n') }
  }
}

// === SkillRegistry ===

/**
 * Registry for executable skills with persistence, lifecycle management,
 * and usage tracking.
 */
export class SkillRegistry {
  private skills = new Map<string, ExecutableSkill>()
  private metadata = new Map<string, SkillMetadata>()
  /** Steps for non-builtin skills (needed for persistence) */
  private steps = new Map<string, SkillStep[]>()
  private dataPath?: string

  constructor(dataPath?: string) {
    this.dataPath = dataPath
  }

  /** Load persisted skill metadata and definitions from disk */
  async init(): Promise<void> {
    if (!this.dataPath) return
    await this.loadFromDisk()
  }

  register(skill: ExecutableSkill, meta?: Partial<SkillMetadata>): void {
    this.skills.set(skill.id, skill)

    // If we already have persisted metadata for this skill (e.g. builtin reload), merge
    const existing = this.metadata.get(skill.id)
    if (existing) {
      // Preserve persisted usage data, but allow overrides
      if (meta) Object.assign(existing, meta)
    } else {
      const createdFrom = meta?.createdFrom ?? (skill.category === 'builtin' ? 'builtin' : 'user')
      this.metadata.set(skill.id, defaultMetadata({ createdFrom, ...meta }))
    }
  }

  /**
   * Register a step-based skill (can be persisted).
   * Used for user-created and agent-created skills.
   */
  registerWithSteps(
    skill: Omit<ExecutableSkill, 'execute'>,
    skillSteps: SkillStep[],
    meta?: Partial<SkillMetadata>,
  ): ExecutableSkill {
    const executable: ExecutableSkill = {
      ...skill,
      execute: buildStepExecutor(skillSteps),
    }
    this.steps.set(skill.id, skillSteps)
    this.register(executable, meta)
    return executable
  }

  get(id: string): ExecutableSkill | undefined {
    return this.skills.get(id)
  }

  getWithMetadata(id: string): SkillWithMetadata | undefined {
    const skill = this.skills.get(id)
    const meta = this.metadata.get(id)
    if (!skill || !meta) return undefined
    return { ...skill, metadata: meta }
  }

  list(): ExecutableSkill[] {
    return [...this.skills.values()]
  }

  listWithMetadata(): SkillWithMetadata[] {
    return this.list()
      .map((s) => {
        const meta = this.metadata.get(s.id)
        return meta ? { ...s, metadata: meta } : undefined
      })
      .filter((s): s is SkillWithMetadata => s !== undefined)
  }

  /** Find skills whose triggers match the given text (only enabled skills) */
  match(text: string): ExecutableSkill[] {
    const lower = text.toLowerCase()
    return this.list().filter((skill) => {
      if (skill.available === false) return false
      const meta = this.metadata.get(skill.id)
      if (meta && !meta.enabled) return false
      return skill.triggers.some((t) => lower.includes(t.toLowerCase()))
    })
  }

  /** Build a summary of all enabled skills for the planner prompt */
  describeForPlanner(): string {
    const available = this.list().filter((s) => {
      if (s.available === false) return false
      const meta = this.metadata.get(s.id)
      return !meta || meta.enabled
    })
    if (available.length === 0) return ''

    const lines = available.map((s) => {
      const params = s.inputs.map((i) => `${i.name}: ${i.type}${i.required ? '' : '?'}`).join(', ')
      return `- skill:${s.id}(${params}) — ${s.description}`
    })

    return `\nAvailable Skills (use "skill:<id>" as tool name with matching params):\n${lines.join('\n')}`
  }

  enable(id: string): boolean {
    const meta = this.metadata.get(id)
    if (!meta) return false
    meta.enabled = true
    meta.status = 'active'
    this.persist(id).catch(() => {})
    return true
  }

  disable(id: string): boolean {
    const meta = this.metadata.get(id)
    if (!meta) return false
    meta.enabled = false
    meta.status = 'disabled'
    this.persist(id).catch(() => {})
    return true
  }

  /** Remove a skill. Cannot remove builtin skills. */
  remove(id: string): boolean {
    const skill = this.skills.get(id)
    if (!skill) return false
    if (skill.category === 'builtin') return false
    this.skills.delete(id)
    this.metadata.delete(id)
    this.steps.delete(id)
    // We don't delete files on disk — they'll be ignored on next load
    return true
  }

  /** Record a skill usage, adjust score, and persist */
  recordUsage(id: string, success: boolean, duration?: number): void {
    const meta = this.metadata.get(id)
    if (!meta) return

    meta.usageCount++
    meta.lastUsed = new Date().toISOString()

    if (success) {
      meta.score = Math.min(1.0, meta.score + 0.1)
    } else {
      meta.score = Math.max(0.0, meta.score - 0.05)
    }

    // Append to history
    const record: SkillUsageRecord = {
      timestamp: meta.lastUsed,
      success,
      duration,
    }
    this.appendHistory(id, record).catch(() => {})
    this.persist(id).catch(() => {})
  }

  /** Get usage history for a skill */
  async getHistory(id: string): Promise<SkillUsageRecord[]> {
    if (!this.dataPath) return []
    const historyPath = join(this.dataPath, 'skills', `${id}.history.jsonl`)
    try {
      const content = await readFile(historyPath, 'utf-8')
      return content
        .split('\n')
        .filter((line: string) => line.trim())
        .map((line: string) => JSON.parse(line) as SkillUsageRecord)
    } catch {
      return []
    }
  }

  // === Private persistence methods ===

  private async persist(id: string): Promise<void> {
    if (!this.dataPath) return
    const skill = this.skills.get(id)
    const meta = this.metadata.get(id)
    if (!skill || !meta) return

    // Don't persist builtin skills' definitions — only metadata
    if (skill.category === 'builtin') {
      // Store just the metadata keyed by id
      const metaPath = join(this.dataPath, 'skills', `${id}.meta.json`)
      await mkdir(join(this.dataPath, 'skills'), { recursive: true })
      await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8')
      return
    }

    const persisted: PersistedSkill = {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      category: skill.category,
      triggers: skill.triggers,
      inputs: skill.inputs,
      steps: this.steps.get(id),
      metadata: meta,
    }
    const dir = join(this.dataPath, 'skills')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${id}.json`), JSON.stringify(persisted, null, 2), 'utf-8')
  }

  private async appendHistory(id: string, record: SkillUsageRecord): Promise<void> {
    if (!this.dataPath) return
    const dir = join(this.dataPath, 'skills')
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, `${id}.history.jsonl`), JSON.stringify(record) + '\n', 'utf-8')
  }

  private async loadFromDisk(): Promise<void> {
    if (!this.dataPath) return
    const dir = join(this.dataPath, 'skills')
    await mkdir(dir, { recursive: true })

    const files = await readdir(dir).catch(() => [] as string[])

    for (const file of files) {
      // Load metadata files for builtin skills
      if (file.endsWith('.meta.json')) {
        try {
          const data = await readFile(join(dir, file), 'utf-8')
          const meta = JSON.parse(data) as SkillMetadata
          const id = file.replace('.meta.json', '')
          // Only apply if the builtin skill is already registered
          if (this.metadata.has(id)) {
            // Preserve persisted usage data
            const existing = this.metadata.get(id)!
            existing.score = meta.score
            existing.usageCount = meta.usageCount
            existing.lastUsed = meta.lastUsed
            existing.enabled = meta.enabled
            existing.status = meta.status
          } else {
            // Stash it — the builtin will be registered later and merge
            this.metadata.set(id, meta)
          }
        } catch {
          /* skip corrupted */
        }
        continue
      }

      // Load full skill definitions (non-builtin)
      if (file.endsWith('.json') && !file.endsWith('.meta.json')) {
        try {
          const data = await readFile(join(dir, file), 'utf-8')
          const persisted = JSON.parse(data) as PersistedSkill
          if (!persisted.id || !persisted.name) continue

          // Rebuild as executable skill
          const steps = persisted.steps ?? []
          const skill: ExecutableSkill = {
            id: persisted.id,
            name: persisted.name,
            description: persisted.description,
            category: persisted.category,
            triggers: persisted.triggers,
            inputs: persisted.inputs,
            execute: buildStepExecutor(steps),
          }
          this.skills.set(skill.id, skill)
          this.steps.set(skill.id, steps)
          this.metadata.set(skill.id, persisted.metadata ?? defaultMetadata({ createdFrom: 'user' }))
        } catch {
          /* skip corrupted */
        }
      }
    }
  }
}
