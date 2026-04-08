/**
 * End-to-end smoke tests — Phase 4 / post-A.
 *
 * Boots the full Hono app via `buildApp()` against a temp data dir and
 * exercises the major route surface using `app.fetch(request)` (no port
 * binding, no real network). The goal is plumbing coverage: every route
 * mounts, every factory wires deps correctly, every JSON contract matches
 * what the client expects.
 *
 * What this DOES test:
 *   - Route mounting (no 404s on the canonical paths)
 *   - JSON contract shape on the read paths
 *   - Empty-state defaults (no fixtures needed)
 *   - Feishu webhook signature flow with a stubbed channel
 *
 * What this does NOT test:
 *   - LLM calls / Agent execution (would need a real API key)
 *   - SSE streaming (chat stream needs an LLM)
 *   - Static SPA fallback (lives in index.ts, not buildApp)
 *
 * The end-to-end LLM-touching paths are covered by manual real-world
 * verification — see the troubleshooting section in `docs/feishu.md`
 * and `docs/experience-distillation.md`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import {
  FeishuChannel,
  MetricsCollector,
  SessionManager,
} from '@evolving-agent/core'

import { buildApp } from './build-app.js'
import { AgentRegistry } from './services/agent-registry.js'
import { SessionStore } from './services/session-store.js'

// ============================================================
// Shared harness
// ============================================================

interface Harness {
  dataPath: string
  sessionManager: SessionManager
  app: ReturnType<typeof buildApp>
  feishuChannel: FeishuChannel | null
  cleanup: () => Promise<void>
}

async function makeHarness(opts: { withFeishu?: { encryptKey?: string } } = {}): Promise<Harness> {
  const dataPath = await mkdtemp(join(tmpdir(), 'ea-smoke-'))

  const metrics = new MetricsCollector(dataPath)
  const agentRegistry = new AgentRegistry(dataPath)
  const sessionStore = new SessionStore(dataPath)
  const sessionManager = new SessionManager({
    dataPath,
    // Disable the cache-health cron so the test process doesn't hold a
    // timer and exit cleanly.
    cacheHealthAlert: { enabled: false },
  })

  await metrics.init()
  await agentRegistry.init()
  await sessionStore.init()
  await sessionManager.init()

  // Mirror the production bootstrap: ensure a "default" session exists.
  if (!sessionManager.list().some((s) => s.id === 'default')) {
    await sessionManager.create({ id: 'default', title: 'Default chat' })
  }

  let feishuChannel: FeishuChannel | null = null
  if (opts.withFeishu) {
    feishuChannel = new FeishuChannel({
      credentials: {
        appId: 'cli_smoke_test',
        appSecret: 'secret_smoke_test',
        verificationToken: 'tok_smoke',
        encryptKey: opts.withFeishu.encryptKey,
      },
    })
    sessionManager.getChannels().register(feishuChannel)
  }

  const app = buildApp({
    dataPath,
    metrics,
    agentRegistry,
    sessionStore,
    sessionManager,
    feishuChannel,
    broadcast: () => {
      /* swallow SSE events in tests */
    },
  })

  return {
    dataPath,
    sessionManager,
    app,
    feishuChannel,
    cleanup: async () => {
      await sessionManager.shutdown()
      await rm(dataPath, { recursive: true, force: true })
    },
  }
}

// Hit a route via in-process fetch. Returns parsed JSON body + status.
async function getJson(
  app: ReturnType<typeof buildApp>,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const res = await app.fetch(new Request(`http://localhost${path}`))
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    /* leave as text */
  }
  return { status: res.status, body }
}

async function postJson(
  app: ReturnType<typeof buildApp>,
  path: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    }),
  )
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    /* leave as text */
  }
  return { status: res.status, body }
}

async function postRaw(
  app: ReturnType<typeof buildApp>,
  path: string,
  rawBody: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: rawBody,
    }),
  )
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    /* leave as text */
  }
  return { status: res.status, body }
}

// ============================================================
// Read-path smoke (no Feishu)
// ============================================================

describe('smoke — core read paths', () => {
  let h: Harness

  beforeAll(async () => {
    h = await makeHarness()
  }, 30_000)
  afterAll(async () => {
    await h.cleanup()
  })

  it('GET /api/health returns ok', async () => {
    const r = await getJson(h.app, '/api/health')
    expect(r.status).toBe(200)
    expect((r.body as { status: string }).status).toBe('ok')
  })

  it('GET /api/dashboard/summary returns shape', async () => {
    const r = await getJson(h.app, '/api/dashboard/summary')
    expect(r.status).toBe(200)
    expect(r.body).toBeTypeOf('object')
  })

  it('GET /api/sessions lists at least the default session', async () => {
    const r = await getJson(h.app, '/api/sessions')
    expect(r.status).toBe(200)
    const list = r.body as { sessions?: Array<{ id: string }> } | Array<{ id: string }>
    const arr = Array.isArray(list) ? list : (list.sessions ?? [])
    expect(arr.some((s) => s.id === 'default')).toBe(true)
  })

  it('POST /api/sessions creates a new session', async () => {
    const r = await postJson(h.app, '/api/sessions', { title: 'smoke session' })
    expect(r.status).toBeLessThan(300)
    const created = r.body as { id?: string; sessionId?: string; metadata?: { id: string } }
    const newId = created.id ?? created.sessionId ?? created.metadata?.id
    expect(newId).toBeTruthy()
  })

  it('GET /api/memory/experiences returns a list (possibly empty)', async () => {
    const r = await getJson(h.app, '/api/memory/experiences')
    expect(r.status).toBe(200)
    expect(r.body).toBeDefined()
  })

  it('GET /api/memory/stats returns store stats', async () => {
    const r = await getJson(h.app, '/api/memory/stats')
    expect(r.status).toBe(200)
  })

  it('GET /api/memory/distill/runs returns empty run list', async () => {
    const r = await getJson(h.app, '/api/memory/distill/runs')
    expect(r.status).toBe(200)
    const body = r.body as { runs?: unknown[] }
    expect(Array.isArray(body.runs)).toBe(true)
    expect(body.runs!.length).toBe(0)
  })

  it('GET /api/prompts lists registered prompt ids', async () => {
    const r = await getJson(h.app, '/api/prompts')
    expect(r.status).toBe(200)
    expect(r.body).toBeDefined()
  })

  it('GET /api/prompts/runs returns empty optimization runs', async () => {
    const r = await getJson(h.app, '/api/prompts/runs')
    expect(r.status).toBe(200)
    const body = r.body as { runs: unknown[] }
    expect(Array.isArray(body.runs)).toBe(true)
    expect(body.runs.length).toBe(0)
  })

  it('GET /api/mcp/config returns empty server list when no config', async () => {
    const r = await getJson(h.app, '/api/mcp/config')
    expect(r.status).toBe(200)
    const body = r.body as { servers: unknown[] }
    expect(Array.isArray(body.servers)).toBe(true)
  })

  it('GET /api/mcp/status returns runtime status', async () => {
    const r = await getJson(h.app, '/api/mcp/status')
    expect(r.status).toBe(200)
  })

  it('GET /api/mcp/secrets returns key-name list only', async () => {
    const r = await getJson(h.app, '/api/mcp/secrets')
    expect(r.status).toBe(200)
  })

  it('GET /api/agents returns agent list', async () => {
    const r = await getJson(h.app, '/api/agents')
    expect(r.status).toBe(200)
  })

  it('GET /api/skills returns the SessionManager built-in skills', async () => {
    const r = await getJson(h.app, '/api/skills')
    expect(r.status).toBe(200)
    const body = r.body as { skills?: unknown[] } | unknown[]
    const arr = Array.isArray(body) ? body : (body.skills ?? [])
    expect((arr as unknown[]).length).toBeGreaterThanOrEqual(8)
  })

  // The tools route invokes `npx playwright install --dry-run` and
  // checkBrowserHealth() on the first call (slow — up to ~30s on a clean
  // machine), then memoises the result for 60s. The first GET below pays
  // that cost; the second is essentially free.
  it(
    'GET /api/tools returns tool list (first call hits playwright dry-run)',
    async () => {
      const r = await getJson(h.app, '/api/tools')
      expect(r.status).toBe(200)
      const body = r.body as { tools: unknown[] }
      expect(Array.isArray(body.tools)).toBe(true)
      expect(body.tools.length).toBeGreaterThan(0)
    },
    60_000,
  )

  it('GET /api/tools second call hits the in-memory TTL cache (fast)', async () => {
    const t0 = Date.now()
    const r = await getJson(h.app, '/api/tools')
    const elapsed = Date.now() - t0
    expect(r.status).toBe(200)
    // Cache hit should be sub-100ms even on slow CI. Generous bound to
    // avoid flakiness — the point is "much less than the dry-run cost".
    expect(elapsed).toBeLessThan(500)
  })
})

// ============================================================
// Feishu disabled (no credentials)
// ============================================================

describe('smoke — feishu disabled mode', () => {
  let h: Harness

  beforeAll(async () => {
    h = await makeHarness()
  }, 30_000)
  afterAll(async () => {
    await h.cleanup()
  })

  it('GET /api/channels/feishu/status reports disabled', async () => {
    const r = await getJson(h.app, '/api/channels/feishu/status')
    expect(r.status).toBe(200)
    const body = r.body as { enabled: boolean; reason?: string }
    expect(body.enabled).toBe(false)
    expect(body.reason).toBeTruthy()
  })

  it('POST /api/channels/feishu/webhook returns 503 when channel is disabled', async () => {
    const r = await postJson(h.app, '/api/channels/feishu/webhook', { ping: true })
    expect(r.status).toBe(503)
  })
})

// ============================================================
// Feishu enabled with stubbed credentials
// ============================================================

describe('smoke — feishu enabled mode (stub credentials)', () => {
  const encryptKey = 'smoke-encrypt-key'
  let h: Harness

  beforeAll(async () => {
    h = await makeHarness({ withFeishu: { encryptKey } })
  }, 30_000)
  afterAll(async () => {
    await h.cleanup()
  })

  function signed(body: string, timestamp: string, nonce: string): string {
    return createHash('sha256')
      .update(timestamp + nonce + encryptKey + body)
      .digest('hex')
  }

  it('GET /api/channels/feishu/status reports enabled', async () => {
    const r = await getJson(h.app, '/api/channels/feishu/status')
    expect(r.status).toBe(200)
    const body = r.body as { enabled: boolean; id: string; capabilities: string[] }
    expect(body.enabled).toBe(true)
    expect(body.id).toBe('feishu')
    expect(body.capabilities).toContain('agent.message')
  })

  it('webhook url_verification challenge round-trips', async () => {
    // Plaintext url_verification (no encrypt envelope) — Feishu sends this
    // when the operator clicks "Verify" in the console.
    const payload = {
      type: 'url_verification',
      challenge: 'smoke-challenge-12345',
      token: 'tok_smoke',
    }
    const rawBody = JSON.stringify(payload)
    const timestamp = '1700000000'
    const nonce = 'smoke-nonce'
    const r = await postRaw(h.app, '/api/channels/feishu/webhook', rawBody, {
      'X-Lark-Request-Timestamp': timestamp,
      'X-Lark-Request-Nonce': nonce,
      'X-Lark-Signature': signed(rawBody, timestamp, nonce),
    })
    expect(r.status).toBe(200)
    expect((r.body as { challenge: string }).challenge).toBe('smoke-challenge-12345')
  })

  it('webhook rejects bad signature with 400', async () => {
    const rawBody = JSON.stringify({ type: 'url_verification', challenge: 'x' })
    const r = await postRaw(h.app, '/api/channels/feishu/webhook', rawBody, {
      'X-Lark-Request-Timestamp': '1700000000',
      'X-Lark-Request-Nonce': 'nonce',
      'X-Lark-Signature': createHash('sha256').update('totally wrong').digest('hex'),
    })
    expect(r.status).toBe(400)
    expect((r.body as { error?: string }).error).toBeTruthy()
  })

  it('webhook ignores group message without bot mention (200)', async () => {
    // Build an im.message.receive_v1 group event without mentioning the bot.
    const event = {
      schema: '2.0',
      header: {
        event_id: 'evt_smoke_1',
        event_type: 'im.message.receive_v1',
        tenant_key: 'tenant_smoke',
      },
      event: {
        sender: { sender_id: { open_id: 'ou_smoke_user' } },
        message: {
          message_id: 'om_smoke_1',
          chat_id: 'oc_smoke_group',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: 'hello bot' }),
          mentions: [],
        },
      },
    }
    const rawBody = JSON.stringify(event)
    const timestamp = '1700000001'
    const nonce = 'nonce-2'
    const r = await postRaw(h.app, '/api/channels/feishu/webhook', rawBody, {
      'X-Lark-Request-Timestamp': timestamp,
      'X-Lark-Request-Nonce': nonce,
      'X-Lark-Signature': signed(rawBody, timestamp, nonce),
    })
    expect(r.status).toBe(200)
    const body = r.body as { ok: boolean; ignored?: string }
    expect(body.ok).toBe(true)
    expect(body.ignored).toBeTruthy()
  })

  it('webhook drops non-message event types as ignored', async () => {
    const event = {
      schema: '2.0',
      header: { event_id: 'evt_x', event_type: 'im.message.read_v1', tenant_key: 't' },
      event: {},
    }
    const rawBody = JSON.stringify(event)
    const timestamp = '1700000002'
    const nonce = 'nonce-3'
    const r = await postRaw(h.app, '/api/channels/feishu/webhook', rawBody, {
      'X-Lark-Request-Timestamp': timestamp,
      'X-Lark-Request-Nonce': nonce,
      'X-Lark-Signature': signed(rawBody, timestamp, nonce),
    })
    expect(r.status).toBe(200)
    expect((r.body as { ok: boolean }).ok).toBe(true)
  })
})
