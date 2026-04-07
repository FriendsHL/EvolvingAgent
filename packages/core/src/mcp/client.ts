// ============================================================
// MCPClient — thin wrapper over @modelcontextprotocol/sdk
// ============================================================
//
// Why wrap the SDK at all:
//  - The manager wants ONE consistent failure mode: connect() returns a
//    status object instead of throwing, so a broken server never takes
//    down session startup. The SDK throws on transport errors.
//  - We translate `MCPServerConfig` (our config shape) into the SDK's
//    StdioServerParameters here, keeping the rest of the codebase free
//    of SDK types.
//  - listTools() / callTool() return shapes are normalized into the
//    `MCPToolDescriptor` + `ToolResult` interfaces the rest of the agent
//    already speaks.
//
// Scope of v1: stdio only. The `url`/`headers` fields on MCPServerConfig
// are reserved for a future http transport but currently rejected at
// connect() time so users get a clear error instead of a silent skip.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { ToolResult } from '../types.js'
import type { MCPServerConfig, MCPToolDescriptor } from './types.js'

const CLIENT_NAME = 'evolving-agent'
const CLIENT_VERSION = '0.1.0'

export interface ConnectResult {
  ok: boolean
  /** Diagnostic message when ok=false. */
  error?: string
}

export class MCPClient {
  readonly serverId: string
  private client: Client | null = null
  private transport: StdioClientTransport | null = null
  private connected = false
  /** Resolved env after `${VAR}` expansion — supplied by manager. */
  private resolvedEnv: Record<string, string>

  constructor(
    private readonly config: MCPServerConfig,
    resolvedEnv: Record<string, string>,
  ) {
    this.serverId = config.id
    this.resolvedEnv = resolvedEnv
  }

  /**
   * Spawn the child process and complete the MCP handshake. Catches every
   * error path and reports via the return value — never throws. The
   * manager relies on this to keep startup non-blocking.
   */
  async connect(): Promise<ConnectResult> {
    if (this.connected) return { ok: true }
    if (this.config.url) {
      return { ok: false, error: 'http transport not supported in v1 (use command/args)' }
    }
    if (!this.config.command) {
      return { ok: false, error: 'config missing "command" field' }
    }

    try {
      this.transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args ?? [],
        env: this.resolvedEnv,
        cwd: this.config.cwd,
        // Default 'inherit' would dump the child's stderr into our process,
        // making the test output unreadable. 'pipe' lets us swallow it
        // unless we explicitly attach a listener later.
        stderr: 'pipe',
      })
      this.client = new Client(
        { name: CLIENT_NAME, version: CLIENT_VERSION },
        { capabilities: {} },
      )
      await this.client.connect(this.transport)
      this.connected = true
      return { ok: true }
    } catch (err) {
      // Reset partially-constructed state so a retry starts fresh.
      this.connected = false
      try {
        await this.transport?.close()
      } catch {
        // best effort
      }
      this.client = null
      this.transport = null
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Pull the tool list from the server and translate into descriptors.
   * Returns [] if not connected — callers should check connect() result
   * before calling this.
   */
  async listTools(): Promise<MCPToolDescriptor[]> {
    if (!this.client || !this.connected) return []
    try {
      const res = await this.client.listTools()
      const tools = (res.tools ?? []) as Array<{
        name: string
        description?: string
        inputSchema?: Record<string, unknown>
      }>
      return tools.map((t) => ({
        registryName: `mcp:${this.serverId}:${t.name}`,
        originalName: t.name,
        serverId: this.serverId,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      }))
    } catch {
      // Same fail-quiet contract: a flaky listTools shouldn't bring down
      // the session. Return [] and let the manager surface 'failed' state.
      return []
    }
  }

  /**
   * Invoke an MCP tool by ORIGINAL name (not the `mcp:server:name` form).
   * Translates the response into the agent's `ToolResult` shape so the
   * tool registry can call this transparently.
   */
  async callTool(
    originalName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (!this.client || !this.connected) {
      return { success: false, output: '', error: `MCP client "${this.serverId}" not connected` }
    }
    try {
      const res = await this.client.callTool({ name: originalName, arguments: args })
      // MCP returns content as an array of typed parts; flatten text parts
      // for output and treat isError flag as the success bit.
      const content = (res.content ?? []) as Array<{ type: string; text?: string }>
      const textParts = content.filter((c) => c.type === 'text' && typeof c.text === 'string')
      const output = textParts.map((c) => c.text!).join('\n')
      const isError = res.isError === true
      return {
        success: !isError,
        output,
        error: isError ? output || 'MCP tool returned isError=true' : undefined,
      }
    } catch (err) {
      return {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /** Tear down the underlying transport + client. Idempotent. */
  async close(): Promise<void> {
    this.connected = false
    try {
      await this.client?.close()
    } catch {
      // ignore
    }
    try {
      await this.transport?.close()
    } catch {
      // ignore
    }
    this.client = null
    this.transport = null
  }

  isConnected(): boolean {
    return this.connected
  }
}
