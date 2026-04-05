import { z } from 'zod'
import { generateWithTools, buildMessages, type GenerateResult } from '../llm/provider.js'
import type { ExecutionStep, PromptConfig, Reflection } from '../types.js'

const REFLECTOR_SYSTEM_PROMPT = `You are a post-execution reflector for an AI Agent. Analyze the task execution and produce a structured reflection.

Given:
- The original task
- The execution steps with their results

Respond with a JSON object:
{
  "whatWorked": ["list of things that went well"],
  "whatFailed": ["list of things that failed or could be improved"],
  "lesson": "A concise lesson learned from this execution that could help with similar tasks in the future",
  "tags": ["suggested_tag_1", "suggested_tag_2"]
}

Focus on actionable insights. Be specific about what worked/failed and why.
The lesson should be something that would genuinely help if this type of task comes up again.
Tags should be short keywords that categorize this task (e.g., "debugging", "file-ops", "http", "config").`

const reflectionSchema = z.object({
  whatWorked: z.array(z.string()),
  whatFailed: z.array(z.string()),
  lesson: z.string(),
  tags: z.array(z.string()).optional(),
})

export class Reflector {
  async reflect(
    task: string,
    steps: ExecutionStep[],
    overallResult: 'success' | 'partial' | 'failure',
  ): Promise<{ reflection: Reflection; tags: string[]; metrics: GenerateResult['metrics'] }> {
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
      provider: 'anthropic',
    }

    const messages = buildMessages(config)
    const result = await generateWithTools('reflector', messages)

    let reflection: Reflection
    let tags: string[] = []

    try {
      const parsed = reflectionSchema.parse(JSON.parse(result.text))
      reflection = {
        whatWorked: parsed.whatWorked,
        whatFailed: parsed.whatFailed,
        lesson: parsed.lesson,
      }
      tags = parsed.tags ?? []
    } catch {
      // Fallback reflection
      reflection = {
        whatWorked: overallResult === 'success' ? ['Task completed'] : [],
        whatFailed: overallResult === 'failure' ? ['Task failed'] : [],
        lesson: result.text.slice(0, 200),
      }
    }

    return { reflection, tags, metrics: result.metrics }
  }
}
