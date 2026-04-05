import { exec } from 'node:child_process'
import type { Tool, ToolResult } from '../types.js'

const DEFAULT_TIMEOUT = 30_000

export const shellTool: Tool = {
  name: 'shell',
  description:
    'Execute a shell command. Returns stdout on success, stderr on failure. Use for running scripts, installing packages, checking system state, etc.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 30000)' },
      cwd: { type: 'string', description: 'Working directory (default: process.cwd())' },
    },
    required: ['command'],
  },
  async execute(params): Promise<ToolResult> {
    const command = params.command as string
    const timeout = (params.timeout as number) ?? DEFAULT_TIMEOUT
    const cwd = (params.cwd as string) ?? process.cwd()

    return new Promise((resolve) => {
      exec(command, { timeout, cwd, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          resolve({
            success: false,
            output: stdout || '',
            error: stderr || error.message,
          })
        } else {
          resolve({
            success: true,
            output: stdout,
            error: stderr || undefined,
          })
        }
      })
    })
  },
}
