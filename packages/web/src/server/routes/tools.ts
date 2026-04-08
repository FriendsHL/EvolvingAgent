import { Hono } from 'hono'
import { checkBrowserHealth, resetBrowserState, webSearchSkill, summarizeUrlSkill, selfRepairSkill } from '@evolving-agent/core'
import { execSync } from 'node:child_process'

interface SystemTool {
  id: string
  name: string
  description: string
  category: 'builtin' | 'system' | 'plugin'
  status: 'ready' | 'unavailable' | 'checking'
  error?: string
  actions?: string[]
  dependencies?: Array<{ name: string; installed: boolean; version?: string }>
  setupCommand?: string
}

// Process-level TTL cache for the tool list. Recomputing it triggers
// `npx playwright install --dry-run` (which can take 2-30s on a clean
// machine) plus `checkBrowserHealth()`, so we cache for 60s to keep
// dashboard reads cheap. The setup endpoint invalidates this when it
// successfully installs a dependency.
let toolsCache: { tools: SystemTool[]; expiresAt: number } | null = null
const TOOLS_CACHE_TTL_MS = 60_000

async function getCachedTools(): Promise<SystemTool[]> {
  const now = Date.now()
  if (toolsCache && toolsCache.expiresAt > now) return toolsCache.tools
  const tools = await getAllToolsWithHealth()
  toolsCache = { tools, expiresAt: now + TOOLS_CACHE_TTL_MS }
  return tools
}

function invalidateToolsCache(): void {
  toolsCache = null
}

export function toolsRoutes() {
  const app = new Hono()

  // List all system tools with health
  app.get('/', async (c) => {
    const tools = await getCachedTools()
    return c.json({ tools })
  })

  // Check health of a specific tool
  app.get('/:id/health', async (c) => {
    const id = c.req.param('id')
    const tools = await getCachedTools()
    const tool = tools.find((t) => t.id === id)
    if (!tool) return c.json({ error: 'Tool not found' }, 404)
    return c.json(tool)
  })

  // Install/setup a tool's dependencies
  app.post('/:id/setup', async (c) => {
    const id = c.req.param('id')

    const setupCommands: Record<string, string> = {
      browser: 'npx playwright install chromium',
    }

    const cmd = setupCommands[id]
    if (!cmd) return c.json({ error: 'No setup available for this tool' }, 400)

    try {
      const output = execSync(cmd, {
        encoding: 'utf-8',
        timeout: 120_000,
        cwd: process.cwd(),
      })
      // Reset cached state so the tool can be used immediately
      if (id === 'browser') resetBrowserState()
      // Invalidate the tool-list cache so the next GET reflects the new
      // installed/ready status without waiting for the TTL.
      invalidateToolsCache()
      return c.json({ success: true, output })
    } catch (err) {
      return c.json({
        success: false,
        error: (err as Error).message,
      }, 500)
    }
  })

  return app
}

async function getAllToolsWithHealth(): Promise<SystemTool[]> {
  const tools: SystemTool[] = []

  // 1. Shell tool
  tools.push({
    id: 'shell',
    name: 'Shell',
    description: 'Execute shell commands on the host system',
    category: 'builtin',
    status: 'ready',
    actions: ['execute'],
  })

  // 2. File Read tool
  tools.push({
    id: 'file_read',
    name: 'File Read',
    description: 'Read files from the filesystem',
    category: 'builtin',
    status: 'ready',
    actions: ['read'],
  })

  // 3. File Write tool
  tools.push({
    id: 'file_write',
    name: 'File Write',
    description: 'Write files to the filesystem',
    category: 'builtin',
    status: 'ready',
    actions: ['write'],
  })

  // 4. HTTP tool
  tools.push({
    id: 'http',
    name: 'HTTP',
    description: 'Make HTTP requests (GET, POST, PUT, DELETE)',
    category: 'builtin',
    status: 'ready',
    actions: ['get', 'post', 'put', 'delete'],
  })

  // 5. Browser tool — needs playwright + chromium.
  // checkBrowserHealth() actually launches a headless chromium, so it is the
  // single source of truth: if it passes, both playwright and the browser
  // binary are definitively usable. Fall back to the brittle regex probes
  // only when health fails, so users see *why*.
  const browserHealth = await checkBrowserHealth()
  const dependencies = browserHealth.available
    ? [
        { name: 'playwright', installed: true },
        { name: 'chromium', installed: true },
      ]
    : [checkDep('playwright'), checkChromium()]
  tools.push({
    id: 'browser',
    name: 'Browser',
    description: 'Control a headless Chromium browser (goto, click, type, text, screenshot, evaluate)',
    category: 'system',
    status: browserHealth.available ? 'ready' : 'unavailable',
    error: browserHealth.error,
    actions: ['goto', 'click', 'type', 'text', 'screenshot', 'evaluate', 'wait', 'back', 'html'],
    dependencies,
    setupCommand: 'npx playwright install chromium',
  })

  // === Skills (high-level capabilities) ===
  const builtinSkills = [webSearchSkill, summarizeUrlSkill, selfRepairSkill]
  for (const skill of builtinSkills) {
    tools.push({
      id: `skill:${skill.id}`,
      name: skill.name,
      description: skill.description,
      category: 'system',
      status: 'ready',
      actions: skill.inputs.map((i) => `${i.name}: ${i.type}${i.required ? '' : '?'}`),
    })
  }

  return tools
}

function checkDep(name: string): { name: string; installed: boolean; version?: string } {
  try {
    const pkgPath = require.resolve(`${name}/package.json`, { paths: [process.cwd()] })
    const pkg = require(pkgPath)
    return { name, installed: true, version: pkg.version }
  } catch {
    // Try dynamic resolve for ESM
    return { name, installed: false }
  }
}

function checkChromium(): { name: string; installed: boolean; version?: string } {
  try {
    const output = execSync('npx playwright install --dry-run 2>&1', {
      encoding: 'utf-8',
      timeout: 10_000,
    })
    const chromiumMatch = output.match(/Chrome for Testing ([\d.]+).*\n\s+Install location:\s+(.+)/)
    if (chromiumMatch) {
      const fs = require('node:fs')
      const installed = fs.existsSync(chromiumMatch[2].trim())
      return { name: 'chromium', installed, version: chromiumMatch[1] }
    }
    return { name: 'chromium', installed: false }
  } catch {
    return { name: 'chromium', installed: false }
  }
}
