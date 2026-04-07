import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MCPManager, type MCPClientFactory, type MCPClientLike } from './manager.js'
import type { MCPConfigFile, MCPToolDescriptor } from './types.js'
import { ToolRegistry } from '../tools/registry.js'

// ----------------------------------------------------------------
// Fake MCPClient — observable, deterministic, no real subprocess.
// ----------------------------------------------------------------
interface FakeBehavior {
  /** If true, connect() returns ok=false. */
  failConnect?: boolean
  /** Tools the fake will report from listTools(). */
  tools?: Array<{ name: string; description?: string }>
  /** Result returned by callTool(). */
  callResult?: { success: boolean; output: string }
}

const FAKE_REGISTRY = new Map<string, FakeBehavior>()

function setFake(serverId: string, behavior: FakeBehavior): void {
  FAKE_REGISTRY.set(serverId, behavior)
}

const fakeClientFactory: MCPClientFactory = (config, env) => {
  const behavior = FAKE_REGISTRY.get(config.id) ?? {}
  let connected = false
  const client: MCPClientLike & { lastEnv: Record<string, string>; closed: boolean } = {
    serverId: config.id,
    lastEnv: env,
    closed: false,
    async connect() {
      if (behavior.failConnect) return { ok: false, error: 'simulated connect failure' }
      connected = true
      return { ok: true }
    },
    async listTools(): Promise<MCPToolDescriptor[]> {
      if (!connected) return []
      return (behavior.tools ?? []).map((t) => ({
        registryName: `mcp:${config.id}:${t.name}`,
        originalName: t.name,
        serverId: config.id,
        description: t.description ?? '',
        inputSchema: { type: 'object', properties: {} },
      }))
    },
    async callTool() {
      return behavior.callResult ?? { success: true, output: 'fake' }
    },
    async close() {
      connected = false
      client.closed = true
    },
    isConnected() {
      return connected
    },
  }
  return client
}

let dataPath: string
let tools: ToolRegistry

beforeEach(async () => {
  dataPath = await mkdtemp(join(tmpdir(), 'mcp-manager-test-'))
  tools = new ToolRegistry()
  FAKE_REGISTRY.clear()
})
afterEach(async () => {
  await rm(dataPath, { recursive: true, force: true })
})

async function writeMcpConfig(body: MCPConfigFile): Promise<void> {
  await mkdir(join(dataPath, 'config'), { recursive: true })
  await writeFile(join(dataPath, 'config', 'mcp.json'), JSON.stringify(body), 'utf-8')
}

// ================================================================
describe('MCPManager — empty / missing config', () => {
  it('init with no config file is a no-op (no throw)', async () => {
    const m = new MCPManager({ dataPath, tools, clientFactory: fakeClientFactory })
    await m.init()
    expect(m.status()).toEqual([])
    expect(tools.list()).toEqual([])
    await m.shutdown()
  })

  it('init with empty servers array is a no-op', async () => {
    await writeMcpConfig({ servers: [] })
    const m = new MCPManager({ dataPath, tools, clientFactory: fakeClientFactory })
    await m.init()
    expect(m.status()).toEqual([])
    await m.shutdown()
  })
})

// ================================================================
describe('MCPManager — happy path startup', () => {
  it('connects, lists tools, and registers them with mcp:* naming', async () => {
    setFake('test-server', {
      tools: [{ name: 'echo', description: 'echo back' }],
    })
    await writeMcpConfig({
      servers: [{ id: 'test-server', command: 'fake', scope: 'both' }],
    })
    const m = new MCPManager({ dataPath, tools, clientFactory: fakeClientFactory })
    await m.init()

    const status = m.status()
    expect(status).toHaveLength(1)
    expect(status[0].status).toBe('running')
    expect(status[0].toolNames).toEqual(['echo'])

    expect(tools.get('mcp:test-server:echo')).toBeDefined()
    expect(tools.get('mcp:test-server:echo')?.scope).toBe('both')
    await m.shutdown()
  })

  it('honors per-server scope when registering tools', async () => {
    setFake('main-only', { tools: [{ name: 'a' }] })
    setFake('sub-only', { tools: [{ name: 'b' }] })
    await writeMcpConfig({
      servers: [
        { id: 'main-only', command: 'fake', scope: 'main' },
        { id: 'sub-only', command: 'fake', scope: 'sub' },
      ],
    })
    const m = new MCPManager({ dataPath, tools, clientFactory: fakeClientFactory })
    await m.init()

    expect(tools.get('mcp:main-only:a')?.scope).toBe('main')
    expect(tools.get('mcp:sub-only:b')?.scope).toBe('sub')

    // Sub-agent view should drop the 'main' one.
    const subView = tools.derive((t) => t.scope !== 'main')
    expect(subView.list().map((t) => t.name)).toEqual(['mcp:sub-only:b'])
    await m.shutdown()
  })

  it('execute() routes through the registered tool back to the fake client', async () => {
    setFake('rt', {
      tools: [{ name: 'op' }],
      callResult: { success: true, output: 'routed' },
    })
    await writeMcpConfig({ servers: [{ id: 'rt', command: 'fake' }] })
    const m = new MCPManager({ dataPath, tools, clientFactory: fakeClientFactory })
    await m.init()

    const result = await tools.execute('mcp:rt:op', { x: 1 })
    expect(result.success).toBe(true)
    expect(result.output).toBe('routed')
    await m.shutdown()
  })
})

// ================================================================
describe('MCPManager — failure modes do not block startup', () => {
  it('marks "missing-secret" and skips spawn when ${VAR} unresolved', async () => {
    await writeMcpConfig({
      servers: [
        {
          id: 'needs-key',
          command: 'fake',
          env: { API_KEY: '${MISSING_KEY}' },
        },
      ],
    })
    const m = new MCPManager({
      dataPath,
      tools,
      clientFactory: fakeClientFactory,
      secretsOverride: {},
    })
    await m.init()

    const status = m.status()
    expect(status[0].status).toBe('missing-secret')
    expect(status[0].message).toMatch(/MISSING_KEY/)
    expect(tools.list()).toEqual([])
    await m.shutdown()
  })

  it('marks "failed" but continues startup when connect throws', async () => {
    setFake('broken', { failConnect: true })
    setFake('healthy', { tools: [{ name: 'ok' }] })
    await writeMcpConfig({
      servers: [
        { id: 'broken', command: 'fake' },
        { id: 'healthy', command: 'fake' },
      ],
    })
    const m = new MCPManager({ dataPath, tools, clientFactory: fakeClientFactory })
    await m.init()

    const byId = Object.fromEntries(m.status().map((s) => [s.id, s]))
    expect(byId['broken'].status).toBe('failed')
    expect(byId['broken'].message).toMatch(/simulated/)
    expect(byId['healthy'].status).toBe('running')
    // Healthy server's tool still installed.
    expect(tools.get('mcp:healthy:ok')).toBeDefined()
    await m.shutdown()
  })

  it('skips disabled servers entirely', async () => {
    await writeMcpConfig({
      servers: [{ id: 'off', command: 'fake', enabled: false }],
    })
    const m = new MCPManager({ dataPath, tools, clientFactory: fakeClientFactory })
    await m.init()
    expect(m.status()[0].status).toBe('disabled')
    await m.shutdown()
  })

  it('expands ${VAR} from secrets bag and passes to client env', async () => {
    setFake('with-env', { tools: [{ name: 'a' }] })
    await writeMcpConfig({
      servers: [
        {
          id: 'with-env',
          command: 'fake',
          env: { API_TOKEN: 'Bearer ${SECRET_TOKEN}' },
        },
      ],
    })
    const m = new MCPManager({
      dataPath,
      tools,
      clientFactory: fakeClientFactory,
      secretsOverride: { SECRET_TOKEN: 'xyz' },
    })
    await m.init()
    // Status running implies connect was called with expanded env. We can
    // poke the fake's recorded env via the registry-bound execute path:
    // the fake stored `lastEnv` on the client object, but we don't expose
    // it through the manager. The 'running' status is the observable
    // signal that placeholder expansion succeeded; tested via the
    // expander's own unit tests for the substitution logic.
    expect(m.status()[0].status).toBe('running')
    await m.shutdown()
  })
})

// ================================================================
describe('MCPManager — reload diff', () => {
  it('removes a server that disappeared from the new config', async () => {
    setFake('a', { tools: [{ name: 't' }] })
    await writeMcpConfig({ servers: [{ id: 'a', command: 'fake' }] })
    const m = new MCPManager({ dataPath, tools, clientFactory: fakeClientFactory })
    await m.init()
    expect(tools.get('mcp:a:t')).toBeDefined()

    await m.reload([])
    expect(tools.get('mcp:a:t')).toBeUndefined()
    expect(m.status()).toEqual([])
    await m.shutdown()
  })

  it('leaves unchanged servers running and adds new ones', async () => {
    setFake('keep', { tools: [{ name: 'k' }] })
    setFake('add', { tools: [{ name: 'n' }] })
    await writeMcpConfig({ servers: [{ id: 'keep', command: 'fake' }] })
    const m = new MCPManager({ dataPath, tools, clientFactory: fakeClientFactory })
    await m.init()

    await m.reload([
      { id: 'keep', command: 'fake' },
      { id: 'add', command: 'fake' },
    ])
    expect(tools.get('mcp:keep:k')).toBeDefined()
    expect(tools.get('mcp:add:n')).toBeDefined()
    expect(m.status()).toHaveLength(2)
    await m.shutdown()
  })

  it('restarts a server when its config signature changes', async () => {
    setFake('s', { tools: [{ name: 't' }] })
    await writeMcpConfig({ servers: [{ id: 's', command: 'fake', args: ['v1'] }] })
    const m = new MCPManager({ dataPath, tools, clientFactory: fakeClientFactory })
    await m.init()
    const before = tools.get('mcp:s:t')

    await m.reload([{ id: 's', command: 'fake', args: ['v2'] }])
    const after = tools.get('mcp:s:t')
    // Same registry name, but a fresh Tool instance (rebuilt).
    expect(after).toBeDefined()
    expect(after).not.toBe(before)
    await m.shutdown()
  })
})

// ================================================================
describe('MCPManager — shutdown', () => {
  it('closes all clients and clears registry entries', async () => {
    setFake('s1', { tools: [{ name: 'a' }] })
    setFake('s2', { tools: [{ name: 'b' }] })
    await writeMcpConfig({
      servers: [
        { id: 's1', command: 'fake' },
        { id: 's2', command: 'fake' },
      ],
    })
    const m = new MCPManager({ dataPath, tools, clientFactory: fakeClientFactory })
    await m.init()
    expect(tools.list()).toHaveLength(2)

    await m.shutdown()
    expect(tools.list()).toEqual([])
    expect(m.status()).toEqual([])
  })
})
