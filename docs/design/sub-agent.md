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

## Isolation Strategy (Decision: 2026-04-07)

**Sub-Agents run in-process, not as child processes.** Each Sub-Agent is a separate
`Agent` class instance with its own short-term memory, working state, and tool
registry references — but all instances share the same Node.js process and the
same single JS thread.

### Why in-process (the decision)

We originally planned `child_process.fork`. After reading the two reference
implementations we have on disk we changed direction:

- **openclaw** (`/myspace/openclaw/src/agents/subagent-spawn.ts`, 841 lines):
  zero `child_process` / `spawn` / `fork` usage. Sub-agents are spawned via an
  in-process `subagent-registry`. The "sandbox" axis is a separate concern
  (Docker container runtimes), not OS process isolation.
- **Claude Code** (`/myspace/package/restored-src/src/tasks/`): defines
  `InProcessTeammateTask`, `LocalAgentTask`, and `RemoteAgentTask` as separate
  task types. The default sub-agent path is in-process; only `RemoteAgentTask`
  goes to a separate runtime, and even that is over network, not local fork.

Both production-grade agents independently chose in-process. Their reasoning
applies to us:

1. **Agent work is IO-bound, not CPU-bound.** Each step waits 1–30s on an LLM
   HTTP response. Node's single-threaded event loop happily interleaves N
   concurrent `await llm.generate()` calls. Spawning a process buys nothing
   for the dominant cost.
2. **Process startup is expensive vs task duration.** A new Node process needs
   50–200ms to boot, then must re-import the entire agent codebase, re-init
   Vercel AI SDK, re-load tool registry, re-open data files. For a task that
   completes in 5–30s, this is 1–10% pure overhead with zero benefit.
3. **IPC complicates everything for marginal safety.** Serializing tool
   results, propagating errors with stack traces, debugging across process
   boundaries — all real costs. The "safety" upside (kill -9 a stuck child)
   only matters if sub-agents run untrusted code, which ours don't.
4. **Shared data layer becomes free.** Experience / Skill / Knowledge stores
   are in-memory caches over JSON files; in-process sub-agents read directly,
   no IPC marshaling.

### Node.js concurrency model (terminology)

To be precise about what "in-process" means:

| Mechanism | Memory | Thread | Use case |
|-----------|--------|--------|----------|
| `child_process.fork` | Independent V8 | Independent OS thread | True isolation, untrusted code |
| `worker_threads` | Mostly independent V8 | Independent thread, shared event loop primitives | CPU-bound work (embedding math, hashing) |
| async/await + Promises | Same V8, same heap | **Same** JS thread | Concurrent IO (our case) |

Sub-Agents use the third option. They are **independent objects on the same
event loop**, not independent threads. At any instant only one sub-agent's JS
code is executing; concurrency comes from yielding during `await`.

### Cost we accept

- A sub-agent stuck in a synchronous CPU loop (e.g., infinite regex backtrack)
  blocks the whole process including Main Agent.
- An uncaught exception in a sub-agent can crash the process if not properly
  caught at the SubAgentManager boundary.
- No `kill -9` ultimate fallback; budget enforcement must work cooperatively
  via `task:cancel` + the sub-agent's own pre-LLM-call check.

We accept these because (a) sub-agent code is our own, not user-supplied, and
(b) uncaught exceptions are caught at the manager boundary.

### Topology

```
  ┌────────────────────────────────────────────────────────────┐
  │              Single Node.js process / single JS thread      │
  │                                                             │
  │   ┌──────────┐    ┌──────────┐    ┌──────────┐             │
  │   │ Session 1 │    │ Session 2 │    │ Session N │            │
  │   │ Main      │    │ Main      │    │ Main      │            │
  │   │ Agent     │    │ Agent     │    │ Agent     │            │
  │   └────┬─────┘    └──────────┘    └──────────┘             │
  │        │                                                    │
  │   ┌────┼────┐          (each Session = independent          │
  │   ▼    ▼    ▼           Main Agent instance + its own       │
  │ Sub-A Sub-B Sub-C       short-term memory)                  │
  │                                                             │
  │   All boxes above = JS objects, scheduled by event loop     │
  └────────────────────────────────────────────────────────────┘

  ════════════════════════════════════════════════════════════
  ┌────────────────────────────────────────────────────────┐
  │   Shared Data Layer (in-memory cache + JSON files)      │
  │   data/memory/  data/skills/  data/knowledge/           │
  │   Read: direct access. Write: only via Main's Reflector │
  └────────────────────────────────────────────────────────┘
```

### Future-proofing: Transport adapter

To preserve the option of switching to true process isolation later (e.g. for
running untrusted user-supplied skills), the IPC protocol below is defined as
**pure JSON, no function references**, and Sub-Agents talk to Main through a
`SubAgentTransport` interface:

```typescript
interface SubAgentTransport {
  send(msg: SubAgentMessage): Promise<void>
  onMessage(handler: (msg: SubAgentMessage) => void): void
  close(): Promise<void>
}
```

We ship `InProcessTransport` (direct function call, microtask-scheduled).
A future `ChildProcessTransport` (JSON-line over `child_process.fork` stdio)
or `WorkerThreadTransport` (postMessage) can be added without changing any
sub-agent business logic.

## IPC Message Protocol

All communication goes through Main Agent (star topology, not mesh).
Although Sub-Agents are currently in-process, the protocol is defined as if
crossing a process boundary: pure JSON-serializable, no function references,
no shared mutable objects passed by reference. This preserves the option of
swapping in a `ChildProcessTransport` later without rewriting sub-agent logic.

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
  tokensUsed > 100% budget → send task:cancel
  In-process mode: no kill() fallback. Sub-Agent must check
  cancellation flag at every await point (cooperative cancellation).

  Layer 3: Global budget (hard ceiling)
  ════════════════════════════════════════════════════════
  All Sub-Agent tokens ≤ 50% of task total budget
  Single Sub-Agent ≤ 20% of task total budget
  Over → stop spawning new Sub-Agents

  Note: in-process mode loses the kill() ultimate fallback. A sub-agent
  stuck in a synchronous CPU loop will block the whole process. We accept
  this because our sub-agent code is in-house, not user-supplied.
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
  Internal: TaskAssign/TaskResult (in-process Transport, JSON payloads)
  External: A2A protocol (HTTP + JSON-RPC) via adapter

  ┌──────────┐   TaskAssign    ┌──────────────┐   A2A Task    ┌──────────┐
  │ Main     │ ──────────────> │ A2AAdapter   │ ────────────> │ External │
  │ Agent    │ <────────────── │              │ <──────────── │ Agent    │
  └──────────┘   TaskResult    └──────────────┘   A2A Result  └──────────┘
```
