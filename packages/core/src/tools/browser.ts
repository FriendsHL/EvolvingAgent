import type { Tool, ToolResult } from '../types.js'

// Lazy-load playwright to avoid startup cost when browser tool is not used
let _pw: typeof import('playwright') | null = null
let _browser: import('playwright').Browser | null = null
let _context: import('playwright').BrowserContext | null = null
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

/**
 * Build a fresh BrowserContext with stealth + real Chrome UA + zh-CN locale.
 *
 * Many CN sites (zhihu, weibo, juejin) actively fingerprint headless playwright
 * via navigator.webdriver / languages / plugins. With these masks the FIRST
 * navigation usually succeeds (zhihu serves HTTP 403 but with the real article
 * body in the response). However, once a context has accumulated cookies / JS
 * storage / TLS session state across multiple navigations, the same site
 * starts returning a JSON bot-wall response on every request. The fix is to
 * NOT reuse contexts across navigations — each top-level `goto` builds a
 * fresh context. The browser process itself is reused (it costs ~1-2s to
 * launch chromium) so the per-call overhead is only ~50-100ms for the new
 * context + page.
 */
async function buildFreshContext(): Promise<import('playwright').BrowserContext> {
  const pw = await getPw()
  if (!_browser || !_browser.isConnected()) {
    try {
      _browser = await pw.chromium.launch({
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-dev-shm-usage',
        ],
        env: {},  // Clean env — prevents parent's NODE_PATH/tsx/pnpm state from affecting TLS fingerprint
      })
    } catch (err) {
      throw new Error(`Failed to launch browser: ${(err as Error).message}. Run "npx playwright install chromium" to install browser binaries.`)
    }
  }
  const context = await _browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'zh-CN',
  })
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] })
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
  })
  return context
}

/**
 * Recycle the current context+page+browser in favour of a fresh one.
 *
 * IMPORTANT: this kills the chromium process too, not just the context.
 * In testing, anti-bot walls (zhihu in particular) fingerprint the
 * chromium process itself — TLS session resumption, JA3 fingerprint
 * stability, process uptime — so reusing the same chromium across many
 * navigations gets the entire process tagged. Recycling just the context
 * was not enough; the wall persisted. Killing the process between
 * navigations costs ~1.5s per call but is the only thing that reliably
 * gets a fresh session.
 */
async function recycleContext(): Promise<import('playwright').Page> {
  if (_page && !_page.isClosed()) await _page.close().catch(() => {})
  if (_context) await _context.close().catch(() => {})
  if (_browser?.isConnected()) await _browser.close().catch(() => {})
  _page = null
  _context = null
  _browser = null
  _context = await buildFreshContext()
  _page = await _context.newPage()
  return _page
}

/** Get the current page, creating one on first use. */
async function getPage(): Promise<import('playwright').Page> {
  if (_page && !_page.isClosed()) return _page
  return recycleContext()
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
- goto: Navigate to a URL — returns title + HTTP status, NOT the body content. Always follow with 'text' to read the page.
- text: Extract visible text from page or element. CALL THIS WITH NO selector for the full body text — that is the right default for reading articles, summaries, and any content you have not already inspected. Only specify a selector when you have ALREADY verified from a prior tool call that the selector exists; making one up wastes a 5s probe and the tool will fall back to body text anyway.
- click: Click an element by CSS selector
- type: Type text into an element by CSS selector
- screenshot: Take a screenshot (returns base64)
- evaluate: Run JavaScript in page context
- wait: Wait for a selector to appear
- back: Go back in history
- html: Get page HTML

Typical reading flow: goto(url) → text() to capture body. A status >= 400 from goto does NOT mean failure — many anti-bot sites (zhihu, weibo, ...) return 403 but still render real content; always try 'text' before giving up.`,
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
    // Default 30s: modern SPA sites routinely take >10s on first load; the
    // old 10s default produced spurious "timeout" errors against slow / geo-
    // restricted sites (e.g. x.com from intranets).
    const timeout = (params.timeout as number) ?? 30000

    try {
      // Top-level navigations get a fresh context per call so cookies / TLS
      // session state from previous turns don't accumulate fingerprintable
      // history that anti-bot walls (zhihu in particular) latch onto.
      const page = action === 'goto' ? await recycleContext() : await getPage()

      switch (action) {
        case 'goto': {
          const url = params.url as string
          if (!url) return { success: false, output: '', error: 'url is required for goto' }
          // Two-stage wait: try 'load' first for full resources, fall back to
          // 'domcontentloaded' if a site streams indefinitely (common on SPA).
          let response: Awaited<ReturnType<typeof page.goto>>
          try {
            response = await page.goto(url, { timeout, waitUntil: 'load' })
          } catch (err) {
            if ((err as Error).message.includes('Timeout')) {
              response = await page.goto(url, { timeout, waitUntil: 'domcontentloaded' })
            } else {
              throw err
            }
          }
          // SPA post-navigation wait: give JS frameworks 0-5s to render after load fires
          try {
            await page.waitForLoadState('networkidle', { timeout: 5000 })
          } catch { /* networkidle timeout is non-fatal — SPA may stream forever */ }
          const title = await page.title()
          const status = response?.status() ?? 0
          // Surface 4xx/5xx as a hint, but DO NOT mark the call failed —
          // anti-bot sites (zhihu etc.) return 403 with real content in the
          // body. The follow-up `text` call still works.
          const statusHint = status >= 400
            ? `\nNote: HTTP ${status} — anti-bot wall is possible. The page may still contain readable content; call action "text" to extract it before giving up.`
            : ''
          return {
            success: true,
            output: `Navigated to ${url}\nTitle: ${title || '(empty)'}\nStatus: ${status || 'unknown'}${statusHint}`,
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
          // Selector probes get a much shorter timeout (5s, not 30s) — when
          // the selector doesn't exist on a defensive site (e.g. zhihu's
          // bot wall serves a different DOM than the public article
          // template), waiting 30s blocks the whole turn. We then fall
          // back to whole-body text so the planner still gets SOMETHING.
          const SELECTOR_TIMEOUT = 5000
          let content: string
          let usedFallback = false
          if (selector) {
            try {
              content = await page.locator(selector).first().innerText({ timeout: SELECTOR_TIMEOUT })
            } catch (err) {
              // Selector miss → fall back to body. Surface the miss so the
              // planner learns its selector was wrong and can adjust.
              usedFallback = true
              const reason = (err as Error).message.split('\n')[0]
              try {
                content = `[selector "${selector}" not found (${reason}); falling back to body text]\n\n` +
                  await page.locator('body').innerText({ timeout })
              } catch (innerErr) {
                return {
                  success: false,
                  output: '',
                  error: `text fallback failed: ${(innerErr as Error).message}`,
                }
              }
            }
          } else {
            content = await page.locator('body').innerText({ timeout })
          }
          // Truncate long content
          if (content.length > 5000) {
            content = content.slice(0, 5000) + '\n... (truncated)'
          }
          return { success: usedFallback ? true : true, output: content }
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
  if (_context) await _context.close().catch(() => {})
  if (_browser?.isConnected()) await _browser.close().catch(() => {})
  _page = null
  _context = null
  _browser = null
}
