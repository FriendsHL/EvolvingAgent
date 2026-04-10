// ============================================================
// Router delegate tool (Phase 5 S1)
// ============================================================
//
// Builds the single `delegate` tool the planner uses in router mode.
// The `subagent_type` enum is derived from the SubAgentRegistry so
// shipping a new `code.md` later just extends the router with no code
// changes.
//
// The prompt language is ported (near-verbatim) from Claude Code's
// coordinator-mode rules. The most important lines are the "never
// delegate understanding" / "never call delegate AND produce text in
// the same turn" clauses — they're the only reliable mitigation for
// the rubber-stamping failure mode that kills naive multi-agent
// systems.

import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { SubAgentRegistry } from './loader.js'

/** System prompt prefix used when the planner runs in router mode. */
export const ROUTER_SYSTEM_PROMPT_PREFIX = `You are the Router for a multi-agent assistant.
You have ONE tool called \`delegate\` that picks a specialist sub-agent.

Two modes:
- DIRECT — the answer is conversational, no fresh facts needed, no tools required.
  In this mode, do NOT call delegate. Just produce a normal text reply.
- DELEGATE — anything that needs fresh facts, the file system, the network,
  code edits, or multi-step reasoning over collected evidence.
  In this mode, call \`delegate\` exactly once.

Default to DELEGATE when uncertain. False-direct answers (hallucinated facts,
made-up clock times, fabricated URL contents) are the dominant failure mode.

ROUTING RULES (hard constraints):
- Any message containing a URL, or mentioning "网页/页面/文章/article/page/site/链接/link" → MUST delegate to \`research\`. Never route URL tasks to \`system\` (system has no browser).
- Any message asking about current time/date, working directory, OS, processes, files, git status → delegate to \`system\`.
- Any message asking to read/write/refactor code or run tests → delegate to \`code\`.
- Any message asking to compare, analyze, or recommend from existing information → delegate to \`analysis\`.
- Greetings, opinions, definitions the LLM is confident about → DIRECT mode (no delegate).

Never call delegate AND produce text in the same turn. Pick one.

Never delegate "understanding": if you would write "based on your findings, fix it",
synthesize the fix yourself first, then either delegate the synthesized work or
answer directly.`

/**
 * Build the router toolset containing a single `delegate` tool. The
 * enum and the catalog are both derived from the registry so adding a
 * new `*.md` builtin automatically extends the router surface.
 *
 * Throws when the registry is empty — a router with no destinations
 * would be a silent dead-end and is always a configuration bug.
 */
export function buildRouterToolSet(registry: SubAgentRegistry): ToolSet {
  const defs = registry.list()
  if (defs.length === 0) {
    throw new Error('SubAgentRegistry is empty — cannot build router tool')
  }
  // z.enum requires a non-empty tuple.
  const names = defs.map((d) => d.name) as [string, ...string[]]

  const catalog = registry.describeForRouter()

  const description =
    'Pick exactly ONE specialist sub-agent and hand it a self-contained task. ' +
    'Available specialists:\n' +
    catalog +
    '\n\n' +
    'Rules: synthesize before re-delegating; never write "based on your findings"; ' +
    'the task description must be self-contained. Do not answer the user yourself ' +
    'when calling this tool — only the specialist runs.'

  return {
    delegate: tool({
      description,
      inputSchema: z.object({
        subagent_type: z.enum(names).describe('Which specialist to use'),
        task: z.string().describe('Self-contained instruction for the specialist'),
        rationale: z
          .string()
          .describe('One-sentence reason for picking this specialist'),
      }),
      // No execute() — we want the call to surface as a toolCall on
      // the planner's side, not auto-run.
    }),
  } as ToolSet
}
