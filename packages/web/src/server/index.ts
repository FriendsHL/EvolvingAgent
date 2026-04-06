import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

import { MetricsCollector, SkillRegistry } from '@evolving-agent/core'
import { dashboardRoutes } from './routes/dashboard.js'
import { metricsRoutes } from './routes/metrics.js'
import { memoryRoutes } from './routes/memory.js'
import { hooksRoutes } from './routes/hooks.js'
import { skillsRoutes } from './routes/skills.js'
import { agentsRoutes } from './routes/agents.js'
import { sessionsRoutes } from './routes/sessions.js'
import { chatRoutes } from './routes/chat.js'
import { toolsRoutes } from './routes/tools.js'
import { coordinateRoutes } from './routes/coordinate.js'
import { knowledgeRoutes } from './routes/knowledge.js'
import { AgentRegistry } from './services/agent-registry.js'
import { SessionStore } from './services/session-store.js'

const PORT = Number(process.env.EA_WEB_PORT ?? 3721)
const DATA_PATH = resolve(process.env.EA_DATA_PATH ?? 'data/memory')

// Initialize services
const metrics = new MetricsCollector(DATA_PATH)
const skillRegistry = new SkillRegistry(DATA_PATH)
const agentRegistry = new AgentRegistry(DATA_PATH)
const sessionStore = new SessionStore(DATA_PATH)

async function main() {
  await metrics.init()
  await skillRegistry.init()
  await agentRegistry.init()
  await sessionStore.init()

  const app = new Hono()

  // Middleware
  app.use('/api/*', cors())

  // Health check
  app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

  // API routes
  app.route('/api/dashboard', dashboardRoutes(metrics, sessionStore, agentRegistry))
  app.route('/api/metrics', metricsRoutes(metrics))
  app.route('/api/memory', memoryRoutes(DATA_PATH))
  app.route('/api/hooks', hooksRoutes())
  app.route('/api/skills', skillsRoutes(skillRegistry))
  app.route('/api/agents', agentsRoutes(agentRegistry))
  app.route('/api/sessions', sessionsRoutes(sessionStore))
  app.route('/api/tools', toolsRoutes())
  app.route('/api/coordinate', coordinateRoutes(DATA_PATH))
  app.route('/api/knowledge', knowledgeRoutes(DATA_PATH))

  // SSE: Server-Sent Events for real-time agent events
  const sseClients = new Set<ReadableStreamDefaultController>()

  function broadcast(event: unknown) {
    const data = `data: ${JSON.stringify(event)}\n\n`
    const encoded = new TextEncoder().encode(data)
    for (const client of sseClients) {
      try { client.enqueue(encoded) } catch { sseClients.delete(client) }
    }
  }

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

  // Chat routes (needs broadcast)
  app.route('/api/chat', chatRoutes(agentRegistry, sessionStore, DATA_PATH, broadcast, metrics))

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
