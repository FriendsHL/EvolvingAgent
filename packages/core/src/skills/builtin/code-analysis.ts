import type { ExecutableSkill, SkillContext, SkillResult } from '../../types.js'

/**
 * Skill: code-analysis
 * Analyze code structure, find functions, and explain code in a repository.
 */
export const codeAnalysisSkill: ExecutableSkill = {
  id: 'code-analysis',
  name: 'Code Analysis',
  description: 'Analyze code structure, find functions, explain code in a repository',
  category: 'builtin',
  triggers: ['分析代码', '代码', 'analyze code', 'code analysis', 'explain code', 'find function', '查找函数'],
  inputs: [
    { name: 'path', description: 'File or directory path to analyze', type: 'string', required: true },
    { name: 'question', description: 'What to analyze or find', type: 'string', required: false },
  ],

  async execute(params, ctx: SkillContext): Promise<SkillResult> {
    const path = params.path as string
    if (!path) return { success: false, output: '', error: 'path is required' }
    const question = (params.question as string) ?? 'Describe the overall structure and purpose of this code.'

    ctx.emit(`Analyzing: ${path}`)

    // Determine if path is a file or directory
    const typeCheck = await ctx.useTool('shell', {
      command: `if [ -d "${path}" ]; then echo DIR; elif [ -f "${path}" ]; then echo FILE; else echo NOTFOUND; fi`,
    })

    if (!typeCheck.success || typeCheck.output.trim() === 'NOTFOUND') {
      return { success: false, output: '', error: `Path not found: ${path}` }
    }

    const isDirectory = typeCheck.output.trim() === 'DIR'
    let codeContext = ''

    if (isDirectory) {
      // Get file listing with common code extensions
      ctx.emit('Scanning directory structure...')
      const fileList = await ctx.useTool('shell', {
        command: `find "${path}" -type f \\( -name "*.ts" -o -name "*.js" -o -name "*.py" -o -name "*.java" -o -name "*.go" -o -name "*.rs" -o -name "*.tsx" -o -name "*.jsx" \\) | head -50`,
      })

      if (fileList.success && fileList.output.trim()) {
        codeContext += `Files found:\n${fileList.output}\n\n`
      }

      // Get line counts per file
      if (fileList.success && fileList.output.trim()) {
        const wcResult = await ctx.useTool('shell', {
          command: `find "${path}" -type f \\( -name "*.ts" -o -name "*.js" -o -name "*.py" -o -name "*.java" -o -name "*.go" -o -name "*.rs" -o -name "*.tsx" -o -name "*.jsx" \\) | head -50 | xargs wc -l 2>/dev/null | tail -20`,
        })
        if (wcResult.success) {
          codeContext += `Line counts:\n${wcResult.output}\n\n`
        }
      }

      // If there is a question, grep for it
      if (question) {
        ctx.emit(`Searching for: ${question}`)
        const grepResult = await ctx.useTool('shell', {
          command: `grep -rn --include="*.ts" --include="*.js" --include="*.py" --include="*.java" --include="*.go" --include="*.rs" "${question}" "${path}" 2>/dev/null | head -30`,
        })
        if (grepResult.success && grepResult.output.trim()) {
          codeContext += `Grep results for "${question}":\n${grepResult.output}\n\n`
        }
      }

      // Read a few key files (package.json, README, main entry)
      const entryFiles = await ctx.useTool('shell', {
        command: `for f in "${path}/package.json" "${path}/README.md" "${path}/index.ts" "${path}/src/index.ts" "${path}/main.ts"; do [ -f "$f" ] && echo "$f"; done | head -3`,
      })
      if (entryFiles.success && entryFiles.output.trim()) {
        for (const file of entryFiles.output.trim().split('\n')) {
          const content = await ctx.useTool('file_read', { path: file })
          if (content.success) {
            codeContext += `\n--- ${file} ---\n${content.output.slice(0, 2000)}\n`
          }
        }
      }
    } else {
      // Single file — read it
      ctx.emit('Reading file...')
      const content = await ctx.useTool('file_read', { path })
      if (!content.success) {
        return { success: false, output: '', error: `Failed to read file: ${content.error}` }
      }
      codeContext = content.output
    }

    if (!codeContext.trim()) {
      return { success: false, output: '', error: 'No code content found to analyze' }
    }

    // Use LLM for analysis
    ctx.emit('Analyzing code...')
    const analysis = await ctx.think(
      `Analyze the following code.\n\nUser question: ${question}\n\nCode context:\n${codeContext.slice(0, 6000)}\n\n` +
      `Provide a clear analysis addressing the user's question. Include:\n` +
      `1. Overview of the code structure/purpose\n` +
      `2. Key components, functions, or classes\n` +
      `3. Direct answer to the user's question\n` +
      `4. Any notable patterns or potential issues`
    )

    return {
      success: true,
      output: analysis,
      data: { path, isDirectory, question },
    }
  },
}
