import type { ExecutableSkill, SkillContext, SkillResult } from '../../types.js'

/**
 * Skill: self-repair
 * Detects and fixes common tool failures by installing missing dependencies.
 * Can be triggered automatically when a tool reports specific error patterns.
 */
export const selfRepairSkill: ExecutableSkill = {
  id: 'self-repair',
  name: 'Self Repair',
  description: 'Automatically diagnose and fix tool failures (e.g., install missing dependencies)',
  category: 'builtin',
  triggers: ['修复', '安装依赖', 'fix', 'repair', 'install', 'missing dependency', 'not found', 'cannot find'],
  inputs: [
    { name: 'error', description: 'The error message from the failed tool', type: 'string', required: true },
    { name: 'toolName', description: 'Which tool failed', type: 'string', required: true },
  ],

  async execute(params, ctx: SkillContext): Promise<SkillResult> {
    const error = params.error as string
    const toolName = params.toolName as string
    if (!error || !toolName) {
      return { success: false, output: '', error: 'error and toolName are required' }
    }

    ctx.emit(`Diagnosing failure in tool: ${toolName}`)

    // Known repair patterns
    const repairs = diagnose(error, toolName)

    if (repairs.length === 0) {
      // Ask LLM for diagnosis
      ctx.emit('Unknown error pattern, analyzing...')
      const analysis = await ctx.think(
        `A tool called "${toolName}" failed with this error:\n\n${error}\n\n` +
        `What is the most likely cause? What shell command would fix it?\n` +
        `Respond with JSON: { "diagnosis": "...", "fixCommand": "..." | null }`
      )

      try {
        const parsed = JSON.parse(analysis)
        if (parsed.fixCommand) {
          repairs.push({ diagnosis: parsed.diagnosis, command: parsed.fixCommand })
        } else {
          return {
            success: false,
            output: `Diagnosis: ${parsed.diagnosis}\nNo automatic fix available.`,
            error: 'Manual intervention required',
          }
        }
      } catch {
        return {
          success: false,
          output: `Could not determine fix. Error: ${error}`,
          error: 'Diagnosis failed',
        }
      }
    }

    // Execute repairs
    const results: string[] = []
    for (const repair of repairs) {
      ctx.emit(`Applying fix: ${repair.diagnosis}`)
      ctx.emit(`Running: ${repair.command}`)

      const shellResult = await ctx.useTool('shell', {
        command: repair.command,
        timeout: 120000,
      })

      if (shellResult.success) {
        results.push(`[OK] ${repair.diagnosis}: ${shellResult.output.slice(0, 200)}`)
      } else {
        results.push(`[FAIL] ${repair.diagnosis}: ${shellResult.error}`)
      }
    }

    const allSuccess = results.every((r) => r.startsWith('[OK]'))
    return {
      success: allSuccess,
      output: results.join('\n'),
      error: allSuccess ? undefined : 'Some repairs failed',
      data: { toolName, repairsAttempted: repairs.length },
    }
  },
}

interface RepairAction {
  diagnosis: string
  command: string
}

function diagnose(error: string, toolName: string): RepairAction[] {
  const repairs: RepairAction[] = []
  const lower = error.toLowerCase()

  // Playwright / browser issues
  if (toolName === 'browser') {
    if (lower.includes('executable doesn\'t exist') || lower.includes('playwright install')) {
      repairs.push({
        diagnosis: 'Playwright browser binaries not installed',
        command: 'npx playwright install chromium',
      })
    }
    if (lower.includes('cannot find package') || lower.includes('module not found')) {
      repairs.push({
        diagnosis: 'Playwright npm package not installed',
        command: 'npm install playwright',
      })
    }
  }

  // Generic npm module issues
  if (lower.includes('cannot find module') || lower.includes('module not found')) {
    const moduleMatch = error.match(/(?:Cannot find (?:module|package)|MODULE_NOT_FOUND).*?['"]([^'"]+)['"]/i)
    if (moduleMatch) {
      repairs.push({
        diagnosis: `Missing npm module: ${moduleMatch[1]}`,
        command: `npm install ${moduleMatch[1]}`,
      })
    }
  }

  // Permission issues
  if (lower.includes('permission denied') || lower.includes('eacces')) {
    repairs.push({
      diagnosis: 'Permission issue — trying with adjusted permissions',
      command: `chmod -R u+rwx ${process.cwd()}/node_modules 2>/dev/null || true`,
    })
  }

  return repairs
}
