// ============================================================
// SubAgentRegistry — frontmatter markdown loader
// ============================================================
//
// Reads every `*.md` file in `builtinDir` (non-recursive) and, if
// provided, every `*.md` in `userDir`. User-defined entries override
// builtins by `name`. The registry is consulted by:
//
//   1. router-tool.ts — to build the `delegate` tool's enum + catalog
//   2. planner.ts     — via describeForRouter() for the system prompt
//   3. agent.ts       — to look up the identityPrompt + tool allowlist
//      when spawning a sub-agent for a `delegate` step
//
// The frontmatter grammar is a deliberate subset of YAML matching the
// style of `parseSkillFrontmatter` in packages/web/src/server/routes/skills.ts —
// simple `key: value` lines plus inline arrays like `[a, b, c]`. We do
// NOT add a YAML runtime dependency; if users need block scalars they
// should keep the description as a single line.

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SubAgentDef } from './types.js'

export class SubAgentRegistry {
  private defs = new Map<string, SubAgentDef>()

  /**
   * Load builtins first, then override with user files. Both directories
   * are optional individually — missing dirs are silently skipped so tests
   * that don't ship a user override still work.
   */
  async init(opts: { builtinDir: string; userDir?: string }): Promise<void> {
    this.defs.clear()

    const builtinDefs = await this.loadDir(opts.builtinDir)
    for (const def of builtinDefs) {
      this.defs.set(def.name, def)
    }

    if (opts.userDir) {
      try {
        const userDefs = await this.loadDir(opts.userDir)
        for (const def of userDefs) {
          this.defs.set(def.name, def) // user override by name
        }
      } catch (err) {
        // Missing user dir is fine; a real load failure we re-throw.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err
        }
      }
    }
  }

  list(): SubAgentDef[] {
    return Array.from(this.defs.values())
  }

  get(name: string): SubAgentDef | undefined {
    return this.defs.get(name)
  }

  /**
   * Format the catalog string the router prompt injects into the
   * `delegate` tool description. One line per sub-agent, compact, no
   * trailing newline. Callers join with newlines.
   */
  describeForRouter(): string {
    return this.list()
      .map((d) => `- ${d.name}: ${d.description.trim().replace(/\s+/g, ' ')}`)
      .join('\n')
  }

  // --------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------

  private async loadDir(dir: string): Promise<SubAgentDef[]> {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const out: SubAgentDef[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue
      const sourcePath = join(dir, entry)
      const raw = await readFile(sourcePath, 'utf-8')
      out.push(parseSubAgentMarkdown(raw, sourcePath))
    }
    return out
  }
}

// ------------------------------------------------------------
// Parser — frontmatter + body into a SubAgentDef
// ------------------------------------------------------------

export function parseSubAgentMarkdown(
  raw: string,
  sourcePath: string,
): SubAgentDef {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) {
    throw new Error(
      `sub-agent loader: ${sourcePath} is missing a YAML frontmatter block`,
    )
  }

  const fmText = match[1]
  const body = match[2] ?? ''
  const fm = parseFrontmatter(fmText, sourcePath)

  const name = asString(fm.name)
  if (!name) {
    throw new Error(
      `sub-agent loader: ${sourcePath} frontmatter missing required "name"`,
    )
  }
  const description = asString(fm.description)
  if (!description) {
    throw new Error(
      `sub-agent loader: ${sourcePath} frontmatter missing required "description"`,
    )
  }

  const memoryRaw = asString(fm.memory) ?? 'none'
  if (memoryRaw !== 'none' && memoryRaw !== 'private' && memoryRaw !== 'shared') {
    throw new Error(
      `sub-agent loader: ${sourcePath} has invalid memory="${memoryRaw}" (must be none|private|shared)`,
    )
  }

  const maxIterRaw = fm.max_iterations ?? fm.maxIterations
  const maxIterations =
    typeof maxIterRaw === 'string' && maxIterRaw.trim() !== ''
      ? Number.parseInt(maxIterRaw, 10)
      : 8
  if (!Number.isFinite(maxIterations) || maxIterations <= 0) {
    throw new Error(
      `sub-agent loader: ${sourcePath} has invalid max_iterations="${String(maxIterRaw)}"`,
    )
  }

  return {
    name,
    displayName: asString(fm.displayName) ?? asString(fm.display_name) ?? name,
    description,
    tools: asStringArray(fm.tools),
    disallowedTools: asStringArray(fm.disallowedTools ?? fm.disallowed_tools),
    skills: asStringArray(fm.skills),
    model: asString(fm.model),
    memory: memoryRaw,
    maxIterations,
    identityPrompt: body.trim(),
    sourcePath,
  }
}

type FrontmatterValue = string | string[] | undefined
type FrontmatterRecord = Record<string, FrontmatterValue>

function parseFrontmatter(text: string, sourcePath: string): FrontmatterRecord {
  const fm: FrontmatterRecord = {}
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const kv = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/)
    if (!kv) {
      // Unknown / malformed line — surface rather than silently drop so
      // typos don't turn into mysterious missing fields.
      throw new Error(
        `sub-agent loader: ${sourcePath} frontmatter has malformed line: "${line}"`,
      )
    }
    const key = kv[1]
    let value: string = kv[2].trim()

    // Strip optional surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      fm[key] = value.slice(1, -1)
      continue
    }

    // Inline YAML array: [a, b, c] — also accept an empty `[]`.
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim()
      if (inner === '') {
        fm[key] = []
      } else {
        fm[key] = inner
          .split(',')
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
          .filter((s) => s.length > 0)
      }
      continue
    }

    fm[key] = value
  }
  return fm
}

function asString(v: FrontmatterValue): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function asStringArray(v: FrontmatterValue): string[] {
  if (Array.isArray(v)) return v
  if (typeof v === 'string' && v.length > 0) return [v]
  return []
}
