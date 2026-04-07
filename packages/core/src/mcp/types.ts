// ============================================================
// MCP — public types shared by client / manager / config loader
// ============================================================
//
// We deliberately keep these decoupled from the upstream SDK types so that
// (a) consumers don't have to import @modelcontextprotocol/sdk to read
// configs, and (b) we can hot-reload mcp.json without round-tripping
// through SDK schemas.

/**
 * One MCP server entry as it appears in `data/config/mcp.json`.
 *
 * Two transport flavours:
 *  - stdio: spawn a child process (`command` + `args`)
 *  - http:  connect to a remote endpoint (`url`) — reserved, not wired in
 *           the v1 client. The shape is here so existing configs survive
 *           an SDK upgrade without a schema migration.
 */
export interface MCPServerConfig {
  /** Stable identifier — used in tool naming `mcp:<id>:<tool>`. */
  id: string
  /** Optional human-friendly label for the UI. */
  label?: string
  /** Whether this server should be loaded at all. Defaults to true. */
  enabled?: boolean
  /**
   * Which agent tier the tools should be exposed to. Mirrors
   * `ToolDefinition.scope`. Defaults to 'both' when omitted.
   */
  scope?: 'main' | 'sub' | 'both'

  // --- stdio ---
  command?: string
  args?: string[]
  /**
   * Environment variables passed to the child process. Values may use
   * `${VAR}` placeholders that the secrets loader expands at runtime.
   */
  env?: Record<string, string>
  cwd?: string

  // --- http (reserved) ---
  url?: string
  headers?: Record<string, string>
}

/** Top-level shape of `data/config/mcp.json`. */
export interface MCPConfigFile {
  servers: MCPServerConfig[]
}

/**
 * Runtime status of one MCP server. The manager keeps one of these per
 * configured server, regardless of whether it succeeded in connecting.
 *
 * Three terminal-ish states matter for the UI / status endpoint:
 *  - 'running'        : connected, tools listed, ready to call
 *  - 'missing-secret' : config references `${VAR}` placeholders that have
 *                       no value in secrets.json — auto-skipped, NOT an
 *                       error condition
 *  - 'failed'         : connection threw or crashed; non-blocking, surfaced
 *                       to UI so the user can inspect/retry
 *
 * `'connecting'` and `'disabled'` are bookkeeping states.
 */
export type MCPServerStatus =
  | 'connecting'
  | 'running'
  | 'missing-secret'
  | 'failed'
  | 'disabled'

export interface MCPServerStatusEntry {
  id: string
  label: string
  status: MCPServerStatus
  /** When the manager last attempted to (re)connect this server. */
  lastAttemptAt?: string
  /** Diagnostic message — error stack for 'failed', placeholder list for 'missing-secret'. */
  message?: string
  /** Tools currently exposed by this server (empty unless status === 'running'). */
  toolNames: string[]
}

/**
 * One MCP tool, after we've translated it into the agent's `Tool`
 * interface and bound it to the upstream Client. Used by the manager to
 * register/unregister against a shared ToolRegistry.
 */
export interface MCPToolDescriptor {
  /** Final tool name installed in the registry: `mcp:<serverId>:<name>` */
  registryName: string
  /** Original tool name as reported by the MCP server. */
  originalName: string
  /** Server id this tool belongs to. */
  serverId: string
  description: string
  /** JSON Schema describing the tool's input. */
  inputSchema: Record<string, unknown>
}
