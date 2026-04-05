import { writeFile, mkdir } from 'node:fs/promises'
import { resolve, isAbsolute, dirname } from 'node:path'
import type { Tool, ToolResult } from '../types.js'

export const fileWriteTool: Tool = {
  name: 'file_write',
  description: 'Write content to a file. Creates parent directories if needed.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (absolute or relative to cwd)' },
      content: { type: 'string', description: 'Content to write' },
      append: { type: 'boolean', description: 'If true, append to file instead of overwrite (default: false)' },
    },
    required: ['path', 'content'],
  },
  async execute(params): Promise<ToolResult> {
    const rawPath = params.path as string
    const content = params.content as string
    const append = (params.append as boolean) ?? false

    const filePath = isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath)

    try {
      await mkdir(dirname(filePath), { recursive: true })

      if (append) {
        const { appendFile } = await import('node:fs/promises')
        await appendFile(filePath, content, 'utf-8')
      } else {
        await writeFile(filePath, content, 'utf-8')
      }

      return { success: true, output: `Written to ${filePath}` }
    } catch (err) {
      return { success: false, output: '', error: `Failed to write ${filePath}: ${(err as Error).message}` }
    }
  },
}
