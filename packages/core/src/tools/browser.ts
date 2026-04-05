import type { Tool, ToolResult } from '../types.js'

// Lazy-load playwright to avoid startup cost when browser tool is not used
let _pw: typeof import('playwright') | null = null
let _browser: import('playwright').Browser | null = null
let _page: import('playwright').Page | null = null
let _initError: string | null = null

async function getPw() {
  if (_initError) throw new Error(_initError)
  if (!_pw) {
    try {
      _pw = await import('playwright')
    } catch (err) {
      _initError = `Playwright not available: ${(err as Error).message}. Run "npx playwright install chromium" to fix.`
      throw new Error(_initError)
    }
  }
  return _pw
}

async function getPage(): Promise<import('playwright').Page> {
  if (_page && !_page.isClosed()) return _page

  const pw = await getPw()
  if (!_browser || !_browser.isConnected()) {
    try {
      _browser = await pw.chromium.launch({ headless: true })
    } catch (err) {
      throw new Error(`Failed to launch browser: ${(err as Error).message}. Run "npx playwright install chromium" to install browser binaries.`)
    }
  }
  const context = await _browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) EvolvingAgent/1.0',
  })
  _page = await context.newPage()
  return _page
}

/** Reset cached error state (call after installing dependencies) */
export function resetBrowserState(): void {
  _initError = null
  _pw = null
}

/** Check whether the browser tool is available (playwright installed + browser binaries present) */
export async function checkBrowserHealth(): Promise<{ available: boolean; error?: string }> {
  // Always do a fresh check — bypass _initError cache
  const savedError = _initError
  _initError = null
  const savedPw = _pw

  try {
    const pw = await getPw()
    const browser = await pw.chromium.launch({ headless: true })
    await browser.close()
    return { available: true, error: undefined }
  } catch (err) {
    // Restore original state if health check was just a probe
    if (!savedPw) {
      _pw = null
      _initError = null // Don't cache health check failures
    }
    return { available: false, error: (err as Error).message }
  }
}

export const browserTool: Tool = {
  name: 'browser',
  description: `Control a headless browser. Actions:
- goto: Navigate to a URL
- click: Click an element by CSS selector
- type: Type text into an element by CSS selector
- text: Extract visible text from page or element
- screenshot: Take a screenshot (returns base64)
- evaluate: Run JavaScript in page context
- wait: Wait for a selector to appear
- back: Go back in history
- html: Get page HTML`,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action to perform: goto, click, type, text, screenshot, evaluate, wait, back, html',
      },
      url: { type: 'string', description: 'URL for goto action' },
      selector: { type: 'string', description: 'CSS selector for click, type, text, wait actions' },
      text: { type: 'string', description: 'Text to type for type action' },
      script: { type: 'string', description: 'JavaScript code for evaluate action' },
      timeout: { type: 'number', description: 'Timeout in ms (default 10000)' },
    },
    required: ['action'],
  },

  async execute(params): Promise<ToolResult> {
    const action = params.action as string
    const timeout = (params.timeout as number) ?? 10000

    try {
      const page = await getPage()

      switch (action) {
        case 'goto': {
          const url = params.url as string
          if (!url) return { success: false, output: '', error: 'url is required for goto' }
          const response = await page.goto(url, { timeout, waitUntil: 'domcontentloaded' })
          const title = await page.title()
          return {
            success: true,
            output: `Navigated to ${url}\nTitle: ${title}\nStatus: ${response?.status() ?? 'unknown'}`,
          }
        }

        case 'click': {
          const selector = params.selector as string
          if (!selector) return { success: false, output: '', error: 'selector is required for click' }
          await page.click(selector, { timeout })
          return { success: true, output: `Clicked: ${selector}` }
        }

        case 'type': {
          const selector = params.selector as string
          const text = params.text as string
          if (!selector || !text) return { success: false, output: '', error: 'selector and text required for type' }
          await page.fill(selector, text, { timeout })
          return { success: true, output: `Typed "${text}" into ${selector}` }
        }

        case 'text': {
          const selector = params.selector as string
          let content: string
          if (selector) {
            content = await page.locator(selector).first().innerText({ timeout })
          } else {
            content = await page.locator('body').innerText({ timeout })
          }
          // Truncate long content
          if (content.length > 5000) {
            content = content.slice(0, 5000) + '\n... (truncated)'
          }
          return { success: true, output: content }
        }

        case 'screenshot': {
          const buffer = await page.screenshot({ type: 'png', fullPage: false })
          const base64 = buffer.toString('base64')
          return { success: true, output: `data:image/png;base64,${base64.slice(0, 200)}... (${buffer.length} bytes)` }
        }

        case 'evaluate': {
          const script = params.script as string
          if (!script) return { success: false, output: '', error: 'script is required for evaluate' }
          const result = await page.evaluate(script)
          const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
          return { success: true, output: output?.slice(0, 5000) ?? 'undefined' }
        }

        case 'wait': {
          const selector = params.selector as string
          if (!selector) return { success: false, output: '', error: 'selector is required for wait' }
          await page.waitForSelector(selector, { timeout })
          return { success: true, output: `Element found: ${selector}` }
        }

        case 'back': {
          await page.goBack({ timeout })
          const title = await page.title()
          return { success: true, output: `Went back. Title: ${title}` }
        }

        case 'html': {
          const selector = params.selector as string
          let html: string
          if (selector) {
            html = await page.locator(selector).first().innerHTML({ timeout })
          } else {
            html = await page.content()
          }
          if (html.length > 10000) {
            html = html.slice(0, 10000) + '\n... (truncated)'
          }
          return { success: true, output: html }
        }

        default:
          return { success: false, output: '', error: `Unknown action: ${action}. Use: goto, click, type, text, screenshot, evaluate, wait, back, html` }
      }
    } catch (err) {
      return { success: false, output: '', error: `Browser error: ${(err as Error).message}` }
    }
  },
}

/** Gracefully close the browser (call on shutdown) */
export async function closeBrowser(): Promise<void> {
  if (_page && !_page.isClosed()) await _page.close().catch(() => {})
  if (_browser?.isConnected()) await _browser.close().catch(() => {})
  _page = null
  _browser = null
}
