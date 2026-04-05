import type { Tool, ToolResult } from '../types.js'

const DEFAULT_TIMEOUT = 30_000

export const httpTool: Tool = {
  name: 'http',
  description: 'Make an HTTP request. Returns the response body as a string.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to request' },
      method: { type: 'string', description: 'HTTP method (default: GET)' },
      headers: { type: 'object', description: 'Request headers' },
      body: { type: 'string', description: 'Request body (for POST/PUT/PATCH)' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 30000)' },
    },
    required: ['url'],
  },
  async execute(params): Promise<ToolResult> {
    const url = params.url as string
    const method = ((params.method as string) ?? 'GET').toUpperCase()
    const headers = (params.headers as Record<string, string>) ?? {}
    const body = params.body as string | undefined
    const timeout = (params.timeout as number) ?? DEFAULT_TIMEOUT

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)

      const response = await fetch(url, {
        method,
        headers,
        body: method !== 'GET' && method !== 'HEAD' ? body : undefined,
        signal: controller.signal,
      })

      clearTimeout(timer)

      const text = await response.text()

      if (!response.ok) {
        return {
          success: false,
          output: text,
          error: `HTTP ${response.status} ${response.statusText}`,
        }
      }

      return { success: true, output: text }
    } catch (err) {
      return { success: false, output: '', error: `HTTP request failed: ${(err as Error).message}` }
    }
  },
}
