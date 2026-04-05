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
| LLM SDK | Vercel AI SDK | Multi-provider abstraction |
| CLI UI | @clack/prompts or ink | Interactive terminal UX |
| Server | Hono or Fastify | Lightweight, WS support |
| Storage | Local filesystem (JSON/MD) | Simple, portable, no DB dependency |
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

Using Vercel AI SDK for provider abstraction — supports Anthropic, OpenAI, Google, Mistral, etc.

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

### Key Guarantee

Core + Core Hooks guarantee Agent always runs — even if ALL evolved hooks are disabled.

---

## Hook System (Inspired by Claude Code)

### Design Philosophy

Hooks = evolving the Agent itself (innate capabilities).
Skills/Tools = giving the Agent external capabilities.

Claude Code has 24+ hook trigger points with three execution modes (Void, Modifying, Claiming) and error isolation via `catchErrors`. We adopt the same patterns, adapted for the Agent evolution loop.

### Hook Trigger Points

```
  User Input
    │
    ▼
  ● before:plan (Modifying)
  │  Can modify: input, context, retrieved experiences
  │  Use: context compression, input preprocessing, experience filtering
  │
  ▼
  Planner
    │
    ▼
  ● after:plan (Modifying)
  │  Can modify: generated execution plan
  │  Use: plan review, risk assessment, step optimization
  │
  ▼
  ● before:tool-call (Modifying)        ← per tool call
  │  Can modify: tool parameters
  │  Use: param validation, permission check, dangerous op interception
  │
  ▼
  Executor (tool call)
    │
    ▼
  ● after:tool-call (Modifying)         ← per tool call
  │  Can modify: tool result
  │  Use: result formatting, anomaly detection, cost recording
  │
  ▼
  ● before:llm-call (Modifying)         ← per LLM call
  │  Can modify: prompt, model selection, parameters
  │  Use: prompt cache optimization, model downgrade, context trimming
  │  ← THE most critical evolution point
  │
  ▼
  LLM Call
    │
    ▼
  ● after:llm-call (Void)               ← observation only
  │  Read-only: LLM response, token consumption
  │  Use: cost tracking, quality monitoring, cache hit stats
  │
  ▼
  ● before:reflect (Modifying)
  │  Can modify: data sent to Reflector
  │  Use: decide whether to skip reflection, compress reflection input
  │
  ▼
  Reflector
    │
    ▼
  ● after:reflect (Modifying)
  │  Can modify: reflection result, experience to store
  │  Use: memory admission filtering, experience quality scoring
  │
  ▼
  ● on:error (Void)                     ← on any error
  │  Read-only: error information
  │  Use: error stats, alerting, auto-degradation decisions
  │
  ══ Independent of conversation ══
  │
  ● cron (Void)                          ← scheduled triggers
  │  Use: periodic inspection, memory cleanup, health check, proactive push
  │
  ● on:startup (Void)                    ← Agent startup
  │  Use: environment check, cache loading, state recovery
```

### Three Execution Modes (from Claude Code)

```typescript
// Mode 1: Void — parallel, fire-and-forget (observation/logging)
// Used for: after:llm-call, on:error, cron, on:startup
async function runVoidHooks(hookName, event) {
  const hooks = getEnabledHooks(hookName)
  await Promise.all(hooks.map(h => safeExec(h, event)))
  // All hooks run in parallel, any failure doesn't affect others
}

// Mode 2: Modifying — sequential, can modify data flow (enhance/filter)
// Used for: before:plan, before:llm-call, after:reflect, etc.
async function runModifyingHooks(hookName, event, data) {
  const hooks = getEnabledHooks(hookName).sort(byPriority)
  let result = data
  for (const hook of hooks) {
    const modified = await safeExec(hook, event, result)
    if (modified !== undefined) {
      result = merge(result, modified)
    }
    // Hook fails → skip it, continue with previous result
  }
  return result
}

// Mode 3: Claiming — sequential, first-match wins (routing/decisions)
// Used for: future Sub-Agent task routing
async function runClaimingHooks(hookName, event) {
  for (const hook of getEnabledHooks(hookName).sort(byPriority)) {
    const result = await safeExec(hook, event)
    if (result?.handled) return result
  }
  return undefined
}
```

### Trust Layers

```
  Layer 0: Core Hooks (built-in, immutable)
  ═════════════════════════════════════════
  priority: 100
  • context-window-guard   (before:llm-call) — hard context window protection
  • cost-hard-limit        (before:llm-call) — hard cost ceiling
  • safety-check           (before:tool-call) — dangerous operation interception

  Layer 1: Evolved-Verified (evolved + battle-tested)
  ══════════════════════════════════════════════════
  priority: 50
  Agent created → tests passed → ran N times without failure → upgraded to verified
  Examples: smart-context-compressor, prompt-cache-optimizer, memory-quality-filter

  Layer 2: Evolved-New (evolved + probationary)
  ════════════════════════════════════════════
  priority: 10
  Freshly created by Agent, in observation period
  fallbackBehavior fixed to 'skip' (fail = skip)
  10 consecutive successes → auto-upgrade to verified
```

### Hook Data Structure

```typescript
interface Hook {
  id: string
  name: string
  description: string
  trigger: HookTrigger
  priority: number
  enabled: boolean
  source: 'core' | 'evolved-verified' | 'evolved-new'

  handler: string  // Function path or script path

  health: {
    consecutiveFailures: number
    lastError?: string
    lastSuccess?: string
    totalRuns: number
    successRate: number
  }

  safety: {
    timeout: number
    maxRetries: number
    fallbackBehavior: 'skip' | 'abort' | 'use-default'
    canBeDisabledByAgent: boolean
  }

  // For cron hooks
  schedule?: string  // cron expression
}

type HookTrigger =
  | 'before:plan' | 'after:plan'
  | 'before:tool-call' | 'after:tool-call'
  | 'before:llm-call' | 'after:llm-call'
  | 'before:reflect' | 'after:reflect'
  | 'on:error' | 'on:startup' | 'cron'
```

### Safety Shell (Error Isolation)

Every hook runs inside a Safety Shell (inspired by Claude Code's `catchErrors: true`):

```
  try {
    result = await Promise.race([
      hook.execute(context),
      timeout(hook.safety.timeout)
    ])
    hook.health.consecutiveFailures = 0
  } catch (error) {
    hook.health.consecutiveFailures++

    if (consecutiveFailures >= 3) {
      hook.enabled = false  // Immediately disable
      scheduleHeal(hook, error)  // Async self-heal, doesn't block
    }

    // Fallback — main flow never interrupted
    switch (hook.safety.fallbackBehavior) {
      case 'skip':        return context        // Skip hook, use original data
      case 'use-default': return defaultHandler  // Use built-in default
      case 'abort':       throw error           // Only for critical core hooks
    }
  }
```

### Self-Heal Flow

```
  Hook fails 3 consecutive times
       │
       ▼
  Step 1: Immediately disable hook
  → Main flow unaffected (fallback kicks in)
       │
       ▼
  Step 2: Diagnose (async, in background)
  → Agent analyzes error: code bug? env issue? logic error?
       │
       ├─── Core Hook → Don't modify, fall back to default, report to user
       │
       └─── Evolved Hook → Attempt repair:
            │
            ├── LLM analyzes error
            ├── Generates fix
            ├── Sandbox test
            │     │
            ├── Pass → Re-enable, version++, reset to evolved-new
            └── Fail → Archive hook permanently

  CRITICAL: Self-heal logic does NOT go through the Hook chain.
  → Prevents recursive dependency / deadlock.
  → Uses independent LLM call with minimal prompt.
```

### Context Compression Evolution Example

```
  Initial state:
  Core hook: context-window-guard (before:llm-call, priority=100)
  Strategy: brute-force truncation from oldest messages

  Problem:
  User defines variable X in message #5
  At message #30, guard truncates message #5
  Agent: "I don't know what X is"
  User corrects: "I defined it earlier!"

  Agent self-evolution:
  1. Reflector detects correction signal
  2. Analyzes: context truncation lost key definition
  3. Creates evolved hook: smart-compressor (before:plan, priority=50)
     - Identifies "definitional" messages (variable defs, decisions)
     - Marks them as pinned (never compressed)
     - Summarizes remaining messages via Haiku
  4. Sandbox test with historical conversations → passes
  5. Registered as evolved-new

  Runtime hook chain for before:llm-call:
  1. [evolved] smart-compressor (priority=50) → intelligent compression
     If fails? → Skip, use original messages
  2. [core] context-window-guard (priority=100) → hard truncation safety net
     If smart-compressor didn't compress enough → this catches it

  Two-layer protection: evolved hook fails → core hook catches.
```

### Scheduled Tasks (Cron Hooks)

Scheduled tasks are cron-triggered hooks, not Skills:

```
  data/hooks/cron/
  ├── memory-cleanup.ts         # Built-in: daily memory cleanup
  ├── health-check.ts           # Built-in: hourly self-check
  ├── kafka-monitor.ts          # Evolved: Agent-created monitoring
  └── daily-report.ts           # Evolved: Agent-created daily report

  Cron scheduler is part of Core (immutable).
  Cron hooks are evolvable — Agent can add/modify/disable them.
  Failed cron hooks auto-disable after 3 consecutive failures.
```

### Hook vs Skill vs Tool

| | Hook | Skill | Tool |
|---|------|-------|------|
| What | Agent internal middleware | Reusable task template | External capability |
| Triggered by | System events (auto) | Planner match | Executor call |
| Changes | Agent's behavior/thinking | Agent's problem-solving strategy | What Agent can do |
| Analogy | Neural reflexes / instincts | Experience-based SOPs | Tools in hand |
| Examples | Context compression, memory filter, cost control, cron tasks | "Debug P99" steps, "Write MCP Server" template | shell, HTTP, Kafka query |

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

## Tool System — Three Layers

```
  Layer 1: Foundation (Agent survival)
  ┌──────────┐ ┌──────────┐ ┌──────────┐
  │ shell    │ │ file-rw  │ │ http     │
  └──────────┘ └──────────┘ └──────────┘

  Layer 2: Development (Agent self-iteration)
  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
  │ git      │ │ code-    │ │ code-    │ │ test-    │
  │          │ │ search   │ │ edit     │ │ runner   │
  └──────────┘ └──────────┘ └──────────┘ └──────────┘

  Layer 3: Observability (Agent self-verification)
  ┌──────────┐ ┌──────────┐ ┌──────────┐
  │ metrics  │ │ log-     │ │ trace    │
  │ query    │ │ search   │ │          │
  └──────────┘ └──────────┘ └──────────┘

  Layer ∞: Dynamic (Agent self-created)
  ┌──────────────────────────────────────────┐
  │  Agent encounters new need → writes code │
  │  → tests → registers as new tool         │
  │  → saves to skill store                  │
  └──────────────────────────────────────────┘
```

### Self-Iteration via ReAct Loop

Agent writes code using ReAct (Think → Edit → Test → Fix), not one-shot generation:

```
  Planner: "Need a Kafka consumer lag checker tool"
    │
  Executor (ReAct loop):
    ├─ Think: "Need to create a tool calling Kafka admin API"
    ├─ Act: code-edit → create data/tools/kafka-lag.ts
    ├─ Observe: test-runner → FAIL: Kafka address not configured
    ├─ Think: "Need to read KAFKA_BROKERS from env"
    ├─ Act: code-edit → modify to read env var
    ├─ Observe: test-runner → PASS
    └─ Done: tool-registry → register "kafka-lag"
```

### Tool Safety

- Tools written by Agent go to `data/tools/` (isolated from Core)
- Sandbox verification: syntax check, security check (no Core imports, no process.exit), test run
- Runtime isolation: dynamic tools run via child_process or vm with timeout
- Crash doesn't affect Agent Core
- Version history in `data/tools/.history/` for rollback

## Memory System Design

### Three-Tier Knowledge System

```
  ┌─────────────┐  Extract  ┌─────────────┐  Generalize ┌──────────┐
  │  Experience  │ ────────> │   Skill     │ ──────────> │ Knowledge │
  │  (Memory)    │           │  (Pattern)   │             │ (Facts)   │
  │             │           │             │             │           │
  │ Specific    │           │ Reusable    │             │ Universal │
  │ Timestamped │           │ Scored      │             │ Persistent│
  │ JSON files  │           │ JSON files  │             │ MD files  │
  └─────────────┘           └─────────────┘             └──────────┘

  Query Priority (when facing a problem):
  1. Skill Store → Is there a ready-to-use SOP?
  2. Experience Store → Have we seen similar problems?
  3. Knowledge Store → Any relevant general knowledge?
  4. LLM pretrained knowledge → Fallback
```

### Experience (Memory)

Specific, time-bound execution records.

```typescript
interface Experience {
  id: string
  task: string
  steps: ExecutionStep[]
  result: 'success' | 'partial' | 'failure'
  reflection: Reflection
  tags: string[]
  timestamp: string
  embedding?: number[]  // Phase 2

  // Health tracking
  health: {
    referencedCount: number      // Times retrieved
    contradictionCount: number   // Times led to failure when reused
    lastReferenced?: string
  }
}
```

### Memory Anti-Corruption Mechanisms

**Strict Admission (write-time filtering):**
- Not all executions deserve memory. Reflector scores each (0-1) via LLM:
  - score < 0.5 → don't store
  - score 0.5-0.7 → store as low-confidence
  - score > 0.7 → store
- Auto-skip: simple queries, duplicate of existing experience, cancelled tasks

**Three-Pool Management:**
```
  ┌───────────────────────────────────────────────┐
  │  Active Pool      │  Stale Pool   │  Archive   │
  │  (hot, searched)  │  (cooling)    │  (no search)│
  │  ←── 200 cap ────>│←── buffer ───>│            │
  └───────────────────────────────────────────────┘

  health_score = 0.3 * recency + 0.4 * frequency + 0.3 * relevance

  Periodic cleanup (weekly or every 100 tasks):
  • health_score < 0.1 → archive
  • 30 days unreferenced → mark stale
  • stale + health_score < 0.2 → archive
```

**Contradiction Detection:**
- When an experience is referenced but leads to failure: `contradictionCount++`
- contradictionCount >= 2 → score decays 50%
- contradictionCount >= 3 → auto-archive as "disproven"

### Skill Health

```
  score = success_count / total_usage_count

  score > 0.8   → Healthy, prioritized
  score 0.5-0.8 → Usable, ask user confirmation
  score < 0.5   → Disabled, trigger re-evaluation
  3 consecutive failures → Frozen, await repair or archive
```

### Knowledge (Generalized Facts)

Universal, time-independent information distilled from multiple experiences:
- Stored as `data/knowledge/*.md`
- Example: `kafka-troubleshooting.md` aggregated from multiple Kafka debugging experiences
- Phase 2+: generated automatically when Agent detects clusters of related skills

## Channel Architecture

```
  ┌─────────────────────────────────────────────────────┐
  │                 Agent Core                           │
  │                    │                                 │
  │                    ▼                                 │
  │  ┌─────────────────────────────────┐                │
  │  │         Channel Manager          │                │
  │  │  • Unified message interface     │                │
  │  │  • Message routing               │                │
  │  │  • Bidirectional (receive+push)  │                │
  │  └──────────┬──────────────────────┘                │
  │             │                                        │
  │    ┌────────┼────────┬────────┬────────┐            │
  │    ▼        ▼        ▼        ▼        ▼            │
  │  ┌─────┐ ┌─────┐ ┌──────┐ ┌──────┐ ┌──────┐       │
  │  │ CLI │ │ Web │ │Feishu│ │DaXiang│ │Slack │       │
  │  │     │ │ WS  │ │ Bot  │ │ Bot  │ │ Bot  │       │
  │  └─────┘ └─────┘ └──────┘ └──────┘ └──────┘       │
  └─────────────────────────────────────────────────────┘

  interface Channel {
    id: string
    send(message: AgentMessage): Promise<void>
    onMessage(handler: MessageHandler): void
    supportsStreaming: boolean
    supportsRichContent: boolean
  }
```

Phase rollout:
- Phase 1: CLI only
- Phase 3: + Server (HTTP/WS) + Feishu webhook (simple push, ~10 lines)
- Phase 4: + Feishu Bot (bidirectional) + Web UI

## Sub-Agent Architecture (Phase 4)

```
  ┌───────────────────────────┐
  │      Main Agent           │  User interaction
  │      (Orchestrator)       │  Task decomposition + result aggregation
  └───────────┬───────────────┘
              │ Assign subtasks
    ┌─────────┼─────────┬──────────────┐
    ▼         ▼         ▼              ▼
  ┌──────┐ ┌──────┐ ┌──────┐    ┌──────────┐
  │ Sub  │ │ Sub  │ │ Sub  │    │ Sub      │
  │Agent1│ │Agent2│ │Agent3│    │Agent N   │
  │Code  │ │Log   │ │Metric│    │(dynamic) │
  └──────┘ └──────┘ └──────┘    └──────────┘

  Each Sub-Agent: independent context, independent tools, independent memory
  Shared (read-only): experience store, skill store, knowledge store
```

Orchestration modes:
1. **Parallel dispatch** — multiple Sub-Agents run independently, results aggregated
2. **Pipeline** — sequential dependency chain
3. **Expert consultation** — multiple Sub-Agents analyze, Main Agent synthesizes

## Prompt Cache Strategy

```
  Prompt structure (ordered by stability):

  ┌───────────────────────────────────┐ ← cache breakpoint 1
  │  Layer 1: System Prompt (very stable)
  │  • Agent identity, behavior rules
  │  • Tool definitions (built-in)
  │  • Output format requirements
  │  → ~100% cache hit
  ├───────────────────────────────────┤ ← cache breakpoint 2
  │  Layer 2: Context (fairly stable)
  │  • Skill store summary (changes daily)
  │  • Knowledge store summary
  │  • User preferences
  │  → 80-90% cache hit
  ├───────────────────────────────────┤ ← cache breakpoint 3
  │  Layer 3: Task Context (moderate change)
  │  • Related experiences (retrieval results)
  │  • Conversation history
  │  → 50-70% cache hit
  ├───────────────────────────────────┤
  │  Layer 4: Current Input (changes every time)
  │  • User's current message
  │  • Tool execution results
  │  → 0% cache
  └───────────────────────────────────┘

  Sub-Agent cache optimization:
  - Sub-Agents share System Prompt prefix → cache reuse
  - Task background in stable position → cache across Sub-Agents
  - Tool definitions sorted alphabetically → consistent cache keys
  - Reflector uses Haiku with templated prompts → very high cache hit
```

### Token Budget Management

```
  Per-task budget (configurable):
  • Total: 50K tokens
  • Planner: 10K
  • Executor (per step): 5K × N
  • Reflector: 5K
  • Sub-Agent (each): 10K

  Over-budget strategy:
  1. Warn user: "Task consumed XX tokens, continue?"
  2. Auto-downgrade: Sonnet → Haiku
  3. Context reduction: keep top 3 experiences instead of 10

  Stats display:
  $ evolve --stats
  Today's tokens: 23,456 (cache hit: 78%)
  Monthly est. cost: $4.32
  Experience store: 47 (active 32 / stale 10 / archived 5)
```

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
│   │   │   │   └── knowledge-store.ts
│   │   │   ├── tools/
│   │   │   │   ├── registry.ts
│   │   │   │   ├── sandbox.ts        # Tool isolation
│   │   │   │   ├── shell.ts
│   │   │   │   ├── file-read.ts
│   │   │   │   ├── file-write.ts
│   │   │   │   └── http.ts
│   │   │   ├── llm/
│   │   │   │   └── provider.ts
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
│   ├── memory/
│   │   ├── experiences/         # Experience records
│   │   └── archive/             # Archived experiences
│   ├── skills/                  # Learned skills
│   ├── tools/                   # Agent-created tools
│   │   └── .history/            # Version history for rollback
│   ├── knowledge/               # Generalized knowledge docs
│   └── vectors/                 # Vector DB (Phase 2+)
│
├── docs/
│   └── ARCHITECTURE.md          # This file
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.json
└── README.md
```

## Core Types

```typescript
// packages/core/src/types.ts

// === Agent Events ===
interface AgentEvent {
  type: 'planning' | 'executing' | 'tool-call' | 'tool-result'
       | 'reflecting' | 'message' | 'error' | 'hook'
  data: any
}

// === Planning ===
interface Plan {
  task: string
  steps: PlanStep[]
  relatedExperiences: Experience[]
}

interface PlanStep {
  id: string
  description: string
  tool: string
  params: Record<string, any>
  dependsOn?: string[]
}

interface ExecutionStep extends PlanStep {
  result: ToolResult
  duration: number
}

// === Memory ===
interface Experience {
  id: string
  task: string
  steps: ExecutionStep[]
  result: 'success' | 'partial' | 'failure'
  reflection: Reflection
  tags: string[]
  timestamp: string
  embedding?: number[]
  health: {
    referencedCount: number
    contradictionCount: number
    lastReferenced?: string
  }
}

interface Reflection {
  whatWorked: string[]
  whatFailed: string[]
  lesson: string
  suggestedSkill?: SkillDraft
}

// === Skills ===
interface Skill {
  id: string
  name: string
  trigger: string
  steps: SkillStep[]
  score: number
  usageCount: number
  lastUsed: string
  createdFrom: string
  version: number
}

// === Tools ===
interface Tool {
  name: string
  description: string
  parameters: Record<string, any>
  execute: (params: any) => Promise<ToolResult>
}

interface ToolResult {
  success: boolean
  output: string
  error?: string
}

// === Hooks ===
interface Hook {
  id: string
  name: string
  description: string
  trigger: HookTrigger
  priority: number
  enabled: boolean
  source: 'core' | 'evolved-verified' | 'evolved-new'
  handler: string
  health: {
    consecutiveFailures: number
    lastError?: string
    lastSuccess?: string
    totalRuns: number
    successRate: number
  }
  safety: {
    timeout: number
    maxRetries: number
    fallbackBehavior: 'skip' | 'abort' | 'use-default'
    canBeDisabledByAgent: boolean
  }
  schedule?: string  // cron expression, for cron hooks
}

type HookTrigger =
  | 'before:plan' | 'after:plan'
  | 'before:tool-call' | 'after:tool-call'
  | 'before:llm-call' | 'after:llm-call'
  | 'before:reflect' | 'after:reflect'
  | 'on:error' | 'on:startup' | 'cron'
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

**Deliverable:** CLI Agent that converses, calls tools, reflects, remembers, with hook infrastructure ready.

### Phase 2: Self-Iteration + Hook Evolution (~2 weeks)
- [ ] Dev tool set: git + code-search + code-edit + test-runner
- [ ] Evolved Hook system: Agent creates/modifies hooks in data/hooks/
- [ ] Safety Shell + self-heal flow
- [ ] Hook trust upgrade: evolved-new → evolved-verified
- [ ] Skill system: Skill data structure + generation + reuse
- [ ] Dynamic tool generation: Agent writes code → sandbox test → register
- [ ] Experience store upgrade: vector storage + semantic retrieval
- [ ] Python AI Engine (embedding CLI)
- [ ] Memory anti-corruption: admission filter, three-pool management, contradiction detection

**Deliverable:** Agent that evolves its own behavior (hooks), writes tools, accumulates skills, with full safety guarantees.

### Phase 3: Observability + Verification + Channels (~2 weeks)
- [ ] Observability tools: metrics-query + log-search + trace
- [ ] Self-verification: use observability to validate results
- [ ] Agent Server (HTTP/WebSocket)
- [ ] Feishu webhook (simple push notification)
- [ ] Cron hook support (scheduled tasks)
- [ ] Eval framework: automated Agent capability assessment
- [ ] Skill scoring + retirement mechanism
- [ ] Prompt cache optimization hooks
- [ ] Token budget management

**Deliverable:** Agent with self-verification, proactive notifications, scheduled tasks, cost control.

### Phase 4: Web UI + Multi-Agent + Advanced Evolution (~3 weeks)
- [ ] Web UI: visual conversation + skill library + experience network + hook management
- [ ] Feishu Bot (bidirectional)
- [ ] Channel Manager with unified interface
- [ ] MCP integration: connect external MCP Servers
- [ ] Sub-Agent system: Main Agent orchestrating Sub-Agents
- [ ] Prompt self-optimization (DSPy approach)
- [ ] Knowledge auto-generation from experience clusters
- [ ] A2A protocol support

**Deliverable:** Full-featured self-evolving Agent platform with visual interface and multi-agent orchestration.

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

- [ ] Memory corruption deep-dive: exact admission scoring criteria, decay formula tuning
- [ ] Sub-Agent communication protocol details
- [ ] Prompt cache implementation specifics with Vercel AI SDK
- [ ] Knowledge auto-generation trigger conditions
- [ ] Feishu Bot message format design (cards, interactive buttons)
