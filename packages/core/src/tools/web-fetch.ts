import type { Tool, ToolResult } from '../types.js'
import TurndownService from 'turndown'

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
})

// Strip noise elements before markdown conversion
turndown.remove(['script', 'style', 'nav', 'header', 'footer', 'aside', 'iframe', 'noscript'])

export const webFetchTool: Tool = {
  name: 'web_fetch',
  description: `Fetch a web page via HTTP GET and return its content as clean markdown. Much faster than the browser tool (~100ms vs ~3s) and does NOT trigger anti-bot detection because it makes a simple HTTP request, not a headless browser visit.

Use this as the DEFAULT for reading web pages and articles. Only fall back to the 'browser' tool when:
- The page requires JavaScript rendering (SPAs like juejin.cn, medium.com)
- You need to interact with the page (click, type, screenshot)
- web_fetch returns empty/meaningless content (the page needs JS)

Parameters:
- url: The URL to fetch (required)
- max_length: Maximum content length to return in characters (default 10000)
- raw: If true, return raw HTML instead of markdown (default false)`,
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
      max_length: { type: 'number', description: 'Max chars to return (default 10000)' },
      raw: { type: 'boolean', description: 'Return raw HTML instead of markdown (default false)' },
    },
    required: ['url'],
  },

  async execute(params): Promise<ToolResult> {
    const url = params.url as string
    if (!url) return { success: false, output: '', error: 'url is required' }

    const maxLength = (params.max_length as number) ?? 10000
    const raw = (params.raw as boolean) ?? false

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      })

      if (!response.ok) {
        return {
          success: false,
          output: '',
          error: `HTTP ${response.status} ${response.statusText}`,
        }
      }

      const contentType = response.headers.get('content-type') ?? ''

      // JSON response — return formatted
      if (contentType.includes('application/json')) {
        const json = await response.json()
        const text = JSON.stringify(json, null, 2)
        return {
          success: true,
          output: text.length > maxLength ? text.slice(0, maxLength) + '\n... (truncated)' : text,
        }
      }

      // HTML response — convert to markdown (or return raw)
      const html = await response.text()
      if (raw) {
        return {
          success: true,
          output: html.length > maxLength ? html.slice(0, maxLength) + '\n... (truncated)' : html,
        }
      }

      const markdown = turndown.turndown(html)
      // Also extract <title> for context
      const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i)
      const title = titleMatch?.[1]?.trim() ?? ''
      const header = title ? `# ${title}\n\n` : ''
      const content = header + markdown

      return {
        success: true,
        output: content.length > maxLength
          ? content.slice(0, maxLength) + '\n... (truncated)'
          : content,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Distinguish timeout from other errors
      if (msg.includes('abort') || msg.includes('timeout')) {
        return { success: false, output: '', error: `Fetch timeout (15s): ${url}` }
      }
      return { success: false, output: '', error: `Fetch error: ${msg}` }
    }
  },
}
