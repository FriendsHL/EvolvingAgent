import type { ExecutableSkill, SkillContext, SkillResult } from '../../types.js'

/**
 * Skill: web-search
 * Uses the browser tool to search the web and extract relevant information.
 * Steps: goto search engine → type query → extract results → summarize
 */
export const webSearchSkill: ExecutableSkill = {
  id: 'web-search',
  name: 'Web Search',
  description: 'Search the web for information using a headless browser, extract and summarize results',
  category: 'builtin',
  triggers: ['搜索', '查找', '查一下', 'search', 'look up', 'find information', '知乎', 'google', '百度', '网上'],
  inputs: [
    { name: 'query', description: 'Search query', type: 'string', required: true },
    { name: 'engine', description: 'Search engine: google, bing, baidu (default: bing)', type: 'string' },
    { name: 'maxResults', description: 'Max results to extract (default: 5)', type: 'number' },
  ],

  async execute(params, ctx: SkillContext): Promise<SkillResult> {
    const query = params.query as string
    if (!query) return { success: false, output: '', error: 'query is required' }

    const engine = (params.engine as string) ?? 'bing'
    const maxResults = (params.maxResults as number) ?? 5

    const searchUrls: Record<string, string> = {
      google: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      bing: `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
      baidu: `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
    }

    const url = searchUrls[engine] ?? searchUrls.bing
    ctx.emit(`Searching ${engine} for: ${query}`)

    // Step 1: Navigate to search engine
    const gotoResult = await ctx.useTool('browser', { action: 'goto', url })
    if (!gotoResult.success) {
      return { success: false, output: '', error: `Failed to open search page: ${gotoResult.error}` }
    }

    // Step 2: Wait for results to load
    await ctx.useTool('browser', { action: 'wait', selector: 'body', timeout: 5000 })

    // Step 3: Extract visible text from results
    ctx.emit('Extracting search results...')
    const textResult = await ctx.useTool('browser', { action: 'text' })
    if (!textResult.success) {
      return { success: false, output: '', error: `Failed to extract text: ${textResult.error}` }
    }

    // Step 4: Use LLM to extract and summarize the top results
    ctx.emit('Summarizing results...')
    const summary = await ctx.think(
      `The user searched for: "${query}"\n\nHere is the raw text from the search results page:\n\n${textResult.output.slice(0, 4000)}\n\n` +
      `Please extract the top ${maxResults} most relevant results. For each result, provide:\n` +
      `1. Title\n2. Brief snippet/description\n3. URL (if visible)\n\n` +
      `Then provide a brief summary of the key findings related to the query. Be concise and factual.`
    )

    return {
      success: true,
      output: summary,
      data: { query, engine, rawTextLength: textResult.output.length },
    }
  },
}
