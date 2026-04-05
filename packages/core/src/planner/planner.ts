import { z } from 'zod'
import { type LLMProvider, type GenerateResult } from '../llm/provider.js'
import type { Experience, Plan, PromptConfig } from '../types.js'
import { nanoid } from 'nanoid'

const PLANNER_SYSTEM_PROMPT = `You are a task planner for an AI Agent system. Your job is to decompose user tasks into executable steps.

Each step should specify:
- A clear description of what to do
- Which tool to use (if any): shell, file_read, file_write, http
- The parameters for that tool

Respond with a JSON object:
{
  "task": "summary of the task",
  "steps": [
    {
      "description": "what this step does",
      "tool": "tool_name or null if no tool needed",
      "params": { ... }
    }
  ]
}

If the task is a simple conversation (greeting, question, etc.) that doesn't require tools, return an empty steps array.
Keep plans concise — prefer fewer, well-defined steps over many small ones.`

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
  constructor(private llm: LLMProvider) {}

  async plan(
    userMessage: string,
    relatedExperiences: Experience[],
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): Promise<{ plan: Plan; metrics: GenerateResult['metrics'] }> {
    const config: PromptConfig = {
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      skills: [],
      knowledge: [],
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
      const parsed = planSchema.parse(JSON.parse(result.text))
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

    return { plan, metrics: result.metrics }
  }
}
