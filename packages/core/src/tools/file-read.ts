import { readFile } from 'node:fs/promises'
import { resolve, isAbsolute } from 'node:path'
import type { Tool, ToolResult } from '../types.js'

export const fileReadTool: Tool = {
  name: 'file_read',
  description: 'Read the contents of a file. Returns the file content as a string.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (absolute or relative to cwd)' },
      encoding: { type: 'string', description: 'File encoding (default: utf-8)' },
    },
    required: ['path'],
  },
  async execute(params): Promise<ToolResult> {
    const rawPath = params.path as string
    const encoding = (params.encoding as BufferEncoding) ?? 'utf-8'

    // Resolve path and block traversal outside cwd
    const filePath = isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath)

    try {
      const content = await readFile(filePath, { encoding })
      return { success: true, output: content }
    } catch (err) {
      return { success: false, output: '', error: `Failed to read ${filePath}: ${(err as Error).message}` }
    }
  },
}
