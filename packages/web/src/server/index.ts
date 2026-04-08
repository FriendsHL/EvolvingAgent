// Load .env files (project root + packages/web) before anything else so
// LLM provider env vars (DASHSCOPE_API_KEY, EVOLVING_AGENT_PROVIDER, …)
// are visible to SessionManager during init. Uses the Node 20.6+ built-in
// loader — no third-party dependency. Missing files are ignored.
for (const candidate of ['.env', '../.env', '../../.env']) {
  try {
    process.loadEnvFile(candidate)
  } catch {
    // Best-effort — file may not exist.
  }
}

import { serve } from '@hono/node-server'
import { cors as _cors } from 'hono/cors' // re-exported via build-app indirectly; kept for type ergonomics
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

import { MetricsCollector, SessionManager } from '@evolving-agent/core'
import { AgentRegistry } from './services/agent-registry.js'
import { SessionStore } from './services/session-store.js'
import { bootstrapFeishuChannel } from './services/feishu-bootstrap.js'
import { createFeishuHandler } from './services/feishu-handler.js'
import { buildApp } from './build-app.js'

const PORT = Number(process.env.EA_WEB_PORT ?? 3721)
const DATA_PATH = resolve(process.env.EA_DATA_PATH ?? 'data/memory')

// Initialize services
const metrics = new MetricsCollector(DATA_PATH)
const agentRegistry = new AgentRegistry(DATA_PATH)
const sessionStore = new SessionStore(DATA_PATH)
// Phase 3 Batch 3: SessionManager owns shared singletons + per-session Agents.
// Its internal SkillRegistry is the authoritative one (with built-ins).
const sessionManager = new SessionManager({ dataPath: DATA_PATH })

async function main() {
  await metrics.init()
  await agentRegistry.init()
  await sessionStore.init()
  await sessionManager.init()

  // Phase 4 / A2 — bootstrap Feishu channel if credentials are present.
  // Returns null silently when not configured; never throws.
  const { channel: feishuChannel } = await bootstrapFeishuChannel({
    dataPath: DATA_PATH,
    sessionManager,
  })
  if (feishuChannel) {
    feishuChannel.onMessage(
      createFeishuHandler({ channel: feishuChannel, sessionManager }),
    )
  }

  // Auto-create a "default" session for legacy clients that don't pass sessionId.
  if (!sessionManager.list().some((s) => s.id === 'default')) {
    await sessionManager.create({ id: 'default', title: 'Default chat' })
  }

  // SSE: Server-Sent Events for real-time agent events
  const sseClients = new Set<ReadableStreamDefaultController>()

  function broadcast(event: unknown) {
    const data = `data: ${JSON.stringify(event)}\n\n`
    const encoded = new TextEncoder().encode(data)
    for (const client of sseClients) {
      try { client.enqueue(encoded) } catch { sseClients.delete(client) }
    }
  }

  // All API routes live in the shared factory so smoke tests can
  // mount the same surface against an in-process tmp data dir.
  const app = buildApp({
    dataPath: DATA_PATH,
    metrics,
    agentRegistry,
    sessionStore,
    sessionManager,
    feishuChannel,
    broadcast,
  })

  app.get('/api/events', (c) => {
    const stream = new ReadableStream({
      start(controller) {
        sseClients.add(controller)
        controller.enqueue(new TextEncoder().encode(': connected\n\n'))
      },
      cancel() {
        sseClients.delete(this as unknown as ReadableStreamDefaultController)
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  })

  // Serve static files (production: built Vite SPA)
  const __dirname = dirname(fileURLToPath(import.meta.url))
  // When running via tsx: __dirname = packages/web/src/server → client at packages/web/dist/client
  // When running built: __dirname = packages/web/dist/server → client at packages/web/dist/client
  const clientDir = existsSync(resolve(__dirname, '../client/index.html'))
    ? resolve(__dirname, '../client')
    : existsSync(resolve(__dirname, '../../dist/client/index.html'))
      ? resolve(__dirname, '../../dist/client')
      : resolve(process.cwd(), 'packages/web/dist/client')

  app.get('/*', async (c) => {
    const urlPath = c.req.path === '/' ? '/index.html' : c.req.path
    const filePath = resolve(clientDir, `.${urlPath}`)

    // Only serve files within clientDir
    if (!filePath.startsWith(clientDir)) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    try {
      const content = await readFile(filePath)
      const ext = filePath.split('.').pop()
      const types: Record<string, string> = {
        html: 'text/html',
        js: 'application/javascript',
        css: 'text/css',
        json: 'application/json',
        svg: 'image/svg+xml',
        png: 'image/png',
        ico: 'image/x-icon',
      }
      return new Response(content, {
        headers: { 'Content-Type': types[ext ?? ''] ?? 'application/octet-stream' },
      })
    } catch {
      // SPA fallback: serve index.html for client-side routes
      const indexPath = resolve(clientDir, 'index.html')
      try {
        const html = await readFile(indexPath, 'utf-8')
        return c.html(html)
      } catch {
        return c.text('Dashboard not built. Run: pnpm --filter @evolving-agent/web build', 404)
      }
    }
  })

  serve({ fetch: app.fetch, port: PORT }, () => {
    console.log(`Evolving Agent Dashboard running at http://localhost:${PORT}`)
  })
}

main().catch(console.error)
