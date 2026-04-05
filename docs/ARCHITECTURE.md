# Evolving Agent — Architecture Design

## Vision

A self-evolving AI Agent system that learns from every interaction, accumulates skills, and improves its problem-solving capabilities over time. Unlike static Agent tools (Claude Code, OpenClaw), Evolving Agent dynamically generates tools, reflects on execution, and reuses learned patterns.

## Product Positioning

- **First user:** Developer (self-use)
- **Interaction:** CLI (Phase 1) + Web UI (Phase 4)
- **Core differentiator:** Execute → Reflect → Evolve loop

## Tech Stack

| Component | Choice | Reason |
|-----------|--------|--------|
| Runtime | Node.js 22+ / Bun | TS ecosystem, fast startup |
| Language | TypeScript (ESM) | Type safety, AI SDK ecosystem |
| Monorepo | pnpm workspace | Clean separation, shared deps |
| LLM SDK | Vercel AI SDK | Multi-provider abstraction (see [framework comparison](design/prompt-cache.md#framework-selection-vercel-ai-sdk)) |
| CLI UI | @clack/prompts or ink | Interactive terminal UX |
| Server | Hono or Fastify | Lightweight, WS support |
| Storage | Local filesystem (JSON/MD) → SQLite (Phase 2) | Simple, portable, no DB dependency |
| Python Engine | CLI pipe (child_process) | Zero network overhead |
| Test | Vitest | Fast, TS-native |
| Build | tsup or unbuild | Simple bundling |

## LLM Model Strategy

| Scenario | Role | Recommended Model |
|----------|------|-------------------|
| Planner | Task decomposition, strategy | Opus / Sonnet |
| Executor | Tool calling, execution | Sonnet |
| Reflector | Post-execution analysis | Haiku (cost-efficient) |
| Skill Generator | Code generation | Sonnet |

---

## Five-Layer Architecture

The human analogy: Agent = person. Hooks evolve the person themselves. Skills/Tools are external capabilities the person acquires.

```
  ┌─────────────────────────────────────────────────────────────────┐
  │                                                                 │
  │  Human Analogy          Agent Layer           Evolvable?        │
  │  ═══════════════════════════════════════════════════════════    │
  │                                                                 │
  │  Skeleton/Organs         Layer 0: Core         ✗ Human-only     │
  │  (basis for life)        agent.ts               Never breaks    │
  │                          hook-runner.ts                         │
  │                          planner/executor/                      │
  │                          reflector/memory/llm/                  │
  │                                                                 │
  │  ─────────────────────────────────────────────────────────     │
  │                                                                 │
  │  Nervous System          Layer 1: Core Hooks   ✗ Human-only     │
  │  (safety baseline)       context-window-guard   Last defense    │
  │                          cost-hard-limit                        │
  │                          safety-check                           │
  │                                                                 │
  │  ─────────────────────────────────────────────────────────     │
  │                                                                 │
  │  Brain/Thinking          Layer 2: Evolved Hooks ✓ Agent evolves │
  │  (intelligence+habits)   smart-compressor       Gets smarter    │
  │                          prompt-cache-optimizer                 │
  │                          memory-quality-filter                  │
  │                          risk-assessor                          │
  │                          cron scheduled tasks                   │
  │                                                                 │
  │  ─────────────────────────────────────────────────────────     │
  │                                                                 │
  │  Experience/Methods      Layer 3: Skills       ✓ Agent evolves  │
  │  (problem-solving SOPs)  "Debug P99 SOP"        Reusable        │
  │                          "Write MCP Server"     patterns        │
  │                                                                 │
  │  ─────────────────────────────────────────────────────────     │
  │                                                                 │
  │  Toolbox                 Layer 4: Tools        ✓ Agent creates  │
  │  (external capabilities) shell / HTTP / git     Can also load   │
  │                          kafka-lag / grafana    external ones    │
  │                          MCP Servers                            │
  │                                                                 │
  └─────────────────────────────────────────────────────────────────┘

  Modification Permission Matrix:
  ┌──────────────┬────────────┬────────────┬──────────────┐
  │              │ Agent Create│ Agent Modify│ Agent Disable│
  ├──────────────┼────────────┼────────────┼──────────────┤
  │ Core         │     ✗      │     ✗      │     ✗        │
  │ Core Hooks   │     ✗      │     ✗      │  per config  │
  │ Evolved Hooks│     ✓      │     ✓      │     ✓        │
  │ Skills       │     ✓      │     ✓      │     ✓        │
  │ Tools        │     ✓      │     ✓      │     ✓        │
  └──────────────┴────────────┴────────────┴──────────────┘
```

**Key Guarantee:** Core + Core Hooks guarantee Agent always runs — even if ALL evolved hooks are disabled.

---

## System Architecture

```
  User Input
    │
    ▼
  ┌──────────────────────────────────────────────────────────────┐
  │                    Evolving Agent                             │
  │                                                              │
  │  ┌─ Hook Chain ──────────────────────────────────────────┐   │
  │  │  before:plan → after:plan → before:tool-call →        │   │
  │  │  after:tool-call → before:llm-call → after:llm-call → │   │
  │  │  before:reflect → after:reflect                       │   │
  │  └───────────────────────────────────────────────────────┘   │
  │       │           │              │                           │
  │  ┌────▼───┐  ┌────▼─────┐  ┌────▼──────┐                   │
  │  │Planner │──│ Executor │──│ Reflector │                   │
  │  └────────┘  └──────────┘  └───────────┘                   │
  │       │           │              │                           │
  │  ┌────▼────────────▼──────────────▼─────┐                   │
  │  │           Memory System               │                   │
  │  │  Short-term │ Skill Store │ Experience │                   │
  │  └──────────────────────────────────────┘                   │
  │       │                                                      │
  │  ┌────▼────────────────────────────────┐                    │
  │  │          Tool System                 │                    │
  │  │  built-in │ MCP │ dynamic-generated  │                    │
  │  └─────────────────────────────────────┘                    │
  └──────────────────────────────────────────────────────────────┘
```

## Execution Flow

```
  1. User input: "Help me debug the P99 latency spike in order-service"
     │
  2. [Hook: before:plan] Context compression + experience filtering
     │
  3. Planner queries memory:
     │  → Experience store: similar problems before? → found 2 matches
     │  → Skill store: reusable debug skill? → found "grafana-query" skill
     │
  4. [Hook: after:plan] Plan review + risk assessment
     │
  5. Planner generates execution plan
     │
  6. For each step:
     │  [Hook: before:tool-call] Permission check
     │  → Executor calls tool
     │  [Hook: after:tool-call] Result validation
     │  [Hook: before:llm-call] Prompt cache optimization
     │  → LLM processes result
     │  [Hook: after:llm-call] Cost tracking
     │
  7. Output result to user
     │
  8. [Hook: before:reflect] Decide if reflection worthwhile
     │
  9. Reflector analyzes execution
     │
  10. [Hook: after:reflect] Memory admission filter
     │
  11. Save experience if quality threshold met
```

---

## Detailed Design Documents

| Document | Description |
|----------|-------------|
| [Hook System](design/hook-system.md) | 11 trigger points, 3 execution modes, trust layers, Safety Shell, self-heal flow, cron hooks |
| [Memory System](design/memory-system.md) | Three-tier knowledge, 5-dimension admission scoring, three-pool management, hybrid retrieval (RRF), storage phasing (JSON → SQLite → PostgreSQL) |
| [Tool System](design/tool-system.md) | Three-layer tools, ReAct self-iteration loop, tool safety sandbox |
| [Sub-Agent](design/sub-agent.md) | Session + Sub-Agent model, process isolation (child_process.fork), IPC protocol, Template vs Ad-hoc, lifecycle modes, token budget control, tool permissions, user interaction |
| [Prompt Cache](design/prompt-cache.md) | Four-layer prompt structure, LLM provider comparison, Vercel AI SDK implementation, cache anti-patterns, token observability, framework selection rationale |
| [Channel](design/channel.md) | Channel Manager, unified interface, phase rollout (CLI → Web → Feishu) |

---

## Project Structure

```
EvolvingAgent/
├── packages/
│   ├── core/                    # Agent Core (Layer 0)
│   │   ├── src/
│   │   │   ├── agent.ts         # Main agent loop
│   │   │   ├── planner/
│   │   │   │   └── planner.ts
│   │   │   ├── executor/
│   │   │   │   └── executor.ts
│   │   │   ├── reflector/
│   │   │   │   └── reflector.ts
│   │   │   ├── hooks/
│   │   │   │   ├── hook-runner.ts    # Hook execution engine
│   │   │   │   ├── safety-shell.ts   # Error isolation
│   │   │   │   ├── self-heal.ts      # Self-heal logic
│   │   │   │   └── core-hooks/       # Built-in hooks (Layer 1)
│   │   │   │       ├── context-window-guard.ts
│   │   │   │       ├── cost-hard-limit.ts
│   │   │   │       └── safety-check.ts
│   │   │   ├── memory/
│   │   │   │   ├── memory-manager.ts
│   │   │   │   ├── short-term.ts
│   │   │   │   ├── experience-store.ts
│   │   │   │   ├── knowledge-store.ts
│   │   │   │   ├── retriever.ts         # Hybrid search (keyword + semantic + tag → RRF)
│   │   │   │   ├── admission.ts         # 5-dimension admission scoring
│   │   │   │   └── compaction.ts        # Memory compaction (5+ similar → 1)
│   │   │   ├── sub-agent/
│   │   │   │   ├── manager.ts           # SubAgentManager (spawn, list, cancel, waitAll)
│   │   │   │   ├── worker.ts            # Child process entry point
│   │   │   │   ├── budget-guard.ts      # Token budget enforcement
│   │   │   │   └── ipc.ts              # IPC message serialization
│   │   │   ├── tools/
│   │   │   │   ├── registry.ts
│   │   │   │   ├── sandbox.ts        # Tool isolation
│   │   │   │   ├── shell.ts
│   │   │   │   ├── file-read.ts
│   │   │   │   ├── file-write.ts
│   │   │   │   └── http.ts
│   │   │   ├── llm/
│   │   │   │   └── provider.ts
│   │   │   ├── metrics/
│   │   │   │   └── collector.ts         # Token/cache metrics via after:llm-call hook
│   │   │   └── types.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── cli/                     # CLI Client
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── commands/
│   │   │   │   ├── chat.ts
│   │   │   │   ├── memory.ts
│   │   │   │   ├── agents.ts      # Sub-Agent management (list, status, cancel, ask)
│   │   │   │   ├── stats.ts       # Token/cache/cost stats display
│   │   │   │   └── hooks.ts       # View/manage hooks
│   │   │   └── ui/
│   │   │       └── renderer.ts
│   │   └── package.json
│   │
│   ├── server/                  # Agent Server (Phase 3)
│   │   └── ...
│   │
│   └── web/                     # Web UI (Phase 4)
│       └── ...
│
├── python/                      # Python AI Engine (Phase 2+)
│   ├── evolving_ai/
│   │   ├── embed.py
│   │   ├── search.py
│   │   └── eval.py
│   └── pyproject.toml
│
├── data/                        # Agent Workspace (evolvable, gitignored)
│   ├── hooks/                   # Evolved hooks (Layer 2)
│   │   ├── before-plan/
│   │   ├── before-llm-call/
│   │   ├── after-reflect/
│   │   └── cron/
│   ├── agents/                  # Agent Templates
│   │   ├── main/               # Default Main Agent
│   │   │   ├── agent.json
│   │   │   └── system.md
│   │   ├── qa/                 # QA expert template
│   │   └── log/                # Log analysis template
│   ├── memory/
│   │   ├── experiences/         # Active + Stale pool (JSON files)
│   │   ├── archive/             # Archived experiences (no search)
│   │   └── index.json           # In-memory index (Phase 1, loaded at startup)
│   ├── skills/                  # Learned skills
│   ├── tools/                   # Agent-created tools
│   │   └── .history/            # Version history for rollback
│   ├── knowledge/               # Generalized knowledge docs
│   ├── metrics/                 # Token/cache observability data
│   │   ├── calls/              # Per-call JSONL (one file per day)
│   │   ├── daily/              # Daily aggregation
│   │   └── agents/             # Per-agent aggregation
│   └── vectors/                 # Vector DB (Phase 2+)
│
├── docs/
│   ├── ARCHITECTURE.md          # This file (overview)
│   ├── design/                  # Detailed design documents
│   │   ├── hook-system.md
│   │   ├── memory-system.md
│   │   ├── tool-system.md
│   │   ├── sub-agent.md
│   │   ├── prompt-cache.md
│   │   └── channel.md
│   └── STRATEGY.md              # Language strategy + project roadmap
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.json
└── README.md
```

---

## Core Types

See each design document for detailed type definitions. Summary of key types:

```typescript
// packages/core/src/types.ts

// === Agent Events ===
interface AgentEvent {
  type: 'planning' | 'executing' | 'tool-call' | 'tool-result'
       | 'reflecting' | 'message' | 'error' | 'hook'
  data: any
}

// === Planning ===
interface Plan { task: string; steps: PlanStep[]; relatedExperiences: Experience[] }
interface PlanStep { id: string; description: string; tool: string; params: Record<string, any>; dependsOn?: string[] }
interface ExecutionStep extends PlanStep { result: ToolResult; duration: number }

// === Memory ===
interface Experience {
  id: string; task: string; steps: ExecutionStep[]
  result: 'success' | 'partial' | 'failure'
  reflection: Reflection; tags: string[]; timestamp: string; embedding?: number[]
  health: { referencedCount: number; contradictionCount: number; lastReferenced?: string }
}
interface Reflection { whatWorked: string[]; whatFailed: string[]; lesson: string; suggestedSkill?: SkillDraft }

// === Skills ===
interface Skill { id: string; name: string; trigger: string; steps: SkillStep[]; score: number; usageCount: number; lastUsed: string; createdFrom: string; version: number }

// === Tools ===
interface Tool { name: string; description: string; parameters: Record<string, any>; execute: (params: any) => Promise<ToolResult> }
interface ToolResult { success: boolean; output: string; error?: string }

// === Hooks === (full definition in design/hook-system.md)
interface Hook {
  id: string; name: string; trigger: HookTrigger; priority: number; enabled: boolean
  source: 'core' | 'evolved-verified' | 'evolved-new'; handler: string
  health: { consecutiveFailures: number; totalRuns: number; successRate: number }
  safety: { timeout: number; fallbackBehavior: 'skip' | 'abort' | 'use-default' }
  schedule?: string
}

// === Sessions ===
interface Session { id: string; startedAt: string; status: 'active' | 'idle' | 'closed' }

// === Agent Templates === (full definition in design/sub-agent.md)
interface AgentTemplate { id: string; name: string; description: string; systemPrompt: string; tools: string[]; model: string; tokenBudget: number; source: 'builtin' | 'evolved' }

// === Sub-Agent IPC === (full definition in design/sub-agent.md)
interface TaskAssign { type: 'task:assign'; taskId: string; description: string; config: { model: string; tokenBudget: number; tools: string[] } }
interface TaskResult { type: 'task:result'; taskId: string; outcome: 'success' | 'partial' | 'failure'; metadata: { tokensUsed: number; duration: number } }
```

---

## Phased Roadmap

### Phase 1: Minimum Viable Loop (~1 week)
- [ ] Monorepo scaffold (core + cli)
- [ ] Agent Core: Planner → Executor → Reflector loop
- [ ] Hook Runner + Core Hooks (context-window-guard, safety-check)
- [ ] Built-in tools: shell + file-read + file-write + http
- [ ] LLM calls: Vercel AI SDK + Anthropic
- [ ] Short-term memory: conversation context
- [ ] Experience store: JSON files + keyword matching
- [ ] CLI interaction: conversation + streaming output
- [ ] Reflection: LLM summary after each task → save to experience file
- [ ] Token/cache metrics collection (after:llm-call Core Hook)

**Deliverable:** CLI Agent that converses, calls tools, reflects, remembers, with hook infrastructure and basic cost observability.

### Phase 2: Self-Iteration + Hook Evolution (~2 weeks)
- [ ] Dev tool set: git + code-search + code-edit + test-runner
- [ ] Evolved Hook system: Agent creates/modifies hooks in data/hooks/
- [ ] Safety Shell + self-heal flow
- [ ] Hook trust upgrade: evolved-new → evolved-verified
- [ ] Skill system: Skill data structure + generation + reuse
- [ ] Dynamic tool generation: Agent writes code → sandbox test → register
- [ ] Experience store upgrade: vector storage + semantic retrieval (SQLite + sqlite-vss)
- [ ] Python AI Engine (embedding CLI)
- [ ] Memory anti-corruption: admission filter, three-pool management, contradiction detection

**Deliverable:** Agent that evolves its own behavior (hooks), writes tools, accumulates skills, with full safety guarantees.

### Phase 3: Sub-Agent + Observability + Channels (~2 weeks)
- [ ] Sub-Agent system: process isolation, IPC protocol, SubAgentManager
- [ ] Agent Template system: data/agents/ definitions, template matching
- [ ] Ad-hoc Sub-Agent: auto-generated prompts for parallel tasks
- [ ] Multi-session support: concurrent Sessions with shared data layer
- [ ] Token budget control: three-layer enforcement (self/Main/global)
- [ ] Token cache observability: per-call, task-level, session/daily stats
- [ ] Cache health alerts (Cron Hook)
- [ ] Observability tools: metrics-query + log-search + trace
- [ ] Agent Server (HTTP/WebSocket)
- [ ] Feishu webhook (simple push notification)
- [ ] Cron hook support (scheduled tasks)
- [ ] Eval framework: automated Agent capability assessment

**Deliverable:** Multi-agent system with process isolation, full cost observability, proactive notifications, scheduled tasks.

### Phase 4: Web UI + Advanced Evolution (~3 weeks)
- [ ] Web UI: visual conversation + skill library + experience network + hook management
- [ ] Feishu Bot (bidirectional)
- [ ] Channel Manager with unified interface
- [ ] MCP integration: connect external MCP Servers
- [ ] Prompt self-optimization (DSPy approach)
- [ ] Knowledge auto-generation from experience clusters
- [ ] Ad-hoc → Template evolution (auto-propose templates from repeated patterns)
- [ ] A2A protocol adapter for external Agent interop

**Deliverable:** Full-featured self-evolving Agent platform with visual interface and advanced evolution capabilities.

---

## Design Principles

1. **Evolution over configuration** — The Agent learns, not configures
2. **Hooks evolve the self, Tools extend the reach** — Internal improvement vs external capability
3. **Core never breaks** — All evolved components can be disabled; Agent still runs
4. **Two-layer safety** — Evolved hooks have fallbacks; Core hooks are the safety net
5. **Reflection is mandatory** — Every execution produces an experience record
6. **Skills are earned** — Skills emerge from repeated successful experiences, not pre-coded
7. **Memory decays** — Old, unreferenced, contradicted memories are archived, not kept forever
8. **Verify, don't assume** — Use observability to confirm whether actions were effective
9. **Start simple, grow smart** — JSON files before vector DBs, keyword match before embeddings

---

## Open Questions (To Discuss)

- [ ] Knowledge auto-generation trigger conditions
- [ ] Feishu Bot message format design (cards, interactive buttons)
