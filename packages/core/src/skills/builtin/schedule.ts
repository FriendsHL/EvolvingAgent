import type { ExecutableSkill, SkillContext, SkillResult } from '../../types.js'

/**
 * Skill: schedule
 * Simple in-memory task scheduling — create, list, and cancel recurring shell commands.
 */

interface ScheduledTask {
  id: string
  command: string
  intervalMs: number
  createdAt: string
  lastRun?: string
  runCount: number
}

// Module-level state: active timers and their metadata
const activeTasks = new Map<string, { timer: ReturnType<typeof setInterval>; meta: ScheduledTask }>()
let nextId = 1

export const scheduleSkill: ExecutableSkill = {
  id: 'schedule',
  name: 'Schedule',
  description: 'Schedule tasks to run at intervals or specific times',
  category: 'builtin',
  triggers: ['定时', '计划', 'schedule', 'cron', 'timer', 'every', 'interval', '每隔'],
  inputs: [
    { name: 'action', description: 'Action: create, list, cancel', type: 'string', required: true },
    { name: 'interval', description: 'Interval in seconds (for create)', type: 'number', required: false },
    { name: 'command', description: 'Shell command to execute (for create)', type: 'string', required: false },
    { name: 'taskId', description: 'Task ID (for cancel)', type: 'string', required: false },
  ],

  async execute(params, ctx: SkillContext): Promise<SkillResult> {
    const action = params.action as string
    if (!action) return { success: false, output: '', error: 'action is required' }

    switch (action) {
      case 'create': {
        const interval = params.interval as number | undefined
        const command = params.command as string | undefined
        if (!interval || interval <= 0) {
          return { success: false, output: '', error: 'interval (positive number of seconds) is required for create' }
        }
        if (!command) {
          return { success: false, output: '', error: 'command is required for create' }
        }

        const taskId = `task-${nextId++}`
        const intervalMs = interval * 1000
        const meta: ScheduledTask = {
          id: taskId,
          command,
          intervalMs,
          createdAt: new Date().toISOString(),
          runCount: 0,
        }

        ctx.emit(`Creating scheduled task ${taskId}: "${command}" every ${interval}s`)

        const timer = setInterval(async () => {
          try {
            await ctx.useTool('shell', { command })
            meta.lastRun = new Date().toISOString()
            meta.runCount++
          } catch {
            // Silently continue — the task keeps running
          }
        }, intervalMs)

        // Prevent the timer from keeping the process alive if it is the only ref
        if (timer.unref) timer.unref()

        activeTasks.set(taskId, { timer, meta })

        return {
          success: true,
          output: `Scheduled task created.\n  ID: ${taskId}\n  Command: ${command}\n  Interval: ${interval}s`,
          data: { taskId, command, interval },
        }
      }

      case 'list': {
        if (activeTasks.size === 0) {
          return { success: true, output: 'No active scheduled tasks.', data: { count: 0 } }
        }

        const lines: string[] = ['Active scheduled tasks:', '']
        for (const [id, { meta }] of activeTasks) {
          lines.push(`  [${id}]`)
          lines.push(`    Command:  ${meta.command}`)
          lines.push(`    Interval: ${meta.intervalMs / 1000}s`)
          lines.push(`    Created:  ${meta.createdAt}`)
          lines.push(`    Runs:     ${meta.runCount}`)
          if (meta.lastRun) {
            lines.push(`    Last run: ${meta.lastRun}`)
          }
          lines.push('')
        }

        return {
          success: true,
          output: lines.join('\n'),
          data: { count: activeTasks.size },
        }
      }

      case 'cancel': {
        const taskId = params.taskId as string | undefined
        if (!taskId) {
          return { success: false, output: '', error: 'taskId is required for cancel' }
        }

        const entry = activeTasks.get(taskId)
        if (!entry) {
          return { success: false, output: '', error: `Task not found: ${taskId}` }
        }

        clearInterval(entry.timer)
        activeTasks.delete(taskId)
        ctx.emit(`Cancelled task ${taskId}`)

        return {
          success: true,
          output: `Task ${taskId} cancelled. It ran ${entry.meta.runCount} time(s).`,
          data: { taskId, runCount: entry.meta.runCount },
        }
      }

      default:
        return {
          success: false,
          output: '',
          error: `Unknown action: ${action}. Supported: create, list, cancel`,
        }
    }
  },
}
