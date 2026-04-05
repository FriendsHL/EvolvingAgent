import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import type { ProviderConfig, PresetName } from '@evolving-agent/core'

export interface AgentEntry {
  id: string
  name: string
  description: string
  provider: ProviderConfig | PresetName
  systemPrompt?: string
  costLimit?: number
  tokenBudget?: number
  createdAt: string
  updatedAt: string
}

export class AgentRegistry {
  private filePath: string
  private agents = new Map<string, AgentEntry>()

  constructor(dataPath: string) {
    this.filePath = join(dataPath, 'agents.json')
  }

  async init(): Promise<void> {
    await mkdir(join(this.filePath, '..'), { recursive: true })
    try {
      const data = await readFile(this.filePath, 'utf-8')
      const list = JSON.parse(data) as AgentEntry[]
      for (const a of list) this.agents.set(a.id, a)
    } catch { /* file doesn't exist yet */ }
  }

  private async persist(): Promise<void> {
    await writeFile(this.filePath, JSON.stringify([...this.agents.values()], null, 2), 'utf-8')
  }

  getAll(): AgentEntry[] {
    return [...this.agents.values()]
  }

  getById(id: string): AgentEntry | undefined {
    return this.agents.get(id)
  }

  async create(input: { name: string; description?: string; provider: ProviderConfig | PresetName; systemPrompt?: string; costLimit?: number; tokenBudget?: number }): Promise<AgentEntry> {
    const entry: AgentEntry = {
      id: nanoid(),
      name: input.name,
      description: input.description ?? '',
      provider: input.provider,
      systemPrompt: input.systemPrompt,
      costLimit: input.costLimit,
      tokenBudget: input.tokenBudget,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    this.agents.set(entry.id, entry)
    await this.persist()
    return entry
  }

  async update(id: string, updates: Partial<AgentEntry>): Promise<AgentEntry | null> {
    const entry = this.agents.get(id)
    if (!entry) return null
    Object.assign(entry, updates, { id, updatedAt: new Date().toISOString() })
    await this.persist()
    return entry
  }

  async delete(id: string): Promise<boolean> {
    if (!this.agents.has(id)) return false
    this.agents.delete(id)
    await this.persist()
    return true
  }
}
