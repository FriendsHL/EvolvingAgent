// ============================================================
// Sub-Agent definition types (Phase 5 S1, router-mode)
// ============================================================
//
// A SubAgentDef is the parsed representation of one frontmatter
// markdown file under `packages/core/src/sub-agents/builtin/` (or the
// user override dir). It captures everything the router needs to
// choose a specialist AND everything the executor needs to spawn
// the specialist via SubAgentManager.
//
// This file holds pure types — no runtime logic. The loader lives
// in ./loader.ts; the router tool builder lives in ./router-tool.ts.

export interface SubAgentDef {
  /** Unique id, matches the router delegate tool's enum value. */
  name: string
  /** Display name; may be the same as `name`. */
  displayName?: string
  /** The whenToPickMe hint injected into the router's delegate tool description. */
  description: string
  /** Allowlist of low-level tool names. Empty array = no tools. */
  tools: string[]
  /** Denylist (overrides allowlist). For v1 you can leave it as `string[]`
   *  but we accept it from frontmatter for forward-compat. */
  disallowedTools: string[]
  /** Allowlist of skill names. */
  skills: string[]
  /** Reserved for Phase 6 — kept on the type but ignored by v1 runtime. */
  model?: string
  /** Memory access mode. v1 only honors 'none' and 'shared'. Default 'none'. */
  memory: 'none' | 'private' | 'shared'
  /** Cap on ReAct loop iterations. */
  maxIterations: number
  /** The full markdown body after the frontmatter — becomes the sub-agent's
   *  system prompt when the router spawns this agent. */
  identityPrompt: string
  /** Absolute path to the source file, useful for hot-reload + diagnostics. */
  sourcePath: string
}
