// ============================================================
// MCPManager — multi-client lifecycle, ToolRegistry binding, hot reload
// ============================================================
//
// Responsibilities:
//  1. Read `data/config/mcp.json` + `data/config/secrets.json`
//  2. For each enabled server: expand placeholders → check missing →
//     either spawn a client OR mark `missing-secret` and skip
//  3. After connect, list tools and register them into the SHARED
//     ToolRegistry under name `mcp:<serverId>:<tool>` with the configured
//     scope baked in (so the sub-agent's `derive(scope !== 'main')` filter
//     does the right thing automatically)
//  4. Surface a status snapshot for the Web UI / status endpoint
//  5. Hot reload: `reload(newServers)` diffs against the current set,
//     closes removed/changed clients, spawns new ones, and re-registers
//     tools — without touching unaffected entries
//  6. Graceful shutdown: close all clients
//
// Failure modes (intentional, see project_mcp_spec.md):
//  - missing-secret  → skip, status='missing-secret', do NOT throw
//  - connect failed  → status='failed', do NOT throw, do NOT block init
//  - listTools fail  → status='failed', tool list empty
//
// Test seam:
//  The manager accepts an injectable `clientFactory` so unit tests can
//  swap MCPClient for a fake. Default factory builds the real one.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Tool, ToolResult } from '../types.js'
import type { ToolRegistry } from '../tools/registry.js'
import { MCPClient } from './client.js'
import type {
  MCPConfigFile,
  MCPServerConfig,
  MCPServerStatus,
  MCPServerStatusEntry,
  MCPToolDescriptor,
} from './types.js'
import { findMissingPlaceholders, expandPlaceholders, loadSecrets } from '../secrets/loader.js'

export interface MCPClientLike {
  readonly serverId: string
  connect(): Promise<{ ok: boolean; error?: string }>
  listTools(): Promise<MCPToolDescriptor[]>
  callTool(originalName: string, args: Record<string, unknown>): Promise<ToolResult>
  close(): Promise<void>
  isConnected(): boolean
}

export type MCPClientFactory = (
  config: MCPServerConfig,
  resolvedEnv: Record<string, string>,
) => MCPClientLike

export interface MCPManagerOptions {
  /** Root data directory; the manager reads `<dataPath>/config/mcp.json`. */
  dataPath: string
  /** Shared tool registry. The manager registers/unregisters mcp:* tools here. */
  tools: ToolRegistry
  /** Test seam — inject a fake client factory. */
  clientFactory?: MCPClientFactory
  /**
   * Inject a secrets bag directly (skips reading secrets.json from disk).
   * Used by tests so they don't need a temp data directory.
   */
  secretsOverride?: Record<string, string>
}

interface ManagedClient {
  config: MCPServerConfig
  client: MCPClientLike
  status: MCPServerStatusEntry
  /** Names installed in the shared ToolRegistry — used for clean unregister. */
  installedToolNames: string[]
}

const defaultClientFactory: MCPClientFactory = (config, env) => new MCPClient(config, env)

export class MCPManager {
  private clients = new Map<string, ManagedClient>()
  /** Servers that are configured but skipped (missing-secret / disabled). */
  private skipped = new Map<string, MCPServerStatusEntry>()
  private secrets: Record<string, string> = {}
  private secretsLoaded = false

  constructor(private readonly options: MCPManagerOptions) {}

  /**
   * Load mcp.json + secrets.json and bring up all servers. NEVER throws —
   * a malformed mcp.json is logged and treated as "no servers". Callers
   * (SessionManager.init) rely on this so a bad config can't take down
   * the whole session.
   */
  async init(): Promise<void> {
    // Load secrets first so we know what placeholders we can resolve.
    if (this.options.secretsOverride) {
      this.secrets = this.options.secretsOverride
      this.secretsLoaded = true
    } else {
      try {
        const result = await loadSecrets(this.options.dataPath)
        this.secrets = result.secrets
        this.secretsLoaded = result.loaded
      } catch (err) {
        // Malformed secrets.json — log and continue with empty bag.
        // Servers needing secrets will fall through to 'missing-secret'.
        console.warn(`[MCPManager] failed to load secrets.json: ${(err as Error).message}`)
        this.secrets = {}
        this.secretsLoaded = false
      }
    }

    const servers = await this.readConfig()
    for (const server of servers) {
      await this.startServer(server)
    }
  }

  /**
   * Diff `newServers` against current state and apply the minimum set of
   * mutations: close removed, restart changed, add new. Used by Web
   * config endpoint to hot-reload without restart.
   *
   * "Changed" detection is structural — JSON.stringify of the relevant
   * fields. Cheap and good enough; the alternative (per-field diff) adds
   * complexity for no real win since restart is fast.
   */
  async reload(newServers: MCPServerConfig[]): Promise<void> {
    const newById = new Map(newServers.map((s) => [s.id, s]))
    const currentIds = new Set([...this.clients.keys(), ...this.skipped.keys()])

    // 1. Removed servers — close + drop
    for (const id of currentIds) {
      if (!newById.has(id)) {
        await this.stopServer(id)
      }
    }

    // 2. New or changed servers — (re)start
    for (const server of newServers) {
      const existing = this.clients.get(server.id)
      if (existing && this.signature(existing.config) === this.signature(server)) {
        // Unchanged — leave running.
        continue
      }
      // Changed or new — stop existing (if any) then start fresh.
      await this.stopServer(server.id)
      await this.startServer(server)
    }
  }

  /** Snapshot of every configured server's runtime state. */
  status(): MCPServerStatusEntry[] {
    const out: MCPServerStatusEntry[] = []
    for (const m of this.clients.values()) out.push({ ...m.status })
    for (const s of this.skipped.values()) out.push({ ...s })
    // Stable order so the UI doesn't flicker.
    out.sort((a, b) => a.id.localeCompare(b.id))
    return out
  }

  /** Close every client and clear all registry entries. Idempotent. */
  async shutdown(): Promise<void> {
    const ids = [...this.clients.keys()]
    for (const id of ids) {
      await this.stopServer(id)
    }
    this.skipped.clear()
  }

  // ----------------------------------------------------------
  // Internals
  // ----------------------------------------------------------

  private async readConfig(): Promise<MCPServerConfig[]> {
    const filePath = join(this.options.dataPath, 'config', 'mcp.json')
    try {
      const raw = await readFile(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as MCPConfigFile
      if (!parsed || !Array.isArray(parsed.servers)) {
        console.warn(`[MCPManager] ${filePath} missing "servers" array; ignoring`)
        return []
      }
      // Filter out entries with no id — id is the registry key, can't proceed without it.
      return parsed.servers.filter((s) => {
        if (!s.id) {
          console.warn('[MCPManager] dropping server entry with missing id')
          return false
        }
        return true
      })
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e && e.code === 'ENOENT') return [] // No config file yet — fine.
      console.warn(`[MCPManager] failed to read ${filePath}: ${(err as Error).message}`)
      return []
    }
  }

  /** Start one server. Records status in either `clients` or `skipped`. */
  private async startServer(config: MCPServerConfig): Promise<void> {
    const label = config.label ?? config.id

    // Disabled flag = explicit user opt-out, surface in status as 'disabled'.
    if (config.enabled === false) {
      this.skipped.set(config.id, {
        id: config.id,
        label,
        status: 'disabled',
        toolNames: [],
      })
      return
    }

    // Missing-secret check BEFORE attempting to spawn — saves a process
    // launch and gives the user a clearer error in the UI.
    const missing = findMissingPlaceholders(config.env, this.secrets)
    if (missing.length > 0) {
      this.skipped.set(config.id, {
        id: config.id,
        label,
        status: 'missing-secret',
        message: `missing secrets: ${missing.join(', ')}`,
        toolNames: [],
      })
      return
    }

    const { expanded } = expandPlaceholders(config.env, this.secrets)
    const factory = this.options.clientFactory ?? defaultClientFactory
    const client = factory(config, expanded)

    const status: MCPServerStatusEntry = {
      id: config.id,
      label,
      status: 'connecting',
      lastAttemptAt: new Date().toISOString(),
      toolNames: [],
    }

    const connectResult = await client.connect()
    if (!connectResult.ok) {
      // Failed but non-blocking — record and move on.
      status.status = 'failed'
      status.message = connectResult.error
      this.clients.set(config.id, {
        config,
        client,
        status,
        installedToolNames: [],
      })
      return
    }

    const tools = await client.listTools()
    const installedToolNames = this.installTools(config, client, tools)
    status.status = 'running'
    status.toolNames = tools.map((t) => t.originalName)

    this.clients.set(config.id, {
      config,
      client,
      status,
      installedToolNames,
    })
  }

  /** Translate MCP tools into agent Tools and register on the shared registry. */
  private installTools(
    config: MCPServerConfig,
    client: MCPClientLike,
    descriptors: MCPToolDescriptor[],
  ): string[] {
    const installed: string[] = []
    for (const desc of descriptors) {
      const tool: Tool = {
        name: desc.registryName,
        description: desc.description,
        parameters: desc.inputSchema,
        scope: config.scope ?? 'both',
        execute: (params) => client.callTool(desc.originalName, params),
      }
      this.options.tools.register(tool)
      installed.push(desc.registryName)
    }
    return installed
  }

  /** Stop one server, clean up registry entries. Safe to call on unknown id. */
  private async stopServer(id: string): Promise<void> {
    this.skipped.delete(id)
    const managed = this.clients.get(id)
    if (!managed) return
    for (const name of managed.installedToolNames) {
      this.options.tools.unregister(name)
    }
    try {
      await managed.client.close()
    } catch {
      // ignore — we're tearing down anyway
    }
    this.clients.delete(id)
  }

  /** Stable signature used by `reload()` to detect "actually changed". */
  private signature(c: MCPServerConfig): string {
    return JSON.stringify({
      command: c.command,
      args: c.args,
      env: c.env,
      cwd: c.cwd,
      url: c.url,
      headers: c.headers,
      enabled: c.enabled,
      scope: c.scope,
    })
  }
}
