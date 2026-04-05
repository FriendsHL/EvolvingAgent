import type { ExecutableSkill, SkillContext, SkillResult } from '../../types.js'

/**
 * Skill: data-extract
 * Extract structured data from URLs, files, or APIs using tools + LLM.
 */
export const dataExtractSkill: ExecutableSkill = {
  id: 'data-extract',
  name: 'Data Extract',
  description: 'Extract structured data from URLs, files, or APIs',
  category: 'builtin',
  triggers: ['提取', '抽取', 'extract', 'scrape', 'parse', '解析', 'data from'],
  inputs: [
    { name: 'source', description: 'URL or file path to extract from', type: 'string', required: true },
    { name: 'schema', description: 'Description of desired output format', type: 'string', required: false },
    { name: 'format', description: 'Output format: json, csv, text (default: json)', type: 'string', required: false },
  ],

  async execute(params, ctx: SkillContext): Promise<SkillResult> {
    const source = params.source as string
    if (!source) return { success: false, output: '', error: 'source is required' }

    const schema = (params.schema as string) ?? 'Extract all key data points into a structured format.'
    const format = (params.format as string) ?? 'json'
    const isUrl = source.startsWith('http://') || source.startsWith('https://')

    let rawContent = ''

    if (isUrl) {
      ctx.emit(`Fetching data from URL: ${source}`)

      // Try HTTP first for API endpoints (faster, simpler)
      const httpResult = await ctx.useTool('http', { method: 'GET', url: source })
      if (httpResult.success && httpResult.output.trim()) {
        rawContent = httpResult.output
      } else {
        // Fallback to browser for rendered pages
        ctx.emit('HTTP fetch incomplete, trying browser...')
        const gotoResult = await ctx.useTool('browser', { action: 'goto', url: source, timeout: 15000 })
        if (!gotoResult.success) {
          return { success: false, output: '', error: `Cannot access URL: ${gotoResult.error}` }
        }
        await ctx.useTool('browser', { action: 'wait', selector: 'body', timeout: 5000 })
        const textResult = await ctx.useTool('browser', { action: 'text' })
        if (!textResult.success) {
          return { success: false, output: '', error: `Failed to extract page text: ${textResult.error}` }
        }
        rawContent = textResult.output
      }
    } else {
      // File path
      ctx.emit(`Reading file: ${source}`)
      const fileResult = await ctx.useTool('file_read', { path: source })
      if (!fileResult.success) {
        return { success: false, output: '', error: `Failed to read file: ${fileResult.error}` }
      }
      rawContent = fileResult.output
    }

    if (!rawContent.trim()) {
      return { success: false, output: '', error: 'No content retrieved from source' }
    }

    // Use LLM to extract structured data
    ctx.emit('Extracting structured data...')

    const formatInstructions: Record<string, string> = {
      json: 'Return the extracted data as valid JSON. Use arrays for lists and objects for records.',
      csv: 'Return the extracted data as CSV with a header row. Use commas as delimiters.',
      text: 'Return the extracted data as plain text with clear labels and formatting.',
    }

    const extracted = await ctx.think(
      `Extract structured data from the following raw content.\n\n` +
      `Schema / what to extract: ${schema}\n` +
      `Output format: ${format}\n` +
      `${formatInstructions[format] ?? formatInstructions.json}\n\n` +
      `Raw content (truncated to 5000 chars):\n${rawContent.slice(0, 5000)}\n\n` +
      `Return ONLY the extracted data in the requested format, no extra commentary.`
    )

    return {
      success: true,
      output: extracted,
      data: {
        source,
        isUrl,
        format,
        rawContentLength: rawContent.length,
      },
    }
  },
}
