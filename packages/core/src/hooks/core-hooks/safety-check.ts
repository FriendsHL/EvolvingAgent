import type { Hook, HookContext } from '../../types.js'

// Dangerous command patterns that require extra caution
const DANGEROUS_PATTERNS = [
  /\brm\s+(-rf?|--recursive)\s+[\/~]/i,
  /\brm\s+-rf?\s+\*/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\bkill\s+-9\s+1\b/,
  /\b>\s*\/dev\/sd[a-z]/i,
  /\bchmod\s+-R\s+777\s+\//i,
  /\bcurl\b.*\|\s*(bash|sh|zsh)\b/i,
]

interface ToolCallData {
  toolName: string
  params: Record<string, unknown>
}

/**
 * Core Hook: safety-check
 * Trigger: before:tool-call (modifying)
 * Blocks or warns about dangerous shell commands.
 */
export const safetyCheck: Hook = {
  id: 'core:safety-check',
  name: 'safety-check',
  description: 'Block dangerous tool calls (destructive shell commands, etc.)',
  trigger: 'before:tool-call',
  priority: 100,
  enabled: true,
  source: 'core',

  async handler(context: HookContext): Promise<unknown> {
    const data = context.data as ToolCallData
    if (data.toolName !== 'shell') return undefined

    const command = data.params.command as string
    if (!command) return undefined

    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        throw new Error(
          `[safety-check] Blocked dangerous command: "${command}" (matched pattern: ${pattern})`,
        )
      }
    }

    return undefined
  },

  health: { consecutiveFailures: 0, totalRuns: 0, successRate: 1 },
  safety: { timeout: 500, maxRetries: 0, fallbackBehavior: 'abort', canBeDisabledByAgent: false },
}
