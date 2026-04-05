import type { ExecutableSkill, SkillContext, SkillResult } from '../../types.js'

/**
 * Skill: file-batch
 * Batch file operations: find-replace, rename patterns, bulk transforms.
 */
export const fileBatchSkill: ExecutableSkill = {
  id: 'file-batch',
  name: 'File Batch',
  description: 'Batch file operations: find-replace, rename patterns, bulk transforms',
  category: 'builtin',
  triggers: ['批量', 'batch', 'find and replace', '查找替换', 'rename files', '重命名', 'bulk'],
  inputs: [
    { name: 'action', description: 'Action: find-replace, rename, find, count', type: 'string', required: true },
    { name: 'pattern', description: 'File glob pattern or search pattern', type: 'string', required: true },
    { name: 'replacement', description: 'Replacement string (for find-replace/rename)', type: 'string', required: false },
    { name: 'path', description: 'Directory to operate in (default: .)', type: 'string', required: false },
  ],

  async execute(params, ctx: SkillContext): Promise<SkillResult> {
    const action = params.action as string
    const pattern = params.pattern as string
    if (!action) return { success: false, output: '', error: 'action is required' }
    if (!pattern) return { success: false, output: '', error: 'pattern is required' }

    const basePath = (params.path as string) || '.'
    const replacement = params.replacement as string | undefined

    switch (action) {
      case 'find': {
        ctx.emit(`Finding files matching: ${pattern} in ${basePath}`)
        const result = await ctx.useTool('shell', {
          command: `find "${basePath}" -name "${pattern}" 2>/dev/null | head -100`,
        })
        if (!result.success) {
          return { success: false, output: '', error: `Find failed: ${result.error}` }
        }
        const files = result.output.trim()
        const count = files ? files.split('\n').length : 0
        return {
          success: true,
          output: count > 0 ? `Found ${count} file(s):\n${files}` : 'No files found.',
          data: { action, pattern, count },
        }
      }

      case 'count': {
        ctx.emit(`Counting files matching: ${pattern} in ${basePath}`)
        const result = await ctx.useTool('shell', {
          command: `find "${basePath}" -name "${pattern}" 2>/dev/null | wc -l`,
        })
        if (!result.success) {
          return { success: false, output: '', error: `Count failed: ${result.error}` }
        }
        const count = parseInt(result.output.trim(), 10) || 0
        return {
          success: true,
          output: `Found ${count} file(s) matching "${pattern}" in ${basePath}`,
          data: { action, pattern, count },
        }
      }

      case 'find-replace': {
        if (!replacement && replacement !== '') {
          return { success: false, output: '', error: 'replacement is required for find-replace' }
        }
        ctx.emit(`Searching for "${pattern}" in ${basePath}...`)

        // Preview: find matching files
        const grepResult = await ctx.useTool('shell', {
          command: `grep -rl "${pattern}" "${basePath}" 2>/dev/null | head -50`,
        })
        if (!grepResult.success || !grepResult.output.trim()) {
          return {
            success: true,
            output: `No files contain "${pattern}" in ${basePath}. Nothing to replace.`,
            data: { action, pattern, filesChanged: 0 },
          }
        }

        const matchedFiles = grepResult.output.trim().split('\n')
        ctx.emit(`Found ${matchedFiles.length} file(s) containing "${pattern}". Applying replacement...`)

        // Perform the replacement using sed
        // Escape forward slashes in pattern and replacement for sed
        const escapedPattern = pattern.replace(/\//g, '\\/')
        const escapedReplacement = (replacement as string).replace(/\//g, '\\/')
        const sedResult = await ctx.useTool('shell', {
          command: `grep -rl "${pattern}" "${basePath}" 2>/dev/null | head -50 | xargs sed -i '' "s/${escapedPattern}/${escapedReplacement}/g" 2>&1`,
        })

        if (!sedResult.success) {
          return { success: false, output: '', error: `Replace failed: ${sedResult.error}` }
        }

        return {
          success: true,
          output: `Replaced "${pattern}" with "${replacement}" in ${matchedFiles.length} file(s):\n${matchedFiles.join('\n')}`,
          data: { action, pattern, replacement, filesChanged: matchedFiles.length },
        }
      }

      case 'rename': {
        if (!replacement) {
          return { success: false, output: '', error: 'replacement is required for rename' }
        }
        ctx.emit(`Finding files matching: ${pattern} in ${basePath}...`)

        const findResult = await ctx.useTool('shell', {
          command: `find "${basePath}" -name "${pattern}" 2>/dev/null | head -50`,
        })
        if (!findResult.success || !findResult.output.trim()) {
          return {
            success: true,
            output: `No files matching "${pattern}" found in ${basePath}. Nothing to rename.`,
            data: { action, pattern, filesRenamed: 0 },
          }
        }

        const files = findResult.output.trim().split('\n')
        ctx.emit(`Found ${files.length} file(s). Previewing renames...`)

        // Preview the renames
        const previews: string[] = []
        for (const file of files) {
          const dir = file.substring(0, file.lastIndexOf('/'))
          const name = file.substring(file.lastIndexOf('/') + 1)
          const newName = name.replace(new RegExp(pattern.replace(/\*/g, '.*')), replacement)
          if (newName !== name) {
            previews.push(`  ${file} -> ${dir}/${newName}`)
          }
        }

        if (previews.length === 0) {
          return {
            success: true,
            output: 'Pattern matched files but no names would change.',
            data: { action, pattern, filesRenamed: 0 },
          }
        }

        ctx.emit(`Renaming ${previews.length} file(s)...`)

        // Execute the renames
        let renamed = 0
        for (const file of files) {
          const dir = file.substring(0, file.lastIndexOf('/'))
          const name = file.substring(file.lastIndexOf('/') + 1)
          const newName = name.replace(new RegExp(pattern.replace(/\*/g, '.*')), replacement)
          if (newName !== name) {
            const mvResult = await ctx.useTool('shell', {
              command: `mv "${file}" "${dir}/${newName}"`,
            })
            if (mvResult.success) renamed++
          }
        }

        return {
          success: true,
          output: `Renamed ${renamed} file(s):\n${previews.join('\n')}`,
          data: { action, pattern, replacement, filesRenamed: renamed },
        }
      }

      default:
        return {
          success: false,
          output: '',
          error: `Unknown action: ${action}. Supported: find, count, find-replace, rename`,
        }
    }
  },
}
