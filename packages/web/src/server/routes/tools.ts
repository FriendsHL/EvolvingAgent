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

export function toolsRoutes() {
  const app = new Hono()

  // List all system tools with health
  app.get('/', async (c) => {
    const tools = await getAllToolsWithHealth()
    return c.json({ tools })
  })

  // Check health of a specific tool
  app.get('/:id/health', async (c) => {
    const id = c.req.param('id')
    const tools = await getAllToolsWithHealth()
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

  // 5. Browser tool — needs playwright + chromium
  const browserHealth = await checkBrowserHealth()
  tools.push({
    id: 'browser',
    name: 'Browser',
    description: 'Control a headless Chromium browser (goto, click, type, text, screenshot, evaluate)',
    category: 'system',
    status: browserHealth.available ? 'ready' : 'unavailable',
    error: browserHealth.error,
    actions: ['goto', 'click', 'type', 'text', 'screenshot', 'evaluate', 'wait', 'back', 'html'],
    dependencies: [
      checkDep('playwright'),
      checkChromium(),
    ],
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
