# MCP Integration

> **Principle:** MCP is the **escape hatch**, not the default. Anything that
> can be done through a `skill` + CLI should stay there. MCP is for
> capabilities that have a published MCP server but no clean CLI surface
> (proprietary SaaS APIs, IDE-side tooling, etc).

## What this gets you

Once an MCP server is configured, every tool it exposes is registered into
the shared `ToolRegistry` under the name `mcp:<server-id>:<tool-name>` and
becomes callable from the agent loop just like a built-in tool. The
sub-agent boundary respects the configured `scope` field.

## Config files

Two files in `data/config/`:

| File | Tracked in git? | Purpose |
|---|---|---|
| `mcp.json` | yes | server definitions, transport config |
| `secrets.json` | **no** (gitignored via parent `data/`) | values for `${VAR}` placeholders |

`secrets.json` shape — top-level flat object of scalar values:

```json
{
  "GITHUB_TOKEN": "ghp_xxx",
  "OPENAI_API_KEY": "sk-..."
}
```

## Example `mcp.json`

```json
{
  "servers": [
    {
      "id": "filesystem",
      "label": "Filesystem (read-only)",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "scope": "both"
    },
    {
      "id": "github",
      "label": "GitHub API",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      },
      "scope": "main"
    }
  ]
}
```

## Field reference

| Field | Required | Notes |
|---|---|---|
| `id` | ✅ | unique; used as `mcp:<id>:<tool>` prefix |
| `label` |  | human-readable name for the dashboard |
| `enabled` |  | defaults to `true`; `false` skips loading |
| `scope` |  | `main` / `sub` / `both` — defaults to `both`. Sub-agents only see tools where `scope !== 'main'` |
| `command` | ✅ for stdio | binary to spawn (`npx`, `node`, etc.) |
| `args` |  | argv passed to the command |
| `env` |  | environment for the child. Values may use `${VAR}` placeholders |
| `cwd` |  | working directory for the child |

`url` and `headers` fields are reserved for a future http transport — they
parse and round-trip but are rejected at connect time in v1.

## Failure modes — none of them block startup

| Scenario | Status badge | Behavior |
|---|---|---|
| `${VAR}` placeholder unresolved | `missing-secret` | Server is **skipped** entirely. No process spawned. Fix by adding the secret in the dashboard or `secrets.json`. |
| Connect / handshake throws | `failed` | Recorded with the error message. Other servers continue loading. Reload from the dashboard to retry. |
| `enabled: false` | `disabled` | Skipped silently — visible in the status panel for clarity. |
| OK | `running` | Tools listed and registered. |

## Hot reload

Saving `mcp.json` (or `secrets.json`) from the dashboard:

1. Writes the file to disk
2. Calls `MCPManager.reload(newServers)`, which diffs against the current
   set: closes removed clients, restarts changed clients, leaves unchanged
   ones running

No service restart required.

## Web UI

The dashboard exposes everything under **🔌 MCP** in the sidebar:

- **Servers tab** — JSON editor for `mcp.json` + a runtime status panel
  showing each server's state badge and the tools it exposes
- **Secrets tab** — table of secret keys. **Values are never echoed back**
  from the server: editing an existing secret requires re-typing it. This
  is intentional — the dashboard is for editing, not for recovering
  forgotten values

## Sub-agent scoping

Tools with `scope: 'main'` are dropped from the registry derived for
sub-agents (`SubAgentManager.spawn → tools.derive(scope !== 'main')`).
Combined with the per-spawn `toolWhitelist`, this lets you pin a
GitHub-API MCP server to the main agent only while still letting code-
search MCPs reach sub-agents.

## When NOT to use MCP

- When the same capability already has a built-in tool (`shell`, `http`,
  `browser`, etc.) — those have richer hooks and metrics
- When a `skill:*` already wraps the workflow — skills compose better with
  the planner
- When you can drop a CLI binary into `$PATH` and call it from `shell` —
  one less moving part
