import type { Tool, ToolResult } from '../../types.js'
import type { ExperienceStore } from '../../memory/experience-store.js'

/**
 * trace — fetch the full execution trace for an experience (steps, tool
 * calls, durations, reflection). Use after `log-search` to drill into a
 * specific run.
 */
export function createTraceTool(experienceStore: ExperienceStore): Tool {
  return {
    name: 'trace',
    description:
      'Fetch the full execution trace for a specific experience: every plan step, every tool call, durations, and the reflection. Use this after `log-search` to drill into a specific run.',
    parameters: {
      type: 'object',
      properties: {
        experienceId: {
          type: 'string',
          description: 'The experience id from log-search',
        },
      },
      required: ['experienceId'],
    },
    async execute(params): Promise<ToolResult> {
      const id = (params.experienceId as string | undefined)?.trim()
      if (!id) {
        return { success: false, output: '', error: 'experienceId is required' }
      }

      const exp = await experienceStore.getAnyPool(id)
      if (!exp) {
        return {
          success: false,
          output: '',
          error: `No experience found with id: ${id}`,
        }
      }

      const lines: string[] = [
        `Experience: ${exp.id}`,
        `Timestamp:  ${exp.timestamp}`,
        `Outcome:    ${exp.result}`,
        `Tags:       ${exp.tags.length > 0 ? exp.tags.join(', ') : '(none)'}`,
        '',
        'Task:',
        `  ${exp.task}`,
        '',
      ]

      const steps = exp.steps ?? []
      let totalDuration = 0
      lines.push(`Steps (${steps.length}):`)
      if (steps.length === 0) {
        lines.push('  (no steps recorded)')
      } else {
        steps.forEach((step, i) => {
          totalDuration += step.duration ?? 0
          lines.push(`  ${i + 1}. ${step.description}`)
          if (step.tool) {
            lines.push(`     tool:     ${step.tool}`)
          }
          if (step.params && Object.keys(step.params).length > 0) {
            lines.push(`     params:   ${truncate(safeJson(step.params), 160)}`)
          }
          const ok = step.result?.success ? 'success' : 'failure'
          lines.push(`     result:   ${ok} (${step.duration ?? 0} ms)`)
          if (!step.result?.success && step.result?.error) {
            lines.push(`     error:    ${truncate(step.result.error, 200)}`)
          }
        })
      }

      lines.push('', 'Reflection:')
      const r = exp.reflection
      if (r) {
        if (r.whatWorked?.length) {
          lines.push('  whatWorked:')
          for (const w of r.whatWorked) lines.push(`    - ${w}`)
        }
        if (r.whatFailed?.length) {
          lines.push('  whatFailed:')
          for (const w of r.whatFailed) lines.push(`    - ${w}`)
        }
        if (r.lesson) {
          lines.push(`  lesson:   ${r.lesson}`)
        }
      } else {
        lines.push('  (no reflection recorded)')
      }

      lines.push('', `Totals: ${steps.length} steps, ${totalDuration} ms`)
      return { success: true, output: lines.join('\n') }
    },
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
