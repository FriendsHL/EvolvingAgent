import { z } from 'zod'
import { type LLMProvider, type GenerateResult } from '../llm/provider.js'
import type { Experience, Plan, PromptConfig } from '../types.js'
import type { SkillRegistry } from '../skills/skill-registry.js'
import type { CapabilityMap } from '../agent/capability-map.js'
import type { PromptRegistry } from '../prompts/registry.js'
import { nanoid } from 'nanoid'

/**
 * Baseline (source-code) prompt. Phase 4 C introduced `PromptRegistry` which
 * can override this at runtime via `data/prompts/active.json`. This constant
 * remains the authoritative fallback when no override is present — do NOT
 * mutate it at runtime.
 */
export const PLANNER_SYSTEM_PROMPT = `You are a task planner for an AI Agent system. Your job is to decompose user tasks into executable steps.

Each step should specify:
- A clear description of what to do
- Which tool or skill to use (if any)
- The parameters for that tool/skill

Available tools (low-level):
- shell: Run shell commands. params: { command: string }
- file_read: Read files. params: { path: string }
- file_write: Write files. params: { path: string, content: string }
- http: HTTP requests. params: { method: string, url: string, body?: string, headers?: object }
- browser: Control headless browser. params: { action: string, url?: string, selector?: string, text?: string, script?: string }

{SKILLS_SECTION}

{CAPABILITIES_SECTION}

Respond with a JSON object:
{
  "task": "summary of the task",
  "steps": [
    {
      "description": "what this step does",
      "tool": "tool_name or skill:<id> or null if no tool needed",
      "params": { ... }
    }
  ]
}

IMPORTANT:
- Prefer skills over raw tools when a matching skill exists — skills handle complex multi-step workflows automatically.
- For example, use "skill:web-search" instead of manually composing browser goto + text extraction steps.
- If the user pastes a URL or asks about "this page / this site / this article", ALWAYS plan a tool step — use "skill:summarize-url" for content extraction, or "browser" with action "goto"+"text" for interactive inspection. Do not answer conversationally about URLs you have not fetched.
- If the task is a simple conversation (greeting, question, etc.) that doesn't require tools, return an empty steps array.
- Keep plans concise — prefer fewer, well-defined steps over many small ones.
- Only use tools and skills that are listed as available. If the task requires capabilities you don't have, say so honestly instead of trying to use unavailable tools.`

const planSchema = z.object({
  task: z.string(),
  steps: z.array(
    z.object({
      description: z.string(),
      tool: z.string().optional(),
      params: z.record(z.unknown()).optional(),
    }),
  ),
})

export class Planner {
  constructor(
    private llm: LLMProvider,
    private skills?: SkillRegistry,
    private capabilityMap?: CapabilityMap,
    private promptRegistry?: PromptRegistry,
  ) {}

  async plan(
    userMessage: string,
    relatedExperiences: Experience[],
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): Promise<{ plan: Plan; metrics: GenerateResult['metrics'] }> {
    // Build system prompt with available skills and capabilities
    const skillsSection = this.skills
      ? this.skills.describeForPlanner()
      : ''
    const capabilitiesSection = this.capabilityMap
      ? this.capabilityMap.describeForPlanner()
      : ''
    const template = this.promptRegistry?.get('planner') ?? PLANNER_SYSTEM_PROMPT
    const systemPrompt = template
      .replace('{SKILLS_SECTION}', skillsSection)
      .replace('{CAPABILITIES_SECTION}', capabilitiesSection)

    const config: PromptConfig = {
      systemPrompt,
      skills: [],
      history,
      experiences: relatedExperiences,
      currentInput: userMessage,
      provider: this.llm.getProviderType(),
    }

    const messages = this.llm.buildMessages(config)
    const result = await this.llm.generate('planner', messages)

    // Parse the plan from LLM response
    let plan: Plan
    try {
      // Try to extract JSON from the response (may have markdown code blocks)
      let jsonText = result.text
      const jsonMatch = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
      if (jsonMatch) jsonText = jsonMatch[1]

      const parsed = planSchema.parse(JSON.parse(jsonText))
      plan = {
        task: parsed.task,
        steps: parsed.steps.map((s) => ({
          id: nanoid(8),
          description: s.description,
          tool: s.tool,
          params: s.params,
        })),
        relatedExperiences,
      }
    } catch {
      // If parsing fails, treat as a conversational response (no tool steps)
      plan = {
        task: userMessage,
        steps: [],
        relatedExperiences,
      }
    }

    // Validate plan steps against available capabilities
    if (this.capabilityMap && plan.steps.length > 0) {
      const available = new Set(
        this.capabilityMap
          .list()
          .filter((c) => c.confidence > 0)
          .flatMap((c) => [...c.tools, ...c.skills.map((s) => `skill:${s}`)]),
      )

      for (const step of plan.steps) {
        if (!step.tool) continue
        if (!available.has(step.tool)) {
          // Mark the step description with a warning so the executor
          // and the user can see this step may fail.
          step.description = `[WARNING: tool "${step.tool}" may not be available] ${step.description}`
        }
      }
    }

    return { plan, metrics: result.metrics }
  }
}
