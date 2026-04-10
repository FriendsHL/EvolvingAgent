import { describe, it, expect, vi, beforeEach } from 'vitest'
import { webFetchTool } from './web-fetch.js'

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => {
  mockFetch.mockReset()
})

function makeResponse(body: string, init?: { status?: number; statusText?: string; headers?: Record<string, string> }) {
  const status = init?.status ?? 200
  const statusText = init?.statusText ?? 'OK'
  const headers = new Map(Object.entries(init?.headers ?? { 'content-type': 'text/html' }))
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: { get: (k: string) => headers.get(k) ?? null },
    text: async () => body,
    json: async () => JSON.parse(body),
  }
}

describe('webFetchTool', () => {
  it('has correct name and required params', () => {
    expect(webFetchTool.name).toBe('web_fetch')
    expect(webFetchTool.parameters.required).toContain('url')
  })

  it('fetches HTML and returns markdown with title', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(
      '<html><head><title>Test Page</title></head><body><h1>Hello</h1><p>World</p></body></html>',
    ))

    const result = await webFetchTool.execute({ url: 'https://example.com' })
    expect(result.success).toBe(true)
    expect(result.output).toContain('# Test Page')
    expect(result.output).toContain('Hello')
    expect(result.output).toContain('World')
  })

  it('handles 404 gracefully', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse('Not Found', {
      status: 404,
      statusText: 'Not Found',
    }))

    const result = await webFetchTool.execute({ url: 'https://example.com/missing' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('HTTP 404')
    expect(result.error).toContain('Not Found')
  })

  it('handles timeout error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'))

    const result = await webFetchTool.execute({ url: 'https://slow.example.com' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('Fetch timeout')
  })

  it('returns formatted JSON for application/json content type', async () => {
    const jsonData = { name: 'test', value: 42 }
    mockFetch.mockResolvedValueOnce(makeResponse(JSON.stringify(jsonData), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }))

    const result = await webFetchTool.execute({ url: 'https://api.example.com/data' })
    expect(result.success).toBe(true)
    expect(result.output).toContain('"name": "test"')
    expect(result.output).toContain('"value": 42')
  })

  it('respects max_length and truncates', async () => {
    const longContent = '<html><body>' + 'x'.repeat(20000) + '</body></html>'
    mockFetch.mockResolvedValueOnce(makeResponse(longContent))

    const result = await webFetchTool.execute({ url: 'https://example.com', max_length: 100 })
    expect(result.success).toBe(true)
    expect(result.output.length).toBeLessThanOrEqual(120) // 100 + "... (truncated)"
    expect(result.output).toContain('... (truncated)')
  })

  it('raw mode returns HTML instead of markdown', async () => {
    const html = '<html><body><h1>Hello</h1></body></html>'
    mockFetch.mockResolvedValueOnce(makeResponse(html))

    const result = await webFetchTool.execute({ url: 'https://example.com', raw: true })
    expect(result.success).toBe(true)
    expect(result.output).toContain('<h1>Hello</h1>')
  })

  it('returns error when url is missing', async () => {
    const result = await webFetchTool.execute({})
    expect(result.success).toBe(false)
    expect(result.error).toContain('url is required')
  })

  it('handles generic fetch errors', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const result = await webFetchTool.execute({ url: 'https://down.example.com' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('Fetch error')
    expect(result.error).toContain('ECONNREFUSED')
  })

  it('strips script/style/nav tags from markdown output', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(
      '<html><body><script>alert(1)</script><style>.x{}</style><nav>Menu</nav><p>Content</p></body></html>',
    ))

    const result = await webFetchTool.execute({ url: 'https://example.com' })
    expect(result.success).toBe(true)
    expect(result.output).toContain('Content')
    expect(result.output).not.toContain('alert(1)')
    expect(result.output).not.toContain('.x{}')
  })
})
