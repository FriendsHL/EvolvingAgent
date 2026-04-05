# Sub-Agent Architecture

> Part of [Evolving Agent Architecture](../ARCHITECTURE.md)

## Core Model: Session + Sub-Agent

User's only entry point is Main Agent. Sub-Agents are background task processes spawned by Main.

```
  ┌─────────────────────────────────────────────────────────┐
  │                       User                               │
  │           ┌───────────┴───────────┐                     │
  │      Session 1               Session 2                   │
  │      (Main Agent)            (Main Agent)                │
  │           │                       │                      │
  │      ┌────┼────┐           direct chat                  │
  │      ▼    ▼    ▼                                        │
  │    Sub-A Sub-B Sub-C                                    │
  │    (QA)  (Log) (Metric)                                 │
  │                                                         │
  │  Sessions: independent Main Agent instances              │
  │  Each has own conversation context                       │
  │  Shared: Experience / Skill / Knowledge Store            │
  └─────────────────────────────────────────────────────────┘
```

**Three concepts:**

| Concept | Definition |
|---------|-----------|
| Agent Template | Predefined Agent config (prompt/tools/model), stored in `data/agents/` |
| Session | A user interaction session, entry always via Main Agent |
| Sub-Agent | Background task child process spawned by Main, using a Template or ad-hoc |

## Process Isolation

Sub-Agents run as child processes (`child_process.fork`), not in-process:

```
  Why process isolation:
  1. Main Agent stays responsive while Sub-Agents work (true async)
  2. Sub-Agent crash/OOM/infinite loop does not affect Main
  3. Main has kill() as ultimate budget enforcement
  4. ~50-80MB per child process, acceptable for local use
  5. IPC latency < 1ms, negligible vs LLM call time (1-30s)
```

```
  Process Topology:

  Terminal 1          Terminal 2
  ┌──────────────┐   ┌──────────────┐
  │ CLI Process   │   │ CLI Process   │   User interaction
  │ (Session 1)   │   │ (Session 2)   │
  └──────┬───────┘   └──────┬───────┘
         │                  │
  ┌──────▼───────┐   ┌─────▼────────┐
  │ Main Agent    │   │ Main Agent    │   Orchestration
  │ (process)     │   │ (process)     │
  └──┬────┬──────┘   └──────────────┘
     │    │
  ┌──▼──┐ ┌──▼──┐
  │Sub-A│ │Sub-B│         Sub-Agent (child processes)
  │(qa) │ │(log)│
  └─────┘ └─────┘

  ═══════════════════════════════════════════════
  ┌──────────────────────────────────────────┐
  │         Shared Data Layer (filesystem)    │
  │  data/memory/  data/skills/  data/knowledge/
  └──────────────────────────────────────────┘
```

## IPC Message Protocol

All communication goes through Main Agent (star topology, not mesh):

```typescript
type SubAgentMessage =
  | TaskAssign         // Main → Sub: assign task
  | TaskProgress       // Sub → Main: progress update
  | TaskResult         // Sub → Main: final result
  | TaskCancel         // Main → Sub: cancel task
  | ResourceRequest    // Sub → Main: request more resources/permissions
  | ResourceGrant      // Main → Sub: grant resources

interface TaskAssign {
  type: 'task:assign'
  taskId: string
  parentTaskId: string
  description: string
  context: {
    background: string              // Shared task background (cache-friendly)
    constraints: string[]
    relatedExperiences: Experience[]
    relevantSkills: Skill[]
  }
  config: {
    model: string
    tokenBudget: number
    timeout: number
    tools: string[]                 // Allowed tool whitelist
    canRequestMore: boolean
  }
}

interface TaskProgress {
  type: 'task:progress'
  taskId: string
  status: 'thinking' | 'executing' | 'tool-calling' | 'waiting-resource'
  summary: string
  tokensUsed: number
  stepsCompleted: number
}

interface TaskResult {
  type: 'task:result'
  taskId: string
  outcome: 'success' | 'partial' | 'failure'
  result: {
    answer: string
    artifacts: Artifact[]
    toolCalls: ToolCallRecord[]
  }
  metadata: {
    tokensUsed: number
    duration: number
    stepsTotal: number
    model: string
  }
  reflection?: {
    whatWorked: string[]
    whatFailed: string[]
    suggestion: string
  }
}

interface ResourceRequest {
  type: 'resource:request'
  taskId: string
  request:
    | { kind: 'more-tokens'; amount: number }
    | { kind: 'more-tools'; tools: string[] }
    | { kind: 'more-context'; query: string }
    | { kind: 'user-input'; question: string }
}
```

## Sub-Agent Creation: Template vs Ad-hoc

```typescript
type SubAgentSpawn =
  | { mode: 'template'; templateId: string; task: TaskAssign }
  | { mode: 'adhoc'; name: string; systemPrompt?: string;
      tools?: string[]; task: TaskAssign }
```

```
  Main Agent receives user request
    │
    ├── Doesn't need Sub-Agent → execute directly
    │
    └── Needs Sub-Agent → match Template?
         │
         ├── Template matched (e.g. QA task → qa template)
         │   → spawn with professional prompt + specialized tools
         │
         └── No template (e.g. "research 3 frameworks in parallel")
             → spawn N ad-hoc Sub-Agents
             → Main auto-generates lightweight prompt (~500 tokens)
             → uses generic ADHOC_TEMPLATE

  Ad-hoc evolution:
  Same type of ad-hoc task appears 3+ times
    → Reflector proposes new Template
    → Agent: "Should I create a 'researcher' template?"
    → User approves → saved to data/agents/researcher/
    → Next similar task auto-uses the template
```

## Agent Template Definition

```
  data/agents/
  ├── main/
  │   ├── agent.json      # { id, name, description, model, tokenBudget }
  │   └── system.md       # System prompt
  ├── qa/
  │   ├── agent.json
  │   └── system.md       # QA methodology, coverage requirements
  ├── log/
  │   ├── agent.json
  │   └── system.md       # Log analysis patterns
  └── researcher/          # Evolved template (auto-created)
      ├── agent.json
      └── system.md
```

```typescript
interface AgentTemplate {
  id: string
  name: string
  description: string              // Used by Main to match tasks
  systemPrompt: string
  tools: string[]
  model: string
  tokenBudget: number
  source: 'builtin' | 'evolved'   // Built-in or Agent-created
}
```

## Lifecycle Modes

```
  Ephemeral (one-off):
  spawn → execute single task → return result → process exit
  Stateless, simplest, used for most tasks

  Session-scoped (multi-turn):
  spawn → task 1 → result → task 2 → result → session end → exit
  Keeps context across tasks, better cache hit rate
  Idle timeout: 10 min → auto-exit
```

```
  Ephemeral:
  Created ──→ Running ──→ Completed ──→ [destroyed]
                │
                ├── Timeout ──→ [killed]
                └── Failed  ──→ [destroyed]

  Session-scoped:
  Created ──→ Idle ←──→ Running ──→ Idle ... ──→ SessionEnd ──→ [destroyed]
               │          │
               │          ├── Timeout ──→ Idle (task failed, agent alive)
               │          └── Failed  ──→ Idle
               │
               └── IdleTimeout (10min) ──→ [destroyed]
```

## Three Orchestration Modes

**Mode A: Parallel Dispatch**
```
  User: "分析 order-service 的 P99"
  Main:
    ├── Sub-A: "查 Grafana 指标"    ─┐
    ├── Sub-B: "查 ELK 日志"        ─┼── parallel spawn
    └── Sub-C: "查 deploy 记录"     ─┘
  Results → Main aggregates → output to User
  Timeout: single timeout → Main uses available results
```

**Mode B: Pipeline**
```
  Sub-A: analyze code → result
    ↓ (result passed as context)
  Sub-B: write refactored code → result
    ↓
  Sub-C: run tests → result
  Circuit breaker: any step failure → Main decides retry/skip/abort
```

**Mode C: Expert Consultation**
```
  Same question → multiple "expert" Sub-Agents:
    Sub-A (security) → risk list
    Sub-B (performance) → bottleneck analysis
    Sub-C (maintainability) → cost assessment
  Main synthesizes (not concatenates) multiple perspectives
```

## Token Budget Control (Three Layers)

```
  Layer 1: Sub-Agent self-discipline (inside child process)
  ════════════════════════════════════════════════════════
  Before each LLM call: check tokensUsed + estimated < budget
  Over budget → downgrade model (Sonnet → Haiku) → compress context
  Still over → stop, return partial result

  Layer 2: Main Agent monitoring (via IPC progress reports)
  ════════════════════════════════════════════════════════
  tokensUsed > 80% budget → send warning
  tokensUsed > 100% budget → send task:cancel → wait 3s → kill()

  Layer 3: Global budget (hard ceiling)
  ════════════════════════════════════════════════════════
  All Sub-Agent tokens ≤ 50% of task total budget
  Single Sub-Agent ≤ 20% of task total budget
  Over → stop spawning new Sub-Agents

  Process isolation advantage: Main has kill() as ultimate fallback.
  Even if Sub-Agent is stuck in CPU-bound loop, Main can force-kill.
```

## Tool Permission (Three Risk Levels)

```
  Level 1 — Safe (Sub-Agent uses freely):
    file-read, code-search, git-log, http-get, metrics-query, log-search

  Level 2 — Caution (needs Main authorization):
    file-write, code-edit, shell, http-post, test-runner

  Level 3 — Danger (needs User confirmation):
    git-push, deploy, database-write, send-message (Feishu/Slack)

  Runtime escalation:
  Sub-Agent → ResourceRequest { kind: 'more-tools' }
  → Main: Level 2 auto-decide; Level 3 → ask User
  → ResourceGrant { granted: true/false }
```

## Context Isolation vs Sharing

```
  Shared (read-only for Sub-Agents):
    Experience Store, Skill Store, Knowledge Store

  Isolated (per Sub-Agent):
    LLM Context (messages), Tool State, Working Memory

  Sub-Agent CANNOT write Experience/Skill/Knowledge.
  Write only at Main Agent's Reflector stage.
  → Single write entry point prevents memory corruption.
```

## User Interaction (Hybrid Mode)

User always communicates through Main Agent:

```
  Default: transparent proxy
  Main handles everything, user doesn't know Sub-Agents exist

  Advanced: user explicitly queries/controls
  "子任务什么状态？" → Main checks SubAgentManager status table
  "#1 详细说说"      → Main forwards to Sub-A, relays answer
  "取消 #1"          → Main cancels Sub-A

  Async notification:
  User chatting with Main about other topics
  → Sub-Agent completes → Main: "── 通知: #1 已完成 ──"
  → User: "#1 结果？" → Main relays

  Permission escalation:
  Sub-Agent needs Level 3 tool → Main asks User → Y/n
```

```bash
$ evolve agents                     # List active Sub-Agents
$ evolve agents status              # Detailed status (tokens, progress)
$ evolve agents inspect #1          # View execution trace
$ evolve agents cancel #1           # Cancel
$ evolve agents ask #1 "详细说说"   # Ask specific Sub-Agent
```

## Multi-Session Concurrency

```
  Phase 1 (JSON files):
    Each experience = one file → no write conflict
    Filename: exp-{timestamp}-{sessionId}.json
    index.json: file lock or write queue

  Phase 2 (SQLite):
    WAL mode → multiple readers, single writer
    Write serialized via queue
```

## Prompt Cache for Sub-Agents

```
  Ad-hoc parallel example (research 3 frameworks):

  Sub-A:
  ┌─────────────────────────────────────┐
  │ Layer 1: Shared Prefix              │ ← all 3 identical → cache hit
  │ (identity + safety + common tools)  │
  ├─────────────────────────────────────┤
  │ Layer 2: Ad-hoc template            │ ← all 3 identical → cache hit
  ├─────────────────────────────────────┤
  │ Layer 3: Task background            │ ← all 3 identical → cache hit
  │ ("Compare 3 AI frameworks...")      │
  ├─────────────────────────────────────┤
  │ Layer 4: Specific task              │ ← only this differs
  │ ("Research LangGraph")             │
  └─────────────────────────────────────┘

  Savings: 3 agents, L1-3 = 2300 tokens, L4 = 50 tokens
  Without cache: 2350 × 3 = 7050 tokens (full price)
  With cache: 2350 + 100 + 460 = 2910 effective tokens (~59% saved)

  Rules:
  • Task background (L3) must NOT include agent-specific details
  • Tool definitions sorted alphabetically for consistent cache keys
  • Session-scoped mode: conversation history becomes stable prefix → more hits
```

## A2A Protocol Compatibility (Future)

```
  Internal: TaskAssign/TaskResult (child_process IPC)
  External: A2A protocol (HTTP + JSON-RPC) via adapter

  ┌──────────┐   TaskAssign    ┌──────────────┐   A2A Task    ┌──────────┐
  │ Main     │ ──────────────> │ A2AAdapter   │ ────────────> │ External │
  │ Agent    │ <────────────── │              │ <──────────── │ Agent    │
  └──────────┘   TaskResult    └──────────────┘   A2A Result  └──────────┘
```
