import type {
  ExecutableSkill,
  SkillContext,
  SkillDraft,
  SkillParam,
  SkillResult,
  ToolResult,
} from '../types.js'

export interface CompiledSkill {
  skill: ExecutableSkill
  source: SkillDraft
}

/** Known tool names that can appear in step descriptions */
const KNOWN_TOOLS = ['shell', 'file_read', 'file_write', 'http', 'browser']

/**
 * Pattern-based parameter extraction from natural language step descriptions.
 * Looks for `{paramName}` placeholders and common tool-parameter idioms.
 */
const PARAM_PATTERNS: Array<{ pattern: RegExp; params: SkillParam[] }> = [
  {
    pattern: /\{path\}/i,
    params: [{ name: 'path', description: 'File path', type: 'string', required: true }],
  },
  {
    pattern: /\{command\}/i,
    params: [{ name: 'command', description: 'Shell command to run', type: 'string', required: true }],
  },
  {
    pattern: /\{query\}/i,
    params: [{ name: 'query', description: 'Search query', type: 'string', required: true }],
  },
  {
    pattern: /\{url\}/i,
    params: [{ name: 'url', description: 'URL', type: 'string', required: true }],
  },
  {
    pattern: /\{content\}/i,
    params: [{ name: 'content', description: 'Content to write', type: 'string', required: true }],
  },
]

/** Additional generic placeholder pattern: `{someParam}` */
const GENERIC_PLACEHOLDER = /\{(\w+)\}/g

/**
 * Compile a SkillDraft (natural language steps from the LLM reflector)
 * into an ExecutableSkill that can be registered and executed.
 */
export class SkillCompiler {
  /**
   * Compile a SkillDraft into an ExecutableSkill.
   * Each step in the draft is parsed to identify:
   * - Which tool to call
   * - What parameters to pass
   * - How to chain results between steps
   */
  compile(draft: SkillDraft): CompiledSkill {
    const id = toKebabCase(draft.name)
    const triggers = parseTriggers(draft.trigger)
    const inputs = inferParams(draft.steps)
    const parsedSteps = draft.steps.map(parseStep)

    const skill: ExecutableSkill = {
      id,
      name: draft.name,
      description: `Learned skill: ${draft.name} (${draft.steps.length} steps)`,
      category: 'learned',
      triggers,
      inputs,
      available: true,

      // The execute closure captures parsedSteps so each invocation walks
      // through the steps sequentially, passing params and chaining results.
      async execute(
        params: Record<string, unknown>,
        ctx: SkillContext,
      ): Promise<SkillResult> {
        const outputs: string[] = []
        // Accumulate results so later steps can reference earlier output
        let lastResult: ToolResult | undefined

        for (const step of parsedSteps) {
          ctx.emit(`Step: ${step.description}`)

          if (step.tool) {
            // Build tool params by merging caller-provided params with
            // any static params extracted from the step description, and
            // inject the previous step's output as `_previousOutput`.
            const toolParams: Record<string, unknown> = {
              ...step.staticParams,
              ...params,
            }
            if (lastResult) {
              toolParams._previousOutput = lastResult.output
            }

            lastResult = await ctx.useTool(step.tool, toolParams)
            if (!lastResult.success) {
              return {
                success: false,
                output: outputs.join('\n'),
                error: `Step "${step.description}" failed: ${lastResult.error}`,
              }
            }
            outputs.push(lastResult.output)
          } else {
            // No tool identified — use LLM reasoning for this step
            const context = lastResult
              ? `Previous step output:\n${lastResult.output}\n\n`
              : ''
            const thought = await ctx.think(
              `${context}Task step: ${step.description}\nUser params: ${JSON.stringify(params)}`,
            )
            outputs.push(thought)
          }
        }

        return {
          success: true,
          output: outputs.join('\n---\n'),
        }
      },
    }

    return { skill, source: draft }
  }
}

// ── Internal helpers ──────────────────────────────────────────────

interface ParsedStep {
  description: string
  tool: string | undefined
  staticParams: Record<string, unknown>
}

/**
 * Parse a single natural language step to extract tool name and static params.
 * Examples:
 *   "Use shell tool to run 'git status'" → tool: shell, staticParams: { command: 'git status' }
 *   "Read the config file at {path}"     → tool: file_read, staticParams: {}
 */
function parseStep(step: string): ParsedStep {
  const lower = step.toLowerCase()
  let tool: string | undefined
  const staticParams: Record<string, unknown> = {}

  // Detect which tool the step references
  for (const t of KNOWN_TOOLS) {
    // Match tool name as word boundary: "use shell tool", "file_read the output"
    const pattern = new RegExp(`\\b${t.replace('_', '[_ ]')}\\b`, 'i')
    if (pattern.test(lower)) {
      tool = t
      break
    }
  }

  // Extract quoted literals as static params (e.g. run 'git status')
  if (tool === 'shell') {
    const quoted = step.match(/['"]([^'"]+)['"]/)?.[1]
    if (quoted) staticParams.command = quoted
  }

  if (tool === 'http') {
    const urlMatch = step.match(/https?:\/\/\S+/i)
    if (urlMatch) staticParams.url = urlMatch[0]
  }

  return { description: step, tool, staticParams }
}

/** Convert a human-readable name to a kebab-case id */
function toKebabCase(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** Split trigger string into individual trigger keywords */
function parseTriggers(trigger: string): string[] {
  return trigger
    .split(/[,;]+/)
    .map((t) => t.trim())
    .filter(Boolean)
}

/** Infer input parameters from all step descriptions */
function inferParams(steps: string[]): SkillParam[] {
  const seen = new Set<string>()
  const params: SkillParam[] = []

  const allText = steps.join(' ')

  // Check well-known patterns first
  for (const { pattern, params: knownParams } of PARAM_PATTERNS) {
    if (pattern.test(allText)) {
      for (const p of knownParams) {
        if (!seen.has(p.name)) {
          seen.add(p.name)
          params.push(p)
        }
      }
    }
  }

  // Scan for any remaining {placeholder} tokens
  let match: RegExpExecArray | null
  // Reset lastIndex for the global regex
  GENERIC_PLACEHOLDER.lastIndex = 0
  while ((match = GENERIC_PLACEHOLDER.exec(allText)) !== null) {
    const name = match[1]
    if (!seen.has(name)) {
      seen.add(name)
      params.push({
        name,
        description: `Parameter: ${name}`,
        type: 'string',
        required: true,
      })
    }
  }

  return params
}
