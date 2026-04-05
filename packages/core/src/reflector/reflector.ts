import { z } from 'zod'
import { type LLMProvider, type GenerateResult } from '../llm/provider.js'
import type { ExecutionStep, PromptConfig, Reflection } from '../types.js'
import type { HookDraft } from '../hooks/hook-compiler.js'

const REFLECTOR_SYSTEM_PROMPT = `You are a post-execution reflector for an AI Agent. Analyze the task execution and produce a structured reflection.

Given:
- The original task
- The execution steps with their results

Respond with a JSON object:
{
  "whatWorked": ["list of things that went well"],
  "whatFailed": ["list of things that failed or could be improved"],
  "lesson": "A concise lesson learned from this execution that could help with similar tasks in the future",
  "tags": ["suggested_tag_1", "suggested_tag_2"],
  "suggestedSkill": null
}

Focus on actionable insights. Be specific about what worked/failed and why.
The lesson should be something that would genuinely help if this type of task comes up again.
Tags should be short keywords that categorize this task (e.g., "debugging", "file-ops", "http", "config").

If the task involved a reusable multi-step workflow that could benefit future similar tasks, suggest a skill:
{
  ...other fields...,
  "suggestedSkill": {
    "name": "Descriptive Skill Name",
    "trigger": "keyword1, keyword2",
    "steps": [
      "Step 1: Use shell tool to run 'git status'",
      "Step 2: Use file_read to read the output",
      ...
    ]
  }
}
Only suggest a skill if the workflow is genuinely reusable (not for one-off tasks). Set suggestedSkill to null otherwise.

If the execution had safety concerns, errors that could be prevented, or patterns that should be monitored, suggest a hook:
{
  ...other fields...,
  "suggestedHook": {
    "trigger": "before:tool-call",
    "condition": "When the shell tool is called with rm -rf",
    "action": "Block the command and log a warning",
    "reason": "Prevent accidental deletion of important files"
  }
}
Valid triggers: before:plan, after:plan, before:tool-call, after:tool-call, before:llm-call, after:llm-call, before:reflect, after:reflect, on:error, on:startup, cron.
Only suggest a hook if there's a genuine safety or efficiency concern. Set suggestedHook to null otherwise.`

const skillDraftSchema = z.object({
  name: z.string(),
  trigger: z.string(),
  steps: z.array(z.string()),
})

const hookDraftSchema = z.object({
  trigger: z.string(),
  condition: z.string(),
  action: z.string(),
  reason: z.string(),
})

const reflectionSchema = z.object({
  whatWorked: z.array(z.string()),
  whatFailed: z.array(z.string()),
  lesson: z.string(),
  tags: z.array(z.string()).optional(),
  suggestedSkill: skillDraftSchema.nullable().optional(),
  suggestedHook: hookDraftSchema.nullable().optional(),
})

export class Reflector {
  constructor(private llm: LLMProvider) {}

  async reflect(
    task: string,
    steps: ExecutionStep[],
    overallResult: 'success' | 'partial' | 'failure',
  ): Promise<{ reflection: Reflection; tags: string[]; suggestedHook?: HookDraft; metrics: GenerateResult['metrics'] }> {
    const stepsDescription = steps
      .map((s, i) => {
        const status = s.result.success ? 'OK' : 'FAIL'
        const error = s.result.error ? ` | Error: ${s.result.error}` : ''
        const output = s.result.output
          ? ` | Output: ${s.result.output.slice(0, 200)}`
          : ''
        return `${i + 1}. [${status}] ${s.description} (tool: ${s.tool ?? 'none'}, ${s.duration}ms)${output}${error}`
      })
      .join('\n')

    const currentInput = `Task: ${task}\nOverall Result: ${overallResult}\n\nExecution Steps:\n${stepsDescription}`

    const config: PromptConfig = {
      systemPrompt: REFLECTOR_SYSTEM_PROMPT,
      skills: [],
      knowledge: [],
      history: [],
      experiences: [],
      currentInput,
      provider: this.llm.getProviderType(),
    }

    const messages = this.llm.buildMessages(config)
    const result = await this.llm.generate('reflector', messages)

    let reflection: Reflection
    let tags: string[] = []
    let suggestedHook: HookDraft | undefined

    try {
      const parsed = reflectionSchema.parse(JSON.parse(result.text))
      reflection = {
        whatWorked: parsed.whatWorked,
        whatFailed: parsed.whatFailed,
        lesson: parsed.lesson,
        suggestedSkill: parsed.suggestedSkill ?? undefined,
      }
      tags = parsed.tags ?? []

      // Extract suggestedHook if the LLM provided one with a valid trigger
      if (parsed.suggestedHook) {
        suggestedHook = {
          trigger: parsed.suggestedHook.trigger as HookDraft['trigger'],
          condition: parsed.suggestedHook.condition,
          action: parsed.suggestedHook.action,
          reason: parsed.suggestedHook.reason,
        }
      }
    } catch {
      // Fallback reflection
      reflection = {
        whatWorked: overallResult === 'success' ? ['Task completed'] : [],
        whatFailed: overallResult === 'failure' ? ['Task failed'] : [],
        lesson: result.text.slice(0, 200),
      }
    }

    return { reflection, tags, suggestedHook, metrics: result.metrics }
  }
}
