import { Hono } from 'hono'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionManager } from '@evolving-agent/core'
import type { MCPServerConfig, MCPConfigFile } from '@evolving-agent/core'

/**
 * MCP integration — config + status + secrets endpoints.
 *
 * Mounted at `/api/mcp` (see server/index.ts).
 *
 *   GET  /api/mcp/config    — current mcp.json contents (servers array)
 *   PUT  /api/mcp/config    — full-replace mcp.json + hot reload
 *   GET  /api/mcp/status    — runtime status of every configured server
 *   GET  /api/mcp/secrets   — KEY LIST ONLY (values never sent over the wire)
 *   PUT  /api/mcp/secrets   — full-replace secrets.json + hot reload
 *
 * Why secrets GET returns only key names: the dashboard is supposed to be a
 * convenience for editing the file, NOT a way to recover the value of a key
 * the user has forgotten. If you need the value, read the file. This avoids
 * the "session got XSS-stolen" attack class.
 */
export function mcpRoutes(manager: SessionManager, dataPath: string) {
  const app = new Hono()
  const mcpJsonPath = join(dataPath, 'config', 'mcp.json')
  const secretsJsonPath = join(dataPath, 'config', 'secrets.json')

  // ============================================================
  // /config — mcp.json
  // ============================================================

  app.get('/config', async (c) => {
    try {
      const raw = await readFile(mcpJsonPath, 'utf-8')
      const parsed = JSON.parse(raw) as MCPConfigFile
      return c.json({ servers: parsed.servers ?? [] })
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e?.code === 'ENOENT') return c.json({ servers: [] })
      return c.json({ error: 'Failed to read mcp.json', message: (err as Error).message }, 500)
    }
  })

  app.put('/config', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Body must be JSON' }, 400)
    }

    const result = validateMCPConfig(body)
    if (!result.ok) {
      return c.json({ error: 'Invalid MCP config', details: result.errors }, 400)
    }

    try {
      await mkdir(join(dataPath, 'config'), { recursive: true })
      await writeFile(
        mcpJsonPath,
        JSON.stringify({ servers: result.value }, null, 2),
        'utf-8',
      )
    } catch (err) {
      return c.json(
        { error: 'Failed to write mcp.json', message: (err as Error).message },
        500,
      )
    }

    // Hot reload — failures are surfaced but the file write already
    // succeeded, so the next restart will at least pick it up.
    try {
      const reloaded = await manager.reloadMCPServers(result.value)
      if (!reloaded) {
        return c.json({
          servers: result.value,
          warning: 'MCP integration disabled in this session — saved to disk only',
        })
      }
    } catch (err) {
      return c.json(
        {
          servers: result.value,
          warning: `Saved to disk but reload failed: ${(err as Error).message}`,
        },
        200,
      )
    }

    return c.json({ servers: result.value, status: manager.getMCPManager()?.status() ?? [] })
  })

  // ============================================================
  // /status — runtime view
  // ============================================================

  app.get('/status', (c) => {
    const mgr = manager.getMCPManager()
    if (!mgr) {
      return c.json({ enabled: false, servers: [] })
    }
    return c.json({ enabled: true, servers: mgr.status() })
  })

  // ============================================================
  // /secrets — secrets.json (KEY LIST ONLY for GET)
  // ============================================================

  app.get('/secrets', async (c) => {
    try {
      const raw = await readFile(secretsJsonPath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return c.json({ keys: [] })
      }
      // Return ONLY the key names + a "set" boolean. Never echo values.
      const keys = Object.entries(parsed).map(([key, value]) => ({
        key,
        set: value !== null && value !== undefined && value !== '',
      }))
      keys.sort((a, b) => a.key.localeCompare(b.key))
      return c.json({ keys })
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e?.code === 'ENOENT') return c.json({ keys: [] })
      return c.json({ error: 'Failed to read secrets.json', message: (err as Error).message }, 500)
    }
  })

  app.put('/secrets', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Body must be JSON' }, 400)
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be an object of {key: value}' }, 400)
    }

    // Validate every value is a scalar; nesting is not allowed.
    const flat: Record<string, string> = {}
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
        return c.json({ error: `Invalid key "${k}" — must be a valid identifier` }, 400)
      }
      if (v === null || v === undefined) continue
      if (typeof v === 'object') {
        return c.json({ error: `Value of "${k}" must be a scalar, got ${typeof v}` }, 400)
      }
      flat[k] = String(v)
    }

    try {
      await mkdir(join(dataPath, 'config'), { recursive: true })
      await writeFile(secretsJsonPath, JSON.stringify(flat, null, 2), 'utf-8')
    } catch (err) {
      return c.json(
        { error: 'Failed to write secrets.json', message: (err as Error).message },
        500,
      )
    }

    // After secrets change, re-trigger MCP reload using the CURRENT mcp.json
    // contents — placeholders that were previously missing may now resolve.
    try {
      const raw = await readFile(mcpJsonPath, 'utf-8').catch(() => '{"servers":[]}')
      const parsed = JSON.parse(raw) as MCPConfigFile
      await manager.reloadMCPServers(parsed.servers ?? [])
    } catch {
      // Best-effort — secrets are saved either way.
    }

    return c.json({
      keys: Object.keys(flat).sort().map((k) => ({ key: k, set: flat[k] !== '' })),
      status: manager.getMCPManager()?.status() ?? [],
    })
  })

  return app
}

// ============================================================
// Validation
// ============================================================

interface ValidationOk {
  ok: true
  value: MCPServerConfig[]
}
interface ValidationFail {
  ok: false
  errors: string[]
}

const VALID_SCOPES = new Set(['main', 'sub', 'both'])

function validateMCPConfig(body: unknown): ValidationOk | ValidationFail {
  const errors: string[] = []
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: ['body must be an object'] }
  }
  const servers = (body as Record<string, unknown>).servers
  if (!Array.isArray(servers)) {
    return { ok: false, errors: ['body.servers must be an array'] }
  }

  const seenIds = new Set<string>()
  const value: MCPServerConfig[] = []

  for (const [i, raw] of servers.entries()) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`servers[${i}] must be an object`)
      continue
    }
    const s = raw as Record<string, unknown>

    if (typeof s.id !== 'string' || !s.id.trim()) {
      errors.push(`servers[${i}].id is required`)
      continue
    }
    if (seenIds.has(s.id)) {
      errors.push(`servers[${i}].id "${s.id}" is duplicated`)
      continue
    }
    seenIds.add(s.id)

    // Either command (stdio) or url (http) — exactly one.
    const hasCommand = typeof s.command === 'string' && s.command.length > 0
    const hasUrl = typeof s.url === 'string' && s.url.length > 0
    if (!hasCommand && !hasUrl) {
      errors.push(`servers[${i}] requires either "command" (stdio) or "url" (http)`)
      continue
    }

    if (s.scope !== undefined && (typeof s.scope !== 'string' || !VALID_SCOPES.has(s.scope))) {
      errors.push(`servers[${i}].scope must be one of: main, sub, both`)
      continue
    }
    if (s.args !== undefined && !Array.isArray(s.args)) {
      errors.push(`servers[${i}].args must be a string array`)
      continue
    }
    if (s.env !== undefined && (typeof s.env !== 'object' || s.env === null || Array.isArray(s.env))) {
      errors.push(`servers[${i}].env must be an object`)
      continue
    }
    if (s.enabled !== undefined && typeof s.enabled !== 'boolean') {
      errors.push(`servers[${i}].enabled must be a boolean`)
      continue
    }

    const out: MCPServerConfig = { id: s.id }
    if (typeof s.label === 'string') out.label = s.label
    if (typeof s.enabled === 'boolean') out.enabled = s.enabled
    if (typeof s.scope === 'string') out.scope = s.scope as MCPServerConfig['scope']
    if (typeof s.command === 'string') out.command = s.command
    if (Array.isArray(s.args)) out.args = s.args.map(String)
    if (s.env && typeof s.env === 'object') {
      out.env = {}
      for (const [k, v] of Object.entries(s.env as Record<string, unknown>)) {
        out.env[k] = String(v ?? '')
      }
    }
    if (typeof s.cwd === 'string') out.cwd = s.cwd
    if (typeof s.url === 'string') out.url = s.url
    if (s.headers && typeof s.headers === 'object') {
      out.headers = {}
      for (const [k, v] of Object.entries(s.headers as Record<string, unknown>)) {
        out.headers[k] = String(v ?? '')
      }
    }
    value.push(out)
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value }
}
