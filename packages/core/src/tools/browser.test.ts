import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Browser tool tests.
 *
 * These tests mock playwright to avoid launching real chromium in CI.
 * The mocks verify that the tool code paths (goto, text, networkidle wait,
 * launch args, clean env) are wired correctly.
 *
 * For real integration testing with chromium, run manually:
 *   1. goto a data URL: browser.execute({ action: 'goto', url: 'data:text/html,<h1>Hi</h1>' })
 *      → verify output contains "Navigated to" and title
 *   2. text with missing selector: browser.execute({ action: 'text', selector: '.nope' })
 *      → verify 5s fallback to body text (not 30s hang)
 *   3. networkidle on data URL: should resolve immediately, not hang
 */

// We mock the entire playwright module to avoid launching chromium.
// All mock methods must return Promises where the real API does, because
// browser.ts chains .catch() on close/close calls.
const mockPage = {
  goto: vi.fn(),
  title: vi.fn(),
  waitForLoadState: vi.fn(),
  locator: vi.fn(),
  isClosed: vi.fn(() => false),
  close: vi.fn().mockResolvedValue(undefined),
  click: vi.fn(),
  fill: vi.fn(),
  screenshot: vi.fn(),
  evaluate: vi.fn(),
  waitForSelector: vi.fn(),
  goBack: vi.fn(),
  content: vi.fn(),
}

const mockContext = {
  newPage: vi.fn().mockResolvedValue(mockPage),
  close: vi.fn().mockResolvedValue(undefined),
  addInitScript: vi.fn().mockResolvedValue(undefined),
}

const mockBrowser = {
  isConnected: vi.fn(() => true),
  newContext: vi.fn().mockResolvedValue(mockContext),
  close: vi.fn().mockResolvedValue(undefined),
}

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue(mockBrowser),
  },
}))

// Import AFTER mock is set up
const { browserTool } = await import('./browser.js')

beforeEach(() => {
  // Reset call counts but keep default implementations
  mockPage.goto.mockReset()
  mockPage.title.mockReset()
  mockPage.waitForLoadState.mockReset()
  mockPage.locator.mockReset()
  mockPage.isClosed.mockReturnValue(false)
  mockPage.close.mockResolvedValue(undefined)
  mockContext.newPage.mockResolvedValue(mockPage)
  mockContext.close.mockResolvedValue(undefined)
  mockContext.addInitScript.mockResolvedValue(undefined)
  mockBrowser.isConnected.mockReturnValue(true)
  mockBrowser.newContext.mockResolvedValue(mockContext)
  mockBrowser.close.mockResolvedValue(undefined)
})

describe('browserTool', () => {
  it('has correct name', () => {
    expect(browserTool.name).toBe('browser')
  })

  it('goto navigates and returns title + status', async () => {
    mockPage.goto.mockResolvedValueOnce({ status: () => 200 })
    mockPage.waitForLoadState.mockResolvedValueOnce(undefined)
    mockPage.title.mockResolvedValueOnce('Test Page')

    const result = await browserTool.execute({ action: 'goto', url: 'https://example.com' })
    expect(result.success).toBe(true)
    expect(result.output).toContain('Navigated to https://example.com')
    expect(result.output).toContain('Test Page')
    expect(result.output).toContain('200')
  })

  it('goto calls networkidle wait after navigation', async () => {
    mockPage.goto.mockResolvedValueOnce({ status: () => 200 })
    mockPage.waitForLoadState.mockResolvedValueOnce(undefined)
    mockPage.title.mockResolvedValueOnce('Page')

    await browserTool.execute({ action: 'goto', url: 'https://example.com' })

    // Verify waitForLoadState('networkidle') was called
    expect(mockPage.waitForLoadState).toHaveBeenCalledWith('networkidle', { timeout: 5000 })
  })

  it('goto does not fail when networkidle times out', async () => {
    mockPage.goto.mockResolvedValueOnce({ status: () => 200 })
    mockPage.waitForLoadState.mockRejectedValueOnce(new Error('Timeout 5000ms exceeded'))
    mockPage.title.mockResolvedValueOnce('SPA Page')

    const result = await browserTool.execute({ action: 'goto', url: 'https://spa.example.com' })
    // networkidle timeout is non-fatal
    expect(result.success).toBe(true)
    expect(result.output).toContain('SPA Page')
  })

  it('goto requires url parameter', async () => {
    mockPage.goto.mockResolvedValueOnce({ status: () => 200 })
    mockPage.waitForLoadState.mockResolvedValueOnce(undefined)
    mockPage.title.mockResolvedValueOnce('')

    const result = await browserTool.execute({ action: 'goto' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('url is required')
  })

  it('text extracts body text when no selector given', async () => {
    const mockLocator = {
      first: () => ({ innerText: vi.fn().mockResolvedValue('Body content') }),
      innerText: vi.fn().mockResolvedValue('Body content'),
    }
    mockPage.locator.mockReturnValue(mockLocator)

    const result = await browserTool.execute({ action: 'text' })
    expect(result.success).toBe(true)
    expect(result.output).toContain('Body content')
  })

  it('text falls back to body when selector not found', async () => {
    const failLocator = {
      first: () => ({
        innerText: vi.fn().mockRejectedValue(new Error('Timeout 5000ms exceeded')),
      }),
    }
    const bodyLocator = {
      innerText: vi.fn().mockResolvedValue('Fallback body text'),
    }
    mockPage.locator.mockImplementation((sel: string) =>
      sel === 'body' ? bodyLocator : failLocator,
    )

    const result = await browserTool.execute({ action: 'text', selector: '.nonexistent' })
    expect(result.success).toBe(true)
    expect(result.output).toContain('Fallback body text')
    expect(result.output).toContain('not found')
  })

  it('chromium launches with anti-detection args and clean env', async () => {
    const pw = await import('playwright')
    // The launch was already called during earlier tests via recycleContext.
    // Verify the call args include our flags.
    const launchCalls = (pw.chromium.launch as ReturnType<typeof vi.fn>).mock.calls
    const lastCall = launchCalls[launchCalls.length - 1]?.[0]
    expect(lastCall).toBeDefined()
    expect(lastCall.args).toContain('--disable-blink-features=AutomationControlled')
    expect(lastCall.args).toContain('--no-sandbox')
    expect(lastCall.args).toContain('--disable-dev-shm-usage')
    expect(lastCall.env).toEqual({})
  })

  it('returns error for unknown action', async () => {
    const result = await browserTool.execute({ action: 'dance' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('Unknown action: dance')
  })
})
