# Browser Tool

Headless Chromium via Playwright, used by the agent when it needs to actually
visit a web page (summarize an article, extract data, scrape a search result).
Source: `packages/core/src/tools/browser.ts`.

## Quick shape

```
browser({ action, url?, selector?, text?, script?, timeout? })
```

Actions: `goto`, `text`, `click`, `type`, `screenshot`, `evaluate`, `wait`,
`back`, `html`.

Typical reading flow (and the one the planner is instructed to use):

```
browser({ action: 'goto',  url: 'https://example.com/article' })
browser({ action: 'text' })          // <-- no selector! returns full body text
```

A bare `goto` only returns title + HTTP status — it does **not** return the
page body. You must follow up with `text` (or use `skill:summarize-url`,
which wraps the pair) to actually read the page.

## Fingerprint hardening (stealth)

Many sites fingerprint headless Playwright immediately and refuse to serve
real content. We apply three layers of hardening automatically in every
context:

1. **Real Chrome UA** — `Chrome/131.0.0.0 Safari/537.36`, not the default
   `HeadlessChrome` string, not the old `EvolvingAgent/1.0` string that
   tripped every CN site's bot wall.
2. **zh-CN locale** — matches a Chinese-user fingerprint for CN targets.
3. **Init-script masks** applied before every page loads:
   - `navigator.webdriver` → `undefined` (the single biggest playwright tell)
   - `navigator.languages` → `['zh-CN', 'zh', 'en']` (empty in headless by default)
   - `navigator.plugins` → non-empty array (empty in headless by default)

These masks are "light stealth" — enough for the common case, not a match
for commercial anti-bot products (see "Known limitations" below).

## Per-call context recycling

The browser tool used to keep one long-lived Chromium + Context + Page across
the entire session. That breaks in two ways:

1. **Cookie / storage accumulation.** After a few navigations to the same
   host, stale cookies and TLS session state turn into a fingerprint the
   remote site can track.
2. **Chromium process duration.** Long-lived headless processes accumulate
   JA3/TLS fingerprint stability that anti-bot walls latch onto.

The fix: **every top-level `goto` recycles both the BrowserContext AND the
underlying Chromium process.** Costs ~1.5s per goto (Chromium launch) but
each navigation now starts from a clean slate. Subsequent `text` / `click` /
`screenshot` calls within the same chat turn reuse the fresh page — they
don't trigger another recycle.

See `recycleContext()` in `browser.ts`.

## Selector fallback

Planners (LLMs) have a strong bias toward over-specifying CSS selectors —
they imagine what the page structure *should* look like and pass something
like `selector: 'h1.QuestionHeader-title'`. When that selector doesn't
exist, Playwright waits for the full timeout (was 30 s) before failing.

Current behavior:

- If `text` is called **with** a selector and the selector can't be found
  within **5 seconds**, the tool automatically falls back to reading the
  full `body` text, prefixed with a `[selector "..." not found; falling
  back to body text]` marker so the planner learns from its mistake.
- If `text` is called **without** a selector (the recommended default),
  it reads `body.innerText` directly.

The tool description explicitly instructs planners to **omit the selector
unless they have already verified it exists from a prior tool call**.

## goto status semantics

`goto` returns `success: true` whenever navigation completed, even on HTTP
4xx / 5xx. This is intentional: many anti-bot walls return HTTP 403 with
the real article body still rendered (you can read it with `text`). The
tool surfaces the status and a hint in the output so the planner knows
not to give up on a 403:

```
Navigated to https://example.com
Title: Example
Status: 403
Note: HTTP 403 — anti-bot wall is possible. The page may still contain
readable content; call action "text" to extract it before giving up.
```

## Known limitations

### 1. Hard anti-bot sites (zhihu-class)

Sites that fingerprint at the TLS / JA3 / process level (notably
**zhihu.com**, some weibo / bilibili endpoints) will still return a 118-byte
JSON bot wall even with our stealth. We verified this against
`https://www.zhihu.com/question/22918070`:

- **Standalone Node process** + the same `browserTool.execute(...)` path:
  returns **5016 characters** of real article content.
- **dev server Node process** (`pnpm dev` → `concurrently` → `tsx watch`):
  returns the **118-byte JSON wall** `{"error":{"code":40362,"message":"您当前请求存在异常..."}}`.

Same machine, same network, same minute, same code. The only difference is
the parent Node process tree. Best hypothesis: the LB (zhihu's edge returns
`server: BLB/25.11.0.2`) routes requests to stricter/laxer backends based
on some TLS-handshake feature that differs between the two process
launch paths.

**What would actually fix this (not in scope today):**

- `playwright-extra` + `puppeteer-extra-plugin-stealth` — much more aggressive
  fingerprint masking than our 3-line init script.
- A residential-IP HTTP proxy (all hand-rolled stealth loses to a paid
  anti-bot product eventually).
- For zhihu specifically, a `wayback machine` fallback: when the target URL
  returns a bot wall, silently retry via
  `https://web.archive.org/web/2024/<original url>` — this was experimentally
  verified to work.
- Headed mode with a persistent user-data-dir (`chromium.launchPersistentContext`)
  — but that breaks the lazy-load / server-environment story.

Until one of those is wired in: **don't rely on the browser tool for zhihu,
weibo, etc.** The planner should prefer `skill:web-search` on those domains
and summarize from search snippets instead of trying to visit the page.

### 2. SPA sites with infinite streams

Some SPA endpoints never fire the `load` event. The tool uses a two-stage
wait: first `waitUntil: 'load'`, and if that times out, retries with
`waitUntil: 'domcontentloaded'`. Default timeout is 30 s.

### 3. No JavaScript wait helpers

If a page fetches its real content via XHR after initial load, you'll need
to manually `wait({ selector })` for the expected element before calling
`text`. The planner is not smart enough to guess this without being told.

## Health check

`packages/web/src/server/routes/tools.ts` runs a real `chromium.launch()`
against `checkBrowserHealth()` whenever `/api/tools` is queried. The
dashboard's Tools page will mark `playwright / chromium` as `installed:true`
only when a fresh headless launch actually succeeds, so a stale "not
installed" report can't linger.

## Debugging browser failures in chat

1. Open the assistant message's tool-call bubble in the Chat page — you'll
   see the raw `goto` status + the raw `text` output. That's the single
   highest-signal diagnostic.
2. If `text` returned `< 300 chars` AND `goto` status was `403`, you're
   looking at an anti-bot wall — see "Known limitations" above.
3. If `text` returned a selector-fallback marker, the planner asked for
   a selector that didn't exist on the page. That's a planner prompt
   issue, not a browser tool issue.
4. If `goto` returned a timeout, the site is probably slow or geo-blocked;
   bump the `timeout` parameter in the planner's tool call to 60000 and
   retry.
