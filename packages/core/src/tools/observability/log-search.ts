import type { Tool, ToolResult } from '../../types.js'
import type { Experience } from '../../types.js'
import type { ExperienceStore } from '../../memory/experience-store.js'

/**
 * log-search — grep through stored Experience records (tasks, reflections,
 * tags, outcomes). Uses ExperienceStore.getAll('all') and filters in the tool
 * so no new query methods need to be added to the store.
 */
export function createLogSearchTool(experienceStore: ExperienceStore): Tool {
  return {
    name: 'log-search',
    description:
      'Search through past execution experiences by keyword, tag, or outcome. Use this to find prior runs related to a topic or to debug recurring failures.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Free-text search across task descriptions and reflection text',
        },
        tag: { type: 'string', description: 'Filter by experience tag' },
        outcome: {
          type: 'string',
          enum: ['success', 'partial', 'failure'],
          description: 'Filter by outcome',
        },
        limit: { type: 'number', description: 'Max results, default 10' },
      },
    },
    async execute(params): Promise<ToolResult> {
      const query = (params.query as string | undefined)?.trim()
      const tag = (params.tag as string | undefined)?.trim()
      const outcomeRaw = params.outcome as string | undefined
      const limit = Math.max(1, Math.min(100, (params.limit as number | undefined) ?? 10))

      if (!query && !tag && !outcomeRaw) {
        return {
          success: false,
          output: '',
          error: 'At least one of query, tag, or outcome must be provided',
        }
      }

      const outcome =
        outcomeRaw === 'success' || outcomeRaw === 'partial' || outcomeRaw === 'failure'
          ? outcomeRaw
          : undefined

      const all = experienceStore.getAll('all')
      const needle = query?.toLowerCase()

      const matches: Experience[] = []
      for (const exp of all) {
        if (outcome && exp.result !== outcome) continue
        if (tag && !exp.tags.includes(tag)) continue
        if (needle) {
          const haystack = [
            exp.task,
            exp.reflection?.lesson ?? '',
            ...(exp.reflection?.whatWorked ?? []),
            ...(exp.reflection?.whatFailed ?? []),
          ]
            .join(' ')
            .toLowerCase()
          if (!haystack.includes(needle)) continue
        }
        matches.push(exp)
      }

      // Newest first.
      matches.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      const top = matches.slice(0, limit)

      if (top.length === 0) {
        return { success: true, output: 'No experiences matched the given filters.' }
      }

      const lines: string[] = [
        `Found ${matches.length} matching experience${matches.length === 1 ? '' : 's'} (showing ${top.length}):`,
        '',
      ]
      top.forEach((exp, i) => {
        const task = truncate(exp.task, 80)
        lines.push(
          `${i + 1}. [${exp.result}] ${exp.id}  ${exp.timestamp}`,
          `   ${task}`,
        )
        if (exp.tags.length > 0) {
          lines.push(`   tags: ${exp.tags.join(', ')}`)
        }
      })
      return { success: true, output: lines.join('\n') }
    },
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}
