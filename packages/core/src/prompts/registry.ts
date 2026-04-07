/**
 * Phase 4 C — PromptRegistry.
 *
 * Central store for runtime-overridable prompts. On init it reads
 * `<dataPath>/prompts/active.json` (if present) and merges the entries onto
 * a caller-supplied `defaults` map. Source-code constants remain authoritative
 * baselines — active.json is the *self-optimization layer*.
 *
 * When active.json is missing or malformed, the registry silently falls back
 * to defaults. Never throws from constructor or get().
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  PromptId,
  PromptActiveEntry,
  PromptActiveFile,
  PromptHistoryEntry,
} from './types.js'
import { PROMPT_IDS } from './types.js'

export interface PromptRegistryOptions {
  /** Path to the data/ directory. Registry uses <dataPath>/prompts/. */
  dataPath: string
  /**
   * Baseline source-code prompts. Required — every PromptId MUST have a
   * default or `get()` would have nothing to fall back to.
   */
  defaults: Record<PromptId, string>
}

export class PromptRegistry {
  private defaults: Record<PromptId, string>
  private active: Partial<Record<PromptId, PromptActiveEntry>> = {}
  /**
   * In-memory transient overrides used by the optimizer to evaluate
   * candidates in a sandbox. Transient entries win over `active`, which in
   * turn wins over `defaults`. Never persisted.
   */
  private transient: Partial<Record<PromptId, string>> = {}
  private dataPath: string
  private loaded = false

  constructor(options: PromptRegistryOptions) {
    this.defaults = { ...options.defaults }
    this.dataPath = options.dataPath
  }

  /**
   * Load `active.json` from disk. Safe to call multiple times. Missing file
   * is not an error — it just means no overrides yet. Malformed file logs a
   * warning and falls back to defaults.
   */
  async init(): Promise<void> {
    const activePath = this.activeFilePath()
    try {
      const raw = await fs.readFile(activePath, 'utf8')
      const parsed = JSON.parse(raw) as PromptActiveFile
      if (parsed && typeof parsed === 'object' && parsed.prompts && typeof parsed.prompts === 'object') {
        // Only accept known prompt ids.
        for (const id of PROMPT_IDS) {
          const entry = parsed.prompts[id]
          if (entry && typeof entry.content === 'string' && entry.content.length > 0) {
            this.active[id] = entry
          }
        }
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        console.warn(`[prompt-registry] failed to load ${activePath}:`, err)
      }
      // ENOENT is silent — first run with no overrides.
    }
    this.loaded = true
  }

  /**
   * Returns the currently active prompt text for an id, falling back to the
   * source-code default. Never throws.
   */
  get(id: PromptId): string {
    return this.transient[id] ?? this.active[id]?.content ?? this.defaults[id]
  }

  /**
   * Install a transient (in-memory only) override. Used by the optimizer
   * sandbox: set → run eval → clear. Never written to disk.
   */
  setTransient(id: PromptId, content: string): void {
    this.transient[id] = content
  }

  /**
   * Clear the transient override for an id (or all ids if none given).
   */
  clearTransient(id?: PromptId): void {
    if (id) delete this.transient[id]
    else this.transient = {}
  }

  /**
   * Run a function with a transient override installed, clearing it on
   * completion (success or failure). Used by the optimizer sandbox loop.
   */
  async withTransient<T>(id: PromptId, content: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.transient[id]
    this.transient[id] = content
    try {
      return await fn()
    } finally {
      if (prev === undefined) delete this.transient[id]
      else this.transient[id] = prev
    }
  }

  /**
   * Returns the baseline (source-code) prompt for an id, ignoring any
   * active override. Used by the optimizer to measure baseline performance.
   */
  getBaseline(id: PromptId): string {
    return this.defaults[id]
  }

  /**
   * Returns the active entry metadata (when it was accepted, pass rate, etc)
   * or undefined if the baseline is in effect.
   */
  getActiveEntry(id: PromptId): PromptActiveEntry | undefined {
    return this.active[id]
  }

  /**
   * Lists the status of all three prompts — whether each is currently using
   * baseline or an active override.
   */
  list(): Array<{
    id: PromptId
    source: 'baseline' | 'active'
    content: string
    activeEntry?: PromptActiveEntry
  }> {
    return PROMPT_IDS.map((id) => {
      const entry = this.active[id]
      if (entry) {
        return { id, source: 'active' as const, content: entry.content, activeEntry: entry }
      }
      return { id, source: 'baseline' as const, content: this.defaults[id] }
    })
  }

  /**
   * Accept a new prompt as active. Writes `active.json` atomically and
   * appends a history snapshot. Used by the optimizer after gate approval.
   */
  async set(
    id: PromptId,
    content: string,
    meta: Omit<PromptActiveEntry, 'content' | 'acceptedAt'> & { timestamp?: string } = {},
  ): Promise<void> {
    const timestamp = meta.timestamp ?? new Date().toISOString()
    const entry: PromptActiveEntry = {
      content,
      acceptedAt: timestamp,
      note: meta.note,
      evalPassRate: meta.evalPassRate,
      baselinePassRate: meta.baselinePassRate,
    }
    this.active[id] = entry
    await this.persist()
    await this.appendHistory({
      id,
      timestamp,
      action: 'accept',
      content,
      note: meta.note,
      evalPassRate: meta.evalPassRate,
      baselinePassRate: meta.baselinePassRate,
    })
  }

  /**
   * Revert a prompt to its source-code baseline (removes the active override).
   * Writes a history snapshot so the rollback itself is auditable.
   */
  async revertToBaseline(id: PromptId, note?: string): Promise<void> {
    delete this.active[id]
    await this.persist()
    await this.appendHistory({
      id,
      timestamp: new Date().toISOString(),
      action: 'rollback',
      content: this.defaults[id],
      note: note ?? 'reverted to source-code baseline',
    })
  }

  /**
   * Lists history snapshot entries for an id (or all ids). Parses the yaml
   * frontmatter from each `.md` file in `data/prompts/history/`. Returns
   * newest first.
   */
  async history(id?: PromptId): Promise<PromptHistoryEntry[]> {
    const dir = this.historyDir()
    let files: string[]
    try {
      files = await fs.readdir(dir)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }

    const entries: PromptHistoryEntry[] = []
    for (const file of files) {
      if (!file.endsWith('.md')) continue
      if (id && !file.includes(`-${id}.md`)) continue
      try {
        const raw = await fs.readFile(path.join(dir, file), 'utf8')
        const parsed = parseHistoryFile(raw)
        if (parsed && (!id || parsed.id === id)) entries.push(parsed)
      } catch {
        // Skip unreadable files — don't fail the whole listing.
      }
    }
    // Newest first.
    entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    return entries
  }

  /**
   * Restore a specific history snapshot as the new active. Used for manual
   * rollback to a previously-accepted version.
   */
  async restoreFromHistory(id: PromptId, timestamp: string): Promise<void> {
    const all = await this.history(id)
    const match = all.find((e) => e.timestamp === timestamp)
    if (!match) throw new Error(`No history entry for ${id} at ${timestamp}`)
    await this.set(id, match.content, {
      note: `restored from history snapshot ${timestamp}`,
      evalPassRate: match.evalPassRate,
      baselinePassRate: match.baselinePassRate,
    })
  }

  isLoaded(): boolean {
    return this.loaded
  }

  private activeFilePath(): string {
    return path.join(this.dataPath, 'prompts', 'active.json')
  }

  private historyDir(): string {
    return path.join(this.dataPath, 'prompts', 'history')
  }

  private async persist(): Promise<void> {
    const file = this.activeFilePath()
    await fs.mkdir(path.dirname(file), { recursive: true })
    const payload: PromptActiveFile = { prompts: { ...this.active } }
    // Atomic-ish: write to temp then rename.
    const tmp = `${file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
    await fs.rename(tmp, file)
  }

  private async appendHistory(entry: PromptHistoryEntry): Promise<void> {
    const dir = this.historyDir()
    await fs.mkdir(dir, { recursive: true })
    const safeTimestamp = entry.timestamp.replace(/[:.]/g, '-')
    const file = path.join(dir, `${safeTimestamp}-${entry.id}.md`)
    const body = serializeHistoryFile(entry)
    await fs.writeFile(file, body, 'utf8')
  }
}

/**
 * Serialize a history entry as markdown with yaml frontmatter. The prompt
 * content goes in the markdown body so diff tools work naturally on it.
 */
function serializeHistoryFile(entry: PromptHistoryEntry): string {
  const fm: string[] = ['---']
  fm.push(`id: ${entry.id}`)
  fm.push(`timestamp: ${entry.timestamp}`)
  fm.push(`action: ${entry.action}`)
  if (entry.note) fm.push(`note: ${JSON.stringify(entry.note)}`)
  if (entry.evalPassRate !== undefined) fm.push(`evalPassRate: ${entry.evalPassRate}`)
  if (entry.baselinePassRate !== undefined) fm.push(`baselinePassRate: ${entry.baselinePassRate}`)
  fm.push('---')
  fm.push('')
  fm.push(entry.content)
  return fm.join('\n')
}

/**
 * Parse a history file back. Tolerates slight format variations but requires
 * the frontmatter block.
 */
function parseHistoryFile(raw: string): PromptHistoryEntry | null {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!fmMatch) return null
  const fmBlock = fmMatch[1]
  const body = fmMatch[2].replace(/^\n/, '')
  const fields: Record<string, string> = {}
  for (const line of fmBlock.split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/)
    if (m) fields[m[1]] = m[2]
  }
  if (!fields.id || !fields.timestamp || !fields.action) return null
  const entry: PromptHistoryEntry = {
    id: fields.id as PromptId,
    timestamp: fields.timestamp,
    action: fields.action as PromptHistoryEntry['action'],
    content: body,
  }
  if (fields.note) {
    try {
      entry.note = JSON.parse(fields.note)
    } catch {
      entry.note = fields.note
    }
  }
  if (fields.evalPassRate) entry.evalPassRate = Number(fields.evalPassRate)
  if (fields.baselinePassRate) entry.baselinePassRate = Number(fields.baselinePassRate)
  return entry
}
