import type { ExecutableSkill, SkillContext, SkillResult } from '../../types.js'

/**
 * Skill: summarize-url
 * Visits a URL, extracts the page content, and produces a structured summary.
 */
export const summarizeUrlSkill: ExecutableSkill = {
  id: 'summarize-url',
  name: 'Summarize URL',
  description: 'Visit a web page and produce a structured summary of its content',
  category: 'builtin',
  triggers: ['总结', '阅读', '读一下', 'summarize', 'read page', 'what does this page say', 'url', 'http://', 'https://'],
  inputs: [
    { name: 'url', description: 'The URL to visit and summarize', type: 'string', required: true },
    { name: 'focus', description: 'Specific aspect to focus on (optional)', type: 'string' },
  ],

  async execute(params, ctx: SkillContext): Promise<SkillResult> {
    const url = params.url as string
    if (!url) return { success: false, output: '', error: 'url is required' }
    const focus = params.focus as string | undefined

    ctx.emit(`Visiting: ${url}`)

    // Step 1: Navigate to the URL
    const gotoResult = await ctx.useTool('browser', { action: 'goto', url, timeout: 15000 })
    if (!gotoResult.success) {
      // Fallback to HTTP tool if browser fails
      ctx.emit('Browser failed, trying HTTP fallback...')
      const httpResult = await ctx.useTool('http', { method: 'GET', url })
      if (!httpResult.success) {
        return { success: false, output: '', error: `Cannot access URL: ${gotoResult.error}` }
      }
      // Summarize raw HTML
      const summary = await ctx.think(
        `Summarize the following web page content${focus ? ` with focus on: ${focus}` : ''}.\n\nRaw HTML (truncated):\n${httpResult.output.slice(0, 4000)}\n\nProvide a clear, structured summary.`
      )
      return { success: true, output: summary, data: { url, method: 'http' } }
    }

    // Step 2: Extract text content
    ctx.emit('Extracting page content...')
    const textResult = await ctx.useTool('browser', { action: 'text' })
    if (!textResult.success) {
      return { success: false, output: '', error: `Failed to extract text: ${textResult.error}` }
    }

    // Step 3: Get page title
    const titleResult = await ctx.useTool('browser', {
      action: 'evaluate',
      script: 'document.title',
    })
    const title = titleResult.success ? titleResult.output : 'Unknown'

    // Step 4: LLM summarization
    ctx.emit('Generating summary...')
    const focusPrompt = focus ? `\nSpecifically focus on: ${focus}` : ''
    const summary = await ctx.think(
      `Summarize the following web page.\n\nTitle: ${title}\nURL: ${url}${focusPrompt}\n\nPage content:\n${textResult.output.slice(0, 4000)}\n\n` +
      `Provide:\n1. A one-line summary\n2. Key points (bullet list)\n3. Any important details, quotes, or data\n\nBe concise and factual.`
    )

    return {
      success: true,
      output: summary,
      data: { url, title, contentLength: textResult.output.length, method: 'browser' },
    }
  },
}
